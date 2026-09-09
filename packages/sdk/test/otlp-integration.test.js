// C1 集成回归：createEys + OTLP 导出端到端（复用 init-smoke 的浏览器桩）。
// 守护：otlp 开启后 trace spans / RUM metrics 经 OTLP/HTTP+JSON 增量导出到客户端点，
// 且不改动既有采集（/api/collect 仍走原通道）；service.name 取 appId；导出位置为浏览器直发。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEys } from '../src/index.js'

// 复刻 init-smoke 的富 DOM 桩（createEys 初始化所需浏览器全局）。
function installDom() {
  const saved = {}
  const define = (k, v) => {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k)
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true })
  }
  const noop = () => {}
  const doc = {
    title: '', hidden: false, visibilityState: 'visible', readyState: 'complete', referrer: '',
    addEventListener: noop, removeEventListener: noop,
    querySelector: () => null, querySelectorAll: () => [],
    matches: () => false,
    createElement: () => ({ style: {}, setAttribute: noop, appendChild: noop }),
    head: {}, body: {},
    documentElement: { nodeType: 1, matches: () => false, querySelectorAll: () => [], addEventListener: noop, appendChild: noop }
  }
  define('window', globalThis)
  define('document', doc)
  define('location', { href: 'https://example.com/', pathname: '/', referrer: '', origin: 'https://example.com' })
  define('navigator', { userAgent: 'node', sendBeacon: () => true })
  define('performance', globalThis.performance || { now: () => Date.now(), getEntriesByType: () => [], getEntriesByName: () => [] })
  define('addEventListener', noop)
  define('removeEventListener', noop)
  define('requestAnimationFrame', (cb) => cb(Date.now()))
  define('BroadcastChannel', class { constructor() {} postMessage() {} close() {} addEventListener() {} })
  define('localStorage', { getItem: () => null, setItem: noop, removeItem: noop })
  define('MutationObserver', class { constructor() {} observe() {} disconnect() {} })
  define('PerformanceObserver', class { constructor() {} observe() {} disconnect() {} })
  define('IntersectionObserver', class { constructor(cb) { this.cb = cb } observe() {} unobserve() {} disconnect() {} })
  const XHR = class { constructor() { this.addEventListener = noop } open() {} send() {} }
  XHR.prototype.open = function () {}
  XHR.prototype.send = function () {}
  define('XMLHttpRequest', XHR)
  define('Headers', globalThis.Headers || class { constructor(h) { this.h = {}; if (h) for (const k in h) this.h[k.toLowerCase()] = h[k] } set(k, v) { this.h[k.toLowerCase()] = v } get(k) { return this.h[k.toLowerCase()] } })
  define('URL', globalThis.URL || URL)
  return { saved }
}
async function uninstallDom(saved) {
  await new Promise(r => setTimeout(r, 0))
  for (const k of Object.keys(saved)) {
    if (saved[k]) Object.defineProperty(globalThis, k, saved[k])
    else delete globalThis[k]
  }
  delete globalThis.fetch
}

test('otlp 开启后 trace span 经 OTLP/HTTP+JSON 直发到客户端点（service.name=appId）', async () => {
  const env = installDom()
  const calls = []
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({}) } }
  try {
    const eys = createEys({
      appId: 'acme-app',
      endpoint: '/api/collect',
      exposure: false, requests: false, replay: false,
      otlp: { enabled: true, endpoint: 'https://otlp.acme.com/v1/traces', headers: { 'x-api-key': 'k' } }
    })
    // 经受支持的公共 API withSpan 结束 span（会走 tracer.endSpan → 通知各 Processor 导出）。
    // 注：直接 span.end() 不会通知 tracer 的 Processor（既有语义，WebCollection 导出同样依赖 withSpan/endSpan）。
    eys.withSpan('checkout', (span) => { span.setAttribute('amount', 1) })
    await eys.flushSpans()

    const otlpCall = calls.find(c => String(c.url).includes('otlp.acme.com'))
    assert.ok(otlpCall, '应出现发往客户 OTLP 端点的请求')
    assert.equal(otlpCall.init.headers['content-type'], 'application/json')
    assert.equal(otlpCall.init.headers['x-api-key'], 'k')
    assert.equal(otlpCall.init.credentials, 'omit')
    const body = JSON.parse(otlpCall.init.body)
    const svc = body.resourceSpans[0].resource.attributes.find(a => a.key === 'service.name')
    assert.equal(svc.value.stringValue, 'acme-app')
    const exportedSpan = body.resourceSpans[0].scopeSpans[0].spans.find(s => s.name === 'checkout')
    assert.ok(exportedSpan, 'checkout span 应被导出')
    await eys.destroy()
  } finally {
    await uninstallDom(env.saved)
  }
})

