// C1 (OpenTelemetry 导出) 回归测试：OTLP/HTTP + JSON 的 trace 与 metrics 导出。
// 覆盖 span → OTLP JSON 映射、Resource/Scope 结构、导出采样（按 traceId 确定性）、
// 自定义头/credentials:omit、metrics 缓冲批处理（add/flush/shutdown）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Span, SpanKind, SpanStatusCode } from '../src/trace/span.js'
import { TraceContext } from '../src/trace/context.js'
import { OtlpTraceExporter, spanToOtlp, spansToOtlpJson } from '../src/trace/otlp-trace-exporter.js'
import { OtlpMetricsExporter, RumMetricBatcher } from '../src/trace/otlp-metrics-exporter.js'

// 最小浏览器垫片（与 exporter.test.js 一致）
globalThis.window = globalThis
globalThis.location = { href: 'http://192.168.17.45:3000/trade', origin: 'http://192.168.17.45:3000' }
globalThis.performance = globalThis.performance || { now: () => Date.now() }
if (typeof globalThis.Headers === 'undefined') {
  globalThis.Headers = class { constructor (h) { this.h = {}; if (h) for (const k in h) this.h[k.toLowerCase()] = h[k] } set (k, v) { this.h[k.toLowerCase()] = v } get (k) { return this.h[k.toLowerCase()] } }
}

function endedSpan (name, ctxOpts = {}, attrs = {}) {
  const ctx = new TraceContext({ traceId: 'trace-x', spanId: 'sx' + Math.random().toString(36).slice(2, 10), parentSpanId: 'sparent', traceFlags: '01', baggage: new Map(), ...ctxOpts })
  const span = new Span({ name, context: ctx, kind: 'CLIENT', attributes: attrs })
  span.end()
  return span
}

function makeFetch () {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({}) }
  }
  return { fetchImpl, calls }
}

test('spanToOtlp 映射标准字段（kind/status/parent/时间戳纳秒）', () => {
  const ctx = new TraceContext({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), parentSpanId: 'c'.repeat(16), traceFlags: '01', baggage: new Map() })
  const span = new Span({ name: 'GET /x', context: ctx, kind: 'SERVER', attributes: { 'http.status_code': 200, ok: true, ratio: 0.5 } })
  span.setStatus(SpanStatusCode.ERROR, 'boom')
  span.end()
  const o = spanToOtlp(span)

  assert.equal(o.traceId, 'a'.repeat(32))
  assert.equal(o.spanId, 'b'.repeat(16))
  assert.equal(o.parentSpanId, 'c'.repeat(16))
  assert.equal(o.name, 'GET /x')
  assert.equal(o.kind, 2, 'SERVER → 2')
  assert.equal(o.status.code, 2, 'ERROR → 2')
  assert.equal(o.status.message, 'boom')
  // 纳秒为字符串且约等于 epoch 毫秒 * 1e6
  assert.ok(/^\d+$/.test(o.startTimeUnixNano))
  assert.ok(Number(o.startTimeUnixNano) >= span.startEpoch * 1e6)
  const httpAttr = o.attributes.find((a) => a.key === 'http.status_code')
  assert.equal(httpAttr.value.intValue, '200')
  const okAttr = o.attributes.find((a) => a.key === 'ok')
  assert.equal(okAttr.value.boolValue, true)
  const ratioAttr = o.attributes.find((a) => a.key === 'ratio')
  assert.equal(ratioAttr.value.doubleValue, 0.5)
})

test('spansToOtlpJson 组装 resourceSpans/scopeSpans 结构', () => {
  const json = spansToOtlpJson([endedSpan('op')], { serviceName: 'frontend', sdkVersion: '9.9.9' }, { name: 'web-collection-sdk', version: '9.9.9' }, 'production')
  assert.equal(json.resourceSpans.length, 1)
  const rs = json.resourceSpans[0]
  const svc = rs.resource.attributes.find((a) => a.key === 'service.name')
  assert.equal(svc.value.stringValue, 'frontend')
  assert.ok(rs.resource.attributes.find((a) => a.key === 'telemetry.sdk.name'))
  assert.equal(rs.scopeSpans.length, 1)
  assert.equal(rs.scopeSpans[0].scope.name, 'web-collection-sdk')
  assert.equal(rs.scopeSpans[0].spans.length, 1)
  assert.equal(rs.scopeSpans[0].spans[0].name, 'op')
})

