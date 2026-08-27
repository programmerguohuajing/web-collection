/**
 * @file PRD 06 页面参与度（Page Engagement）
 *
 * 数据源：events 中 behavior/page_leave 事件的 context 参与度字段
 * （dwell_ms / scroll_max / scroll_buckets / tab_hidden_ms，PRD FR-1）。
 * 旧 SDK 只有 props.stayTime：计入停留兜底但不参与滚动/触达指标（"无数据"语义）。
 * 分享事件：behavior/track 且 name 含 share 的会话计数。
 */
import { all } from '../db.js'
import { parseJson } from '../utils/json.js'

const DWELL_CAP_MS = 2 * 3600000 // 单页超长停留截断 2h
const MIN_SAMPLE = 30

/**
 * 页面参与度报表。
 * @param {{appId?:string, startTime?:number, endTime?:number, q?:string, page?:number, pageSize?:number}} input
 */
export async function listEngagement(input = {}) {
  const start = finiteOr(input.startTime, Date.now() - 7 * 86400000)
  const end = finiteOr(input.endTime, Date.now())
  const rows = await fetchLeaveRows({ appId: input.appId, start, end })
  const pvRows = await all(`
    select coalesce(nullif(path, ''), '/') path,
      count(*)::integer pv,
      count(distinct coalesce(nullif(user_id, ''), nullif(device_id, ''), session_id))::integer uv
    from events
    where type = 'behavior' and name = 'pv' and ts >= ? and ts <= ? ${input.appId ? 'and app_id = ?' : ''}
    group by path`, input.appId ? [start, end, String(input.appId).slice(0, 64)] : [start, end])
  const pvMap = new Map(pvRows.map(row => [row.path, { pv: Number(row.pv), uv: Number(row.uv) }]))

  const grouped = groupBy(rows.filter(row => row.path), row => row.path)
  let items = Object.entries(grouped).map(([path, leaves]) => {
    const metrics = aggregateEngagement(leaves)
    const traffic = pvMap.get(path) || { pv: leaves.length, uv: metrics.sessions }
    return {
      path,
      pv: traffic.pv,
      uv: traffic.uv,
      avgDwellMs: metrics.avgDwellMs,
      p90DwellMs: metrics.p90DwellMs,
      avgScroll: metrics.avgScroll,
      reach75Rate: metrics.reach75Rate,
      bounceRate: metrics.bounceRate,
      shareSessionRate: metrics.shareSessionRate,
      sampleSize: metrics.sampleSize
    }
  })
  if (input.q) items = items.filter(item => item.path.includes(String(input.q).slice(0, 120)))
  items.sort((a, b) => b.pv - a.pv)
  const page = Math.max(1, Number(input.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(input.pageSize) || 20))
  return {
    total: items.length,
    items: items.slice((page - 1) * pageSize, page * pageSize).map(item => ({
      ...item,
      sampleNote: item.sampleSize < MIN_SAMPLE ? '样本量不足，仅供参考' : ''
    }))
  }
}

/** 单页详情：停留分布直方图 + 滚动深度漏斗 + 可选两时间段对比 */
export async function getEngagementDetail(input = {}) {
  const path = String(input.path || '').slice(0, 512)
  if (!path) throw new Error('path 不能为空')
  const start = finiteOr(input.startTime, Date.now() - 7 * 86400000)
  const end = finiteOr(input.endDate ?? input.endTime, Date.now())
  const rows = (await fetchLeaveRows({ appId: input.appId, start, end })).filter(row => (row.path || '/') === path)

  const dwellValues = validDwells(rows).map(Number)
  const distribution = [
    { label: '0-3s', min: 0, max: 3000 },
    { label: '3-10s', min: 3000, max: 10000 },
    { label: '10-30s', min: 10000, max: 30000 },
    { label: '30s-2m', min: 30000, max: 120000 },
    { label: '2m+', min: 120000, max: Infinity }
  ].map(({ label, min, max }) => ({
    label,
    count: dwellValues.filter(value => value >= min && value < max).length
  }))
  const total = dwellValues.length || 1
  for (const bucket of distribution) bucket.rate = Number((bucket.count / total).toFixed(4))

  const scrolls = rows.map(row => engagementOf(row).scrollMax).filter(value => value != null)
  const scrollFunnel = [0.25, 0.5, 0.75, 1].map(threshold => ({
    threshold,
    rate: scrolls.length ? Number((scrolls.filter(value => value >= threshold).length / scrolls.length).toFixed(4)) : null
  }))

  let compare = null
  if (input.compareStart && input.compareEnd) {
    const before = (await fetchLeaveRows({ appId: input.appId, start: finiteOr(input.compareStart, start - 7 * 86400000), end: finiteOr(input.compareEnd, start) }))
      .filter(row => (row.path || '/') === path)
    compare = {
      a: summarizeMetrics(before),
      b: summarizeMetrics(rows)
    }
  }

  return {
    path,
    sampleSize: rows.length,
    sufficientSample: rows.length >= MIN_SAMPLE,
    distribution,
    scrollFunnel,
    summary: summarizeMetrics(rows),
    compare
  }
}

