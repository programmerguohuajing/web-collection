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
    hasError: traceSpanHasError(span),
    ...frontendHttpMeta(span)
  }))
  const edges = spans
    .filter(span => span.parentSpanId && span.parentSpanId !== span.spanId && ids.has(span.parentSpanId))
    .map(span => ({ source: span.parentSpanId, target: span.spanId }))
  const errorSpans = spans.filter(traceSpanHasError).map(span => span.spanId)
  const roots = nodes.filter(node => !edges.some(edge => edge.target === node.id))
  return { root: roots[0] || null, nodes, edges, criticalPath: traceCriticalPath(roots, spanMap), errorSpans }
}

/** 前端 fetch/xhr Span 透出请求端点，供调用拓扑按接口拆分节点（与 PG 端实现保持一致） */
function frontendHttpMeta(span) {
  const op = String(span.operationName || '').toLowerCase()
  if (span.serviceName !== 'frontend' || (op !== 'fetch' && op !== 'xhr')) return {}
  const url = String(span.attributes?.url || '').trim()
  if (!url) return {}
  return { httpMethod: String(span.attributes?.method || 'GET').toUpperCase(), httpUrl: url }
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

/** 单会话全部事件（供 session 级诊断上下文） */
export async function getSessionEvents(db, sessionId, appId) {
  if (!sessionId?.trim()) return []
  const rows = appId
    ? await db.prepare('select * from events where session_id=? and app_id=? order by ts').bind(sessionId, appId).all()
    : await db.prepare('select * from events where session_id=? order by ts').bind(sessionId).all()
  return (rows || []).map(mapEvent)
}

/**
 * 单版本聚合统计（供 release 级诊断上下文）。
 * 返回 { release, appId, total, errors, perfAvg }，无数据返回 null。
 */
export async function getReleaseStats(db, releaseName, appId) {
  if (!releaseName?.trim()) return null
  const sql = appId
    ? 'select type, count(*) as cnt, avg(case when type=? then value else null end) as perf_avg from events where release_name=? and app_id=? group by type'
    : 'select type, count(*) as cnt, avg(case when type=? then value else null end) as perf_avg from events where release_name=? group by type'
  const params = appId ? ['perf', releaseName, appId] : ['perf', releaseName]
  const rows = await db.prepare(sql).bind(...params).all()
  if (!rows?.length) return null
  let total = 0, errors = 0, perfAvg = null
  for (const r of rows) {
    const cnt = Number(r.cnt) || 0
    total += cnt
    if (r.type === 'error') errors += cnt
    if (r.type === 'perf' && r.perf_avg != null) perfAvg = Number(r.perf_avg)
  }
  return { release: releaseName, appId: appId || null, total, errors, perfAvg: perfAvg ? Number(perfAvg.toFixed(2)) : null }
}

/**
 * 版本时间线（首次出现时间升序），供「上一版本」定位。
 * 仅统计 events 中实际出现过的 release_name（releases 表未必全）。
 */
export async function getReleaseList(db, appId) {
  const sql = appId
    ? 'select release_name, min(ts) as first_ts from events where app_id=? and release_name is not null group by release_name order by first_ts asc'
    : 'select release_name, min(ts) as first_ts from events where release_name is not null group by release_name order by first_ts asc'
  const params = appId ? [appId] : []
  const rows = await db.prepare(sql).bind(...params).all()
  return (rows || []).map(r => ({ release_name: r.release_name, firstTs: Number(r.first_ts) || 0 }))
}

/** 当前版本的「上一版本」：按首次出现时间排序，取当前版本之前的那一个 */
export async function getPreviousRelease(db, releaseName, appId) {
  const list = await getReleaseList(db, appId)
  const idx = list.findIndex(r => r.release_name === releaseName)
  if (idx <= 0) return null
  return list[idx - 1]
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

/**
 * 错误簇聚合：窗口内按错误名分组计数，按次数降序取 top。
 * 供 P1 主动诊断「错误簇突增」检测器使用。
 */
export async function getErrorClusters(db, { appId, sinceTs, limit = 5 } = {}) {
  const where = []
  const params = []
  if (appId) { where.push('app_id = ?'); params.push(appId) }
  if (sinceTs) { where.push('ts >= ?'); params.push(Number(sinceTs)) }
  const sql = `select name, message, count(*) as cnt, count(distinct user_id) as affected
    from events where type = 'error'${where.length ? ' and ' + where.join(' and ') : ''}
    group by name, message order by cnt desc limit ?`
  const rows = await db.prepare(sql).bind(...params, limit).all()
  return (rows || []).map(r => ({ name: r.name, message: r.message, count: Number(r.cnt), affected: Number(r.affected || 0) }))
}

/** 时间窗内性能均值（type='perf' 的 value 视为耗时/指标值） */
export async function getPerfWindow(db, { appId, fromTs, toTs } = {}) {
  const where = []
  const params = []
  if (appId) { where.push('app_id = ?'); params.push(appId) }
  if (fromTs != null) { where.push('ts >= ?'); params.push(Number(fromTs)) }
  if (toTs != null) { where.push('ts <= ?'); params.push(Number(toTs)) }
  const sql = `select count(*) as cnt, avg(value) as avgv from events where type = 'perf'${where.length ? ' and ' + where.join(' and ') : ''}`
  const row = await db.prepare(sql).bind(...params).first()
  return { count: Number(row?.cnt || 0), avg: row?.avgv != null ? Number(row.avgv) : null }
}

/** 时间窗内非错误事件量（流量/转化代理指标） */
export async function getVolumeWindow(db, { appId, fromTs, toTs, type } = {}) {
  const where = []
  const params = []
  if (appId) { where.push('app_id = ?'); params.push(appId) }
  if (fromTs != null) { where.push('ts >= ?'); params.push(Number(fromTs)) }
  if (toTs != null) { where.push('ts <= ?'); params.push(Number(toTs)) }
  if (type) { where.push('type = ?'); params.push(type) }
  const sql = `select count(*) as cnt from events where type <> 'error'${where.length ? ' and ' + where.join(' and ') : ''}`
  const row = await db.prepare(sql).bind(...params).first()
  return Number(row?.cnt || 0)
}

/** D1 的 SQLITE_MAX_LIKE_PATTERN_LENGTH 很小（实测 >~50 字符即报错），保守取 32 */
export const SAFE_LIKE_LEN = 32

/** 构造安全 LIKE pattern：截断到 SAFE_LIKE_LEN、转义通配符与转义符本身，前后加 % */
export function likePattern(text) {
  return `%${String(text ?? '').slice(0, SAFE_LIKE_LEN).replace(/[\\%_]/g, ch => '\\' + ch)}%`
}
