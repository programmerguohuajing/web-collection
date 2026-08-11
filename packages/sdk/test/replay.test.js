import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ReplayRingBuffer } from '../src/replay/ring-buffer.js'
import { createReplayCompressor, hasCompressionStream } from '../src/replay/compress.js'
import { loadRrweb, injectScript } from '../src/replay/rrweb-driver.js'
import { ensureDriver, isDriverLoaded, addReplayEvent, takeReplaySnapshot, __setDriver, setupReplayMonitor } from '../src/replay/index.js'
import { replayShouldKeep, paginate } from '../src/replay/sampler.js'
import { createEys } from '../src/index.js'

// ---------------------------------------------------------------------------
// ReplayRingBuffer（SDK-210 · 内存护栏 + 错误前 30 秒）
// ---------------------------------------------------------------------------

test('RingBuffer 容量超限淘汰最旧事件并累计 evicted', () => {
  const rb = new ReplayRingBuffer({ maxSize: 3, windowMs: 0 })
  rb.push({ a: 1 }, 1000)
  rb.push({ a: 2 }, 1001)
  rb.push({ a: 3 }, 1002)
  rb.push({ a: 4 }, 1003) // 超出容量，最旧 {a:1} 被淘汰
  assert.equal(rb.size, 3)
  assert.equal(rb.evictedTotal, 1)
  const drained = rb.drain(1004)
  assert.deepEqual(drained, [{ a: 2 }, { a: 3 }, { a: 4 }])
  assert.equal(rb.size, 0)
})

test('RingBuffer 时间窗口淘汰旧事件（内存护栏）', () => {
  const rb = new ReplayRingBuffer({ maxSize: 1000, windowMs: 30000 })
  const now = 1_000_000
  rb.push({ t: 'old' }, now - 40000) // 超出 30s 窗口
  rb.push({ t: 'new' }, now - 1000)
  assert.equal(rb.size, 2) // 写入时尚未惰性淘汰
  assert.equal(rb.evictedTotal, 0)
  // take 时惰性淘汰超出窗口的旧事件
  const taken = rb.take(10, now)
  assert.deepEqual(taken, [{ t: 'new' }])
  assert.equal(rb.evictedTotal, 1)
})

test('RingBuffer drain 取出全部留存、take 只取前 N 个', () => {
  const rb = new ReplayRingBuffer({ maxSize: 50, windowMs: 0 })
  for (let i = 0; i < 5; i++) rb.push({ i }, i)
  assert.deepEqual(rb.take(2).map((e) => e.i), [0, 1])
  assert.equal(rb.size, 3)
  assert.deepEqual(rb.drain().map((e) => e.i), [2, 3, 4])
  assert.equal(rb.size, 0)
})

// ---------------------------------------------------------------------------
// 压缩（SDK-210 · gzip / Worker / 降级）
// ---------------------------------------------------------------------------

test('压缩 gzip 主线程往返一致', async () => {
  if (!hasCompressionStream()) return // 环境无 CompressionStream 时跳过 gzip 路径
  const c = createReplayCompressor()
  const events = [{ type: 'mutation', n: 1 }, { type: 'mutation', n: 2 }]
  const { compression, body } = await c.compress(events)
  assert.equal(compression, 'gzip')
  assert.equal(typeof body, 'string')
  const back = await c.decompress({ compression, body })
  assert.deepEqual(back, events)
})

test('压缩无 CompressionStream 时降级 none 且发诊断', async () => {
  const diag = []
  const c = createReplayCompressor({
    onDiagnostic: (type, detail) => diag.push({ type, detail })
  })
  // 临时移除全局 CompressionStream 以模拟不支持环境
  const saved = globalThis.CompressionStream
  globalThis.CompressionStream = undefined
  try {
    const events = [{ x: 1 }]
    const { compression, body } = await c.compress(events)
    assert.equal(compression, 'none')
    assert.deepEqual(JSON.parse(Buffer.from(body, 'base64').toString('utf8')), events)
    assert.ok(diag.some((d) => d.type === 'replay_worker_unavailable'))
  } finally {
    globalThis.CompressionStream = saved
  }
})

