/**
 * @file QA 独立验证：B1 智能基线异常检测 + A1 留存/同期群分析
 *
 * 目标不是复跑既有用例，而是补「边界 / 脏数据 / 错误路径」：
 *   - B1：σ=0 除零与误报、样本不足门槛、日表空→events 降级、z 为负（指标下降）、
 *         appId 缺省/空串全局基线、sensitivity 与 minBaselineDays 覆盖、perfAvg/volume 口径、
 *         confidence 上限与降级衰减、runScan scope 过滤、DB 异常传播。
 *   - A1：单用户单天、全员仅一次、offsets 非法输入（负数/非数字/超 365/小数/超长）、
 *         startTime>endTime、uid 全空、day 脏数据/极大值、分页非法入参、appId 空串与超长、
 *         加权平均一致性、query 异常传播。
 *   - 前端一致性（静态）：路由 path / 导航 path / 页面文件 / 后端接口 path 三方对齐，
 *         以及 dashboard.js 的 pageLoading|error 为 ref（页面只能 .value 使用，不能当函数调用）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { computeBaseline, detectBaselineDeviations, getMetricDailyStats, getDailyMetricAggregates, getObserved } from '../packages/ai/baseline.js'
import { runScan } from '../packages/ai/findings.js'
import { listRetention } from '../apps/api/src/services/retention-service.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOUR_MS = 3600 * 1000
const DAY_MS = 24 * HOUR_MS

// ============ 通用桩 ============

/** B1 内存 DB 桩：覆盖 metric_daily_stats / events 日聚合 / 实测窗口 / ai_findings */
function memDb(seed = {}) {
  const findings = []
  const calls = []
  return {
    findings,
    calls,
    prepare(sql) {
      const stmt = {
        _v: null,
        bind(...v) { this._v = v; return this },
        async all() {
          calls.push({ sql, values: this._v })
          if (sql.includes('from metric_daily_stats')) {
            const [appId, metric, fromDay] = this._v
            return (seed.daily || [])
              .filter(r => r.app_id === appId && r.metric === metric && Number(r.day) >= Number(fromDay))
              .map(r => ({ day: Number(r.day), value: Number(r.value), samples: Number(r.samples || 0) }))
              .sort((a, b) => a.day - b.day)
          }
          if (sql.includes('from events') && sql.includes('group by')) return seed.eventDaily || []
          if (sql.includes('from ai_findings')) {
            let rows = findings
            if (sql.includes('scope=? and object=?')) rows = rows.filter(r => r.scope === this._v[0] && r.object === this._v[1] && r.status === 'open')
            return rows.slice(0, 10)
          }
          return []
        },
        async first() {
          calls.push({ sql, values: this._v })
          if (sql.includes('sum(case when type=')) return { total: seed.obsTotal ?? 0, errors: seed.obsErrors ?? 0 }
          if (sql.includes('avg(value)')) return { perf_avg: seed.perfObserved ?? null }
          if (sql.includes('count(*) as cnt')) return { cnt: seed.volObserved ?? 0 }
          return null
        },
        async run() {
          if (sql.includes('insert into ai_findings')) {
            const [id, scope, object, appId] = this._v
            findings.push({ id, scope, object, app_id: appId, status: 'open', created_at: Date.now() })
          }
          return { changes: 1 }
        }
      }
      return stmt
    }
  }
}

function dayAgo(k) {
  const d = new Date(Date.now() - k * DAY_MS)
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate()
}

/** 构造 n 天日表（前 n-1 天为历史，最后一天为观测日） */
function dailyRows(n, valueFn, lastValue, metric = 'errorRate', appId = 'global') {
  const rows = []
  for (let k = n - 1; k >= 1; k -= 1) rows.push({ app_id: appId, metric, day: dayAgo(k), value: valueFn(k), samples: 1000 })
  rows.push({ app_id: appId, metric, day: dayAgo(0), value: lastValue, samples: 1000 })
  return rows
}

/** events 日聚合桩行（getDailyMetricAggregates 返回的原始形状） */
function eventRows(n, { errors = k => (k % 2 ? 3 : 5), perf = 200, total = 1000 } = {}) {
  const rows = []
  for (let k = n - 1; k >= 0; k -= 1) {
    const errs = errors(k)
    rows.push({ day: dayAgo(k), total, errors: errs, perf_avg: perf, non_error: total - errs, samples: total })
  }
  return rows
}

