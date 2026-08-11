// Phase 2 (SDK-202) 回归测试：Span Processor / Exporter 闭环
// 覆盖 Span.toExport、WebCollectionSpanExporter（v2 信封 + 错误隔离）、
// BatchSpanProcessor（达量触发 / forceFlush / shutdown / 异常不抛出）、
// Tracer 经 Processor 导出自定义 Span（父子正确）、
// 自动请求 Span 经同一 Processor 导出（不再只靠 perf event「猜」Span）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Span, SpanStatusCode } from '../src/trace/span.js'
import { Tracer, createTracer } from '../src/trace/tracer.js'
import { TraceContext } from '../src/trace/context.js'
import { BatchSpanProcessor, WebCollectionSpanExporter, DEFAULT_RESOURCE } from '../src/trace/processor.js'
import { setupFetchMonitor } from '../src/performance/fetch.js'

// 最小浏览器垫片
globalThis.window = globalThis
globalThis.location = { href: 'http://192.168.17.45:3000/trade', origin: 'http://192.168.17.45:3000' }
globalThis.performance = globalThis.performance || { now: () => Date.now(), getEntriesByName: () => [] }
globalThis.Headers = globalThis.Headers || class {
  constructor (h) { this.h = {}; if (h) for (const k in h) this.h[k.toLowerCase()] = h[k] }
  set (k, v) { this.h[k.toLowerCase()] = v }
  get (k) { return this.h[k.toLowerCase()] }
}
globalThis.URL = URL
globalThis.document = { addEventListener () {}, removeEventListener () {}, hidden: false }
Object.defineProperty(globalThis, 'navigator', { value: { sendBeacon: () => true }, configurable: true, writable: true })
globalThis.localStorage = { getItem: () => null, setItem () {}, removeItem () {} }
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0)
globalThis.addEventListener = globalThis.addEventListener || (() => {})
globalThis.removeEventListener = globalThis.removeEventListener || (() => {})

function endedSpan (name, ctxOpts = {}, attrs = {}) {
  const ctx = new TraceContext({ traceId: 'trace-x', spanId: 's-' + Math.random().toString(36).slice(2, 10), parentSpanId: '', traceFlags: '01', baggage: new Map(), ...ctxOpts })
  const span = new Span({ name, context: ctx, kind: 'INTERNAL', attributes: attrs })
  span.end()
  return span
}

test('Span.toExport 生成与后端 normalizeSpan 对齐的 wire 记录', () => {
  const ctx = new TraceContext({ traceId: 't1', spanId: 's1', parentSpanId: '', traceFlags: '01', baggage: new Map() })
  const span = new Span({ name: 'op', context: ctx, kind: 'CLIENT', attributes: { 'http.url': 'http://x/y' } })
  span.setStatus(SpanStatusCode.ERROR, 'boom')
  span.end()
  const rec = span.toExport({ serviceName: 'frontend' })

  assert.equal(rec.id, 't1-s1')
  assert.equal(rec.traceId, 't1')
  assert.equal(rec.spanId, 's1')
  assert.equal(rec.parentSpanId, '')
  assert.equal(rec.serviceName, 'frontend')
  assert.equal(rec.operationName, 'op')
  assert.equal(rec.kind, 'CLIENT')
  assert.equal(rec.statusCode, 'ERROR')
  assert.equal(rec.statusMessage, 'boom')
  assert.equal(rec.attributes['http.url'], 'http://x/y')
  assert.ok(Number.isFinite(rec.startTime), 'startTime 应为 epoch 毫秒')
  assert.ok(rec.duration >= 0, 'duration 应 >= 0')
})

test('WebCollectionSpanExporter 发送 v2 信封并调用 send', async () => {
  const sent = []
  const exporter = new WebCollectionSpanExporter({ send: async (p) => { sent.push(p); return { ok: true } } })
  const span = endedSpan('op')
  const result = await exporter.export([span])

  assert.equal(result.ok, true)
  assert.equal(result.count, 1)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].schemaVersion, 2)
  assert.equal(sent[0].resource.serviceName, 'frontend')
  assert.equal(sent[0].spans[0].spanId, span.context.spanId)
  assert.equal(sent[0].spans[0].id, `${span.context.traceId}-${span.context.spanId}`)
})

test('WebCollectionSpanExporter 错误隔离返回 ok:false', async () => {
  const exporter = new WebCollectionSpanExporter({ send: async () => { throw new Error('net down') } })
  const res = await exporter.export([endedSpan('op')])
  assert.equal(res.ok, false)
  assert.match(res.error, /net down/)
})

