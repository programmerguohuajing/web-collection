import assert from 'node:assert/strict'
import test from 'node:test'
import { computeBaseline, detectBaselineDeviations, missingMetricDailyDays, writeMetricDailyStats } from '../packages/ai/baseline.js'
import { runScan, createFindingsRepo } from '../packages/ai/findings.js'

const HOUR_MS = 3600 * 1000
const DAY_MS = 24 * HOUR_MS

/** 基线测试用内存 DB：覆盖 metric_daily_stats / events 聚合 / ai_findings 读写 */
function baselineMemDb(seed = {}) {
  const findings = []
  return {
    findings,
    prepare(sql) {
      const stmt = {
        _v: null,
        bind(...v) { this._v = v; return this },
        async all() {
          if (sql.includes('from metric_daily_stats')) {
            const [appId, metric] = this._v
            return (seed.metricDailyStats || [])
              .filter(r => r.app_id === appId && r.metric === metric)
              .map(r => ({ day: r.day, value: r.value, samples: r.samples || 0 }))
              .sort((a, b) => a.day - b.day)
          }
          if (sql.includes('from events') && sql.includes('group by')) {
            return seed.eventDaily || []
          }
          if (sql.includes('from ai_findings')) {
            let rows = findings
            if (sql.includes('scope=? and object=?')) rows = rows.filter(r => r.scope === this._v[0] && r.object === this._v[1])
            if (sql.includes('status=? and created_at>=')) rows = rows.filter(r => r.status === this._v[2] && Number(r.created_at) >= this._v[3])
            return rows.slice(0, (this._v[this._v.length - 1] || 50))
          }
          return []
        },
        async first() {
          if (sql.includes('from ai_findings where id=')) return findings.find(r => r.id === this._v[0]) || null
          if (sql.includes('sum(case when type=') && sql.includes("type='error'")) return { total: seed.obsTotal ?? 0, errors: seed.obsErrors ?? 0 }
          if (sql.includes('avg(value)') && sql.includes("type='perf'")) return { perf_avg: seed.perfObserved ?? null }
          if (sql.includes('count(*) as cnt') && sql.includes("type<>'error'")) return { cnt: seed.volObserved ?? 0 }
          return null
        },
        async run() {
          if (sql.includes('insert into ai_findings')) {
            const [id, scope, object, appId, summary, evidence_json, detail_json, confidence, status, created_at] = this._v
            findings.push({ id, scope, object, app_id: appId, summary, evidence_json, detail_json, confidence, status, created_at, updated_at: created_at })
          } else if (sql.includes('update ai_findings set status')) {
            const [status, updated_at, id] = this._v
            const r = findings.find(x => x.id === id)
            if (r) { r.status = status; r.updated_at = updated_at }
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

/** 构造 14 天日表：历史 13 天 errorRate 在 0.003/0.005 间交替（含微小方差），最后一天可注入偏离 */
function dailyStatsSeed(lastValue) {
  const rows = []
  for (let k = 13; k >= 1; k--) rows.push({ app_id: 'global', metric: 'errorRate', day: dayAgo(k), value: k % 2 ? 0.003 : 0.005, samples: 1000 })
  rows.push({ app_id: 'global', metric: 'errorRate', day: dayAgo(0), value: lastValue, samples: 1000 })
  return rows
}

test('computeBaseline：均值与样本标准差正确（含空值边界）', () => {
  const { center, dispersion } = computeBaseline([2, 4, 4, 4, 5, 5, 7, 9])
  assert.ok(Math.abs(center - 5) < 1e-6)
  // 样本标准差（n-1）：偏差平方和 32，/7 → √4.571 ≈ 2.1381
  assert.ok(Math.abs(dispersion - Math.sqrt(32 / 7)) < 1e-4)
  const empty = computeBaseline([])
  assert.equal(empty.center, null)
  assert.equal(empty.dispersion, 0)
  const single = computeBaseline([3.14])
  assert.equal(single.center, 3.14)
  assert.equal(single.dispersion, 0)
})

test('detectBaselineDeviations：偏离超 3σ 产出 finding（日表权威源）', async () => {
  const db = baselineMemDb({ metricDailyStats: dailyStatsSeed(0.018) }) // 0.018 vs 基线 ~0.004，z≈9.9
  const findings = await detectBaselineDeviations(db, {})
  assert.equal(findings.length, 1)
  assert.equal(findings[0].scope, 'baseline-deviation')
  assert.equal(findings[0].object, 'errorRate:global')
  assert.equal(findings[0].appId, undefined)
  assert.ok(findings[0].detail.z >= 3, `z 应 ≥3，实际 ${findings[0].detail.z}`)
  assert.equal(findings[0].detail.method, 'rolling-mean-std')
  assert.equal(findings[0].detail.warming, false)
  assert.ok(findings[0].evidence.some(e => e.startsWith('metric:errorRate')))
  assert.ok(findings[0].confidence > 0.5 && findings[0].confidence <= 0.95)
})

test('detectBaselineDeviations：未超 3σ 不产出 finding', async () => {
  // 14 天全部 0.003/0.005 交替，最后一天也是正常波动 → z<3
  const db = baselineMemDb({ metricDailyStats: dailyStatsSeed(0.005) })
  const findings = await detectBaselineDeviations(db, {})
  assert.equal(findings.length, 0)
})

test('detectBaselineDeviations：历史样本不足门槛（<14 天）不产出', async () => {
  const few = []
  for (let k = 5; k >= 0; k--) few.push({ app_id: 'global', metric: 'errorRate', day: dayAgo(k), value: 0.004, samples: 1000 })
  few.push({ app_id: 'global', metric: 'errorRate', day: dayAgo(0), value: 0.5, samples: 1000 }) // 极端偏离
  const db = baselineMemDb({ metricDailyStats: few }) // 仅 7 天 < minBaselineDays(14) → 降级 events，events 未播种 → null
  const findings = await detectBaselineDeviations(db, {})
  assert.equal(findings.length, 0)
})

test('detectBaselineDeviations：appId 缺省走全局基线（object=metric:global）', async () => {
  const db = baselineMemDb({ metricDailyStats: dailyStatsSeed(0.02) })
  const findings = await detectBaselineDeviations(db, { appId: undefined })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].object, 'errorRate:global')
  assert.equal(findings[0].appId, undefined)
})

test('detectBaselineDeviations：指定 appId 走应用级基线', async () => {
  const rows = []
  for (let k = 13; k >= 1; k--) rows.push({ app_id: 'appX', metric: 'errorRate', day: dayAgo(k), value: k % 2 ? 0.003 : 0.005, samples: 1000 })
  rows.push({ app_id: 'appX', metric: 'errorRate', day: dayAgo(0), value: 0.05, samples: 1000 })
  const db = baselineMemDb({ metricDailyStats: rows })
  const findings = await detectBaselineDeviations(db, { appId: 'appX' })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].object, 'errorRate:appX')
  assert.equal(findings[0].appId, 'appX')
})

test('detectBaselineDeviations：events 降级路径（日表不足时）产出 warming finding', async () => {
  // 原始聚合行形状（getDailyMetricAggregates 的入参；函数内部换算 errorRate/perfAvg/volume）
  const eventDaily = []
  for (let k = 13; k >= 1; k--) eventDaily.push({ day: dayAgo(k), total: 1000, errors: k % 2 ? 3 : 5, perf_avg: 200, non_error: 995, samples: 1000 })
  eventDaily.push({ day: dayAgo(0), total: 1000, errors: 20, perf_avg: 200, non_error: 980, samples: 1000 }) // 当日错误率 0.02
  // events 实测窗口：总 1000 事件、错误 20 → observed=0.02（与 spike 一致）
  const db = baselineMemDb({ eventDaily, obsTotal: 1000, obsErrors: 20 })
  const findings = await detectBaselineDeviations(db, {})
  assert.equal(findings.length, 1)
  assert.equal(findings[0].detail.method, 'rolling-mean-std-events')
  assert.equal(findings[0].detail.warming, true)
  assert.ok(findings[0].detail.z >= 3)
})

test('runScan：基线洞察去重——同类 open 不重复写入', async () => {
  const db = baselineMemDb({ metricDailyStats: dailyStatsSeed(0.018) })
  const r1 = await runScan(db, {})
  assert.equal(r1.inserted.length, 1)
  const r2 = await runScan(db, {})
  assert.equal(r2.inserted.length, 0)
  assert.equal(r2.skipped, 1)
  assert.equal(db.findings.length, 1)
  // 落库字段核对
  const stored = db.findings[0]
  assert.equal(stored.scope, 'baseline-deviation')
  assert.equal(stored.object, 'errorRate:global')
})

test('createFindingsRepo + baseline：list 按 scope 过滤', async () => {
  const db = baselineMemDb({ metricDailyStats: dailyStatsSeed(0.018) })
  const repo = createFindingsRepo(db)
  await detectBaselineDeviations(db, {}).then(async f => {
    for (const x of f) await repo.insert(x)
  })
  const list = await repo.list({ scope: 'baseline-deviation' })
  assert.equal(list.length, 1)
  assert.equal(list[0].detail.metric, 'errorRate')
})

// ---------------- EOD writer（writeMetricDailyStats / missingMetricDailyDays） ----------------

test('writeMetricDailyStats：每日 6 条 upsert（3 指标 × per-app/global），日界为 UTC 整日', async () => {
  const issued = []
  const db = {
    prepare(sql) {
      return {
        bind(...v) { issued.push([sql, v]); return this },
        async run() { return { changes: 2 } }
      }
    }
  }
  const day = 20260910
  const r = await writeMetricDailyStats(db, { days: [day] })
  assert.equal(issued.length, 6)
  assert.equal(r.written, 12)
  assert.deepEqual(r.days, [day])
  const startTs = Date.UTC(2026, 8, 10), endTs = startTs + 86400000
  for (const [sql, v] of issued) {
    assert.equal(v[0], day, '首参为日键')
    assert.equal(v[1], startTs, '次参为当日 UTC 00:00')
    assert.equal(v[2], endTs, '三参为次日 UTC 00:00（左闭右开）')
    assert.match(sql, /on conflict\(app_id, metric, day\) do update set value=excluded\.value, samples=excluded\.samples/, '幂等 upsert')
    assert.match(sql, /where ts>=\? and ts<?/, 'INSERT..SELECT 带 where（规避 upsert JOIN 解析歧义）')
  }
  // 3 指标 × 双作用域（per-app 分组 + global 哨兵）
  const metrics = [...new Set(issued.map(([sql]) => (sql.match(/'(errorRate|perfAvg|volume)'/) || [])[1]))].sort()
  assert.deepEqual(metrics, ['errorRate', 'perfAvg', 'volume'])
  assert.equal(issued.filter(([sql]) => sql.includes('group by app_id')).length, 3, 'per-app 按应用分组')
  assert.equal(issued.filter(([sql]) => sql.includes("select 'global',")).length, 3, 'global 哨兵行')
  // global errorRate 是总错误/总事件（而非 per-app 比率平均）
  const globalErr = issued.find(([sql]) => sql.includes("'global', 'errorRate'"))[0]
  assert.match(globalErr, /sum\(case when type='error' then 1 else 0 end\)\*1\.0\/count\(\*\)/)
  // perfAvg 无样本日跳过（having is not null）
  assert.match(issued.find(([sql]) => sql.includes("'perfAvg'"))[0], /having avg\(case when type='perf' then value else null end\) is not null/)
  // 非法日过滤（月份 13 / 0 / 非数值）
  const r2 = await writeMetricDailyStats(db, { days: [20261301, 0, 'x', 20260910] })
  assert.deepEqual(r2.days, [20260910])
  // 空入参零执行
  const r3 = await writeMetricDailyStats(db, {})
  assert.equal(r3.written, 0)
  assert.deepEqual(r3.days, [])
})

test('missingMetricDailyDays：闭区间报缺失日（含跨月边界与空库）', async () => {
  // 存在 dayAgo(2)/dayAgo(3)，请求 [dayAgo(4), dayAgo(1)] → 缺 dayAgo(4) 与 dayAgo(1)
  const db = {
    prepare() {
      return {
        bind() { return this },
        async all() { return [{ day: dayAgo(2) }, { day: dayAgo(3) }] }
      }
    }
  }
  const missing = await missingMetricDailyDays(db, { fromDay: dayAgo(4), toDay: dayAgo(1) })
  assert.deepEqual(missing, [dayAgo(4), dayAgo(1)])
  // 跨月：8/30–9/2 共 4 天（UTC），空库全缺
  const emptyDb = {
    prepare() {
      return {
        bind() { return this },
        async all() { return [] }
      }
    }
  }
  const crossMonth = await missingMetricDailyDays(emptyDb, { fromDay: 20260830, toDay: 20260902 })
  assert.deepEqual(crossMonth, [20260830, 20260831, 20260901, 20260902])
  // 全存在 → 无缺口
  const fullDb = {
    prepare() {
      return {
        bind() { return this },
        async all() { return [{ day: 20260830 }, { day: 20260831 }, { day: 20260901 }, { day: 20260902 }] }
      }
    }
  }
  assert.deepEqual(await missingMetricDailyDays(fullDb, { fromDay: 20260830, toDay: 20260902 }), [])
})