// =====================================================================
// B1 · computeBaseline
// =====================================================================

test('B1 computeBaseline：脏输入（null/undefined/NaN/Infinity/字符串数字）不抛异常且返回有限值', () => {
  const dirty = [null, undefined, NaN, Infinity, -Infinity, '3', 5]
  const r = computeBaseline(dirty)
  assert.ok(Number.isFinite(r.center), 'center 应为有限数')
  assert.ok(Number.isFinite(r.dispersion), 'dispersion 应为有限数')
  assert.ok(r.dispersion >= 0)
})

test('B1 computeBaseline：非数组入参安全降级', () => {
  for (const bad of [null, undefined, 'x', 42, {}]) {
    const r = computeBaseline(bad)
    assert.equal(r.center, null, `${String(bad)} 应降级为 center=null`)
    assert.equal(r.dispersion, 0)
  }
})

test('B1 computeBaseline：perfAvg 历史含 null 日（当日无 perf 事件）不得被当作 0 参与基线', () => {
  // 若 null 被 Number() 强转为 0，均值会被拉低到 (200+0+210)/3≈136.67，基线完全失真
  const { center, dispersion } = computeBaseline([200, null, 210])
  assert.ok(Math.abs(center - 205) < 1e-6, `缺测日应被忽略，期望 center=205，实际 ${center}`)
  assert.ok(Math.abs(dispersion - Math.sqrt(50)) < 1e-4, `期望 σ=√50≈7.07，实际 ${dispersion}`)
})

// =====================================================================
// B1 · detectBaselineDeviations
// =====================================================================

test('B1 σ=0（历史全同值）不除零、不误报', async () => {
  const db = memDb({ daily: dailyRows(14, () => 0.004, 0.004) })
  const findings = await detectBaselineDeviations(db, {})
  assert.equal(findings.length, 0, '历史恒定时不应产出 finding')
})

test('B1 σ=0 且观测值极端偏离时不抛异常（已知漏报，仅锁定不崩）', async () => {
  const db = memDb({ daily: dailyRows(14, () => 0.004, 0.9) })
  const findings = await detectBaselineDeviations(db, {})
  assert.ok(Array.isArray(findings), '应返回数组而非抛异常')
  // 已知行为：离散度为 0 时直接跳过，极端偏离也会漏报（σ=0 时 z 无定义）
  assert.equal(findings.length, 0, '当前实现：σ=0 一律不报（潜在漏报，见报告）')
})

test('B1 历史样本不足门槛（13 天 < 14）且 events 为空时不产出', async () => {
  const db = memDb({ daily: dailyRows(13, () => 0.004, 0.9) })
  const findings = await detectBaselineDeviations(db, {})
  assert.equal(findings.length, 0)
})

test('B1 日表为空且 events 为空：不产出、不抛异常', async () => {
  const db = memDb({})
  const findings = await detectBaselineDeviations(db, {})
  assert.deepEqual(findings, [])
})

test('B1 日表为空 → 降级 events 近 30 天窗口产出 warming finding', async () => {
  const db = memDb({
    eventDaily: eventRows(14, { errors: k => (k === 0 ? 20 : (k % 2 ? 3 : 5)) }),
    obsTotal: 1000,
    obsErrors: 20
  })
  // 只测 errorRate 口径：perfAvg 历史恒为 200（σ=0 不报）、volume 需另设桩
  const findings = await detectBaselineDeviations(db, { metrics: ['errorRate'] })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].detail.method, 'rolling-mean-std-events')
  assert.equal(findings[0].detail.warming, true)
  assert.ok(findings[0].detail.z >= 3)
})

test('B1 events 降级样本不足（<14 天）不产出', async () => {
  const db = memDb({ eventDaily: eventRows(9), obsTotal: 1000, obsErrors: 900 })
  const findings = await detectBaselineDeviations(db, {})
  assert.equal(findings.length, 0)
})

