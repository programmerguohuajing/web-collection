/**
 * @file B1 智能基线异常检测 · 基线偏离检测器
 *
 * 作为第 5 类规则检测器接入 `packages/ai/findings.js` 的 `runScan`（复用去重/落库/Cron）。
 * 计算"当前窗口实测值"相对"自身历史滚动基线"的偏离（z = (observed - center) / dispersion），
 * |z| ≥ sensitivity（默认 3σ）且历史样本达门槛时产出 candidate finding（scope='baseline-deviation'）。
 *
 * 数据源：
 *   - 权威源 `metric_daily_stats`（预聚合日表，governance 写入；P0 未建 writer 时可能为空）。
 *   - 降级源 `events` 近 30 天滚动窗口（events 仅保留 30 天，全局原则 #6），打 warming=true。
 *
 * 标准差一律在 JS 层计算（computeBaseline），规避 D1/SQLite 无内置 stddev 的方言差异，
 * 保证 D1 与 PG 双后端 SQL 完全一致、无方言分支（仅日键表达式按 db.dialect 选）。
 *
 * 不依赖任何外部库；不调用 LLM；复用 packages/ai/db-adapter.js 的统一 db 接口（双后端无感）。
 */

// ---------------- 常量与默认配置 ----------------

const HOUR_MS = 3600 * 1000
const DAY_MS = 24 * HOUR_MS

/** 基线检测器默认集（D2 默认指标集 / D4 灵敏度 / D5 预热门槛，详见设计文档 §3.3） */
export const BaselineConfig = {
  metrics: ['errorRate', 'perfAvg', 'volume'],
  baselineWindowDays: 28, // D1 滚动基线窗口（排除"观测当日"，避免自包含）
  sensitivity: 3, // D4 默认 3σ；可每调用覆盖
  minBaselineDays: 14, // D5 预热：历史天数 < 14 不报
  method: 'rolling-mean-std' // D3 P0 算法；降级时为 'rolling-mean-std-events'
}

const DEFAULTS = BaselineConfig

/** 指标中文标签（用于 summary 人话结论） */
const METRIC_LABEL = {
  errorRate: '错误率',
  perfAvg: '性能均值',
  volume: '事件量'
}

// ---------------- 纯工具 ----------------

/**
 * 判断某个原始值是否"缺测"（不应参与基线计算）。
 *
 * 关键：不能先 Number() 再过滤——`Number(null) === 0`、`Number('') === 0`，
 * 会把"当日无数据"当成"当日值为 0ms"，导致基线均值与标准差被严重拉低（误报/漏报）。
 * 因此必须在数值转换**之前**剔除缺测值。
 *
 * @param {unknown} v 原始值
 * @returns {boolean} true 表示有效（可参与计算）
 */
function isValidSample(v) {
  if (v == null) return false // null / undefined：缺测
  if (typeof v === 'string' && v.trim() === '') return false // 空串/纯空白：缺测
  if (typeof v === 'boolean') return false // 布尔不是有效指标值
  return true
}

/**
 * 计算均值（中心）与样本标准差（离散度）。纯 JS，双端一致。
 * 缺测值（null/undefined/空串）与非法数值（NaN/±Infinity/非数字串）一律跳过；
 * 无任何有效值时返回安全空结果（center=null, dispersion=0），不产生 NaN、不除零。
 * @param {number[]} values
 * @returns {{ center: number|null, dispersion: number }}
 */
export function computeBaseline(values) {
  const arr = (Array.isArray(values) ? values : [])
    .filter(isValidSample) // 先剔除缺测，避免 Number(null)→0 污染基线
    .map(v => Number(v))
    .filter(v => Number.isFinite(v)) // 再剔除 NaN / ±Infinity
  const n = arr.length
  if (n === 0) return { center: null, dispersion: 0 }
  const mean = arr.reduce((a, b) => a + b, 0) / n
  // 样本标准差（n-1），n=1 时离散度置 0（无法估计方差）
  const variance = n > 1 ? arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0
  return {
    center: Number(mean.toFixed(6)),
    dispersion: Number(Math.sqrt(variance).toFixed(6))
  }
}