class MockWorker {
  constructor() {
    this.handlers = {}
    this.posted = null
  }
  addEventListener(type, fn) { this.handlers[type] = fn }
  removeEventListener() {}
  postMessage(data) {
    this.posted = data
    // 模拟 Worker 内 gzip（复用全局 CompressionStream）
    const run = async () => {
      const cs = new CompressionStream('gzip')
      const w = cs.writable.getWriter()
      w.write(new TextEncoder().encode(data.text))
      w.close()
      const ab = await new Response(cs.readable).arrayBuffer()
      const bytes = new Uint8Array(ab)
      let bin = ''
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
      this.handlers.message({ data: { id: data.id, b64: btoa(bin) } })
    }
    run()
  }
  terminate() {}
}

test('压缩优先使用 Worker（提供 workerUrl 且支持 CompressionStream）', async () => {
  if (!hasCompressionStream()) return
  const origWorker = globalThis.Worker
  globalThis.Worker = MockWorker
  try {
    const c = createReplayCompressor({ workerUrl: 'replay.worker.js' })
    const events = [{ type: 'full_snapshot' }]
    const { compression, body } = await c.compress(events)
    assert.equal(compression, 'gzip')
    const back = await c.decompress({ compression, body })
    assert.deepEqual(back, events)
  } finally {
    globalThis.Worker = origWorker
  }
})

// ---------------------------------------------------------------------------
// rrweb 懒加载驱动（SDK-209 · 分包边界）
// ---------------------------------------------------------------------------

test('loadRrweb 优先复用已注入的 window.rrweb（不触发动态 import）', async () => {
  const fakeRrweb = { record: () => () => {} }
  const saved = globalThis.window
  globalThis.window = { rrweb: fakeRrweb }
  try {
    const rr = await loadRrweb()
    assert.equal(rr, fakeRrweb)
  } finally {
    globalThis.window = saved
  }
})

test('injectScript 注入 <script> 并在 load 后 resolve', async () => {
  let createdEl = null
  const savedDoc = globalThis.document
  globalThis.document = {
    querySelector: () => null,
    head: { appendChild() {} },
    createElement: () => {
      const handlers = {}
      createdEl = {
        dataset: {},
        addEventListener: (t, fn) => { handlers[t] = fn },
        _fire: (t) => handlers[t] && handlers[t]()
      }
      return createdEl
    }
  }
  try {
    const p = injectScript('https://cdn/x/rrweb.js')
    assert.ok(createdEl, '应创建 script 元素')
    createdEl._fire('load')
    await p // 不应抛错
  } finally {
    globalThis.document = savedDoc
  }
})

test('injectScript 脚本加载失败时 reject 可读错误', async () => {
  let createdEl = null
  const savedDoc = globalThis.document
  globalThis.document = {
    querySelector: () => null,
    head: { appendChild() {} },
    createElement: () => {
      const handlers = {}
      createdEl = {
        dataset: {},
        addEventListener: (t, fn) => { handlers[t] = fn },
        _fire: (t) => handlers[t] && handlers[t]()
      }
      return createdEl
    }
  }
  try {
    const p = injectScript('https://cdn/x/rrweb.js')
    createdEl._fire('error')
    await assert.rejects(() => p, /replayLibUrl load failed/)
  } finally {
    globalThis.document = savedDoc
  }
})

test('loadRrweb 在 window.rrweb 缺失时通过动态 import 加载 rrweb（SDK-209 懒加载核心路径）', async () => {
  const savedWin = globalThis.window
  globalThis.window = undefined // 无全局注入 → 走动态 import 拆分 chunk
  try {
    const rr = await loadRrweb()
    // rrweb 解析为含 record 的模块，证明核心包未静态包含 rrweb、按需加载成功。
    assert.equal(typeof rr.record, 'function')
  } finally {
    globalThis.window = savedWin
  }
})

