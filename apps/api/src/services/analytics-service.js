import { all, run } from '../db.js'
import { mapEvent } from '../mappers/event-mapper.js'

const analyticsFields = {
  release: 'release_name',
  path: 'path',
  browser: 'browser',
  device: 'device'
}
const filterOperators = new Set(['eq', 'in', 'exists'])

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
  const { where, params } = whereFor(filters, ["trace_id<>''"])
  const page = pageOf(filters)
  const [rows, totalRows] = await Promise.all([
    all(`select trace_id, min(ts) started_at, max(ts) ended_at, count(*)::integer span_count,
      max(case when type='error' or coalesce((props_json->>'status')::integer, 0) >= 400 then 1 else 0 end)::integer error_count,
      max(app_id) app_id, max(release_name) release_name, max(url) url
      from events ${where} group by trace_id order by started_at desc limit ? offset ?`, [...params, page.pageSize, (page.page - 1) * page.pageSize]),
    all(`select count(*)::integer count from (select 1 from events ${where} group by trace_id) traces`, params)
  ])
  return { ...page, total: Number(totalRows[0]?.count || 0), items: rows.map(row => ({ ...row, started_at: Number(row.started_at), ended_at: Number(row.ended_at), duration: Number(row.ended_at) - Number(row.started_at) })) }
}

export async function getTrace(traceId, filters = {}) {
  const page = pageOf(filters)
  if (!traceId?.trim()) return { ...page, total: 0, items: [] }
  const [rows, totalRows] = await Promise.all([
    all('select * from events where trace_id=? order by ts asc limit ? offset ?', [traceId, page.pageSize, (page.page - 1) * page.pageSize]),
    all('select count(*)::integer count from events where trace_id=?', [traceId])
  ])
  return { ...page, total: Number(totalRows[0]?.count || 0), items: rows.map(mapEvent) }
}

export async function getSessions(filters = {}) {
  const { where, params } = whereFor(filters, ["session_id<>''"])
  const page = pageOf(filters)
  const [rows, totalRows] = await Promise.all([
    all(`select session_id, max(user_id) user_id, max(user_name) user_name, max(device_id) device_id,
      min(ts) started_at, max(ts) ended_at, count(*)::integer event_count,
      count(*) filter(where type='error')::integer error_count,
      array_agg(distinct path) filter(where path is not null) paths
      from events ${where} group by session_id order by ended_at desc limit ? offset ?`, [...params, page.pageSize, (page.page - 1) * page.pageSize]),
    all(`select count(*)::integer count from (select 1 from events ${where} group by session_id) sessions`, params)
  ])
  const replays = await all('select distinct session_id from replay_events order by session_id')
  return { ...page, total: Number(totalRows[0]?.count || 0), items: rows.map(row => ({ ...row, started_at: Number(row.started_at), ended_at: Number(row.ended_at), duration: Number(row.ended_at) - Number(row.started_at), replaySessionId: replays.find(item => item.session_id.startsWith(row.session_id))?.session_id })) }
}

