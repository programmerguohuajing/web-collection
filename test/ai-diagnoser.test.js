import assert from 'node:assert/strict'
import test from 'node:test'
import { createDiagnoser } from '../packages/ai/diagnoser.js'

/**
 * M2 主干集成测试：用内存 db / mock model-gateway / mock kb 驱动 diagnoser 全链路。
 * db 采用"SQL 前缀匹配"的 mock，让真实 queries.js（getDistributedTrace/getIssue 等）
 * 能命中注入数据 → 组装上下文 → 调模型 → 结构化解析 → 落库 → 返回契约 + 缓存 + 降级。
 */

function buildDb(rows = {}) {
  const inserts = []
  const prepared = []
  const db = {
    inserts,
    prepared,
    prepare(sql) {
      prepared.push(sql)
      // 返回链式 stmt（bind 同步，first/all/run 异步，与 D1/PG adapter 一致）
      const stmt = {
        _values: null,
        bind(...values) { this._values = values; return this },
        async all() {
          // 按 SQL 特征返回注入行
          if (sql.includes('from events where trace_id=')) return rows.events || []
          if (sql.includes('status <>')) return rows.similar || []
          if (sql.includes('ai_kb_chunks')) return []
          return []
        },
        async first() {
          if (sql.includes('from issues where fingerprint=')) return rows.issue || null
          if (sql.includes('ai_diagnoses')) return rows.diagnosis || null
          return null
        },
        async run() {
          inserts.push(sql)
          return { changes: 1, lastRowId: 1 }
        }
      }
      return stmt
    }
  }
  return db
}

function modelGateway(impl) {
  return { route: impl }
}

test('trace 诊断：分布链路 + 错误事件 → 模型 → 结构化契约 → 落库', async () => {
  const db = buildDb({
    events: [
      { id: 'e1', ts: 1000, type: 'perf', app_id: 'a', span_id: 's1', parent_span_id: '', props_json: '{}', metric: 'lcp', value: 2500 },
      { id: 'e2', ts: 1200, type: 'error', app_id: 'a', span_id: 's2', parent_span_id: 's1', props_json: '{}', name: 'TypeError', message: 'x undefined', stack: 'at app.js:1', metric: '', value: null, trace_id: 't1' }
    ]
  })
  let routeCalls = 0
  const gateway = modelGateway(async () => {
    routeCalls++
    return {
      model: 'domestic:deepseek-chat', provider: 'domestic',
      content: JSON.stringify({
        summary: '列表数据未初始化导致 TypeError',
        hypotheses: [{ cause: 'data 数组未初始化', confidence: 0.82, evidence: ['span:s2', 'event:e2'] }],
        suggestions: [{ action: '初始化列表为 []', codeRef: 'app.js:1' }],
        relatedKb: [{ title: 'undefined 读取', source: 'issue', score: 0.9 }]
      })
    }
  })
  const d = createDiagnoser({ db, gateway, kb: { search: async () => [] }, embedder: {} })

  const res = await d.trace({ traceId: 't1', appId: 'a' })
  assert.equal(routeCalls, 1)
  assert.equal(res.summary, '列表数据未初始化导致 TypeError')
  assert.equal(res.hypotheses[0].confidence, 0.82)
  assert.equal(res.model, 'domestic:deepseek-chat')
  assert.equal(res.refId, 't1')
  assert.equal(res.degraded, false)
  // 落库到 ai_diagnoses
  assert.ok(db.inserts.some(s => s.includes('ai_diagnoses')))
})

test('error 诊断：issue 数据 + 相似 issue + kb → 契约', async () => {
  const db = buildDb({
    issue: {
      fingerprint: 'fp-1', status: 'open', app_id: 'a', release_name: '1.0',
      name: 'TypeError', message: 'Cannot read x', stack: 'at x.js:1', url: 'u',
      props_json: '{}', breadcrumbs_json: '[]', original_json: '{}',
      count: 5, first_seen: 1, last_seen: 2, resolution_notes: null
    },
    similar: [
      { fingerprint: 'fp-0', status: 'resolved', app_id: 'a', release_name: '1.0', name: 'TypeError', message: 'Cannot read y', count: 3, first_seen: 1, last_seen: 2, resolution_notes: '列表初始化' }
    ]
  })
  const gateway = modelGateway(async (sys, user) => {
    assert.ok(user.includes('当前 issue'))
    assert.ok(user.includes('相似历史 issue'))
    return { model: 'm', provider: 'p', content: JSON.stringify({ summary: '列表未初始化', hypotheses: [{ cause: 'x', confidence: 0.7, evidence: ['kb:fp-0'] }], suggestions: [], relatedKb: [] }) }
  })
  const d = createDiagnoser({ db, gateway, kb: { search: async () => [] }, embedder: {} })

  const res = await d.error({ issueId: 'fp-1', appId: 'a' })
  assert.equal(res.summary, '列表未初始化')
  assert.equal(res.degraded, false)
})

test('缓存：同 ref 10 分钟内命中，不重复调用模型', async () => {
  const diagnosisRow = {
    ref_type: 'error', ref_id: 'fp-c', app_id: 'a', request_summary: '{}',
    response_json: JSON.stringify({ summary: '缓存命中' }), model: 'm', confidence: 0.9,
    degraded: 0, created_at: Date.now() - 1000
  }
  const db = buildDb({ diagnosis: diagnosisRow, issue: null })
  const gateway = modelGateway(async () => { throw new Error('不应被调用（应有缓存）') })
  const d = createDiagnoser({ db, gateway, kb: { search: async () => [] }, embedder: {} })
  const res = await d.error({ issueId: 'fp-c', appId: 'a' })
  assert.equal(res.summary, '缓存命中')
  assert.equal(res.refId, 'fp-c')
})

test('降级：模型不可用抛错，由上层转降级响应', async () => {
  const db = buildDb({ issue: { fingerprint: 'fp-2', app_id: 'a', release_name: '1', name: 'E', message: 'm', stack: 's', first_seen: 1, last_seen: 2 } })
  const gateway = modelGateway(async () => { throw new Error('llm down') })
  const d = createDiagnoser({ db, gateway, kb: { search: async () => [] }, embedder: {} })
  await assert.rejects(() => d.error({ issueId: 'fp-2', appId: 'a' }))
})

test('参数校验：无任何标识抛 400', async () => {
  const db = buildDb({})
  const gateway = modelGateway(async () => ({ content: '{}' }))
  const d = createDiagnoser({ db, gateway, kb: { search: async () => [] }, embedder: {} })
  await assert.rejects(() => d.error({ issueId: null, errorText: null }), err => err.status === 400)
})

test('丢失 trace（无错误/无节点）返回降级上下文而非报错', async () => {
  const db = buildDb({ events: [] })
  const gateway = modelGateway(async () => { throw new Error('不应调用模型') })
  const d = createDiagnoser({ db, gateway, kb: { search: async () => [] }, embedder: {} })
  const res = await d.trace({ traceId: 'none', appId: 'a' })
  assert.equal(res.degraded, true)
})