test('ensureDriver 幂等且仅加载一次 rrweb', async () => {
  const fakeRrweb = { record: () => () => {} }
  const saved = globalThis.window
  globalThis.window = { rrweb: fakeRrweb }
  try {
    const a = await ensureDriver()
    const b = await ensureDriver()
    assert.equal(a, fakeRrweb)
    assert.equal(b, fakeRrweb)
    assert.equal(isDriverLoaded(), true)
  } finally {
    globalThis.window = saved
  }
})

test('addReplayEvent / takeReplaySnapshot 在驱动未加载时为安全 no-op', () => {
  // 全新进程模块状态：驱动未加载，调用不应抛错
  assert.doesNotThrow(() => addReplayEvent('click', { x: 1 }))
  assert.doesNotThrow(() => takeReplaySnapshot())
})

// ---------------------------------------------------------------------------
// SDK 集成：replay 配置不阻断构造与上报
// ---------------------------------------------------------------------------

test('createEys replay:false 与 replay:true 均可构造且客户端 API 完整', async () => {
  // 构造 SDK 需要最小 DOM 环境。navigator 为 Node 只读全局，使用 Node 内置值，不覆盖。
  const props = {
    window: globalThis,
    location: { href: 'https://example.com/', pathname: '/', referrer: '' },
    document: {
      title: '', hidden: false,
      addEventListener() {}, removeEventListener() {}, querySelector: () => null,
      head: { appendChild() {} },
      createElement: () => ({ dataset: {}, addEventListener() {}, style: {} })
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: () => {},
    // Node 22 暴露了全局 BroadcastChannel，但 Node/SSR 无多标签页场景，且 Node 中
    // BroadcastChannel.close() 不会释放底层 PipeWrap（实测仍泄漏）。置为 undefined 使其退化为
    // 单标签页布尔守卫（SDK 文档既定降级路径），保证测试进程干净退出。
    BroadcastChannel: undefined,
    // 单元测试不做真实网络：mock fetch，避免 destroy 的退出刷新留下悬挂 socket。
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) })
  }
  const originals = {}
  for (const k of Object.keys(props)) {
    originals[k] = Object.getOwnPropertyDescriptor(globalThis, k)
    Object.defineProperty(globalThis, k, { value: props[k], configurable: true, writable: true })
  }
  let clientOff, clientOn
  try {
    const base = { distributedTracing: false, replaySegmentByRoute: false, behavior: false, exposure: false, requests: false, performance: false, console: false, whiteScreen: false, memory: false, runtime: false, environment: false, runtimeInfo: false, replayMaxDuration: 0 }
    clientOff = createEys({ ...base, appId: 't', endpoint: '/api/collect', replay: false })
    clientOn = createEys({ ...base, appId: 't', endpoint: '/api/collect', replay: true })
    for (const c of [clientOff, clientOn]) {
      assert.equal(typeof c.track, 'function')
      assert.equal(typeof c.error, 'function')
      assert.equal(typeof c.startReplay, 'function')
      assert.equal(typeof c.flushReplay, 'function')
      assert.equal(typeof c.stopReplay, 'function')
      assert.equal(typeof c.addReplayEvent, 'function')
      assert.equal(typeof c.takeReplaySnapshot, 'function')
      assert.equal(typeof c.endReplaySegment, 'function')
    }
    // replay:false 时不应尝试录制（startReplay 内部以 document 守卫）
    assert.doesNotThrow(() => { clientOff.track('evt', { a: 1 }) })
    assert.doesNotThrow(() => { clientOff.error(new Error('boom')) })
  } finally {
    // 清除 SDK 内部 setInterval，避免 worker 因 ref'd 定时器无法退出。
    await clientOff?.destroy?.()
    await clientOn?.destroy?.()
    for (const k of Object.keys(props)) {
      if (originals[k]) Object.defineProperty(globalThis, k, originals[k])
      else delete globalThis[k]
    }
    // restore 后可能仍有排队的 rAF setTimeout 回调会引用全局 requestAnimationFrame，
    // 若此时全局已被删除会抛 ReferenceError。补一个 no-op 桩，保证退出干净、不崩溃。
    if (typeof globalThis.requestAnimationFrame !== 'function') {
      globalThis.requestAnimationFrame = () => 0
    }
    if (typeof globalThis.cancelAnimationFrame !== 'function') {
      globalThis.cancelAnimationFrame = () => {}
    }
  }
})

