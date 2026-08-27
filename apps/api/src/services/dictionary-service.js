/**
 * @file PRD 02 事件字典与数据健康（Event Dictionary）
 *
 * 自动发现线上事件 + 可解释健康判定 + 字段完整率 + 人工登记。
 * 统计基于 events 聚合：列表窗口 ≤8 天、详情趋势 ≤31 天，
 * 均有索引支撑（idx_events_analytics / idx_events_type_ts）；
 * 长区间预聚合表 event_daily_stats 由治理任务后续接入（见 PRD §6）。
 */
import { all, run } from '../db.js'
import { parseJson } from '../utils/json.js'
import { badRequest } from '../utils/http-error.js'
import { keyFieldsOf } from '../../../../packages/event-keyfields.js'

/** 健康规则常量（M1 写死，M2 可配置） */
const RULES = {
  incompleteRate: 0.95,
  fluctuationRatio: 0.5,
  windowDays: 7
}

/** 各类别的关键字段清单——通过 packages/event-keyfields.js 与 Worker 端共享 */
const keyFieldsOfCached = (name) => keyFieldsOf(name)

const DAY = 86400000

/**
 * 字典列表：事件名聚合 + 健康判定。
 * @param {{source?:string, health?:string, platform?:string, q?:string, appId?:string, page?:number, pageSize?:number}} input
 */
export async function listDictionary(input = {}) {
  const page = Math.max(1, Number(input.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(input.pageSize) || 50))
  const now = Date.now()
  const since7 = now - RULES.windowDays * DAY
  const since24 = now - DAY

  // 单次聚合：近 7 天按 name 分组，拆出近 24h 计数与此前日均对比
  const parts = ['ts >= ?', "coalesce(name, '') <> ''", "type in ('behavior','track','error','perf')"]
  const params = [since7]
  if (input.appId) { parts.push('app_id = ?'); params.push(String(input.appId).slice(0, 64)) }
  if (input.platform) { parts.push('device ilike ?'); params.push(`%${input.platform}%`) }
  if (input.q) { parts.push('name ilike ?'); params.push(`%${String(input.q).slice(0, 80)}%`) }
  const where = `where ${parts.join(' and ')}`

  const rows = await all(`
    select name, type,
      count(*)::integer count7d,
      count(*) filter (where ts >= ?)::integer count24h,
      min(ts) first_seen_7d, max(ts) last_seen_at
    from events ${where}
    group by name, type
    order by count7d desc
    limit 500`, [since24, ...params])

  // 历史存在性（停滞判定的"历史有数据"）：7 日窗口外是否出现过该事件
  const names = rows.map(row => row.name)
  let historicNames = new Set()
  if (names.length) {
    const historic = await all(`
      select distinct name from events
      where ts < ? and name in (${names.map(() => '?').join(',')})
      limit 1000`, [since7, ...names])
    historicNames = new Set(historic.map(row => row.name))
  }

  // 登记信息
  const registeredRows = names.length
    ? await all(`select name, owner, description from event_dictionary where name in (${names.map(() => '?').join(',')})`, names)
    : []
  const registeredMap = new Map(registeredRows.map(row => [row.name, row]))

  // 字段完整率（采样计算，见 sampleCompleteness）
  const completeness = await sampleCompleteness(names.filter(Boolean), input.appId)

  const items = rows.map(row => {
    const count7d = Number(row.count7d || 0)
    const count24h = Number(row.count24h || 0)
    const lastSeenAt = Number(row.last_seen_at || 0)
    const registered = registeredMap.get(row.name)
    const completenessInfo = completeness.get(row.name)
    const health = judgeHealth({ count7d, count24h, lastSeenAt, hasHistory: historicNames.has(row.name), worstField: completenessInfo?.worst?.field, worstRate: completenessInfo?.worst?.rate })
    return {
      name: row.name,
      type: row.type,
      source: sourceOf(row),
      platform: '',
      count7d,
      count24h,
      lastSeenAt,
      fieldCompleteness: completenessInfo || null,
      health: health.status,
      verdict: health.verdict,
      registered: Boolean(registered),
      owner: registered?.owner || ''
    }
  })

  const filtered = input.health && input.health !== '' ? items.filter(item => item.health === input.health) : items
  const unregistered = filtered.filter(item => !item.registered && item.count7d > 0)
  return {
    total: filtered.length,
    unregisteredCount: unregistered.length,
    items: filtered.slice((page - 1) * pageSize, page * pageSize)
  }
}

