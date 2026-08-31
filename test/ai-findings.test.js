import assert from 'node:assert/strict'
import test from 'node:test'
import { runScan, createFindingsRepo, detectErrorClusters, detectReleaseRegressions, detectPerfRegressions, detectMetricDrops } from '../packages/ai/findings.js'

/** 极简内存 DB（仅覆盖 findings 查询/写入语句），让真实 findings.js 逻辑可跑。 */
function memDb(seed = {}) {
  const findings = []
  return {
    findings,
    prepare(sql) {
      const stmt = {
        _v: null,
        bind(...v) { this._v = v; return this },
        async all() {
          if (sql.includes('from events where type = ') && sql.includes('name, message')) return seed.errorClusters || []
          if (sql.includes('group by release_name')) return seed.releaseList || []
          if (sql.includes('group by type')) return seed.releaseStats || []
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

test('detectErrorClusters：阈值过滤 + 证据组装', async () => {
  const db = memDb({ errorClusters: [
    { name: 'TypeError', message: 'x', cnt: 120, affected: 30 },
    { name: 'RangeError', message: 'y', cnt: 3, affected: 1 }
  ] })
  const findings = await detectErrorClusters(db, { sinceTs: Date.now() - 86400000, minCount: 5 })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].scope, 'error-cluster')
  assert.equal(findings[0].object, 'TypeError')
  assert.ok(findings[0].evidence.some(e => e.startsWith('count:120')))
})

test('detectReleaseRegressions：错误率上升触发', async () => {
  const db = memDb({
    releaseList: [{ release_name: '1.0', first_ts: 1 }, { release_name: '2.0', first_ts: 2 }]
  })
  // getReleaseStats 先查 cur(2.0, 高错误) 再查 prev(1.0, 低错误)
  const highErr = [{ type: 'error', cnt: 50, perf_avg: null }, { type: 'perf', cnt: 10, perf_avg: 120 }]
  const lowErr = [{ type: 'error', cnt: 5, perf_avg: null }, { type: 'perf', cnt: 10, perf_avg: 100 }]
  let call = 0
  db.prepare = (orig => ({
    bind(...v) { this._v = v; return this },
    async all() {
      if (orig.includes('group by release_name')) return [{ release_name: '1.0', first_ts: 1 }, { release_name: '2.0', first_ts: 2 }]
      if (orig.includes('group by type')) return call++ === 0 ? highErr : lowErr
      return []
    },
    async first() { return null },
    async run() { return { changes: 1 } }
  }))
  const findings = await detectReleaseRegressions(db, {})
  assert.ok(findings.length >= 1)
  assert.ok(findings.some(f => f.scope === 'release-regression' && f.object === '2.0'))
})

test('detectPerfRegressions：性能退化超阈值触发（cur 用 first()）', async () => {
  const db = memDb({})
  let call = 0
  db.prepare = (sql => ({
    bind(...v) { this._v = v; return this },
    async all() { return [] },
    async first() {
      if (sql.includes("type = 'perf'")) return call++ === 0 ? { cnt: 5, avgv: 200 } : { cnt: 5, avgv: 50 }
      return null
    },
    async run() { return { changes: 1 } }
  }))
  const findings = await detectPerfRegressions(db, {})
  assert.equal(findings.length, 1)
  assert.equal(findings[0].scope, 'perf-regression')
})

test('detectMetricDrops：事件量骤降触发（cur 用 first()）', async () => {
  const db = memDb({})
  let call = 0
  db.prepare = (sql => ({
    bind(...v) { this._v = v; return this },
    async all() { return [] },
    async first() {
      if (sql.includes("type <> 'error'")) return call++ === 0 ? { cnt: 30 } : { cnt: 100 }
      return null
    },
    async run() { return { changes: 1 } }
  }))
  const findings = await detectMetricDrops(db, {})
  assert.equal(findings.length, 1)
  assert.equal(findings[0].scope, 'metric-drop')
})

test('runScan：去重——同类 open 洞察不重复写入', async () => {
  const db = memDb({ errorClusters: [{ name: 'TypeError', message: 'x', cnt: 100, affected: 20 }] })
  const r1 = await runScan(db, {})
  assert.equal(r1.inserted.length, 1)
  const r2 = await runScan(db, {})
  assert.equal(r2.inserted.length, 0)
  assert.equal(r2.skipped, 1)
  assert.equal(db.findings.length, 1)
})

test('createFindingsRepo：list/get/updateStatus 契约', async () => {
  const db = memDb({})
  const repo = createFindingsRepo(db)
  const id = await repo.insert({ scope: 'error-cluster', object: 'E', summary: 's', confidence: 0.8, appId: 'a' })
  const list = await repo.list({ appId: 'a' })
  assert.equal(list.length, 1)
  assert.equal(list[0].id, id)
  const got = await repo.get(id)
  assert.equal(got.summary, 's')
  const updated = await repo.updateStatus(id, 'resolved')
  assert.equal(updated.status, 'resolved')
})
