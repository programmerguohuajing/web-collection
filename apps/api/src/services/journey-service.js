/**
 * @file PRD 01 用户链路（User Journey）
 *
 * 给定用户/设备/会话/trace 任一标识还原行为序列。
 * 存储模型实况：无独立 errors/logs 表——日志为 events(type='log')，
 * 错误明细入 events(type='error')；API 请求主要来自 events(type='perf',
 * metric in ('fetch','xhr'))，自带 session_id；后端 spans 经 trace_id 关联补充。
 */
import { all } from '../db.js'
import { mapEvent } from '../mappers/event-mapper.js'
import { parseJson } from '../utils/json.js'
import { badRequest } from '../utils/http-error.js'

const TIMELINE_LIMIT = 500

const SEARCH_FIELD = {
  user: 'user_id',
  device: 'device_id',
  session: 'session_id',
  trace: 'trace_id'
}

/**
 * 会话检索：按标识定位相关会话并给出摘要列表。
 * @param {{type?:string, value?:string, appId?:string, startTime?:number, endTime?:number, page?:number, pageSize?:number}} input
 */
export async function searchJourneySessions(input = {}) {
  const type = SEARCH_FIELD[input.type] ? input.type : 'session'
  const value = String(input.value || '').trim()
  if (!value) throw badRequest('标识值不能为空', 'MISSING_VALUE')
  const column = SEARCH_FIELD[type]
  const parts = [`e.${column} = ?`]
  const params = [value]
  if (input.appId) { parts.push('e.app_id = ?'); params.push(String(input.appId).slice(0, 64)) }
  const startTime = finite(input.startTime)
  const endTime = finite(input.endTime)
  if (startTime) { parts.push('e.ts >= ?'); params.push(startTime) }
  if (endTime) { parts.push('e.ts <= ?'); params.push(endTime) }
  const where = `where ${parts.join(' and ')}`
  const page = Math.max(1, Number(input.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(input.pageSize) || 30))
  const rows = await all(`
    select e.session_id,
      max(e.user_id) user_id, max(e.user_name) user_name, max(e.device_id) device_id,
      min(e.ts) started_at, max(e.ts) last_at,
      count(*)::integer event_count,
      count(*) filter (where e.type = 'error')::integer error_count,
      max(e.app_id) app_id, max(e.sdk_version) sdk_version,
      max(e.device) device, max(e.browser) browser
    from events e
    ${where} and coalesce(e.session_id, '') <> ''
    group by e.session_id
    order by last_at desc
    limit ? offset ?`, [...params, pageSize, (page - 1) * pageSize])
  const totalRows = await all(`
    select count(*)::integer count from (
      select 1 from events e ${where} and coalesce(e.session_id, '') <> '' group by e.session_id
    ) sessions`, params)
  const replayIds = await all(`select distinct base_session_id from replay_events where base_session_id is not null`)
  const replaySet = new Set(replayIds.map(row => row.base_session_id))
  return {
    total: Number(totalRows[0]?.count || 0),
    sessions: rows.map(row => ({
      sessionId: row.session_id,
      userId: row.user_id || '',
      userName: row.user_name || '',
      anonymousId: row.device_id || '',
      eventCount: Number(row.event_count || 0),
      errorCount: Number(row.error_count || 0),
      startedAt: Number(row.started_at),
      lastAt: Number(row.last_at),
      appId: row.app_id || '',
      sdkVersion: row.sdk_version || '',
      device: row.device || '',
      browser: row.browser || '',
      hasReplay: replaySet.has(row.session_id)
    }))
  }
}

/**
 * 会话时间线：events 六类 + spans（经 trace_id 关联）合并升序。
 * @param {string} sessionId
 * @param {{appId?:string, startTime?:number, endTime?:number, limit?:number}} input
 */