export async function getSessionEvents(sessionId, filters = {}) {
  const page = pageOf(filters)
  if (!sessionId?.trim()) return { ...page, total: 0, items: [] }
  const [rows, totalRows] = await Promise.all([
    all('select * from events where session_id=? order by ts asc limit ? offset ?', [sessionId, page.pageSize, (page.page - 1) * page.pageSize]),
    all('select count(*)::integer count from events where session_id=?', [sessionId])
  ])
  return { ...page, total: Number(totalRows[0]?.count || 0), items: rows.map(mapEvent) }
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

export async function listEventProperties(filters = {}) {
  const eventName = cleanText(filters.eventName || filters.name, 160)
  if (!eventName) throw new Error('事件名称不能为空')
  const { where, params } = whereFor({ ...filters, name: eventName }, ["type in ('behavior','track')"])
  return all(`select key name, count(*)::integer count
    from events cross join lateral jsonb_object_keys(coalesce(props_json, '{}'::jsonb)) key
    ${where} group by key order by count desc, key limit 100`, params)
}

export async function queryEventInsight(input = {}) {
  const definition = normalizeInsightQuery(input)
  const { parts, params } = analyticsWhere(definition)
  const bucket = bucketSql(definition.interval)
  const series = dimensionSql(definition.breakdown)
  const measure = definition.measure === 'users'
    ? "count(distinct coalesce(nullif(user_id,''),nullif(device_id,'')))"
    : definition.measure === 'sessions'
      ? "count(distinct nullif(session_id,''))"
      : 'count(*)'
  const rows = await all(`select ${bucket} bucket, ${series} series, ${measure}::integer value
    from events where ${parts.join(' and ')}
    group by bucket, series order by bucket asc, value desc limit 2000`, params)
  const topSeries = [...rows.reduce((totals, row) => totals.set(row.series, (totals.get(row.series) || 0) + Number(row.value)), new Map())]
    .sort((a, b) => b[1] - a[1]).slice(0, 10).map(item => item[0])
  const table = rows.filter(row => topSeries.includes(row.series)).map(row => ({ bucket: Number(row.bucket), series: row.series, value: Number(row.value) }))
  return {
    definition,
    table,
    series: topSeries.map(name => ({ name, points: table.filter(row => row.series === name).map(({ bucket, value }) => ({ bucket, value })) }))
  }
}

export async function queryPaths(input = {}) {
  const definition = normalizePathQuery(input)
  const { where, params } = whereFor(definition, ["type='behavior'", "name in ('pv','pushState','replaceState','popstate','hashchange')", "session_id<>''"])
  const rows = await all(`select session_id,user_id,device_id,path,ts from events ${where} order by session_id,ts limit 50000`, params)
  return { definition, ...computePaths(rows, definition) }
}

export async function listInsights() {
  return (await all('select * from analytics_insights order by updated_at desc')).map(publicInsight)
}

export async function saveInsight(input = {}, id = null) {
  const name = cleanText(input.name, 128)
  const kind = input.kind === 'path' ? 'path' : input.kind === 'eventTrend' ? 'eventTrend' : ''
  if (!name || !kind) throw new Error('分析名称和类型不能为空')
  const definition = kind === 'path' ? normalizePathQuery(input.definition) : normalizeInsightQuery(input.definition)
  const now = Date.now()
  if (id) {
    const rows = await all('update analytics_insights set name=?,kind=?,definition_json=?::jsonb,updated_at=? where id=? returning id', [name, kind, JSON.stringify(definition), now, id])
    if (!rows.length) throw new Error('分析不存在')
    return { id: Number(id) }
  }
  const rows = await all('insert into analytics_insights(name,kind,definition_json,created_at,updated_at) values(?,?,?::jsonb,?,?) returning id', [name, kind, JSON.stringify(definition), now, now])
  return { id: Number(rows[0].id) }
}

export async function deleteInsight(id) {
  const dashboards = await all('select id,widgets_json from dashboard_definitions')
  for (const dashboard of dashboards) {
    const widgets = normalizeDashboardWidgets(dashboard.widgets_json).filter(item => !(typeof item === 'object' && item.type === 'insight' && item.id === Number(id)))
    if (widgets.length !== normalizeDashboardWidgets(dashboard.widgets_json).length) {
      await run('update dashboard_definitions set widgets_json=?::jsonb,updated_at=? where id=?', [JSON.stringify(widgets), Date.now(), dashboard.id])
    }
  }
  await run('delete from analytics_insights where id=?', [id])
  return { ok: true }
}

export async function listFunnels(filters = {}) {
  const page = pageOf(filters)
  const [items, totalRows] = await Promise.all([
    all('select * from funnel_definitions order by updated_at desc limit ? offset ?', [page.pageSize, (page.page - 1) * page.pageSize]),
    all('select count(*)::integer count from funnel_definitions')
  ])
  return { ...page, total: Number(totalRows[0]?.count || 0), items }
}

export async function listFunnelEventNames(filters = {}) {
  const { where, params } = whereFor(filters, ["type in ('behavior','track')", "name is not null", "name<>''"])
  return all(`select name, count(*)::integer count from events ${where} group by name order by count desc, name limit 100`, params)
}

export async function saveFunnel(input) {
  const name = String(input.name || '').trim().slice(0, 128)
  const steps = normalizeFunnelSteps(input.steps)
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
  const steps = normalizeFunnelSteps(def.steps_json)
  const names = [...new Set(steps.map(step => step.eventName))]
  const { where, params } = whereFor({ ...filters, appId: filters.appId || def.app_id })
  const rows = await all(`select session_id, coalesce(nullif(user_id,''), nullif(device_id,'')) actor, name, type, ts, release_name, browser, device, props_json
    from events ${where} ${where ? 'and' : 'where'} session_id<>'' and (name = any(?::text[]) or type='error') order by session_id,ts limit 50000`, [...params, names])
  const replayRows = await all('select distinct session_id from replay_events')
  return { definition: def, ...computeFunnel(rows, steps, replayRows) }
}

export function computeFunnel(rows, steps, replayRows = []) {
  const normalizedSteps = normalizeFunnelSteps(steps)
  const sessions = Object.values(groupBy(rows, row => row.session_id || ''))
    .filter(events => events[0]?.session_id)
    .map(events => events.sort((a, b) => Number(a.ts) - Number(b.ts)))
  const reachedActors = normalizedSteps.map(() => new Set())
  for (const events of sessions) {
    normalizedSteps.forEach((_, target) => {
      if (reaches(events, normalizedSteps, target) && events[0].actor) reachedActors[target].add(events[0].actor)
    })
  }
  const counts = reachedActors.map(items => items.size)
  return {
    steps: normalizedSteps.map((step, index) => ({ step: step.eventName, filters: step.filters, count: counts[index], rate: counts[0] ? Number((counts[index] / counts[0] * 100).toFixed(2)) : 0, lost: index ? counts[index - 1] - counts[index] : 0 })),
    lostSessions: sessions.filter(events => reaches(events, normalizedSteps, 0) && !reaches(events, normalizedSteps, normalizedSteps.length - 1)).slice(0, 100).map(events => ({ sessionId: events[0].session_id, actor: events[0].actor, lastEvent: events.filter(item => item.type !== 'error').at(-1)?.name, errors: events.filter(item => item.type === 'error').length, ts: Number(events.at(-1).ts), replaySessionId: replayRows.find(row => row.session_id.startsWith(events[0].session_id))?.session_id })),
    dimensions: ['release_name', 'browser', 'device'].map(field => ({ field, items: dimensionFunnels(sessions, normalizedSteps, field) })),
    trend: funnelTrend(sessions, normalizedSteps)
  }
}

export async function listDashboards() { return all('select * from dashboard_definitions order by updated_at desc') }
export async function deleteDashboard(id) { await run('delete from dashboard_definitions where id=?', [id]); return { ok: true } }
export async function saveDashboard(input) {
  const name = String(input.name || '').trim().slice(0, 128)
  if (!name) throw new Error('仪表盘名称不能为空')
  const widgets = normalizeDashboardWidgets(input.widgets)
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
  for (const event of events) {
    if (matchesStep(event, steps[cursor]) && cursor++ === target) return true
  }
  return false
}

function dimensionFunnels(sessions, steps, field) {
  return Object.entries(groupBy(sessions, events => events[0]?.[field] || '未知')).map(([name, items]) => ({
    name,
    entered: new Set(items.filter(events => reaches(events, steps, 0)).map(events => events[0].actor).filter(Boolean)).size,
    converted: new Set(items.filter(events => reaches(events, steps, steps.length - 1)).map(events => events[0].actor).filter(Boolean)).size
  }))
}

function funnelTrend(sessions, steps) {
  return Object.entries(groupBy(sessions, events => new Date(Number(events[0]?.ts)).toISOString().slice(0, 10))).map(([date, items]) => ({
    date,
    entered: new Set(items.filter(events => reaches(events, steps, 0)).map(events => events[0].actor).filter(Boolean)).size,
    converted: new Set(items.filter(events => reaches(events, steps, steps.length - 1)).map(events => events[0].actor).filter(Boolean)).size
  }))
}

export function normalizeInsightQuery(input = {}) {
  const eventName = cleanText(input.eventName, 160)
  if (!eventName) throw new Error('事件名称不能为空')
  const startTime = finiteTime(input.startTime)
  const endTime = finiteTime(input.endTime)
  if (startTime && endTime && startTime > endTime) throw new Error('开始时间不能晚于结束时间')
  if (input.eventType && !['behavior', 'track'].includes(input.eventType)) throw new Error('事件类型无效')
  if (input.measure && !['events', 'users', 'sessions'].includes(input.measure)) throw new Error('分析指标无效')
  if (input.interval && !['hour', 'day', 'week'].includes(input.interval)) throw new Error('时间粒度无效')
  const interval = ['hour', 'day', 'week'].includes(input.interval) ? input.interval : autoInterval(startTime, endTime)
  return {
    eventName,
    eventType: ['behavior', 'track'].includes(input.eventType) ? input.eventType : '',
    appId: cleanText(input.appId, 64),
    release: cleanText(input.release, 64),
    startTime,
    endTime,
    measure: ['events', 'users', 'sessions'].includes(input.measure) ? input.measure : 'events',
    interval,
    breakdown: normalizeField(input.breakdown, true),
    filters: normalizeAnalyticsFilters(input.filters)
  }
}

export function normalizePathQuery(input = {}) {
  const startTime = finiteTime(input.startTime)
  const endTime = finiteTime(input.endTime)
  if (startTime && endTime && startTime > endTime) throw new Error('开始时间不能晚于结束时间')
  return {
    appId: cleanText(input.appId, 64),
    release: cleanText(input.release, 64),
    startTime,
    endTime,
    startPath: cleanText(input.startPath, 512),
    endPath: cleanText(input.endPath, 512),
    maxDepth: clampInt(input.maxDepth, 2, 8, 5),
    minUsers: clampInt(input.minUsers, 1, 100000, 1)
  }
}

export function normalizeFunnelSteps(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 10).map(item => {
    const source = typeof item === 'string' ? { eventName: item } : item || {}
    return { eventName: cleanText(source.eventName || source.name, 160), filters: normalizeAnalyticsFilters(source.filters) }
  }).filter(step => step.eventName)
}