/** yyyyMMdd（UTC，避免时区漂移） */
function yyyymmdd(ts) {
  const d = new Date(Number(ts))
  if (!isFinite(d.getTime())) return 0
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate()
}

/** 按 db.dialect 选择"日键"SQL 表达式（D1 strftime / PG to_char），查询层只返回逐日聚合数组 */
function dayExpr(db) {
  if (db && db.dialect === 'postgres') {
    return "to_char(to_timestamp(ts/1000),'YYYYMMDD')::int"
  }
  return "cast(strftime('%Y%m%d', ts/1000,'unixepoch') as integer)"
}

/** 指标值格式化（summary 展示） */
function fmtMetric(metric, v) {
  const n = Number(v)
  if (!isFinite(n)) return '-'
  if (metric === 'errorRate') return `${(n * 100).toFixed(2)}%`
  if (metric === 'perfAvg') return `${n.toFixed(0)}ms`
  return `${Math.round(n)}`
}

// ---------------- 查询层（统一 db 接口，双后端无感） ----------------

/**
 * 读基线权威源：metric_daily_stats 日表（按 app_id+metric 的滚动窗口）。
 * appId 缺省时落 'global' 哨兵（与产出 finding 的 object `${metric}:global` 对齐）。
 * @returns {Array<{day:number, value:number, samples:number}>} 按 day 升序
 */
export async function getMetricDailyStats(db, { appId, metric, fromDay }) {
  const appKey = appId || 'global'
  const sql = 'select day, value, samples from metric_daily_stats where app_id = ? and metric = ? and day >= ? order by day asc'
  const rows = await db.prepare(sql).bind(appKey, metric, fromDay).all()
  return (rows || []).map(r => ({
    day: Number(r.day),
    value: Number(r.value),
    samples: Number(r.samples || 0)
  }))
}

/**
 * 降级源：从 events 按日聚合三类指标（errorRate/perfAvg/volume）。
 * 单条查询同时返回三列，JS 按 metric 取列，保证 D1/PG 共用同一 group by 模板。
 * @returns {Array<{day:number, errorRate:number, perfAvg:number|null, volume:number, samples:number}>} 按 day 升序
 */
export async function getDailyMetricAggregates(db, { appId, metric, fromTs, toTs }) {
  const day = dayExpr(db)
  const appCond = appId ? 'app_id = ? and ' : ''
  const sql = `select ${day} as day,
    count(*) as total,
    sum(case when type='error' then 1 else 0 end) as errors,
    avg(case when type='perf' then value else null end) as perf_avg,
    count(case when type<>'error' then 1 end) as non_error
    from events where ${appCond} ts >= ? and ts < ?
    group by ${day} order by day asc`
  const params = appId ? [appId, fromTs, toTs] : [fromTs, toTs]
  const rows = await db.prepare(sql).bind(...params).all()
  return (rows || []).map(r => {
    const total = Number(r.total || 0)
    const errors = Number(r.errors || 0)
    const perfAvg = r.perf_avg != null ? Number(r.perf_avg) : null
    const nonError = Number(r.non_error || 0)
    return {
      day: Number(r.day),
      errorRate: total > 0 ? errors / total : 0,
      perfAvg,
      volume: nonError,
      samples: total
    }
  })
}

// ---------------- EOD 预聚合 writer（PRD 15 P2-4 / 迁移 0022 注释的 P1 待办） ----------------

/** yyyyMMdd → [当日 UTC 00:00 的 epoch ms, 次日 UTC 00:00)。非法日返回 null。 */
function dayBoundsUtc(day) {
  const d = Number(day)
  if (!Number.isInteger(d) || d < 19700101 || d > 99991231) return null
  const y = Math.floor(d / 10000), m = Math.floor((d % 10000) / 100), dt = d % 100
  if (m < 1 || m > 12 || dt < 1 || dt > 31) return null
  const start = Date.UTC(y, m - 1, dt)
  return Number.isFinite(start) ? [start, start + 86400000] : null
}