async function fetchLeaveRows({ appId, start, end }) {
  const params = ['page_leave', start, end]
  let appClause = ''
  if (appId) { appClause = ' and app_id = ?'; params.push(String(appId).slice(0, 64)) }
  try {
    return await all(`
      select id, session_id, path, url, user_id, device_id, ts, props_json, context_json
      from events
      where type = 'behavior' and name = ? and ts >= ? and ts <= ?${appClause}
      order by ts desc limit 20000`, params)
  } catch {
    return []
  }
}

function aggregateEngagement(leaves) {
  const sessions = new Set(leaves.map(row => row.session_id || row.id))
  const dwells = validDwells(leaves)
  const scrolls = leaves.map(row => engagementOf(row).scrollMax).filter(value => value != null)
  const reach75 = scrolls.length ? scrolls.filter(value => value >= 0.75).length : 0
  const bounceCount = leaves.filter(row => {
    const engagement = engagementOf(row)
    const dwell = engagement.dwellMs ?? toNumber(engagement.stayTime)
    return dwell != null && dwell < 3000 && !engagement.interacted
  }).length
  const shareSessions = leaves.filter(row => engagementOf(row).shared).length
  const avg = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
  return {
    sessions: sessions.size,
    sampleSize: dwells.length,
    avgDwellMs: dwells.length ? Math.round(avg(dwells)) : null,
    p90DwellMs: percentile(dwells, 0.9),
    avgScroll: scrolls.length ? Number(avg(scrolls).toFixed(3)) : null,
    reach75Rate: scrolls.length ? Number((reach75 / scrolls.length).toFixed(4)) : null,
    bounceRate: leaves.length ? Number((bounceCount / leaves.length).toFixed(4)) : null,
    shareSessionRate: sessions.size ? Number((shareSessions / sessions.size).toFixed(4)) : null
  }
}

function summarizeMetrics(leaves) {
  const metrics = aggregateEngagement(leaves)
  return {
    avgDwellMs: metrics.avgDwellMs,
    p90DwellMs: metrics.p90DwellMs,
    avgScroll: metrics.avgScroll,
    reach75Rate: metrics.reach75Rate,
    bounceRate: metrics.bounceRate,
    sampleSize: metrics.sampleSize
  }
}

function validDwells(rows) {
  return rows.map(row => engagementOf(row).dwellMs)
    .filter(value => value != null && value > 0 && value < DWELL_CAP_MS)
    .map(Number)
}

/** 从行中提取参与度字段：新 SDK 在 context；stayTime 兜底自 props */
function engagementOf(row) {
  const context = parseJson(row.context_json) || {}
  const props = parseJson(row.props_json) || {}
  return {
    dwellMs: toNumber(context.dwell_ms ?? context.dwellMs ?? (props.stayTime != null ? Number(props.stayTime) : null)),
    scrollMax: clamp01(toNumber(context.scroll_max ?? context.scrollMax)),
    scrollBuckets: context.scroll_buckets || context.scrollBuckets || null,
    tabHiddenMs: toNumber(context.tab_hidden_ms ?? context.tabHiddenMs),
    interacted: Boolean(context.interacted ?? props.interacted),
    shared: Boolean(context.shared ?? props.shared)
  }
}

function toNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function clamp01(value) {
  if (value == null) return null
  return Math.max(0, Math.min(1, value))
}

function percentile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return Math.round(sorted[index])
}

function groupBy(items, keyOf) {
  return items.reduce((groups, item) => ((groups[keyOf(item)] ||= []).push(item), groups), {})
}

function finiteOr(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}