test('B1 z 为负（指标下降）同样被识别，且 detail.z 保留符号、evidence 用绝对值', async () => {
  const db = memDb({ daily: dailyRows(14, k => (k % 2 ? 0.030 : 0.032), 0.001) })
  const findings = await detectBaselineDeviations(db, {})
  assert.equal(findings.length, 1, '指标骤降应被识别')
  assert.ok(findings[0].detail.z <= -3, `detail.z 应为负数，实际 ${findings[0].detail.z}`)
  const zEvidence = findings[0].evidence.find(e => e.startsWith('z:'))
  assert.ok(zEvidence && !zEvidence.includes('-'), `evidence 的 z 应为绝对值：${zEvidence}`)
  assert.ok(findings[0].summary.includes('当前'), 'summary 应包含人话结论')
})

test('B1 appId 缺省与空串均走全局基线（object=metric:global）', async () => {
  const seed = { daily: dailyRows(14, k => (k % 2 ? 0.003 : 0.005), 0.02) }
  for (const appId of [undefined, '']) {
    const db = memDb(seed)
    const findings = await detectBaselineDeviations(db, { appId })
    assert.equal(findings.length, 1)
    assert.equal(findings[0].object, 'errorRate:global')
  }
})

test('B1 sensitivity 可覆盖：z≈2.5 时 3σ 不报、2σ 报', async () => {
  // 13 天历史交替 0.003/0.005 → center≈0.003923，σ≈0.001038；观测 0.0065 → z≈2.48
  const seed = { daily: dailyRows(14, k => (k % 2 ? 0.003 : 0.005), 0.0065) }
  const strict = await detectBaselineDeviations(memDb(seed), { sensitivity: 3 })
  const loose = await detectBaselineDeviations(memDb(seed), { sensitivity: 2 })
  assert.equal(strict.length, 0, '默认 3σ 不应触发')
  assert.equal(loose.length, 1, '2σ 应触发')
  assert.ok(loose[0].detail.z > 2 && loose[0].detail.z < 3, `z 应在 2~3 之间，实际 ${loose[0].detail.z}`)
})

test('B1 minBaselineDays 可覆盖：降到 3 天时短历史也能产出', async () => {
  const db = memDb({ daily: dailyRows(4, k => (k % 2 ? 0.003 : 0.005), 0.09) })
  const findings = await detectBaselineDeviations(db, { minBaselineDays: 3 })
  assert.equal(findings.length, 1)
  assert.ok(findings[0].detail.z >= 3)
})

test('B1 perfAvg / volume 指标口径与 summary 文案正确', async () => {
  const perfDb = memDb({ daily: dailyRows(14, k => (k % 2 ? 200 : 210), 900, 'perfAvg') })
  const perf = await detectBaselineDeviations(perfDb, { metrics: ['perfAvg'] })
  assert.equal(perf.length, 1)
  assert.ok(perf[0].summary.includes('ms'), `perfAvg 应以 ms 展示：${perf[0].summary}`)
  assert.ok(perf[0].summary.includes('性能均值'))

  const volDb = memDb({ daily: dailyRows(14, k => (k % 2 ? 1000 : 1020), 100, 'volume') })
  const vol = await detectBaselineDeviations(volDb, { metrics: ['volume'] })
  assert.equal(vol.length, 1)
  assert.ok(vol[0].summary.includes('事件量'))
  assert.ok(!vol[0].summary.includes('%'), 'volume 不应按百分比格式化')
})

test('B1 confidence：上限 0.95，events 降级再打 0.9 折', async () => {
  const dailyDb = memDb({ daily: dailyRows(14, k => (k % 2 ? 0.003 : 0.005), 0.5) })
  const dailyF = await detectBaselineDeviations(dailyDb, { metrics: ['errorRate'] })
  assert.ok(dailyF[0].confidence <= 0.95 + 1e-9)
  assert.ok(dailyF[0].confidence > 0.5)

  const evDb = memDb({
    eventDaily: eventRows(14, { errors: k => (k === 0 ? 500 : (k % 2 ? 3 : 5)) }),
    obsTotal: 1000,
    obsErrors: 500
  })
  const evF = await detectBaselineDeviations(evDb, { metrics: ['errorRate'] })
  assert.equal(evF.length, 1)
  assert.ok(evF[0].confidence < dailyF[0].confidence || evF[0].confidence <= 0.95 * 0.9 + 1e-9,
    `降级置信度应低于日表路径：${evF[0].confidence} vs ${dailyF[0].confidence}`)
})