export function computePaths(rows, definition = {}) {
  const config = normalizePathQuery(definition)
  const nodes = new Map()
  const edges = new Map()
  const dropoffs = new Map()
  for (const events of Object.values(groupBy(rows, row => row.session_id || '')).filter(items => items[0]?.session_id)) {
    let paths = events.sort((a, b) => Number(a.ts) - Number(b.ts)).map(item => item.path).filter((path, index, list) => path && path !== list[index - 1])
    if (config.startPath) {
      const start = paths.indexOf(config.startPath)
      if (start < 0) continue
      paths = paths.slice(start)
    }
    if (config.endPath) {
      const end = paths.indexOf(config.endPath)
      if (end < 0) continue
      paths = paths.slice(0, end + 1)
    }
    paths = paths.slice(0, config.maxDepth)
    if (!paths.length) continue
    const actor = events[0].user_id || events[0].device_id || ''
    paths.forEach((path, step) => {
      const id = `${step}:${path}`
      const node = nodes.get(id) || { id, name: id, label: path, step, actors: new Set(), sessions: new Set() }
      if (actor) node.actors.add(actor)
      node.sessions.add(events[0].session_id)
      nodes.set(id, node)
      if (step) {
        const source = `${step - 1}:${paths[step - 1]}`
        const edgeId = `${source}→${id}`
        const edge = edges.get(edgeId) || { source, target: id, actors: new Set(), sessions: new Set() }
        if (actor) edge.actors.add(actor)
        edge.sessions.add(events[0].session_id)
        edges.set(edgeId, edge)
      }
    })
    const last = paths.length - 1
    const drop = dropoffs.get(last) || { step: last, actors: new Set(), sessions: new Set() }
    if (actor) drop.actors.add(actor)
    drop.sessions.add(events[0].session_id)
    dropoffs.set(last, drop)
  }
  const resultNodes = [...nodes.values()]
    .map(item => ({ id: item.id, name: item.name, label: item.label, step: item.step, users: item.actors.size, sessions: item.sessions.size }))
    .filter(item => item.users >= config.minUsers)
  const nodeIds = new Set(resultNodes.map(item => item.id))
  const resultEdges = [...edges.values()]
    .map(item => ({ source: item.source, target: item.target, users: item.actors.size, sessions: item.sessions.size, value: item.actors.size }))
    .filter(item => item.users >= config.minUsers && nodeIds.has(item.source) && nodeIds.has(item.target))
  return {
    nodes: resultNodes,
    edges: resultEdges,
    dropoffs: [...dropoffs.values()].map(item => ({ step: item.step, users: item.actors.size, sessions: item.sessions.size })).sort((a, b) => a.step - b.step)
  }
}