/**
 * 健康判定（优先级 🔴 > 🟠 > 🟡 > 🟢），返回可解释结论。
 */
export function judgeHealth({ count7d, count24h, lastSeenAt, hasHistory, worstField, worstRate }) {
  if (count7d === 0 && hasHistory) {
    return { status: 'stalled', verdict: `${relativeDays(lastSeenAt)}无上报` }
  }
  if (worstRate != null && worstRate < RULES.incompleteRate) {
    return { status: 'incomplete', verdict: `${worstField || '关键字段'}完整率 ${(worstRate * 100).toFixed(0)}% < 95%` }
  }
  if (count7d > 0) {
    const dailyAvg = (count7d - count24h) / (RULES.windowDays - 1)
    if (dailyAvg > 0 && Math.abs(count24h - dailyAvg) / dailyAvg > RULES.fluctuationRatio) {
      const delta = Math.round((count24h - dailyAvg) / dailyAvg * 100)
      return { status: 'fluctuating', verdict: `近24h较前6日日均 ${delta > 0 ? '+' : ''}${delta}%，偏离基线` }
    }
  }
  if (count7d === 0) return { status: 'stalled', verdict: '从未上报' }
  return { status: 'healthy', verdict: `近24h上报 ${count24h.toLocaleString()}，正常` }
}

function relativeDays(ts) {
  const days = Math.floor((Date.now() - ts) / DAY)
  return days <= 0 ? '今日起' : `${days} 天`
}

function sourceOf(row) {
  if (['pv', 'page_leave', 'click'].includes(row.name)) return 'auto'
  if (row.type === 'perf') return 'auto'
  if (row.type === 'behavior') return 'auto'
  return 'manual'
}

/**
 * 字段完整率采样统计：每个事件取最近 ≤200 条，
 * 对「核心列 + props/context 顶层键」统计非空率，取最低者展示。
 */
async function sampleCompleteness(names, appId) {
  const result = new Map()
  if (!names.length) return result
  for (const name of names.slice(0, 60)) {
    const keyFields = keyFieldsOfCached(name)
    try {
      const rows = await all(`
        select url, referrer, path, props_json, context_json from events
        where name = ? ${appId ? 'and app_id = ?' : ''}
        order by ts desc limit 200`, appId ? [name, appId] : [name])
      if (!rows.length) continue
      const keyCounts = new Map()
      let total = 0
      for (const row of rows) {
        total++
        const props = parseJson(row.props_json) || {}
        const context = parseJson(row.context_json) || {}
        const values = {
          url: row.url,
          path: row.path,
          referrer: row.referrer,
          ...Object.fromEntries(Object.entries(props).slice(0, 12)),
          ...Object.fromEntries(Object.entries(context).slice(0, 12))
        }
        // 完整率只按该类别的关键字段清单统计（PRD FR-2）；未配置关键字段的事件不参与 🟠 判定，
        // 避免把"本来就没有的可选字段"算成缺失造成全员误报。
        for (const field of keyFields.slice(0, 20)) {
          const present = values[field] !== undefined && values[field] !== null && values[field] !== ''
          keyCounts.set(field, (keyCounts.get(field) || 0) + (present ? 1 : 0))
        }
      }
      if (!total || !keyCounts.size) continue
      const rates = [...keyCounts.entries()]
        .map(([field, count]) => ({ field, rate: Number((count / total).toFixed(3)) }))
        .sort((a, b) => a.rate - b.rate)
      result.set(name, {
        overall: Number((rates.reduce((sum, item) => sum + item.rate, 0) / rates.length).toFixed(3)),
        worst: rates[0],
        fields: rates,
        sampleSize: total
      })
    } catch {
      // 单个事件的完整率统计失败不阻塞列表
    }
  }
  return result
}

