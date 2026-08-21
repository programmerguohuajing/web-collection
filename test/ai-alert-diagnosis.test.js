import assert from 'node:assert/strict'
import test from 'node:test'
import { maybeAutoDiagnose } from '../packages/ai/alert-diagnosis.js'

/**
 * M5：告警触发自动诊断测试
 * - 配置 AI_WORKER_URL → 调 ai-worker 诊断 → 摘要回写 alert_history.context_json.diagnosis
 * - 未配置 AI_WORKER_URL / 诊断失败时静默降级，不抛错
 */
const dbWith = ({ contextJson = null } = {}) => {
  const log = []
  const row = { context_json: contextJson }
  return {
    log,
    prepare(sql) {
      const stmt = {
        bind(...v) { this._v = v; return this },
        async first() { log.push(['first', sql, this._v]); return sql.includes('select context_json') ? row : null },
        async run() { log.push(['run', sql, this._v]); return { changes: 1 } },
        async all() { return [] }
      }
      return stmt
    }
  }
}

test('配置 AI_WORKER_URL 时触发诊断并把摘要写回 context_json', async () => {
  const db = dbWith({ contextJson: JSON.stringify({ page: '/x' }) })
  const fetchFn = async (url, opts) => {
    assert.ok(url.endsWith('/api/ai/diagnose'))
    assert.ok(JSON.parse(opts.body).issueId === 'fp-1')
    return new Response(JSON.stringify({
      summary: '数据库连接池耗尽',
      hypotheses: [{ cause: '连接泄漏', confidence: 0.9 }, { cause: '连接数不够', confidence: 0.6 }, { cause: 'x', confidence: 0.3 }],
      degraded: false, refId: 'fp-1', model: 'domestic:qwen'
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const r = await maybeAutoDiagnose({
    env: { AI_WORKER_URL: 'https://ai.example.workers.dev', AI_API_KEY: 'k' },
    db, alertId: 42, appId: 'a', issueId: 'fp-1', fetchFn
  })
  assert.equal(r.ok, true)
  // 更新语句写回 context_json.diagnosis
  const upd = db.log.find(x => x[0] === 'run')
  assert.ok(upd, '应有 update alert_history')
  const written = JSON.parse(upd[2][0])
  assert.equal(written.diagnosis.summary, '数据库连接池耗尽')
  assert.equal(written.diagnosis.hypotheses.length, 3)
  assert.equal(written.diagnosis.degraded, false)
})

test('未配置 AI_WORKER_URL 时不触发（静默跳过）', async () => {
  const db = dbWith()
  const r = await maybeAutoDiagnose({ env: {}, db, alertId: 1, appId: 'a', issueId: 'f' })
  assert.equal(r, null)
  assert.equal(db.log.length, 0)
})

test('诊断接口失败不抛错（静默降级返回 error 字段）', async () => {
  const db = dbWith()
  const fetchFn = async () => new Response('boom', { status: 500 })
  const r = await maybeAutoDiagnose({ env: { AI_WORKER_URL: 'https://ai.example.workers.dev' }, db, alertId: 1, appId: 'a', issueId: 'f', fetchFn })
  assert.ok(!r.ok)
  assert.ok(String(r.error).includes('500'))
  assert.equal(db.log.length, 0) // 无更新写回
})

test('诊断接口网络异常静默降级', async () => {
  const db = dbWith()
  const fetchFn = async () => { throw new Error('ECONNREFUSED') }
  const r = await maybeAutoDiagnose({ env: { AI_WORKER_URL: 'https://ai.example.workers.dev' }, db, alertId: 1, appId: 'a', issueId: 'f', fetchFn })
  assert.ok(!r.ok)
  assert.ok(String(r.error).includes('ECONNREFUSED'))
})