function normalizeAnalyticsFilters(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 8).map(item => {
    const field = normalizeField(item?.field)
    if (item?.operator && !filterOperators.has(item.operator)) throw new Error('分析过滤操作符无效')
    const operator = filterOperators.has(item?.operator) ? item.operator : 'eq'
    if (!field) throw new Error('分析过滤字段无效')
    if (operator === 'in') {
      const values = Array.isArray(item.value) ? item.value.map(value => cleanText(value, 512)).filter(Boolean).slice(0, 50) : []
      if (!values.length) throw new Error('集合过滤值不能为空')
      return { field, operator, value: values }
    }
    if (operator === 'exists') return { field, operator }
    const filterValue = cleanText(item?.value, 512)
    if (!filterValue) throw new Error('过滤值不能为空')
    return { field, operator, value: filterValue }
  })
}

function analyticsWhere(definition) {
  const parts = ["type in ('behavior','track')", 'name=?']
  const params = [definition.eventName]
  if (definition.eventType) { parts.push('type=?'); params.push(definition.eventType) }
  for (const [column, value] of [['app_id', definition.appId], ['release_name', definition.release]]) if (value) { parts.push(`${column}=?`); params.push(value) }
  if (definition.startTime) { parts.push('ts>=?'); params.push(definition.startTime) }
  if (definition.endTime) { parts.push('ts<=?'); params.push(definition.endTime) }
  for (const filter of definition.filters) {
    const expression = fieldSql(filter.field)
    if (filter.operator === 'exists') parts.push(`${expression} is not null and ${expression}<>''`)
    else if (filter.operator === 'in') { parts.push(`${expression}=any(?::text[])`); params.push(filter.value) }
    else { parts.push(`${expression}=?`); params.push(filter.value) }
  }
  return { parts, params }
}

