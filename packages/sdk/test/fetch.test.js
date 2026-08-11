// 回归测试：fetch 监控必须产出带 spanId + parentSpanId 的事件，且不能因 const 重赋值崩溃
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTracer } from '../src/trace/tracer.js'
import { setupFetchMonitor } from '../src/performance/fetch.js'

// 最小浏览器垫片
globalThis.window = globalThis
globalThis.location = { href: 'http://192.168.17.45:3000/trade/order/confirm', origin: 'http://192.168.17.45:3000' }
globalThis.performance = globalThis.performance || { now: () => Date.now(), getEntriesByName: () => [] }
globalThis.Headers = globalThis.Headers || class {
  constructor (h) { this.h = {}; if (h) for (const k in h) this.h[k.toLowerCase()] = h[k] }
  set (k, v) { this.h[k.toLowerCase()] = v }
  get (k) { return this.h[k.toLowerCase()] }
}
globalThis.URL = URL

test('traced fetch emits event with spanId and parentSpanId', async () => {
  const captured = []
  const tracer = createTracer({ name: 't', version: '0.1.13', traceId: 'ed238df38c1d1dd21f2bf25bf48ebe96' })
  tracer.createRootSpan('page')

  const originalFetch = async () => ({ status: 200, ok: true, headers: { get: () => null } })
  setupFetchMonitor({
    originalFetch,
    endpoint: 'https://collect.example.com/api/collect',
    metric: (name, value, props) => captured.push({ name, props }),
    error: () => {},
    tracing: true,
    traceOrigins: [],
    pageTraceId: 'ed238df38c1d1dd21f2bf25bf48ebe96',
    requestAllowlist: [],
    tracer
  })

  // 触发一次同源 fetch（不应抛异常）
  const res = await window.fetch('http://192.168.17.45:3000/api/auth/session')
  assert.equal(res.status, 200)

  const fetchEvent = captured.find(e => e.name === 'fetch')
  assert.ok(fetchEvent, '应产出 fetch 事件')
  assert.ok(fetchEvent.props.__spanId, 'fetch 事件必须带 spanId')
  assert.ok(fetchEvent.props.__parentSpanId, 'fetch 事件必须带 parentSpanId（指向根 span）')
  assert.equal(fetchEvent.props.__traceId, 'ed238df38c1d1dd21f2bf25bf48ebe96')
})
