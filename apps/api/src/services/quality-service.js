/**
 * @file PRD 03 版本质量（Version Quality）
 *
 * 每版本一行的质量总览 + A/B 对比 + 观察期状态判定。
 * 全部基于 events 聚合（release_name / sdk_version 两组维度）；
 * 上报延迟用 received_at − ts（received_at 双端已存在，未填充样本不计入）。
 */
import { all } from '../db.js'
import { badRequest } from '../utils/http-error.js'

const DAY = 86400000
const MIN_SESSIONS = 10

/**
 * 版本质量列表。
 * @param {{appId?:string, dim?:'release'|'sdk', startTime?:number, endTime?:number}} input
 */
export async function getReleaseQuality(input = {}) {
  if (!input.appId) throw badRequest('appId 不能为空', 'MISSING_APP_ID')
  const dim = input.dim === 'sdk' ? 'sdk_version' : 'release_name'
  const start = finiteOr(input.startTime, Date.now() - 7 * DAY)
  const end = finiteOr(input.endTime, Date.now())

  const rows = await all(`
    select ${dim} as version,
      count(distinct coalesce(nullif(user_id, ''), device_id))::integer users,
      count(distinct case when coalesce(session_id, '') <> '' then session_id end)::integer sessions,
      count(*) filter (where type = 'error')::integer errors,
      count(distinct case when type = 'error' then session_id end)::integer abnormal_sessions,
      min(ts) first_seen_at, max(ts) last_seen_at,
      avg(case when received_at is not null and received_at >= ts and received_at - ts < 3600000
        then received_at - ts end)::float latency_avg,
      percentile_cont(0.75) within group (order by case when type='perf' and metric='lcp' then value end)
        filter (where type='perf' and metric='lcp')::float lcp_p75,
      percentile_cont(0.75) within group (order by case when type='perf' and metric='inp' then value end)
        filter (where type='perf' and metric='inp')::float inp_p75
    from events
    where app_id = ? and ts >= ? and ts <= ? and coalesce(${dim}, '') <> ''
    group by ${dim}
    order by users desc`, [String(input.appId).slice(0, 64), start, end])

  const items = rows.map(row => {
    const sessions = Number(row.sessions || 0)
    return {
      version: row.version,
      users: Number(row.users || 0),
      sessions,
      errors: Number(row.errors || 0),
      errorsPerKSession: sessions > 0 ? Number((Number(row.errors || 0) * 1000 / sessions).toFixed(2)) : null,
      abnormalSessionRate: sessions > 0 ? Number((Number(row.abnormal_sessions || 0) / sessions).toFixed(4)) : null,
      reportLatencyP75: row.latency_avg != null ? Math.round(Number(row.latency_avg)) : null,
      perf: { lcpP75: row.lcp_p75 != null ? Math.round(Number(row.lcp_p75)) : null, inpP75: row.inp_p75 != null ? Math.round(Number(row.inp_p75)) : null },
      firstSeenAt: Number(row.first_seen_at || 0),
      lastSeenAt: Number(row.last_seen_at || 0)
    }
  })

  // 基线：会话数 ≥ MIN_SESSIONS 的其他版本按会话数加权平均
  const baselinePool = items.filter(item => item.sessions >= MIN_SESSIONS && item.errorsPerKSession != null)
  const totalSessions = baselinePool.reduce((sum, item) => sum + item.sessions, 0)
  const grandSessions = items.reduce((sum, item) => sum + item.sessions, 0)
  const baselineValue = totalSessions > 0
    ? baselinePool.reduce((sum, item) => sum + item.errorsPerKSession * item.sessions, 0) / totalSessions
    : null

  const now = Date.now()
  for (const item of items) {
    item.status = judgeStatus(item, { baselineValue, grandSessions, now })
    if (item.sessions < MIN_SESSIONS) item.status = 'insufficient'
    item.statusLabel = STATUS_LABELS[item.status]
  }

  return {
    baseline: { errorsPerKSession: baselineValue != null ? Number(baselineValue.toFixed(2)) : null },
    summary: {
      versions: items.length,
      watching: items.filter(item => item.status === 'watch' || item.status === 'rollback').length,
      rollback: items.filter(item => item.status === 'rollback').length,
      converge: items.filter(item => item.status === 'converge').length
    },
    items
  }
}