/**
 * 事件详情：30 天趋势 + 完整率 + 样例。
 */
export async function getDictionaryDetail(name, input = {}) {
  const eventName = String(name || '').trim().slice(0, 160)
  if (!eventName) throw badRequest('事件名不能为空', 'MISSING_EVENT_NAME')
  const since30 = Date.now() - 30 * DAY
  const params = [eventName]
  let appClause = ''
  if (input.appId) { appClause = 'and app_id = ?'; params.push(String(input.appId).slice(0, 64)) }

  const [trendRows, firstRow, samples, errorTop] = await Promise.all([
    all(`select floor(ts / 86400000)::bigint day_key, count(*)::integer count
        from events where name = ? ${appClause} and ts >= ?
        group by day_key order by day_key asc`, [...params, since30]),
    all(`select min(ts) first_seen from events where name = ? ${appClause}`, params),
    all(`select * from events where name = ? ${appClause} order by ts desc limit 3`, params),
    all(`select coalesce(name, message) label, count(*)::integer count from events
        where type = 'error' ${appClause} and ts >= ? and props_json::text ilike ?
        group by label order by count desc limit 3`, [since30, `%${eventName}%`])
  ].map(promise => promise.catch(() => [])))

  const registeredRow = (await all(`select * from event_dictionary where name = ?`, [eventName]))[0] || null
  const trendMap = new Map(trendRows.map(row => [Number(row.day_key), Number(row.count)]))
  const trend = []
  const startDay = Math.floor(since30 / DAY)
  for (let index = 0; index < 30; index++) {
    const dayKey = startDay + index
    trend.push({ day: new Date(dayKey * DAY).toISOString().slice(0, 10), count: trendMap.get(dayKey) || 0 })
  }

  return {
    name: eventName,
    registered: Boolean(registeredRow),
    description: registeredRow?.description || '',
    owner: registeredRow?.owner || '',
    tags: parseJson(registeredRow?.tags_json) || [],
    firstSeenAt: Number(firstRow[0]?.first_seen || 0),
    trend,
    errors: errorTop.map(row => ({ label: row.label, count: Number(row.count) })),
    samples: samples.map(sample => ({
      ts: Number(sample.ts),
      name: sample.name,
      path: sample.path,
      props: parseJson(sample.props_json),
      context: parseJson(sample.context_json)
    }))
  }
}

/** 人工登记含义（FR-4）：未登记不阻塞任何功能 */
export async function registerEvent(name, input = {}) {
  const eventName = String(name || '').trim().slice(0, 160)
  if (!eventName) throw badRequest('事件名不能为空', 'MISSING_EVENT_NAME')
  const now = Date.now()
  await run(`
    insert into event_dictionary (name, description, owner, tags_json, registered_at, updated_at)
    values (?, ?, ?, ?::jsonb, ?, ?)
    on conflict (name) do update set
      description = excluded.description,
      owner = excluded.owner,
      tags_json = excluded.tags_json,
      updated_at = excluded.updated_at`,
    [eventName, String(input.description || '').trim() || null, String(input.owner || '').trim().slice(0, 64) || null,
      JSON.stringify(Array.isArray(input.tags) ? input.tags.slice(0, 10) : []), now, now])
  return { ok: true, name: eventName }
}

/** AI 知识源快照（FR-5）：字典全量摘要注入知识库 */
export async function dictionarySnapshot(input = {}) {
  const { items } = await listDictionary({ ...input, pageSize: 100 })
  return items.map(item => ({
    name: item.name,
    source: item.source,
    count7d: item.count7d,
    health: item.health,
    verdict: item.verdict,
    description: '',
    owner: item.owner
  }))
}
