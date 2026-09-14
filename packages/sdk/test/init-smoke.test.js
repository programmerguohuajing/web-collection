/**
 * 初始化冒烟回归测试（init-smoke）
 *
 * 覆盖此前两个 release 阻断 bug：
 *  1) requireCapability 被错误地置于模块顶层，却引用 createEys 作用域内的
 *     webCapabilities / diagnostic → createEys({exposure:true}) 抛
 *     「webCapabilities is not defined」。修复后 requireCapability 已移入 createEys 内部。
 *  2) performance/index.js 调用 setupServerTimingMonitor 却未 import → requests:true
 *     时整段请求监控分支抛 ReferenceError，被 safe('performance') 静默吞掉。
 *     修复后 performance/index.js 已补 import，请求监控（含 fetch 包装）正常执行。
 *
 * 现有 capabilities-identity 的 web 测试传 exposure:false，从不走到 requireCapability，
 * 故未能暴露上述 bug；本文件专门以 exposure:true / requests:true 复现并守护。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEys } from '../src/index.js'
import { SDK_VERSION } from '../src/core/event.js'

function createEysForTest(opts) {
  return createEys({ appId: 'smoke', endpoint: '/api/collect', ...opts })
}

// 富 DOM 桩：覆盖 createEys 初始化所需的浏览器全局。
// 通过 opts.hasIO 控制是否提供 IntersectionObserver（能力位门控的关键）。
function installDom(opts = {}) {
  const saved = {}
  const define = (k, v) => {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k)
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true })
  }
  const noop = () => {}
  // 事件注册表：让 window/document 监听可被测试观察（注册/移除/派发），
  // 用于验证 destroy() 是否真正移除退出冲刷监听（防僵尸实例）。
  const winEvents = new Map()
  const docEvents = new Map()
  const trackAdd = (map) => (type, fn) => {
    if (!map.has(type)) map.set(type, new Set())
    map.get(type).add(fn)
  }
  const trackRemove = (map) => (type, fn) => {
    const set = map.get(type)
    if (set) set.delete(fn)
  }
  const doc = {
    title: '', hidden: false, visibilityState: 'visible', readyState: 'complete',
    referrer: '',
    addEventListener: trackAdd(docEvents), removeEventListener: trackRemove(docEvents),
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
  define('addEventListener', trackAdd(winEvents))
  define('removeEventListener', trackRemove(winEvents))
  // 同步 rAF：避免 teardown 后嵌套 rAF 定时器触发时全局已被卸载
  define('requestAnimationFrame', (cb) => cb(Date.now()))
  define('BroadcastChannel', class { constructor() {} postMessage() {} close() {} addEventListener() {} })
  define('localStorage', { getItem: () => null, setItem: noop, removeItem: noop })
  define('MutationObserver', class { constructor() {} observe() {} disconnect() {} })
  define('PerformanceObserver', class { constructor() {} observe() {} disconnect() {} })
  if (opts.hasIO !== false) {
    define('IntersectionObserver', class {
      constructor(cb) { this.cb = cb }
      observe() {} unobserve() {} disconnect() {}
    })
  }
  // XMLHttpRequest：xhr 监控会 patch prototype.open/send
  const XHR = class {
    constructor() { this.addEventListener = noop }
    open() {} send() {}
  }
  XHR.prototype.open = function () {}
  XHR.prototype.send = function () {}
  define('XMLHttpRequest', XHR)
  // fetch mock（保留引用以便比对是否被包装）
  const fetchMock = async () => ({ ok: true, status: 200, json: async () => ({}) })
  define('fetch', fetchMock)
  define('Headers', globalThis.Headers || class {
    constructor(h) { this.h = {}; if (h) for (const k in h) this.h[k.toLowerCase()] = h[k] }
    set(k, v) { this.h[k.toLowerCase()] = v }
    get(k) { return this.h[k.toLowerCase()] }
  })
  define('URL', globalThis.URL || URL)
  return { saved, fetchMock, winEvents, docEvents }
}

async function uninstallDom({ saved }) {
  // 等待可能残留的微任务/定时器（如 destroy 的退出刷新）结束，再卸载全局，避免悬空引用
  await new Promise(r => setTimeout(r, 0))
  for (const k of Object.keys(saved)) {
    if (saved[k]) Object.defineProperty(globalThis, k, saved[k])
    else delete globalThis[k]
  }
  delete globalThis.fetch
}

test('web: createEys({exposure:true, requests:true}) 在浏览器桩下成功实例化，不再抛 webCapabilities ReferenceError', async () => {
  const env = installDom({ hasIO: true })
  try {
    const eys = createEysForTest({ exposure: true, requests: true, replay: false, batchSize: 10 })
    assert.ok(typeof eys.getCapabilities === 'function')
    assert.ok(typeof eys.track === 'function')
    assert.ok(typeof eys.destroy === 'function')
    // 浏览器桩具备 IntersectionObserver → exposure 能力位应为 true
    assert.equal(eys.getCapabilities().exposure, true)
    await eys.destroy()
  } finally {
    await uninstallDom(env)
  }
})

test('web: requests:true 时 fetch 被包装（setupServerTimingMonitor 缺失依赖已补），证明请求监控分支真正执行', async () => {
  const env = installDom({ hasIO: true })
  const originalFetch = env.fetchMock
  try {
    const eys = createEysForTest({ exposure: true, requests: true, replay: false, batchSize: 10 })
    // 修复前：setupServerTimingMonitor 未 import → 请求分支抛错、fetch 从未被包装。
    // 修复后：请求分支执行到 setupFetchMonitor，window.fetch 被替换为包装函数。
    assert.notEqual(globalThis.fetch, originalFetch, 'window.fetch 应已被 fetch 监控包装')
    await eys.destroy()
  } finally {
    await uninstallDom(env)
  }
})

test('web: exposure:true 但无 IntersectionObserver 时走 diagnostic 分支也不抛 diagnostic ReferenceError', async () => {
  const env = installDom({ hasIO: false })
  try {
    const eys = createEysForTest({ exposure: true, requests: true, replay: false, batchSize: 10 })
    // 无 IO → 能力缺失，requireCapability 走 diagnostic.emit 分支（修复前此处抛 diagnostic is not defined）
    assert.equal(eys.getCapabilities().exposure, false)
    assert.ok(typeof eys.track === 'function')
    await eys.destroy()
  } finally {
    await uninstallDom(env)
  }
})

test('SDK_VERSION 非空且为合法版本串（防止手写常量漏改导致版本失真）', () => {
  // 直引 src（无构建 define）时回退 '0.0.0-dev'，真实值由构建产物 grep 校验。
  // 此处仅守护「不为 undefined / 空串」，真实值由构建产物 grep 校验。
  assert.equal(typeof SDK_VERSION, 'string')
  assert.ok(SDK_VERSION.length > 0, 'SDK_VERSION 不应为空')
  assert.match(SDK_VERSION, /^\d+\.\d+\.\d+/, 'SDK_VERSION 应为 semver 形态')
})

// ---------------------------------------------------------------------------
// destroy() 移除退出冲刷监听（回归：僵尸实例导致多个一直 pending 的 collect）
//
// 此前 pagehide/visibilitychange 以匿名函数注册且 destroy 不移除：应用重复
// 初始化 SDK（HMR / React StrictMode / SPA 重挂载）后，每个旧实例的监听器
// 仍存活——每次切后台，N 个僵尸实例同时各发一批 keepalive collect 请求，
// 浏览器 keepalive 配额被打满，Network 面板出现一排一直 pending 的 collect。
// ---------------------------------------------------------------------------
test('web: destroy() 移除 pagehide/visibilitychange 冲刷监听，重复初始化不再叠加僵尸发送者', async () => {
  const env = installDom({ hasIO: true })
  let collectPosts = 0
  try {
    // 计数 collect POST，模拟真实传输
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).includes('/api/collect') && (init.method || '') === 'POST') collectPosts++
      return { ok: true, status: 200, json: async () => ({}) }
    }
    const eys = createEysForTest({ replay: false, requests: false, exposure: false, batchSize: 10 })
    eys.track('before-destroy')
    // 销毁前 SDK 必须注册了退出冲刷监听（守卫测试自身有效性）
    assert.ok((env.winEvents.get('pagehide') || new Set()).size >= 1, 'window 应已注册 pagehide 监听')
    assert.ok((env.docEvents.get('visibilitychange') || new Set()).size >= 1, 'document 应已注册 visibilitychange 监听')
    const pagehideBefore = new Set(env.winEvents.get('pagehide') || [])
    const visibilityBefore = new Set(env.docEvents.get('visibilitychange') || [])
    await eys.destroy()
    // destroy 后：销毁前注册的监听必须全部移除（旧实例不再响应切后台/关页）
    const pagehideAfter = env.winEvents.get('pagehide') || new Set()
    const visibilityAfter = env.docEvents.get('visibilitychange') || new Set()
    for (const fn of pagehideBefore) {
      assert.ok(!pagehideAfter.has(fn), 'destroy 后 pagehide 监听应已移除')
    }
    for (const fn of visibilityBefore) {
      assert.ok(!visibilityAfter.has(fn), 'destroy 后 visibilitychange 监听应已移除')
    }
    // 功能性验证：模拟「切后台再切回再切后台 + 关页」不应产生任何新的 collect 请求
    const postsAfterDestroy = collectPosts
    const dispatchDoc = (type) => {
      for (const fn of [...(env.docEvents.get(type) || [])]) {
        try { fn({ type }) } catch { /* 与真实事件派发一致，单监听器异常不阻断 */ }
      }
    }
    const dispatchWin = (type) => {
      for (const fn of [...(env.winEvents.get(type) || [])]) {
        try { fn({ type }) } catch { /* 同上 */ }
      }
    }
    const doc = globalThis.document
    doc.hidden = false; dispatchDoc('visibilitychange') // 回前台（解除周期锁）
    doc.hidden = true; dispatchDoc('visibilitychange')  // 切后台（若监听泄漏会触发 flushAll(true)）
    dispatchWin('pagehide')                              // 关页（若监听泄漏会再次触发）
    await new Promise(r => setTimeout(r, 30))
    assert.equal(collectPosts, postsAfterDestroy, 'destroy 后 visibilitychange/pagehide 不应再触发 collect 发送')
  } finally {
    await uninstallDom(env)
  }
})