/**
 * 把 events 按 UTC 日聚合为 errorRate / perfAvg / volume 写入 metric_daily_stats（权威源）。
 *
 * - 口径与 getDailyMetricAggregates 完全一致：errorRate=错误/总；perfAvg=perf 均值（无 perf 样本跳过）；
 *   volume=非错误计数；samples=当日事件总数。
 * - 同时写 per-app 行与 app_id='global' 哨兵行（对齐 getMetricDailyStats 的 appId||'global'）。
 * - 幂等：on conflict 覆盖重算——同日重复执行、补数、重放结果一致（以 retention 清理前的 events 为准）。
 * - 双栈：D1 / PG 适配器均可执行（标准聚合 + coalesce + upsert，无 SQLite 方言）。
 *
 * @param {object} db db-adapter 统一接口
 * @param {{days?: number[]}} opts 需要写入的日列表（yyyyMMdd）
 * @returns {Promise<{written:number, days:number[]}>} 写入行数（含覆盖）与处理日列表
 */
export async function writeMetricDailyStats(db, { days } = {}) {
  const list = (Array.isArray(days) ? days : []).map(Number).filter(d => dayBoundsUtc(d))
  if (!list.length) return { written: 0, days: [] }
  let written = 0
  for (const day of list) {
    const [startTs, endTs] = dayBoundsUtc(day)
    // 6 条 upsert：3 指标 × (per-app / global)。select 均带 where，避免 INSERT..SELECT..ON CONFLICT 的 JOIN 歧义。
    const stmts = [
      // per-app：按应用分组的当日口径
      ["insert into metric_daily_stats (app_id, metric, day, value, samples) select app_id, 'errorRate', ?, sum(case when type='error' then 1 else 0 end)*1.0/count(*), count(*) from events where ts>=? and ts<? group by app_id on conflict(app_id, metric, day) do update set value=excluded.value, samples=excluded.samples", [day, startTs, endTs]],
      ["insert into metric_daily_stats (app_id, metric, day, value, samples) select app_id, 'perfAvg', ?, avg(case when type='perf' then value else null end), count(*) from events where ts>=? and ts<? group by app_id having avg(case when type='perf' then value else null end) is not null on conflict(app_id, metric, day) do update set value=excluded.value, samples=excluded.samples", [day, startTs, endTs]],
      ["insert into metric_daily_stats (app_id, metric, day, value, samples) select app_id, 'volume', ?, count(case when type<>'error' then 1 end), count(*) from events where ts>=? and ts<? group by app_id on conflict(app_id, metric, day) do update set value=excluded.value, samples=excluded.samples", [day, startTs, endTs]],
      // global：全站汇总（注意 errorRate 必须总错误/总事件，而非 per-app 比率的平均）
      ["insert into metric_daily_stats (app_id, metric, day, value, samples) select 'global', 'errorRate', ?, sum(case when type='error' then 1 else 0 end)*1.0/count(*), count(*) from events where ts>=? and ts<? on conflict(app_id, metric, day) do update set value=excluded.value, samples=excluded.samples", [day, startTs, endTs]],
      ["insert into metric_daily_stats (app_id, metric, day, value, samples) select 'global', 'perfAvg', ?, avg(case when type='perf' then value else null end), count(*) from events where ts>=? and ts<? having avg(case when type='perf' then value else null end) is not null on conflict(app_id, metric, day) do update set value=excluded.value, samples=excluded.samples", [day, startTs, endTs]],
      ["insert into metric_daily_stats (app_id, metric, day, value, samples) select 'global', 'volume', ?, count(case when type<>'error' then 1 end), count(*) from events where ts>=? and ts<? on conflict(app_id, metric, day) do update set value=excluded.value, samples=excluded.samples", [day, startTs, endTs]]
    ]
    for (const [sql, params] of stmts) {
      const r = await db.prepare(sql).bind(...params).run().catch(err => { throw new Error(`writeMetricDailyStats day=${day} failed: ${err?.message || err}`) })
      written += Number(r?.changes || 0)
    }
  }
  return { written, days: list }
}

