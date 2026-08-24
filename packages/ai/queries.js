/**
 * @file AI 诊断只读查询层（从 cloudflare/worker.js 抽取，D1 / PG 双后端）
 *
 * db 由 packages/ai/db-adapter.js 构造（createD1Adapter / createPgAdapter），
 * 提供 prepare/bind/all/first/run 统一接口，因此本模块不感知后端。
 * worker.js 改为 import 本模块并 re-export，保持对外行为一致。
 */
import { maskPhone, parse } from './pii.js'

// ---------------- 纯映射（worker.js 抽取） ----------------

export function mapEvent(r) {
  return {
    id: r.id, ts: r.ts, type: r.type, appId: r.app_id, release: r.release_name,
    userId: r.user_id, userName: r.user_name, userPhone: maskPhone(r.user_phone),
    sessionId: r.session_id, deviceId: r.device_id, traceId: r.trace_id, spanId: r.span_id,
    sdkVersion: r.sdk_version, environment: r.environment, source: r.source,
    context: parse(r.context_json, null), url: r.url, path: r.path, title: r.title,
    referrer: r.referrer, userAgent: r.user_agent, name: r.name, metric: r.metric,
    value: r.value, message: r.message, stack: r.stack, props: parse(r.props_json, null),
    breadcrumbs: parse(r.breadcrumbs_json, null),
    appVersion: r.app_version ?? null, productId: r.product_id ?? null, eventId: r.event_id ?? null,
    requestId: r.request_id ?? null, occurredAt: r.occurred_at == null ? null : Number(r.occurred_at),
    receivedAt: r.received_at == null ? null : Number(r.received_at),
    schemaVersion: r.schema_version ?? null, batchId: r.batch_id ?? null,
    retryCount: r.retry_count == null ? null : Number(r.retry_count),
    contractStatus: r.contract_status ?? null, contractErrors: parse(r.contract_errors_json, null) ?? null
  }
}

export function mapIssue(r) {
  return {
    fingerprint: r.fingerprint, status: r.status, appId: r.app_id, release: r.release_name ?? r.release,
    name: r.name, message: r.message, stack: r.stack, url: r.url,
    props: parse(r.props_json, null), breadcrumbs: parse(r.breadcrumbs_json, null),
    original: parse(r.original_json, null), count: r.count, firstSeen: r.first_seen,
    lastSeen: r.last_seen, resolvedAt: r.resolved_at, affectedUsers: Number(r.affected_users || 0),
    resolutionNotes: r.resolution_notes ?? null
  }
}

// ---------------- 分布式 trace（worker.js buildDistributedTrace 抽取） ----------------

export function buildDistributedTrace(events = [], backendSpans = []) {
  const spanMap = new Map()
  for (const [index, event] of events.entries()) {
    const attributes = parse(event.props_json, {}) || {}
    const span = {
      spanId: String(event.span_id || '').trim() || `event-${event.id || index}`,
      parentSpanId: String(event.parent_span_id || attributes.__parentSpanId || '').trim(),
      serviceName: 'frontend',
      operationName: event.metric || event.name || event.type || 'event',
      kind: 'CLIENT',
      startTs: Number(event.ts) || 0,
      duration: event.type === 'perf' ? Number(event.value) || 0 : 0,
      statusCode: event.type === 'error' || attributes.failed === true || attributes.failed === 'true' || Number(attributes.status) >= 400 ? 'ERROR' : 'OK',
      attributes
    }
    mergeSpan(spanMap, span)
  }
  // 后端 span（M5：跨服务诊断），字段形状与 PG 端 normalizeSpan / services/buildDistributedTrace 对齐
  for (const [index, span] of (backendSpans || []).entries()) {
    const attributes = parse(span.attributes_json, {}) || {}
    mergeSpan(spanMap, {
      spanId: String(span.span_id || '').trim() || `backend-${span.id || index}`,
      parentSpanId: String(span.parent_span_id || '').trim(),
      serviceName: span.service_name || 'unknown',
      operationName: span.operation_name || 'span',
      kind: span.kind || 'INTERNAL',
      startTs: Number(span.start_ts) || 0,
      duration: Number(span.duration) || 0,
      statusCode: String(span.status_code || 'UNSET').toUpperCase() || 'UNSET',
      attributes
    })
  }

  const ids = new Set(spanMap.keys())
  const spans = [...spanMap.values()]
  const nodes = spans.map(span => ({
    id: span.spanId,
    name: span.operationName,
    service: span.serviceName,
    kind: span.kind,
    startTs: Number.isFinite(span.startTs) ? span.startTs : 0,
    duration: span.duration,
    status: span.statusCode,
    hasError: traceSpanHasError(span)
  }))
  const edges = spans
    .filter(span => span.parentSpanId && span.parentSpanId !== span.spanId && ids.has(span.parentSpanId))
    .map(span => ({ source: span.parentSpanId, target: span.spanId }))
  const errorSpans = spans.filter(traceSpanHasError).map(span => span.spanId)
  const roots = nodes.filter(node => !edges.some(edge => edge.target === node.id))
  return { root: roots[0] || null, nodes, edges, criticalPath: traceCriticalPath(roots, spanMap), errorSpans }
}