const STATUS_LABELS = {
  rollback: '建议回滚',
  watch: '观察',
  converge: '建议收敛',
  healthy: '健康',
  insufficient: '数据不足'
}

/**
 * 状态判定（FR-2）：🔴 观察期内错误密度 > 基线×2 → 回滚；发布后 48h 内 → 观察；
 * ⚪ 采用率 <5% 且 >14 天无上报 → 收敛；🟢 其余。
 */
export function judgeStatus(item, { baselineValue, grandSessions, now }) {
  const inObservation = now - item.firstSeenAt < 48 * 3600000
  if (inObservation && baselineValue != null && item.errorsPerKSession != null && item.errorsPerKSession > baselineValue * 2) return 'rollback'
  if (item.lastSeenAt < now - 14 * DAY && grandSessions > 0 && item.sessions / grandSessions < 0.05) return 'converge'
  if (inObservation) return 'watch'
  if (baselineValue != null && item.errorsPerKSession != null && item.errorsPerKSession > baselineValue * 1.2) return 'watch'
  return 'healthy'
}

/**
 * A/B 对比：错误 Top10 差异 + 性能 P75 + 采用趋势。
 */
export async function compareReleases(input = {}) {
  const appId = String(input.appId || '').slice(0, 64)
  const a = String(input.a || '').slice(0, 64)
  const b = String(input.b || '').slice(0, 64)
  if (!appId || !a || !b) throw badRequest('appId 与 A/B 版本不能为空', 'MISSING_COMPARE_INPUT')
  const since14 = Date.now() - 14 * DAY

  const [errorsA, errorsB, perfA, perfB, trendRows] = await Promise.all([
    errorCounts(appId, a),
    errorCounts(appId, b),
    perfP75(appId, a),
    perfP75(appId, b),
    all(`select release_name, floor(ts / 86400000)::bigint day_key,
        count(distinct coalesce(nullif(user_id, ''), device_id))::integer users
      from events where app_id = ? and release_name in (?, ?) and ts >= ?
      group by release_name, day_key order by day_key asc`, [appId, a, b, since14]).catch(() => [])
  ])

  const names = [...new Set([...Object.keys(errorsA), ...Object.keys(errorsB)])]
  const errors = names.map(name => {
    const aCount = errorsA[name] || 0
    const bCount = errorsB[name] || 0
    return {
      name,
      aCount, bCount,
      delta: aCount > 0 && bCount === 0 ? 'new' : aCount === 0 && bCount > 0 ? 'gone' : 'flat'
    }
  }).sort((x, y) => y.aCount - x.aCount).slice(0, 10)

  const trendMapA = new Map(), trendMapB = new Map()
  for (const row of trendRows) {
    const target = row.release_name === a ? trendMapA : trendMapB
    target.set(Number(row.day_key), Number(row.users))
  }
  const trend = mergeTrendDays(trendMapA, trendMapB)

  return { errors, perf: { a: perfA, b: perfB }, trend }
}

async function errorCounts(appId, release) {
  const rows = await all(`select coalesce(name, 'unknown') name, count(*)::integer count
    from events where app_id = ? and release_name = ? and type = 'error'
    group by name order by count desc limit 50`, [appId, release]).catch(() => [])
  return Object.fromEntries(rows.map(row => [row.name, Number(row.count)]))
}

async function perfP75(appId, release) {
  const rows = await all(`select metric, percentile_cont(0.75) within group (order by value)::float p75
    from events where app_id = ? and release_name = ? and type = 'perf' and metric in ('lcp','inp','fcp')
    group by metric`, [appId, release]).catch(() => [])
  const out = {}
  for (const row of rows) out[row.metric] = row.p75 != null ? Math.round(Number(row.p75)) : null
  return out
}

function mergeTrendDays(mapA, mapB) {
  const days = [...new Set([...mapA.keys(), ...mapB.keys()])].sort((x, y) => x - y)
  return days.map(dayKey => ({
    day: new Date(dayKey * DAY).toISOString().slice(0, 10),
    a: mapA.get(dayKey) || 0,
    b: mapB.get(dayKey) || 0
  }))
}

function finiteOr(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}