/**
 * 找出 [fromDay, toDay]（闭区间，yyyyMMdd）内 metric_daily_stats 完全缺失的日。
 * 用于 cron 增量回填：只补缺口，不重复计算已有日。
 * 注意：日级判定（某日只有 global 行而无新应用行时不补——该应用检测器自动降级 events，语义可接受）。
 */
export async function missingMetricDailyDays(db, { fromDay, toDay }) {
  const rows = await db.prepare('select distinct day from metric_daily_stats where day>=? and day<=?').bind(fromDay, toDay).all().catch(() => [])
  const present = new Set((rows || []).map(r => Number(r.day)))
  const missing = []
  let [y, m, d] = [Math.floor(fromDay / 10000), Math.floor((fromDay % 10000) / 100), fromDay % 100]
  let cursor = Date.UTC(y, m - 1, d)
  const end = dayBoundsUtc(toDay)?.[0]
  while (Number.isFinite(cursor) && end != null && cursor <= end) {
    const day = yyyymmdd(cursor)
    if (!present.has(day)) missing.push(day)
    cursor += 86400000
  }
  return missing
}

/**
 * 实测值（最近 sinceHours 窗口），按 metric 口径聚合。
 * @returns {number|null} errorRate=比率; perfAvg=均值; volume=计数; 无样本返回 null
 */
export async function getObserved(db, { appId, metric, fromTs, toTs }) {
  const appCond = appId ? 'app_id = ? and ' : ''
  if (metric === 'errorRate') {
    const sql = `select count(*) as total, sum(case when type='error' then 1 else 0 end) as errors
      from events where ${appCond} ts >= ? and ts < ?`
    const params = appId ? [appId, fromTs, toTs] : [fromTs, toTs]
    const r = await db.prepare(sql).bind(...params).first()
    const total = Number(r?.total || 0)
    const errors = Number(r?.errors || 0)
    return total > 0 ? errors / total : null
  }
  if (metric === 'perfAvg') {
    const sql = `select avg(value) as perf_avg from events where ${appCond} type='perf' and ts >= ? and ts < ?`
    const params = appId ? [appId, fromTs, toTs] : [fromTs, toTs]
    const r = await db.prepare(sql).bind(...params).first()
    return r?.perf_avg != null ? Number(r.perf_avg) : null
  }
  // volume：非错误事件数
  const sql = `select count(*) as cnt from events where ${appCond} type<>'error' and ts >= ? and ts < ?`
  const params = appId ? [appId, fromTs, toTs] : [fromTs, toTs]
  const r = await db.prepare(sql).bind(...params).first()
  return Number(r?.cnt || 0)
}

// ---------------- 基线源解析（日表优先，不足降级 events） ----------------

/**
 * 解析某指标的基线源：优先 metric_daily_stats（权威），样本不足则降级 events 滚动窗口。
 * @returns {{kind:'daily'|'events', method:string, center:number, dispersion:number, observed:number|null, samples:number}|null}
 *   null 表示预热不足（无法计算基线）。
 */