// ---------------------------------------------------------------------------
// SDK-211 · 错误触发升采样（采样决策纯函数）
// ---------------------------------------------------------------------------

test('replayShouldKeep：升采样窗口内全保留，rate 边界正确', () => {
  // 错误升采样期间：无论 rate 多少都全保留
  assert.equal(replayShouldKeep(0, true), true)
  assert.equal(replayShouldKeep(0.3, true), true)
  // rate 边界
  assert.equal(replayShouldKeep(1, false), true)
  assert.equal(replayShouldKeep(0, false), false)
})

test('replayShouldKeep：rate<1 按概率取舍（确定性 rng）', () => {
  // rng 交替 0.1/0.9 → 偶数次(<0.5 保留)、奇数次(>=0.5 丢弃)
  const alt = (() => { let i = 0; return () => (i++ % 2 === 0 ? 0.1 : 0.9) })()
  assert.equal(replayShouldKeep(0.5, false, alt), true)
  assert.equal(replayShouldKeep(0.5, false, alt), false)
  assert.equal(replayShouldKeep(0.5, false, alt), true)
})

// ---------------------------------------------------------------------------
// SDK-211 · 分页加载（分页纯函数）
// ---------------------------------------------------------------------------

test('paginate：空数组、整除、余数、单页', () => {
  assert.deepEqual(paginate([], 10), [])
  assert.equal(paginate(Array(100).fill(0), 50).length, 2)
  const p = paginate(Array(120).fill(0), 50)
  assert.deepEqual(p.map((x) => x.length), [50, 50, 20])
  // pageSize >= 长度 → 单页
  assert.equal(paginate(Array(3).fill(0), 10).length, 1)
  // pageSize <= 0 → 按 1 处理
  assert.equal(paginate(Array(3).fill(0), 0).length, 3)
})

// ---------------------------------------------------------------------------
// SDK-211 · 环形缓冲窗口动态调整（错误升采样扩展窗口）
// ---------------------------------------------------------------------------

test('RingBuffer setWindow 改变留存窗口并影响惰性淘汰', () => {
  const rb = new ReplayRingBuffer({ maxSize: 1000, windowMs: 1000 })
  const now = 1_000_000
  rb.push({ t: 'old' }, now - 800) // 在 1s 窗口内
  assert.equal(rb.windowMs, 1000)
  rb.setWindow(500) // 收缩到 0.5s → old 超出窗口
  assert.equal(rb.windowMs, 500)
  assert.deepEqual(rb.take(10, now).map((e) => e.t), []) // 被惰性淘汰
  // 错误升采样扩展窗口：重新写入并扩展窗口
  rb.push({ t: 'new' }, now - 400)
  rb.setWindow(60000)
  assert.equal(rb.windowMs, 60000)
  assert.deepEqual(rb.take(10, now).map((e) => e.t), ['new'])
})

// ---------------------------------------------------------------------------
// SDK-211 · facade 选项透传（Canvas / iframe 显式 opt-in）
// ---------------------------------------------------------------------------

test('setupReplayMonitor 透传 recordCanvas / recordCrossOriginIframes / inlineIframes', async () => {
  let captured = null
  __setDriver({
    record: (opts) => { captured = opts; return () => {} }
  })
  try {
    await ensureDriver()
    setupReplayMonitor({
      emit: () => {},
      options: { recordCanvas: true, recordCrossOriginIframes: true, inlineIframes: true }
    })
    // 必须不被静态默认值（recordCanvas:false）覆盖
    assert.equal(captured.recordCanvas, true)
    assert.equal(captured.recordCrossOriginIframes, true)
    assert.equal(captured.inlineIframes, true)
    // errorHandler 可被覆盖（默认是空函数）
    assert.equal(typeof captured.errorHandler, 'function')
  } finally {
    __setDriver(null)
  }
})

