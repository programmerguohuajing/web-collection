import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDistributedTrace, getDistributedTrace } from '../packages/ai/queries.js'
import { buildDistributedTrace as workerBuild } from '../cloudflare/worker.js'

/**
 * M5b：后端 span 上报到 Cloudflare
 * - buildDistributedTrace 支持 events + backendSpans 合并（跨服务诊断）
 * - getDistributedTrace 并行查 events + spans
 * - worker.js 与 queries.js 共享同一实现（re-export）
 */
test('buildDistributedTrace 合并后端 spans（service 标记 + 错误传播）', () => {
  const events = [
    { id: 'e1', ts: 1000, type: 'perf', metric: 'lcp', value: 2000, span_id: 'front-1', parent_span_id: '', props_json: '{}' },
    { id: 'e2', ts: 1500, type: 'error', span_id: 'front-1', parent_span_id: '', props_json: '{"failed":true}', name: 'TypeError', message: 'x', stack: 's' }
  ]
  const backendSpans = [
    { id: 's1', trace_id: 't', span_id: 'be-1', parent_span_id: 'front-1', service_name: 'svc-order', operation_name: 'GET /api/order', kind: 'SERVER', start_ts: 1200, duration: 300, status_code: 'ERROR', status_message: 'db timeout', attributes_json: '{"http.status_code":500}' }
  ]
  const t = buildDistributedTrace(events, backendSpans)
  // 后端 span 成为节点，service 标记
  const be = t.nodes.find(n => n.id === 'be-1')
  assert.ok(be)
  assert.equal(be.service, 'svc-order')
  assert.equal(be.kind, 'SERVER')
  assert.equal(be.hasError, true)
  // 前端 error span 也在
  const fe = t.nodes.find(n => n.id === 'front-1')
  assert.ok(fe)
  assert.equal(fe.hasError, true)
  // 边：backend 挂在 frontend 下
  assert.ok(t.edges.some(e => e.source === 'front-1' && e.target === 'be-1'))
  // errorSpans 包含前后端
  assert.ok(t.errorSpans.includes('be-1'))
  assert.ok(t.errorSpans.includes('front-1'))
})

test('buildDistributedTrace 纯 events 与合并版对无 spans 时输出等价（向前兼容）', () => {
  const events = [
    { id: 'e1', ts: 1000, type: 'perf', metric: 'lcp', value: 2000, span_id: 's-1', parent_span_id: '', props_json: '{}' }
  ]
  const a = buildDistributedTrace(events)
  const b = buildDistributedTrace(events, [])
  assert.deepEqual(a, b)
  assert.equal(a.nodes[0].service, 'frontend')
})

test('worker.js 与 queries.js 的 buildDistributedTrace 是同一实现（re-export）', () => {
  const events = [{ id: 'e1', ts: 1, type: 'perf', metric: 'lcp', value: 1, span_id: 's', parent_span_id: '', props_json: '{}' }]
  const backendSpans = [{ id: 'b1', trace_id: 't', span_id: 'be', parent_span_id: 's', service_name: 'api', operation_name: 'op', kind: 'SERVER', start_ts: 2, duration: 1, status_code: 'OK', attributes_json: '{}' }]
  assert.deepEqual(workerBuild(events, backendSpans), buildDistributedTrace(events, backendSpans))
})

test('getDistributedTrace 并行查 events 与 spans 并合并', async () => {
  let queries = []
  const db = {
    prepare(sql) {
      const stmt = {
        bind(...v) { this._v = v; return this },
        async all() {
          queries.push(sql)
          if (sql.includes('from spans')) return [
            { id: 'b1', trace_id: 't', span_id: 'be-1', parent_span_id: 'front-1', service_name: 'svc-cart', operation_name: 'POST /cart', kind: 'SERVER', start_ts: 100, duration: 20, status_code: 'ERROR', status_message: 'err', attributes_json: '{}' }
          ]
          return [
            { id: 'e1', ts: 50, type: 'error', span_id: 'front-1', parent_span_id: '', props_json: '{"failed":true}', name: 'E', message: 'm' }
          ]
        },
        async first() { return null },
        async run() { return { changes: 0 } }
      }
      return stmt
    }
  }
  const t = await getDistributedTrace(db, 't')
  assert.ok(queries.some(q => q.includes('from spans')))
  assert.ok(queries.some(q => q.includes('from events')))
  // 合并了后端 svc-cart span
  assert.ok(t.nodes.some(n => n.service === 'svc-cart'))
  assert.ok(t.nodes.some(n => n.service === 'frontend'))
  assert.ok(t.errorSpans.length >= 2) // frontend error + backend error
})