test('otlp 开启后 RUM metric 增量导出（destroy 冲刷 metrics 缓冲）', async () => {
  const env = installDom()
  const calls = []
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({}) } }
  try {
    const eys = createEys({
      appId: 'acme-app',
      endpoint: '/api/collect',
      exposure: false, requests: false, replay: false,
      otlp: { enabled: true, endpoint: 'https://otlp.acme.com/v1/traces', metrics: true }
    })
    eys.metric('lcp', 1234)
    await eys.destroy()

    const metricsCall = calls.find(c => String(c.url).includes('otlp.acme.com') && String(c.init.body).includes('resourceMetrics'))
    assert.ok(metricsCall, '应出现发往客户 metrics 端点的请求（/v1/metrics 由 /v1/traces 推导）')
    const body = JSON.parse(metricsCall.init.body)
    const lcp = body.resourceMetrics[0].scopeMetrics[0].metrics.find(m => m.name === 'lcp')
    assert.ok(lcp, 'lcp 指标应被导出')
    assert.equal(lcp.gauge.dataPoints[0].asDouble, 1234)
  } finally {
    await uninstallDom(env.saved)
  }
})

test('otlp 默认关闭时不向任何客户端点发送（仅走既有 /api/collect）', async () => {
  const env = installDom()
  const calls = []
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({}) } }
  try {
    const eys = createEys({ appId: 'acme-app', endpoint: '/api/collect', exposure: false, requests: false, replay: false })
    const span = eys.startSpan('noop')
    span.end()
    await eys.flushSpans()
    await eys.destroy()
    // 不应有任何指向外部 OTLP 域的请求
    assert.equal(calls.filter(c => String(c.url).includes('otlp.')).length, 0, '默认关闭不应导出到 OTLP 端点')
  } finally {
    await uninstallDom(env.saved)
  }
})

// 回归：远程配置下发 otlp 会触发 teardownOtlp 重装配。旧 metrics batcher 必须先冲刷再关闭，
// 否则已缓冲的 RUM metrics 整批丢失（曾因 shutdown 先置位致 flush 早退）。
test('远程配置重装配触发 teardown 时 metrics 仍被冲刷发出（不丢批）', async () => {
  const env = installDom()
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    const isConfig = String(url).includes('/sdk-config')
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => (isConfig
        ? { config_version: 7, ttl_ms: 300000, otlp: { enabled: true, endpoint: 'https://otlp.acme.com/v1/traces', metrics: true } }
        : {})
    }
  }
  try {
    const eys = createEys({
      appId: 'acme-app',
      endpoint: '/api/collect',
      exposure: false, requests: false, replay: false,
      otlp: { enabled: true, endpoint: 'https://otlp.acme.com/v1/traces', metrics: true }
    })
    eys.metric('lcp', 1234)
    // 等远程配置轮询返回 → applyRemoteConfig → setupOtlpPipeline → teardownOtlp（冲刷旧 batcher）
    await new Promise(r => setTimeout(r, 10))
    await eys.destroy()

    const metricsCalls = calls.filter(c => String(c.init?.body || '').includes('resourceMetrics'))
    assert.ok(metricsCalls.length >= 1, 'teardown 不应丢弃已缓冲的 metrics')
    assert.ok(
      metricsCalls.some(c => String(c.init.body).includes('"lcp"')),
      'lcp 指标必须在 teardown 的冲刷中真正发出'
    )
  } finally {
    await uninstallDom(env.saved)
  }
})