async function getBaselineSource(db, { appId, metric, windowDays, minDays, sinceHours, now, fromDay }) {
  // A. 日表（权威源）
  const dailyRows = await getMetricDailyStats(db, { appId, metric, fromDay })
  if (dailyRows.length >= minDays) {
    const history = dailyRows.slice(0, -1).map(r => r.value) // 排除"观测当日"避免自包含
    const { center, dispersion } = computeBaseline(history)
    const observedRow = dailyRows[dailyRows.length - 1]
    return {
      kind: 'daily',
      method: 'rolling-mean-std',
      center,
      dispersion,
      observed: observedRow != null ? Number(observedRow.value) : null,
      samples: dailyRows.length
    }
  }

  // B. 降级 events（≤30d，events 保留期）
  const fallbackDays = Math.min(windowDays, 30)
  const aggFrom = now - fallbackDays * DAY_MS
  const aggRows = await getDailyMetricAggregates(db, { appId, metric, fromTs: aggFrom, toTs: now })
  if (aggRows.length < minDays) return null // 预热不足
  const histRows = aggRows.slice(0, -1) // 排除最近观测窗
  const values = histRows.map(r => r[metric])
  if (!values.length) return null
  const { center, dispersion } = computeBaseline(values)
  const observed = await getObserved(db, { appId, metric, fromTs: now - sinceHours * HOUR_MS, toTs: now })
  const samples = histRows.reduce((s, r) => s + (r.samples || 0), 0)
  return {
    kind: 'events',
    method: 'rolling-mean-std-events',
    center,
    dispersion,
    observed,
    samples
  }
}

// ---------------- 检测器（第 5 类） ----------------

/**
 * 5. 基线偏离：当前窗口 vs 自身历史滚动基线（廉价规则，不调 LLM）
 * 完全仿 detectPerfRegressions 的返回形状，由 runScan 统一去重落库。
 * @param {object} db  db-adapter 统一接口（D1/PG 均可）
 * @param {object} opts
 *   appId?: string            不传=全局（object 退化为 `${metric}:global`）
 *   sinceHours?: number       观测窗口，默认 24
 *   baselineWindowDays?: number  默认 28
 *   sensitivity?: number      σ 阈值，默认 3
 *   metrics?: string[]       覆盖默认指标集
 *   minBaselineDays?: number  预热门槛，默认 14
 *   now?: number              测试可注入当前时间
 * @returns {Array<{scope,object,appId,summary,evidence,detail,confidence}>}
 */
export async function detectBaselineDeviations(db, opts = {}) {
  const { appId } = opts
  const metrics = opts.metrics || DEFAULTS.metrics
  const windowDays = opts.baselineWindowDays || DEFAULTS.baselineWindowDays
  const sensitivity = opts.sensitivity || DEFAULTS.sensitivity
  const minDays = opts.minBaselineDays || DEFAULTS.minBaselineDays
  const sinceHours = opts.sinceHours || 24
  const now = opts.now || Date.now()
  const fromDay = yyyymmdd(now - windowDays * DAY_MS)
  const findings = []

  for (const metric of metrics) {
    // 1) 优先日表；不足则降级 events
    const src = await getBaselineSource(db, { appId, metric, windowDays, minDays, sinceHours, now, fromDay })
    if (!src) continue // 预热不足 / 无数据
    if (src.dispersion == null || src.dispersion <= 0) continue // 离散度为 0（历史恒定）不报
    if (src.observed == null) continue
    const z = (src.observed - src.center) / src.dispersion
    if (Math.abs(z) < sensitivity) continue // 未超灵敏度门槛

    const absZ = Math.abs(z)
    let confidence = Math.min(0.95, 0.5 + absZ / 10)
    if (src.kind === 'events') confidence *= 0.9 // 降级（events）数据置信下调

    findings.push({
      scope: 'baseline-deviation',
      object: `${metric}:${appId || 'global'}`,
      appId,
      summary: `${METRIC_LABEL[metric] || metric} 当前 ${fmtMetric(metric, src.observed)}，历史基线 ${fmtMetric(metric, src.center)}（偏离 ${absZ.toFixed(1)}σ）`,
      evidence: [
        `metric:${metric}`,
        `baseline:${src.center}`,
        `observed:${src.observed}`,
        `z:${absZ.toFixed(1)}`,
        `window:${windowDays}d`,
        `method:${src.method}`
      ],
      detail: {
        metric,
        baseline: src.center,
        dispersion: src.dispersion,
        observed: src.observed,
        z: Number(z.toFixed(2)),
        window: windowDays,
        method: src.method,
        warming: src.kind === 'events',
        samples: src.samples
      },
      confidence: Number(confidence.toFixed(3))
    })
  }
  return findings
}