test('B1 evidence 与 detail 字段齐全（供前端洞察详情渲染）', async () => {
  const db = memDb({ daily: dailyRows(14, k => (k % 2 ? 0.003 : 0.005), 0.02) })
  const [f] = await detectBaselineDeviations(db, {})
  for (const key of ['metric:', 'baseline:', 'observed:', 'z:', 'window:', 'method:']) {
    assert.ok(f.evidence.some(e => e.startsWith(key)), `evidence 缺少 ${key}`)
  }
  for (const key of ['metric', 'baseline', 'dispersion', 'observed', 'z', 'window', 'method', 'warming', 'samples']) {
    assert.ok(key in f.detail, `detail 缺少 ${key}`)
  }
})

test('B1 runScan：scopes 指定 baseline-deviation 时只跑基线检测器', async () => {
  const db = memDb({ daily: dailyRows(14, k => (k % 2 ? 0.003 : 0.005), 0.02) })
  const r = await runScan(db, { scopes: ['baseline-deviation'] })
  assert.equal(r.inserted.length, 1)
  assert.equal(db.findings.length, 1)
  assert.equal(db.findings[0].scope, 'baseline-deviation')
})

test('B1 runScan：scopes 不含 baseline-deviation 时不产出基线洞察', async () => {
  const db = memDb({ daily: dailyRows(14, k => (k % 2 ? 0.003 : 0.005), 0.02) })
  await runScan(db, { scopes: ['error-cluster'] })
  assert.equal(db.findings.filter(f => f.scope === 'baseline-deviation').length, 0)
})

test('B1 空数据 / 脏数据（日表含 NaN、null、字符串）不抛异常', async () => {
  const db = memDb({
    daily: [
      ...dailyRows(14, k => (k % 2 ? 0.003 : 0.005), 0.02),
      { app_id: 'global', metric: 'errorRate', day: dayAgo(0), value: 'NaN', samples: null },
      { app_id: 'global', metric: 'volume', day: dayAgo(0), value: null, samples: 0 },
      { app_id: 'global', metric: 'perfAvg', day: dayAgo(0), value: 'abc', samples: 0 }
    ]
  })
  const findings = await detectBaselineDeviations(db, {})
  assert.ok(Array.isArray(findings), '脏数据不应导致抛异常')
})

test('B1 DB 查询抛错时异常向上传播（runScan 无内部兜底，由路由层 try/catch 转 500）', async () => {
  const broken = { prepare() { throw new Error('d1 down') } }
  await assert.rejects(() => detectBaselineDeviations(broken, {}), /d1 down/)
})

test('B1 查询层：getMetricDailyStats / getDailyMetricAggregates / getObserved 参数与映射正确', async () => {
  const db = memDb({
    daily: dailyRows(3, () => 0.004, 0.02),
    eventDaily: [{ day: 20240101, total: 10, errors: 2, perf_avg: 150, non_error: 8, samples: 10 }],
    obsTotal: 10,
    obsErrors: 2,
    perfObserved: 150,
    volObserved: 8
  })
  const stats = await getMetricDailyStats(db, { appId: undefined, metric: 'errorRate', fromDay: 19700101 })
  assert.ok(stats.length >= 1)
  assert.ok(stats.every(r => Number.isFinite(r.day) && Number.isFinite(r.value) && Number.isFinite(r.samples)))

  const agg = await getDailyMetricAggregates(db, { appId: 'appX', metric: 'errorRate', fromTs: 1, toTs: 2 })
  assert.equal(agg[0].errorRate, 0.2)
  assert.equal(agg[0].perfAvg, 150)
  assert.equal(agg[0].volume, 8)

  assert.equal(await getObserved(db, { metric: 'errorRate', fromTs: 1, toTs: 2 }), 0.2)
  assert.equal(await getObserved(db, { metric: 'perfAvg', fromTs: 1, toTs: 2 }), 150)
  assert.equal(await getObserved(db, { metric: 'volume', fromTs: 1, toTs: 2 }), 8)
})

// =====================================================================
// A1 · listRetention
// =====================================================================

const BASE_DAY = 20000
const END_MS = (BASE_DAY + 30) * DAY_MS // endDay = 20030

