import { all, run } from '../db.js'
import { mapEvent } from '../mappers/event-mapper.js'

export async function listLogs(filters = {}) {
  const { where, params } = whereFor({ ...filters, type: 'log' })
  const page = pageOf(filters)
  const [rows, totalRows] = await Promise.all([
    all(`select * from events ${where} order by ts desc limit ? offset ?`, [...params, page.pageSize, (page.page - 1) * page.pageSize]),
    all(`select count(*)::integer count from events ${where}`, params)
  ])
  return { ...page, total: Number(totalRows[0]?.count || 0), items: rows.map(mapEvent) }
}

export async function listTraces(filters = {}) {
  const { where, params } = whereFor(filters, ['trace_id is not null'])
  const rows = await all(`select trace_id, min(ts) started_at, max(ts) ended_at, count(*)::integer span_count,
    max(case when type='error' or coalesce((props_json->>'status')::integer, 0) >= 400 then 1 else 0 end)::integer error_count,
    max(app_id) app_id, max(release_name) release_name, max(url) url
    from events ${where} group by trace_id order by started_at desc limit 200`, params)
  return rows.map(row => ({ ...row, started_at: Number(row.started_at), ended_at: Number(row.ended_at), duration: Number(row.ended_at) - Number(row.started_at) }))
}

export async function getTrace(traceId) {
  return (await all('select * from events where trace_id=? order by ts asc', [traceId])).map(mapEvent)
}

export async function getSessions(filters = {}) {
  const { where, params } = whereFor(filters, ['session_id is not null'])
  const rows = await all(`select session_id, max(user_id) user_id, max(user_name) user_name, max(device_id) device_id,
    min(ts) started_at, max(ts) ended_at, count(*)::integer event_count,
    count(*) filter(where type='error')::integer error_count,
    array_agg(distinct path) filter(where path is not null) paths
    from events ${where} group by session_id order by ended_at desc limit 200`, params)
  const replays = await all('select distinct session_id from replay_events order by session_id')
  return rows.map(row => ({ ...row, started_at: Number(row.started_at), ended_at: Number(row.ended_at), duration: Number(row.ended_at) - Number(row.started_at), replaySessionId: replays.find(item => item.session_id.startsWith(row.session_id))?.session_id }))
}

export async function getSessionEvents(sessionId) {
  return (await all('select * from events where session_id=? order by ts asc limit 2000', [sessionId])).map(mapEvent)
}

export async function getPaths(filters = {}) {
  const { where, params } = whereFor(filters, ["type='behavior'", "name in ('pv','pushState','replaceState','popstate','hashchange')"])
  const rows = await all(`select session_id, path, ts from events ${where} order by session_id, ts limit 20000`, params)
  const counts = new Map()
  for (const events of Object.values(groupBy(rows, row => row.session_id || ''))) {
    const path = events.map(item => item.path).filter((value, index, list) => value && value !== list[index - 1]).slice(0, 8).join(' → ')
    if (path) counts.set(path, (counts.get(path) || 0) + 1)
  }
  return [...counts].map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count).slice(0, 50)
}

export async function getLive(filters = {}) {
  const since = Date.now() - 5 * 60000
  const { where, params } = whereFor({ ...filters, startTime: Math.max(Number(filters.startTime || 0), since) })
  const rows = await all(`select count(distinct session_id)::integer sessions, count(distinct coalesce(nullif(user_id,''), device_id))::integer users,
    count(*)::integer events from events ${where}`, params)
  return { since, ...(rows[0] || { sessions: 0, users: 0, events: 0 }) }
}

export async function getReleaseComparison(filters = {}) {
  const { where, params } = whereFor(filters)
  return all(`select release_name release, count(*)::integer events,
    count(*) filter(where type='error')::integer errors,
    count(distinct coalesce(nullif(user_id,''), device_id))::integer users,
    round(avg(value) filter(where type='perf' and metric='lcp')::numeric, 2) lcp
    from events ${where} group by release_name order by max(ts) desc limit 20`, params)
}

export async function listFunnels() { return all('select * from funnel_definitions order by updated_at desc') }

export async function listFunnelEventNames(filters = {}) {
  const { where, params } = whereFor(filters, ["type in ('behavior','track')", "name is not null", "name<>''"])
  return all(`select name, count(*)::integer count from events ${where} group by name order by count desc, name limit 100`, params)
}

export async function saveFunnel(input) {
  const name = String(input.name || '').trim().slice(0, 128)
  const steps = Array.isArray(input.steps) ? input.steps.map(String).map(item => item.trim().slice(0, 160)).filter(Boolean).slice(0, 10) : []
  if (!name || steps.length < 2) throw new Error('漏斗名称和至少两个步骤不能为空')
  const now = Date.now()
  if (input.id) {
    await run('update funnel_definitions set name=?, app_id=?, steps_json=?::jsonb, updated_at=? where id=?', [name, input.appId || null, JSON.stringify(steps), now, input.id])
    return { id: Number(input.id) }
  }
  const rows = await all('insert into funnel_definitions (name, app_id, steps_json, created_at, updated_at) values (?, ?, ?::jsonb, ?, ?) returning id', [name, input.appId || null, JSON.stringify(steps), now, now])
  return { id: Number(rows[0].id) }
}