export async function getJourneyTimeline(sessionId, input = {}) {
  const id = String(sessionId || '').trim()
  if (!id) throw badRequest('会话 ID 不能为空', 'MISSING_SESSION_ID')
  const parts = ["coalesce(session_id, '') <> ''", '(session_id = ? or session_id = ?)']
  // 回放分段会产生派生 session_id，一并纳入同一链路视图
  const segments = await all(`select session_id from replay_events where base_session_id = ?`, [id])
  const sessionIds = [id, ...segments.map(row => row.session_id).filter(Boolean)].slice(0, 20)
  parts.length = 1
  parts.push(`session_id in (${sessionIds.map(() => '?').join(',')})`)
  const params = [...sessionIds]
  if (input.appId) { parts.push('app_id = ?'); params.push(String(input.appId).slice(0, 64)) }
  const startTime = finite(input.startTime)
  const endTime = finite(input.endTime)
  if (startTime) { parts.push('ts >= ?'); params.push(startTime) }
  if (endTime) { parts.push('ts <= ?'); params.push(endTime) }

  const limit = Math.min(TIMELINE_LIMIT, Math.max(50, Number(input.limit) || TIMELINE_LIMIT))
  const [eventRows, summaryRows] = await Promise.all([
    all(`select * from events where ${parts.join(' and ')} order by ts asc limit ?`, [...params, limit + 1]),
    all(`select min(ts) started_at, max(ts) last_at,
        count(*)::integer event_count, count(*) filter (where type='error')::integer error_count,
        max(user_id) user_id, max(user_name) user_name, max(device_id) device_id,
        max(app_id) app_id, max(sdk_version) sdk_version, max(release_name) release_name,
        max(device) device, max(os) os, max(browser) browser, max(user_agent) user_agent
      from events where ${parts.join(' and ')}`, params)
  ])
  const truncated = eventRows.length > limit
  if (truncated) eventRows.length = limit

  // spans 关联：取该会话事件携带的 trace_id 集合反查（spans 表无 session_id）
  const traceIds = [...new Set(eventRows.map(row => row.trace_id).filter(Boolean))].slice(0, 20)
  let spanRows = []
  if (traceIds.length) {
    spanRows = await all(
      `select id, trace_id, operation_name, kind, start_ts, duration, status_code, service_name
       from spans where trace_id in (${traceIds.map(() => '?').join(',')})
       order by start_ts asc limit ?`, [...traceIds, limit])
  }

  const events = [
    ...eventRows.map(row => timelineEvent(mapEvent(row), parseJson(row.props_json), parseJson(row.context_json))),
    ...spanRows.map(spanRow)
  ].sort((a, b) => a.ts - b.ts)

  return {
    session: sessionSummary(summaryRows[0], sessionIds),
    events,
    truncated
  }
}

function timelineEvent(event, props, context) {
  const category = categorize(event)
  return {
    id: `evt-${event.id}`,
    ts: Number(event.ts),
    category,
    name: displayName(event, category),
    summary: summarize(event, category),
    level: event.type === 'error' ? 'error' : levelOf(props),
    batchId: event.batchId || null,
    source: 'event',
    detail: {
      ...pickDetail(event),
      props,
      context
    },
    refs: {
      errorId: event.type === 'error' ? (event.name || event.id) : null,
      traceId: event.traceId || null,
      replayAvailable: false
    }
  }
}

function spanRow(row) {
  const status = String(row.status_code || '').toUpperCase()
  const failed = status === 'ERROR' || (Number.isFinite(Number(row.status_code)) && Number(row.status_code) >= 400)
  return {
    id: `span-${row.id}`,
    ts: Number(row.start_ts),
    category: 'api',
    name: row.operation_name || 'span',
    summary: `${row.service_name || 'backend'} · ${row.duration ?? 0}ms`,
    level: failed ? 'error' : 'info',
    batchId: null,
    source: 'span',
    detail: {
      traceId: row.trace_id,
      kind: row.kind,
      service: row.service_name,
      duration: Number(row.duration || 0),
      statusCode: row.status_code || ''
    },
    refs: { traceId: row.trace_id, replayAvailable: false }
  }
}