/** 固定行桩 */
const stub = rows => async () => rows
/** 模拟 SQL 时间区间过滤的桩（startTime>endTime 时返回空，与真实 SQL 一致） */
function rangeAwareStub(rows) {
  return async (sql, params) => {
    const [start, end] = params
    if (Number(start) > Number(end)) return []
    return rows
  }
}
function rowsFrom(users) {
  const rows = []
  for (const [uid, days] of Object.entries(users)) for (const day of days) rows.push({ uid, day })
  return rows
}

test('A1 单用户单天：不除零，day0=100%，其余为 0', async () => {
  const res = await listRetention({ startTime: 1, endTime: END_MS }, stub(rowsFrom({ u1: [BASE_DAY] })))
  assert.equal(res.total, 1)
  assert.equal(res.totalUsers, 1)
  const c = res.items[0]
  assert.equal(c.size, 1)
  assert.equal(c.retention.find(r => r.day === 0).rate, 1)
  assert.ok(c.retention.filter(r => r.day !== 0).every(r => r.rate === 0 && r.users === 0))
  assert.ok(res.average.every(r => Number.isFinite(r.rate)), 'average 不应出现 NaN/Infinity')
})

test('A1 全部用户只出现一次：除 day0 外留存全为 0', async () => {
  const users = {}
  for (let i = 0; i < 40; i += 1) users[`u${i}`] = [BASE_DAY + (i % 5)]
  const res = await listRetention({ startTime: 1, endTime: END_MS }, stub(rowsFrom(users)))
  assert.equal(res.totalUsers, 40)
  const avg = Object.fromEntries(res.average.map(r => [r.day, r]))
  assert.equal(avg[0].rate, 1)
  for (const d of [1, 2, 3, 7, 14, 30]) assert.equal(avg[d].rate, 0, `第 ${d} 日应为 0`)
})

test('A1 offsets 非法输入：负数/非数字/>365/小数被过滤，全非法回落默认档位', async () => {
  const cases = [
    ['-1,2', [0, 2], '负数被丢弃'],
    ['abc', [0, 1, 2, 3, 7, 14, 30], '非数字回落默认'],
    ['999', [0, 1, 2, 3, 7, 14, 30], '超过 365 回落默认'],
    ['1.5', [0, 1, 2, 3, 7, 14, 30], '小数回落默认'],
    ['1e3', [0, 1, 2, 3, 7, 14, 30], '科学计数法（>365）回落默认'],
    ['2,1,1', [0, 1, 2], '去重 + 升序 + 恒含 0'],
    ['0', [0], '仅 0 合法'],
    ['365', [0, 365], '边界值 365 合法']
  ]
  for (const [input, expected, label] of cases) {
    const res = await listRetention({ startTime: 1, endTime: END_MS, offsets: input }, stub([]))
    assert.deepEqual(res.offsets, expected, `${label}：offsets=${input}`)
  }
})

test('A1 offsets 超长输入（500 组重复）被去重并截断到 12 个', async () => {
  const huge = '1,2,'.repeat(500)
  const res = await listRetention({ startTime: 1, endTime: END_MS, offsets: huge }, stub([]))
  assert.ok(res.offsets.length <= 12, `offsets 应被截断到 ≤12，实际 ${res.offsets.length}`)
  assert.equal(res.offsets[0], 0)
  assert.deepEqual(res.offsets, [...res.offsets].sort((a, b) => a - b), 'offsets 应升序')
})

test('A1 offsets 恒含 day0 且升序，retention 与 offsets 顺序一致', async () => {
  const res = await listRetention(
    { startTime: 1, endTime: END_MS, offsets: '7,3,1' },
    stub(rowsFrom({ u1: [BASE_DAY, BASE_DAY + 1, BASE_DAY + 3, BASE_DAY + 7] }))
  )
  assert.deepEqual(res.offsets, [0, 1, 3, 7])
  assert.deepEqual(res.items[0].retention.map(r => r.day), [0, 1, 3, 7])
  assert.ok(res.items[0].retention.every(r => r.rate === 1), '该用户每个档位都有回访')
})

test('A1 startTime > endTime：不抛异常，返回空结果', async () => {
  const res = await listRetention(
    { startTime: END_MS, endTime: 1 },
    rangeAwareStub(rowsFrom({ u1: [BASE_DAY, BASE_DAY + 1] }))
  )
  assert.equal(res.total, 0)
  assert.equal(res.totalUsers, 0)
  assert.deepEqual(res.items, [])
  assert.ok(res.average.every(r => r.rate === 0))
})