export async function deleteFunnel(id) {
  await run('delete from funnel_definitions where id=?', [id])
  return { ok: true }
}

export async function runFunnel(id, filters = {}) {
  const defs = await all('select * from funnel_definitions where id=?', [id])
  const def = defs[0]
  if (!def) throw new Error('漏斗不存在')
  const steps = def.steps_json
  const { where, params } = whereFor({ ...filters, appId: filters.appId || def.app_id })
  const rows = await all(`select session_id, coalesce(nullif(user_id,''), device_id, session_id) actor, name, type, ts, release_name, browser, device
    from events ${where} ${where ? 'and' : 'where'} (name = any(?::text[]) or type='error') order by ts limit 50000`, [...params, steps])
  const replayRows = await all('select distinct session_id from replay_events')
  return { definition: def, ...computeFunnel(rows, steps, replayRows) }
}

export function computeFunnel(rows, steps, replayRows = []) {
  const actors = Object.values(groupBy(rows, row => row.actor))
  const counts = steps.map((_, target) => actors.filter(events => reaches(events, steps, target)).length)
  return {
    steps: steps.map((step, index) => ({ step, count: counts[index], rate: counts[0] ? Number((counts[index] / counts[0] * 100).toFixed(2)) : 0, lost: index ? counts[index - 1] - counts[index] : 0 })),
    lostSessions: actors.filter(events => reaches(events, steps, 0) && !reaches(events, steps, steps.length - 1)).slice(0, 100).map(events => ({ sessionId: events[0].session_id, actor: events[0].actor, lastEvent: events.filter(item => item.type !== 'error').at(-1)?.name, errors: events.filter(item => item.type === 'error').length, ts: Number(events.at(-1).ts), replaySessionId: replayRows.find(row => row.session_id.startsWith(events[0].session_id))?.session_id })),
    dimensions: ['release_name', 'browser', 'device'].map(field => ({ field, items: dimensionFunnels(rows, steps, field) })),
    trend: funnelTrend(rows, steps)
  }
}

export async function listDashboards() { return all('select * from dashboard_definitions order by updated_at desc') }
export async function saveDashboard(input) {
  const name = String(input.name || '').trim().slice(0, 128)
  if (!name) throw new Error('仪表盘名称不能为空')
  const widgets = Array.isArray(input.widgets) ? input.widgets.map(String).slice(0, 12) : []
  const now = Date.now()
  if (input.id) {
    await run('update dashboard_definitions set name=?, widgets_json=?::jsonb, updated_at=? where id=?', [name, JSON.stringify(widgets), now, input.id])
    return { id: Number(input.id) }
  }
  const rows = await all('insert into dashboard_definitions (name, widgets_json, created_at, updated_at) values (?, ?::jsonb, ?, ?) returning id', [name, JSON.stringify(widgets), now, now])
  return { id: Number(rows[0].id) }
}

function reaches(events, steps, target) {
  let cursor = 0
  for (const event of events) if (event.name === steps[cursor] && cursor++ === target) return true
  return false
}

function dimensionFunnels(rows, steps, field) {
  return Object.entries(groupBy(rows, row => row[field] || '未知')).map(([name, items]) => ({ name, entered: new Set(items.filter(row => row.name === steps[0]).map(row => row.actor)).size, converted: new Set(items.filter(row => row.name === steps.at(-1)).map(row => row.actor)).size }))
}

function funnelTrend(rows, steps) {
  return Object.entries(groupBy(rows, row => new Date(Number(row.ts)).toISOString().slice(0, 10))).map(([date, items]) => ({ date, entered: new Set(items.filter(row => row.name === steps[0]).map(row => row.actor)).size, converted: new Set(items.filter(row => row.name === steps.at(-1)).map(row => row.actor)).size }))
}

function groupBy(items, keyOf) {
  return items.reduce((groups, item) => ((groups[keyOf(item)] ||= []).push(item), groups), {})
}

function pageOf(filters) { return { page: Math.max(1, Number(filters.page || 1)), pageSize: Math.max(1, Math.min(100, Number(filters.pageSize || 20))) } }

function whereFor(filters = {}, fixed = []) {
  const parts = [...fixed]
  const params = []
  for (const [field, value] of [['app_id', filters.appId], ['release_name', filters.release], ['type', filters.type], ['name', filters.name], ['user_id', filters.userId], ['session_id', filters.sessionId]]) if (value) { parts.push(`${field}=?`); params.push(value) }
  if (filters.startTime) { parts.push('ts>=?'); params.push(Number(filters.startTime)) }
  if (filters.endTime) { parts.push('ts<=?'); params.push(Number(filters.endTime)) }
  if (filters.keyword) { parts.push('(name ilike ? or message ilike ? or props_json::text ilike ? or trace_id ilike ?)'); params.push(...Array(4).fill(`%${filters.keyword}%`)) }
  return { where: parts.length ? `where ${parts.join(' and ')}` : '', params }
}