/** 六类映射：pv / behavior / error / api / log / perf */
function categorize(event) {
  if (event.type === 'behavior') return event.name === 'pv' ? 'pv' : 'behavior'
  if (event.type === 'track') return 'behavior'
  if (event.type === 'error') return 'error'
  if (event.type === 'log') return 'log'
  if (event.type === 'perf') return ['fetch', 'xhr'].includes(event.metric) ? 'api' : 'perf'
  return 'behavior'
}

function displayName(event, category) {
  if (category === 'api') return `${String(event.props?.method || 'GET').toUpperCase()} ${shortUrl(event.props?.url || event.url)}`
  if (category === 'pv') return '页面浏览'
  if (category === 'error') return event.name || 'JS 错误'
  return event.name || event.metric || event.type
}

function summarize(event, category) {
  if (category === 'pv') return `${event.path || event.url || '/'}${event.title ? ` · ${event.title}` : ''}`
  if (category === 'behavior') {
    if (event.name === 'page_leave') return `停留 ${Math.round(Number(event.props?.stayTime || 0) / 1000)}s`
    const label = event.props?.elementLabel || event.props?.text || ''
    return label ? String(label).slice(0, 80) : event.path || ''
  }
  if (category === 'error') return `${event.message || ''}`.slice(0, 60)
  if (category === 'api') {
    const status = Number(event.props?.status)
    const cost = Number(event.props?.duration ?? event.value ?? 0)
    const bits = []
    if (Number.isFinite(status) && status > 0) bits.push(`${status}`)
    if (cost > 0) bits.push(`耗时 ${Math.round(cost)}ms`)
    return bits.join(' · ')
  }
  if (category === 'log') return `${event.message || ''}`.slice(0, 60)
  if (category === 'perf') return `${event.metric || ''} ${formatMetricValue(event)}`.trim()
  return ''
}

function formatMetricValue(event) {
  const value = Number(event.value)
  if (!Number.isFinite(value)) return ''
  return event.metric === 'cls' ? value.toFixed(3) : `${Math.round(value)}ms`
}

function pickDetail(event) {
  return {
    id: event.id,
    type: event.type,
    appId: event.appId,
    release: event.release,
    sdkVersion: event.sdkVersion,
    environment: event.environment,
    sessionId: event.sessionId,
    deviceId: event.deviceId,
    userId: event.userId,
    url: event.url,
    path: event.path,
    referrer: event.referrer,
    browser: event.browser,
    os: event.os,
    device: event.device,
    ip: event.ip,
    ipRegion: event.ipRegion,
    metric: event.metric,
    value: event.value,
    message: event.message,
    stack: event.stack,
    traceId: event.traceId,
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt
  }
}

function levelOf(props) {
  const status = Number(props?.status)
  if (Number.isFinite(status) && status >= 400) return 'warn'
  return 'info'
}

function shortUrl(url) {
  try {
    const parsed = new URL(String(url))
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return String(url || '').slice(0, 120)
  }
}

function sessionSummary(row, sessionIds) {
  if (!row) return null
  const startedAt = Number(row.started_at || 0)
  const lastAt = Number(row.last_at || 0)
  const identityChain = []
  if (row.device_id) identityChain.push(`${row.device_id}(匿名)`)
  if (row.user_name) identityChain.push(`${row.user_name}(登录)`)
  else if (row.user_id) identityChain.push(`${row.user_id}(登录)`)
  return {
    sessionId: sessionIds[0],
    relatedSessionIds: sessionIds.slice(1),
    identityChain,
    startedAt,
    lastAt,
    durationMs: Math.max(0, lastAt - startedAt),
    eventCount: Number(row.event_count || 0),
    errorCount: Number(row.error_count || 0),
    appId: row.app_id || '',
    sdkVersion: row.sdk_version || '',
    release: row.release_name || '',
    device: row.device || '',
    os: row.os || '',
    browser: row.browser || '',
    userAgent: row.user_agent || ''
  }
}

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}