test('A1 uid 全空脏数据（null/空串/undefined）不抛异常且不计入', async () => {
  const dirty = [
    { uid: null, day: BASE_DAY },
    { uid: '', day: BASE_DAY },
    { uid: undefined, day: BASE_DAY },
    { uid: 0, day: BASE_DAY },
    { uid: 'u1', day: BASE_DAY }
  ]
  const res = await listRetention({ startTime: 1, endTime: END_MS }, stub(dirty))
  assert.equal(res.totalUsers, 1, '仅 u1 计入')
  assert.equal(res.total, 1)
})

test('A1 day 为非法值（NaN/undefined/非数字字符串）时被跳过', async () => {
  const rows = [
    { uid: 'u1', day: NaN },
    { uid: 'u2', day: undefined },
    { uid: 'u3', day: 'abc' },
    { uid: 'u4', day: BASE_DAY }
  ]
  const res = await listRetention({ startTime: 1, endTime: END_MS }, stub(rows))
  assert.equal(res.totalUsers, 1, '非法 day 行应被跳过')
  assert.equal(res.items[0].cohortDay, BASE_DAY)
})

test('A1 day 为 null 时不得回退成 1970-01-01 幽灵分群', async () => {
  const rows = [
    { uid: 'u1', day: null },
    { uid: 'u2', day: BASE_DAY }
  ]
  const res = await listRetention({ startTime: 1, endTime: END_MS }, stub(rows))
  assert.equal(res.totalUsers, 1, 'day=null 应被跳过，不应产生 day0 幽灵群')
  assert.equal(res.total, 1)
  assert.equal(res.items[0].cohortDay, BASE_DAY)
})

test('A1 极大 day 值（脏数据）不抛异常', async () => {
  // day 来自 (ts/86400000)::integer，脏数据可能远超 Date 可表示范围；
  // dayToDate() 直接 new Date(day*86400000).toISOString() 会抛 RangeError: Invalid time value
  const rows = [{ uid: 'u1', day: 2e8 }, { uid: 'u2', day: BASE_DAY }]
  const res = await listRetention({ startTime: 1, endTime: END_MS }, stub(rows))
  assert.equal(res.total, 2)
  assert.ok(res.items.every(i => typeof i.cohortDate === 'string' && i.cohortDate.length > 0))
})

test('A1 分页入参非法（0/负数/超大/非数字）不崩且语义正确', async () => {
  const rows = rowsFrom({ u1: [BASE_DAY] })
  for (const page of [0, -3, 'abc', 1e10]) {
    const res = await listRetention({ startTime: 1, endTime: END_MS, page, pageSize: 'x' }, stub(rows))
    assert.equal(res.total, 1, `page=${page} 时 total 仍应为 1`)
    assert.ok(Array.isArray(res.items))
  }
  const overflow = await listRetention({ startTime: 1, endTime: END_MS, page: 999, pageSize: 10 }, stub(rows))
  assert.deepEqual(overflow.items, [], '越界页应返回空 items')
  assert.equal(overflow.total, 1, '但 total 仍反映真实分群数')
})

test('A1 page/pageSize 边界：pageSize 上限 100、下限 1', async () => {
  const users = {}
  for (let i = 0; i < 5; i += 1) users[`u${i}`] = [BASE_DAY + i]
  const big = await listRetention({ startTime: 1, endTime: END_MS, pageSize: 1e6 }, stub(rowsFrom(users)))
  assert.ok(big.items.length <= 100, `pageSize 应被裁剪到 100，实际 ${big.items.length}`)
  // pageSize=0 走 `Number(0) || 20` → 回落默认 20；pageSize=-5 走 Math.max(1,·) → 1
  const zero = await listRetention({ startTime: 1, endTime: END_MS, pageSize: 0 }, stub(rowsFrom(users)))
  assert.equal(zero.total, 5, 'pageSize=0 时仍返回全部分群')
  const negative = await listRetention({ startTime: 1, endTime: END_MS, pageSize: -5 }, stub(rowsFrom(users)))
  assert.equal(negative.items.length, 1, 'pageSize 为负应被裁剪到 1')
})