// ---------------------------------------------------------------------------
// SDK-211 · 集成：错误升采样 + 分页加载 + 质量指标（mock rrweb 避免 Node 泄漏）
// ---------------------------------------------------------------------------

test('createEys 错误触发升采样扩展窗口并发出 replay_error_triggered', async () => {
  const props = {
    window: globalThis,
    location: { href: 'https://example.com/', pathname: '/', referrer: '' },
    document: {
      title: '', hidden: false,
      addEventListener() {}, removeEventListener() {}, querySelector: () => null,
      head: { appendChild() {} },
      createElement: () => ({ dataset: {}, addEventListener() {}, style: {} })
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: () => {},
    BroadcastChannel: undefined,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) })
  }
  const originals = {}
  for (const k of Object.keys(props)) {
    originals[k] = Object.getOwnPropertyDescriptor(globalThis, k)
    Object.defineProperty(globalThis, k, { value: props[k], configurable: true, writable: true })
  }
  // mock rrweb：捕获 emit 回调（用于模拟录制产生事件），record 不真正启动录制，避免 Node 泄漏。
  let capturedEmit = null
  __setDriver({
    record: (opts) => { capturedEmit = opts.emit; return () => {} }
  })
  const diags = []
  let client
  try {
    const base = {
      distributedTracing: false, replaySegmentByRoute: false, behavior: false, exposure: false,
      requests: false, performance: false, console: false, whiteScreen: false, memory: false,
      runtime: false, environment: false, runtimeInfo: false, replayMaxDuration: 0,
      replay: true, replayErrorTrigger: true, replayWindowMs: 30000, replayWindowMsError: 60000,
      replaySampleRate: 1, replayCompression: false, replayBatchSize: 100000, // 关闭压缩、抑制增量刷新，聚焦升采样/分页/质量
      onDiagnostic: (e) => diags.push(e)
    }
    client = createEys({ ...base, appId: 't', endpoint: '/api/collect' })
    await client.startReplay()
    assert.ok(capturedEmit, 'record 应被调用并提供 emit 回调')

    // 模拟 rrweb 持续产出 120 个增量事件（sampleRate=1 → 全部保留）
    for (let i = 0; i < 120; i++) capturedEmit({ type: 5, data: { i } })

    // 强制刷新（错误/分段结束语义）→ 分页：ceil(120/50)=3 页
    await client.flushReplay(true)
    const quality = diags.filter((d) => d.type === 'replay_quality')
    assert.ok(quality.length >= 1, '应发出 replay_quality')
    assert.equal(quality[quality.length - 1].pages, 3)
    assert.equal(quality[quality.length - 1].errorBoosted, false)

    // 触发错误 → 升采样：窗口扩展为 60s + 发出 replay_error_triggered
    client.error(new Error('boom'))
    const triggered = diags.filter((d) => d.type === 'replay_error_triggered')
    assert.ok(triggered.length >= 1, '应发出 replay_error_triggered')
    assert.equal(triggered[triggered.length - 1].windowMs, 60000)
    // 错误后写入的事件处于升采样窗口（全保留，即便 rate<1）
  } finally {
    await client?.destroy?.()
    __setDriver(null)
    for (const k of Object.keys(props)) {
      if (originals[k]) Object.defineProperty(globalThis, k, originals[k])
      else delete globalThis[k]
    }
    if (typeof globalThis.requestAnimationFrame !== 'function') globalThis.requestAnimationFrame = () => 0
    if (typeof globalThis.cancelAnimationFrame !== 'function') globalThis.cancelAnimationFrame = () => {}
  }
})