test('OtlpTraceExporter.export 以 JSON POST 到客户端点（content-type/自定义头/credentials:omit）', async () => {
  const { fetchImpl, calls } = makeFetch()
  const exporter = new OtlpTraceExporter({ endpoint: 'https://otlp.customer.com/v1/traces', headers: { 'x-api-key': 'secret' }, fetchImpl })
  const res = await exporter.export([endedSpan('op')])
  assert.equal(res.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://otlp.customer.com/v1/traces')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.equal(calls[0].init.headers['x-api-key'], 'secret')
  assert.equal(calls[0].init.credentials, 'omit')
  const body = JSON.parse(calls[0].init.body)
  assert.ok(body.resourceSpans[0].scopeSpans[0].spans[0])
})

test('OtlpTraceExporter 按 traceId 确定性导出采样（samplingRate=0 全部丢弃）', async () => {
  const { fetchImpl } = makeFetch()
  const exporter = new OtlpTraceExporter({ endpoint: 'https://x/v1/traces', fetchImpl, samplingRate: 0 })
  const r = await exporter.export([endedSpan('a', { traceId: 't1' }), endedSpan('b', { traceId: 't1' }), endedSpan('c', { traceId: 't1' })])
  assert.equal(r.ok, true)
  assert.equal(r.count, 0)
  assert.equal(r.droppedBySample, 3)
})

test('OtlpTraceExporter 同 traceId 多 Span 采样决策一致（samplingRate=0.5）', async () => {
  const { fetchImpl, calls } = makeFetch()
  const exporter = new OtlpTraceExporter({ endpoint: 'https://x/v1/traces', fetchImpl, samplingRate: 0.5 })
  const r = await exporter.export([endedSpan('a', { traceId: 'same' }), endedSpan('b', { traceId: 'same' }), endedSpan('c', { traceId: 'same' })])
  // 同一 traceId 要么全保留要么全丢弃，绝不部分拆分
  assert.ok(r.count === 0 || r.count === 3, `同链路应一致保留/丢弃，实际 count=${r.count}`)
  assert.equal(calls.length, r.count > 0 ? 1 : 0)
})

test('OtlpMetricsExporter.export 组装 resourceMetrics 并以 JSON POST', async () => {
  const { fetchImpl, calls } = makeFetch()
  const exporter = new OtlpMetricsExporter({ endpoint: 'https://otlp.customer.com/v1/metrics', headers: { 'x-api-key': 'k' }, fetchImpl })
  const r = await exporter.export([{ name: 'lcp', value: 1234, timeUnixNano: String(1234567890000000) }])
  assert.equal(r.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://otlp.customer.com/v1/metrics')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.resourceMetrics.length, 1)
  assert.equal(body.resourceMetrics[0].scopeMetrics[0].metrics[0].name, 'lcp')
  assert.equal(body.resourceMetrics[0].scopeMetrics[0].metrics[0].gauge.dataPoints[0].asDouble, 1234)
})

test('RumMetricBatcher add/flush/shutdown 正确批处理并清空缓冲', async () => {
  const { fetchImpl, calls } = makeFetch()
  const exporter = new OtlpMetricsExporter({ endpoint: 'https://x/v1/metrics', fetchImpl })
  const batcher = new RumMetricBatcher(exporter, { flushIntervalMillis: 0, maxBatchSize: 1000 })
  batcher.add('fcp', 500)
  batcher.add('cls', 0.1)
  assert.equal(batcher._buffer.length, 2)
  const r = await batcher.flush()
  assert.equal(r.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(JSON.parse(calls[0].init.body).resourceMetrics[0].scopeMetrics[0].metrics.length, 2)
  assert.equal(batcher._buffer.length, 0)
  await batcher.shutdown()
  assert.equal(batcher._shutdown, true)
})

// 回归：shutdown() 曾因「先置 _shutdown 再调 flush()，而 flush() 首行以 _shutdown 早退」
// 导致剩余缓冲整批丢弃（远程配置重装配时 metrics 全丢）。此处固化「shutdown 必须发出剩余点」。
test('RumMetricBatcher.shutdown 冲刷剩余缓冲（回归：置位顺序曾致整批丢弃）', async () => {
  const { fetchImpl, calls } = makeFetch()
  const exporter = new OtlpMetricsExporter({ endpoint: 'https://x/v1/metrics', fetchImpl })
  const batcher = new RumMetricBatcher(exporter, { flushIntervalMillis: 0, maxBatchSize: 1000 })
  batcher.add('fcp', 500)
  batcher.add('cls', 0.1)
  assert.equal(batcher._buffer.length, 2)

  const r = await batcher.shutdown()
  assert.equal(r.ok, true)
  assert.equal(r.count, 2, 'shutdown 必须把剩余 2 个点冲刷出去')
  assert.equal(calls.length, 1, 'shutdown 应触发一次导出请求')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.resourceMetrics[0].scopeMetrics[0].metrics.length, 2)
  assert.equal(batcher._buffer.length, 0)
  assert.equal(batcher._shutdown, true)

  // 置位后拒绝新点；重复 shutdown 幂等（缓冲已空）
  batcher.add('late', 1)
  assert.equal(batcher._buffer.length, 0, 'shutdown 后不应再接收新点')
  const again = await batcher.shutdown()
  assert.equal(again.count, 0)
  assert.equal(calls.length, 1, '重复 shutdown 不应重复发送')
})