test('A1 appId 空串不带 app_id 条件；超长 appId 截断到 64 字符', async () => {
  let captured = null
  const spy = async (sql, params) => { captured = { sql, params }; return [] }
  await listRetention({ startTime: 1, endTime: END_MS, appId: '' }, spy)
  assert.ok(!captured.sql.includes('app_id'), 'appId 为空串时不应加 app_id 条件')
  assert.deepEqual(captured.params, [1, END_MS])

  const long = 'a'.repeat(200)
  await listRetention({ startTime: 1, endTime: END_MS, appId: long }, spy)
  assert.equal(captured.params[2].length, 64, 'appId 应截断到 64 字符')
  assert.deepEqual(captured.params, [1, END_MS, 'a'.repeat(64)])
})

test('A1 加权平均与 totalUsers / 分群规模一致', async () => {
  const users = {
    u1: [BASE_DAY, BASE_DAY + 1],
    u2: [BASE_DAY],
    u3: [BASE_DAY],
    u4: [BASE_DAY]
  }
  const res = await listRetention({ startTime: 1, endTime: END_MS, offsets: '0,1' }, stub(rowsFrom(users)))
  assert.equal(res.totalUsers, 4)
  assert.equal(res.items[0].size, 4)
  const avg = Object.fromEntries(res.average.map(r => [r.day, r]))
  assert.equal(avg[0].users, 4)
  assert.equal(avg[0].rate, 1)
  assert.equal(avg[1].users, 1)
  assert.equal(Math.round(avg[1].rate * 10000) / 10000, 0.25)
})

test('A1 complete 标记：窗口未成熟的群返回 false', async () => {
  const res = await listRetention(
    { startTime: 1, endTime: END_MS },
    stub(rowsFrom({ u1: [BASE_DAY], u2: [BASE_DAY + 1], u3: [BASE_DAY + 29] }))
  )
  const byDay = Object.fromEntries(res.items.map(i => [i.cohortDay, i]))
  assert.equal(byDay[BASE_DAY].complete, true, '20000+30 <= 20030')
  assert.equal(byDay[BASE_DAY + 1].complete, false, '20001+30 > 20030')
  assert.equal(byDay[BASE_DAY + 29].complete, false)
})

test('A1 空数据 / 无入参：返回零值与口径说明，不抛异常', async () => {
  const empty = await listRetention({ startTime: 1, endTime: END_MS }, stub([]))
  assert.equal(empty.total, 0)
  assert.equal(empty.totalUsers, 0)
  assert.deepEqual(empty.items, [])
  assert.ok(empty.average.every(r => r.rate === 0 && r.users === 0))
  assert.ok(typeof empty.caliber === 'string' && empty.caliber.includes('UTC'))

  const noArgs = await listRetention(undefined, stub([]))
  assert.equal(noArgs.total, 0, '无入参时走默认 30 天窗口，不应抛异常')
  assert.deepEqual(noArgs.offsets, [0, 1, 2, 3, 7, 14, 30])
})

test('A1 行数据整体为脏（null 行 / 缺字段）不抛异常', async () => {
  const res = await listRetention({ startTime: 1, endTime: END_MS }, stub([null, undefined, {}, { uid: 'u1' }]))
  assert.equal(res.totalUsers, 0)
})

test('A1 query 抛错时异常向上传播（由路由 try/catch 转 500）', async () => {
  await assert.rejects(
    () => listRetention({ startTime: 1, endTime: END_MS }, async () => { throw new Error('pg down') }),
    /pg down/
  )
})

test('A1 API 契约：返回字段齐全，前端渲染所需键均存在', async () => {
  const res = await listRetention({ startTime: 1, endTime: END_MS }, stub(rowsFrom({ u1: [BASE_DAY] })))
  for (const key of ['total', 'totalUsers', 'offsets', 'average', 'items', 'minSample', 'caliber']) {
    assert.ok(key in res, `响应缺少 ${key}`)
  }
  const item = res.items[0]
  for (const key of ['cohortDay', 'cohortDate', 'size', 'complete', 'retention', 'sampleNote']) {
    assert.ok(key in item, `item 缺少 ${key}`)
  }
  assert.equal(typeof item.complete, 'boolean', 'complete 必须是布尔（前端 el-tag 三元判断）')
  assert.ok(Array.isArray(item.retention))
  assert.ok(item.retention.every(r => 'day' in r && 'users' in r && 'rate' in r))
})

