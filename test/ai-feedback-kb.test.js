import assert from 'node:assert/strict'
import test from 'node:test'
import { sedimentFeedback } from '../packages/ai/feedback.js'

/**
 * M5：反馈→KB 自动沉淀测试（down + correction → KB chunk）
 */
function buildDb({ diagnosis = null } = {}) {
  const called = []
  return {
    called,
    prepare(sql) {
      const stmt = {
        bind(...values) { this._v = values; return this },
        async first() {
          called.push(['first', sql, this._v])
          if (sql.includes('ai_diagnoses')) return diagnosis
          return null
        },
        async all() { called.push(['all', sql, this._v]); return [] },
        async run() { called.push(['run', sql, this._v]); return { changes: 1 } }
      }
      return stmt
    }
  }
}

function buildKb() {
  const calls = { upsert: [], remove: [], meta: [] }
  return {
    calls,
    async getMeta(type, id) { calls.meta.push(['get', type, id]); return null },
    async upsertMeta(m) { calls.meta.push(['upsert', m]); return null },
    async removeBySource(type, id) { calls.remove.push([type, id]); return null },
    async upsertChunk(c) { calls.upsert.push(c); return null }
  }
}

test('反馈 down+correction 沉淀为 KB chunk', async () => {
  const db = buildDb({ diagnosis: { id: 'trace:t1:999', ref_type: 'trace', ref_id: 't1', app_id: 'a' } })
  const kb = buildKb()
  const r = await sedimentFeedback({ db, kb, diagnosisId: 'trace:t1:999', rating: 'down', correction: '根因其实是缓存未失效', appId: 'a' })
  assert.equal(r.ingested, 1)
  assert.equal(kb.calls.remove[0][0], 'feedback')
  assert.ok(kb.calls.upsert.length === 1)
  const chunk = kb.calls.upsert[0]
  assert.equal(chunk.sourceType, 'feedback')
  assert.equal(chunk.appId, 'a')
  assert.ok(chunk.text.includes('根因其实是缓存未失效'))
})

test('反馈 up 不沉淀', async () => {
  const db = buildDb()
  const kb = buildKb()
  const r = await sedimentFeedback({ db, kb, diagnosisId: 'x', rating: 'up', correction: '很好', appId: 'a' })
  assert.equal(r, null)
  assert.equal(kb.calls.upsert.length, 0)
})

test('down 但无 correction 不沉淀', async () => {
  const db = buildDb()
  const kb = buildKb()
  const r = await sedimentFeedback({ db, kb, diagnosisId: 'x', rating: 'down', correction: '', appId: 'a' })
  assert.equal(r, null)
  assert.equal(kb.calls.upsert.length, 0)
})

test('同内容重复反馈去重（content_hash 命中跳过）', async () => {
  const { hash } = await import('../packages/ai/db-adapter.js')
  const db = buildDb({ diagnosis: { id: 'd', ref_type: 'error', ref_id: 'fp', app_id: 'a' } })
  const expected = hash('feedback|d|修正')
  const kb = {
    async getMeta(type, id) { return { content_hash: expected } },
    async upsertMeta() {},
    async removeBySource() {},
    async upsertChunk() { throw new Error('不应 upsert（content_hash 命中）') }
  }
  const r = await sedimentFeedback({ db, kb, diagnosisId: 'd', rating: 'down', correction: '修正', appId: 'a' })
  assert.equal(r.skipped, 1)
  assert.equal(r.ingested, 0)
})