/** 合并同 spanId 的 span，避免重复 key 与断裂边（与 PG 端 buildDistributedTrace 一致） */
function mergeSpan(spanMap, span) {
  const existing = spanMap.get(span.spanId)
  spanMap.set(span.spanId, existing ? {
    ...existing,
    parentSpanId: existing.parentSpanId || span.parentSpanId,
    startTs: Math.min(existing.startTs || Infinity, span.startTs || Infinity),
    duration: Math.max(existing.duration, span.duration),
    statusCode: traceSpanHasError(existing) || traceSpanHasError(span) ? 'ERROR' : existing.statusCode,
    attributes: { ...existing.attributes, ...span.attributes }
  } : span)
}

function traceSpanHasError(span) {
  if (String(span.statusCode || '').toUpperCase() === 'ERROR') return true
  return Object.values(span.attributes || {}).some(value => String(value).toLowerCase().includes('error'))
}

function traceCriticalPath(roots, spanMap) {
  const childrenByParent = new Map()
  for (const span of spanMap.values()) {
    if (!span.parentSpanId) continue
    const children = childrenByParent.get(span.parentSpanId) || []
    children.push(span)
    childrenByParent.set(span.parentSpanId, children)
  }
  let longest = { path: [], duration: 0 }
  function visit(spanId, path, duration, visited) {
    if (visited.has(spanId)) return
    visited.add(spanId)
    path.push(spanId)
    const total = duration + (spanMap.get(spanId)?.duration || 0)
    const children = childrenByParent.get(spanId) || []
    if (!children.length && (total > longest.duration || (total === longest.duration && path.length > longest.path.length))) longest = { path: [...path], duration: total }
    for (const child of children) visit(child.spanId, path, total, visited)
    path.pop()
    visited.delete(spanId)
  }
  for (const root of roots) visit(root.id, [], 0, new Set())
  return longest.path
}

// ---------------- 只读查询（依赖 db 统一接口） ----------------

export async function getDistributedTrace(db, traceId) {
  if (!traceId?.trim()) return { root: null, nodes: [], edges: [], criticalPath: [], errorSpans: [] }
  const [events, backendSpans] = await Promise.all([
    db.prepare('select * from events where trace_id=? order by ts').bind(traceId).all(),
    db.prepare('select * from spans where trace_id=? order by start_ts').bind(traceId).all().catch(() => [])
  ])
  return buildDistributedTrace(events || [], backendSpans || [])
}

export async function getTrace(db, traceId) {
  const rows = (await db.prepare('select * from events where trace_id=? order by ts').bind(traceId).all()) || []
  return rows.map(mapEvent)
}

export async function getIssue(db, fingerprint) {
  const row = fingerprint?.trim()
    ? await db.prepare('select * from issues where fingerprint=?').bind(fingerprint).first()
    : null
  return row ? mapIssue(row) : null
}

/** 关联 trace 的错误事件（供诊断上下文） */
export async function getErrorEvents(db, { traceId, appId, limit = 20 } = {}) {
  let where = '', params = []
  if (traceId) { where = `trace_id=? and (type='error')`; params = [traceId] }
  else if (appId) { where = `app_id=? and type='error'`; params = [appId] }
  else return []
  const sql = `select * from events where ${where} order by ts desc limit ?`
  const rows = await db.prepare(sql).bind(...params, limit).all()
  return (rows || []).map(mapEvent)
}

/** 相似历史 issue（名称或消息文本模糊匹配，按发生次数排序） */
export async function getSimilarIssues(db, { name, message, appId, limit = 5 } = {}) {
  // 括号必须包住整组 or 匹配条件，否则 or 会撕裂前面的 and 条件。
  // D1 对 LIKE pattern 有 ~48 字节硬限制（超限抛 "LIKE or GLOB pattern too complex"，
  // 与特殊字符无关），因此匹配文本截断到 SAFE_LIKE_LEN 并转义通配符。
  const fixed = []
  if (appId) { fixed.push('app_id = ?') }
  const matchParts = []
  if (name) { matchParts.push("(name = ? or name like ? escape '\\')") }
  if (message) { matchParts.push("message like ? escape '\\'") }
  let sql = `select * from issues where status <> 'resolved'`
  const values = []
  if (fixed.length) { sql += ' and ' + fixed.join(' and '); values.push(appId) }
  if (matchParts.length) {
    sql += ' and (' + matchParts.join(' or ') + ')'
    if (name) {
      const namePat = likePattern(String(name).slice(0, SAFE_LIKE_LEN))
      values.push(name, namePat)
    }
    if (message) values.push(likePattern(String(message).slice(0, SAFE_LIKE_LEN)))
  }
  const rows = await db.prepare(`${sql} order by count desc limit ?`).bind(...values, limit).all()
  return (rows || []).map(mapIssue)
}

/** D1 的 SQLITE_MAX_LIKE_PATTERN_LENGTH 很小（实测 >~50 字符即报错），保守取 32 */
export const SAFE_LIKE_LEN = 32

/** 构造安全 LIKE pattern：截断到 SAFE_LIKE_LEN、转义通配符与转义符本身，前后加 % */
export function likePattern(text) {
  return `%${String(text ?? '').slice(0, SAFE_LIKE_LEN).replace(/[\\%_]/g, ch => '\\' + ch)}%`
}