function matchesStep(event, step) {
  if (!step || event.name !== step.eventName) return false
  return step.filters.every(filter => {
    const value = filterValue(event, filter.field)
    if (filter.operator === 'exists') return value != null && value !== ''
    if (filter.operator === 'in') return filter.value.includes(String(value ?? ''))
    return String(value ?? '') === filter.value
  })
}

function filterValue(event, field) {
  if (field.startsWith('props.')) return (event.props_json || event.props || {})[field.slice(6)]
  return event[analyticsFields[field]]
}

function normalizeField(value, optional = false) {
  if (value == null || value === '') return optional ? '' : ''
  if (analyticsFields[value]) return value
  const match = String(value).match(/^props\.([A-Za-z0-9_.-]{1,80})$/)
  if (match) return `props.${match[1]}`
  if (optional) throw new Error('分析拆分维度无效')
  return ''
}

function fieldSql(field) {
  if (analyticsFields[field]) return analyticsFields[field]
  return `props_json->>'${field.slice(6).replaceAll("'", "''")}'`
}

function dimensionSql(field) {
  return field ? `coalesce(nullif(${fieldSql(field)},''),'未设置')` : "'全部'"
}

function bucketSql(interval) {
  const unit = interval === 'hour' ? 'hour' : interval === 'week' ? 'week' : 'day'
  return `extract(epoch from date_trunc('${unit}',to_timestamp(ts/1000.0)))*1000`
}

function autoInterval(startTime, endTime) {
  const duration = (endTime || Date.now()) - (startTime || Date.now() - 86400000)
  return duration <= 2 * 86400000 ? 'hour' : duration > 90 * 86400000 ? 'week' : 'day'
}

function normalizeDashboardWidgets(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 12).map(item => {
    if (typeof item === 'string') return cleanText(item, 64)
    const type = item?.type === 'funnel' ? 'funnel' : item?.type === 'insight' ? 'insight' : ''
    const id = Number(item?.id)
    return type && Number.isInteger(id) && id > 0 ? { type, id } : null
  }).filter(Boolean)
}

function publicInsight(row) {
  return {
    id: Number(row.id),
    name: row.name,
    kind: row.kind,
    definition: row.definition_json,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  }
}

function cleanText(value, max) {
  return String(value || '').trim().slice(0, max)
}

function finiteTime(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function clampInt(value, min, max, fallback) {
  const number = Math.round(Number(value))
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback
}

function groupBy(items, keyOf) {
  return items.reduce((groups, item) => ((groups[keyOf(item)] ||= []).push(item), groups), {})
}

function pageOf(filters) { return { page: Math.max(1, Number(filters.page || 1)), pageSize: Math.max(1, Math.min(100, Number(filters.pageSize || 20))) } }

export function whereFor(filters = {}, fixed = []) {
  const parts = [...fixed]
  const params = []
  for (const [field, value] of [['app_id', filters.appId], ['release_name', filters.release], ['type', filters.type], ['name', filters.name], ['user_id', filters.userId], ['session_id', filters.sessionId]]) if (value) { parts.push(`${field}=?`); params.push(value) }
  if (filters.traceId) { parts.push('trace_id ilike ?'); params.push(`%${filters.traceId}%`) }
  if (filters.path) { parts.push('(path ilike ? or url ilike ?)'); params.push(...Array(2).fill(`%${filters.path}%`)) }
  if (filters.startTime) { parts.push('ts>=?'); params.push(Number(filters.startTime)) }
  if (filters.endTime) { parts.push('ts<=?'); params.push(Number(filters.endTime)) }
  if (filters.keyword) { parts.push('(name ilike ? or message ilike ? or props_json::text ilike ? or trace_id ilike ?)'); params.push(...Array(4).fill(`%${filters.keyword}%`)) }
  return { where: parts.length ? `where ${parts.join(' and ')}` : '', params }
}