// =====================================================================
// 前端一致性（静态检查，不起服务）
// =====================================================================

const read = p => readFileSync(path.join(ROOT, p), 'utf8')

test('FE 一致性：路由 / 导航 / 页面文件 / 后端接口 四方对齐', () => {
  const router = read('apps/web/src/router/index.js')
  const layout = read('apps/web/src/layout/index.vue')
  const apiIndex = read('apps/api/src/index.js')

  assert.ok(existsSync(path.join(ROOT, 'apps/web/src/views/insight/retention/index.vue')), '留存页面文件必须存在')
  assert.ok(/path:\s*'retention'/.test(router), 'router 需注册 retention 子路由')
  assert.ok(/views\/insight\/retention\/index\.vue/.test(router), '路由组件需指向留存页面')
  assert.ok(/path:\s*'\/retention'/.test(layout), '侧边导航需含 /retention')
  assert.ok(/app\.get\('\/api\/analytics\/retention'/.test(apiIndex), '后端需注册 /api/analytics/retention')

  const page = read('apps/web/src/views/insight/retention/index.vue')
  assert.ok(page.includes('/api/analytics/retention'), '页面请求路径需与后端一致')
  // 路由为 '/' 的 children，故 path 'retention' → '/retention'，与导航一致
  const rootChildren = router.match(/path:\s*'\/',[\s\S]*?children:/)
  assert.ok(rootChildren, 'retention 必须挂在根路径 children 下，才能拼成 /retention')
})

test('FE 一致性：layout 导航图标 Grid 已在 import 列表中（避免运行时 undefined 图标）', () => {
  const layout = read('apps/web/src/layout/index.vue')
  const importBlock = layout.match(/import\s*\{([\s\S]*?)\}\s*from\s*'@element-plus\/icons-vue'/)
  assert.ok(importBlock, 'layout 需从 @element-plus/icons-vue 导入图标')
  const names = importBlock[1].split(',').map(s => s.trim()).filter(Boolean)
  assert.ok(names.includes('Grid'), 'Grid 必须已导入（留存导航使用）')
  assert.ok(/icon:\s*Grid/.test(layout), '留存导航项应使用 Grid 图标')
})

test('FE 正确性：dashboard.js 的 pageLoading / error 是 ref，页面不得当作函数调用', () => {
  const dash = read('apps/web/src/dashboard.js')
  assert.ok(/export\s+const\s+pageLoading\s*=\s*ref\(/.test(dash), 'pageLoading 必须是 ref')
  assert.ok(/export\s+const\s+error\s*=\s*ref\(/.test(dash), 'error 必须是 ref')

  const page = read('apps/web/src/views/insight/retention/index.vue')
  assert.ok(!/pageLoading\s*\(/.test(page), 'pageLoading 不得作为函数调用（会抛 is not a function）')
  // 排除 ElMessage.error(...) 这类方法调用，只检查裸 error(...) 调用
  const bareErrorCall = page.match(/(^|[^.\w$])error\s*\(/m)
  assert.equal(bareErrorCall, null, 'error 不得作为函数调用')
  assert.ok(/pageLoading\.value\s*=/.test(page), 'pageLoading 应通过 .value 赋值')
  // 引用 dashboard.js 时必须是 ref 语义导入（不能解构成函数调用）
  assert.ok(/import\s*\{[^}]*pageLoading[^}]*\}\s*from\s*'\.\.\/\.\.\/\.\.\/dashboard\.js'/.test(page),
    'pageLoading 需从 dashboard.js 导入')
})

test('FE 一致性：ai-insights 已配置 baseline-deviation 标签/配色/详情字段', () => {
  const page = read('apps/web/src/views/insight/ai-insights/index.vue')
  assert.ok(/'baseline-deviation':\s*'基线偏离'/.test(page), '需有中文 scope 标签')
  assert.ok(/'baseline-deviation':\s*\{[^}]*background/.test(page), '需有紫色系配色')
  for (const key of ['基线值', '实测值', '偏离 σ', '对比窗口', '算法']) {
    assert.ok(page.includes(key), `详情区需展示「${key}」`)
  }
  // 扫描默认 scope 列表需包含 baseline-deviation
  assert.ok(/scanScopes\s*=\s*ref\(\[[^\]]*baseline-deviation/.test(page), '默认扫描范围需含 baseline-deviation')
})