test('WebCollectionSpanExporter 空批不调用 send', async () => {
  let called = false
  const exporter = new WebCollectionSpanExporter({ send: async () => { called = true } })
  const res = await exporter.export([])
  assert.equal(res.ok, true)
  assert.equal(res.count, 0)
  assert.equal(called, false)
})

test('DEFAULT_RESOURCE.serviceName 为 frontend', () => {
  assert.equal(DEFAULT_RESOURCE.serviceName, 'frontend')
})

test('BatchSpanProcessor 达量触发 export 并清空缓冲', async () => {
  const exported = []
  const exporter = { export: async (spans) => { exported.push(...spans); return { ok: true, count: spans.length } } }
  const bp = new BatchSpanProcessor(exporter, { maxExportBatchSize: 3, scheduledDelayMillis: 100000 })

  bp.onEnd(endedSpan('a'))
  bp.onEnd(endedSpan('b'))
  assert.equal(exported.length, 0, '未达量不应导出')

  bp.onEnd(endedSpan('c'))
  assert.equal(exported.length, 3, '达量应立即触发导出')
})

test('BatchSpanProcessor forceFlush / shutdown 冲刷剩余缓冲', async () => {
  const batches = []
  const exporter = { export: async (spans) => { batches.push(spans); return { ok: true, count: spans.length } } }
  const bp = new BatchSpanProcessor(exporter, { maxExportBatchSize: 100, scheduledDelayMillis: 100000 })

  bp.onEnd(endedSpan('a'))
  bp.onEnd(endedSpan('b'))
  await bp.shutdown()
  assert.equal(batches.length, 1, 'shutdown 应输出一个批次')
  assert.equal(batches[0].length, 2)
})

test('BatchSpanProcessor 导出异常不向上抛出', () => {
  const exporter = { export: async () => { throw new Error('x') } }
  const bp = new BatchSpanProcessor(exporter, { maxExportBatchSize: 1 })
  // maxExportBatchSize=1 时 onEnd 立即触发 forceFlush（内部吞掉异常）
  assert.doesNotThrow(() => bp.onEnd(endedSpan('a')))
})

test('Tracer 经 SpanProcessor 导出自定义 Span（父子关系正确）', async () => {
  const captured = []
  const exporter = { export: async (spans) => { captured.push(...spans); return { ok: true, count: spans.length } } }
  const tracer = createTracer({ name: 't', traceId: 'trace-1' })
  tracer.addSpanProcessor(new BatchSpanProcessor(exporter, { maxExportBatchSize: 100, scheduledDelayMillis: 100000 }))
  tracer.createRootSpan('page')

  tracer.withSpan('child', (span) => { span.setAttribute('k', 'v') })
  await tracer.flushSpans()

  const rootSpanId = tracer.getRootSpan().context.spanId
  const recs = captured.map((s) => s.toExport({ serviceName: 'frontend' }))
  const child = recs.find((r) => r.operationName === 'child')
  assert.ok(child, '子 Span 应被导出')
  assert.equal(child.traceId, 'trace-1')
  assert.equal(child.parentSpanId, rootSpanId, '子 Span 的父应指向根 Span')
  assert.equal(child.attributes.k, 'v')
})

test('自动请求 Span 经同一 Processor 导出（不再只靠 perf event）', async () => {
  const captured = []
  const exporter = { export: async (spans) => { captured.push(...spans); return { ok: true, count: spans.length } } }
  const tracer = createTracer({ name: 't', traceId: 'trace-2' })
  tracer.addSpanProcessor(new BatchSpanProcessor(exporter, { maxExportBatchSize: 100, scheduledDelayMillis: 100000 }))
  tracer.createRootSpan('page')

  const originalFetch = async () => ({ status: 200, ok: true, headers: { get: () => null } })
  const metric = () => {}
  const error = () => {}
  setupFetchMonitor({
    originalFetch,
    endpoint: 'https://collect.example.com/api/collect',
    metric,
    error,
    tracing: true,
    traceOrigins: [],
    pageTraceId: 'trace-2',
    requestAllowlist: [],
    tracer
  })

  await window.fetch('http://192.168.17.45:3000/api/order')
  await tracer.flushSpans()

  const rootSpanId = tracer.getRootSpan().context.spanId
  const recs = captured.map((s) => s.toExport({ serviceName: 'frontend' }))
  const reqSpan = recs.find((r) => r.kind === 'CLIENT' && String(r.attributes['http.url'] || '').includes('/api/order'))
  assert.ok(reqSpan, '自动请求应导出 CLIENT Span')
  assert.equal(reqSpan.traceId, 'trace-2')
  assert.equal(reqSpan.parentSpanId, rootSpanId, '请求 Span 的父应指向根 Span')
})
