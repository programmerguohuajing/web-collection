/**
 * @file Web Collection SDK 入口模块
 * 前端监控 SDK，提供错误监控、性能采集、用户行为追踪、元素曝光和会话回放能力。
 * 支持 Vue 插件安装（install）和独立调用（createEys）两种接入方式。
 */

import { setupBehaviorMonitor } from './behavior/index.js'
import { setupClickMonitor } from './behavior/click.js'
import { setupInputMonitor } from './behavior/input.js'
import { setupKeyboardMonitor } from './behavior/keyboard.js'
import { setupTouchMonitor } from './behavior/touch.js'
import { setupConsoleMonitor } from './behavior/console.js'
import { setupRouteMonitor } from './behavior/route.js'
import { setupErrorMonitor } from './error/index.js'
import { setupWorkerMonitor } from './error/worker.js'
import { setupExposureMonitor } from './exposure/index.js'
import { setupPerformanceMonitor } from './performance/index.js'
import { setupTtiMonitor } from './performance/tti.js'
import { setupMemoryMonitor } from './performance/memory.js'
import { setupBodySampler } from './performance/body-sampler.js'
import { setupServerTimingMonitor } from './performance/server-timing.js'
import { setupBundleMonitor } from './performance/bundle.js'
// Phase 7 · Replay 分包与懒加载（SDK-209）：rrweb 唯一动态边界在 rrweb-driver.js。
import { ensureDriver, setupReplayMonitor, addReplayEvent, takeReplaySnapshot, __setDriver } from './replay/index.js'
// Phase 7 · Replay 环形缓冲与压缩（SDK-210）：内存护栏 + gzip（Worker/主线程/降级）。
import { ReplayRingBuffer } from './replay/ring-buffer.js'
import { createReplayCompressor } from './replay/compress.js'
// SDK-211 · Replay 增强：错误触发升采样 + 分页加载纯函数。
import { replayShouldKeep, paginate } from './replay/sampler.js'
import { setupServiceWorkerMonitor } from './runtime/sw.js'
import { imageReport } from './core/report.js'
import { SDK_VERSION, eventCategory, eventSource, sanitizeEvent } from './core/event.js'
import { createSanitizer, resolveConsent } from './core/sanitizer.js'
import { getId } from './utils/id.js'
import { setupEnvironmentMonitor } from './utils/environment.js'
import { setupRuntimeMonitor } from './utils/runtime.js'
// 链路追踪模块
import { createTracer, Tracer, getCurrentSpan, Span, SpanKind, BatchSpanProcessor, WebCollectionSpanExporter } from './trace/index.js'
// Phase 6 · 确定性采样（U06 / SDK-208）：基于 traceId/sessionId 的一致性采样 + 优先级保留。
import { createDeterministicSampler } from './sampling/index.js'
// Reliable Transport v2：可替换、可测试的发送通道与持久化队列（SDK-207 / SDK-219）。
import { ReliableSender, FetchTransport, BeaconTransport, IndexedDBQueue, createDiagnosticSink, createMultiTabLock } from './transport/index.js'

/**
 * 由事件采集端点推导出 Span 接收端点。
 * 例：`/api/collect` → `/api/spans`；`https://host/api/collect` → `https://host/api/spans`。
 * @param {string} endpoint
 * @returns {string}
 */
function deriveSpansUrl(endpoint) {
  try {
    const url = new URL(endpoint, location.href)
    const suffix = '/api/collect'
    url.pathname = url.pathname.endsWith(suffix)
      ? url.pathname.slice(0, -suffix.length) + '/api/spans'
      : url.pathname.replace(/\/$/, '') + '/api/spans'
    return url.toString()
  } catch {
    return endpoint
  }
}

/**
 * 创建 SDK 实例。
 *
 * @param {object} [options={}] - SDK 配置项
 * @param {string} [options.endpoint='/api/collect'] - 后端采集接口地址
 * @param {string} [options.appId='default'] - 应用标识
 * @param {string} [options.release='dev'] - 应用版本号
 * @param {string} [options.userId=''] - 当前登录用户 ID
 * @param {string} [options.userName=''] - 当前用户名
 * @param {string} [options.userPhone=''] - 当前用户手机号
 * @param {number} [options.batchSize=10] - 累计多少条事件后触发一次上报
 * @param {number} [options.flushInterval=60000] - 定时批量上报的时间间隔（ms）
 * @param {number} [options.maxQueue=200] - 本地队列最大可缓存事件数
 * @param {number} [options.maxRetries=3] - 单次上报失败后的最大重试次数
 * @param {number} [options.sampleRate=1] - 采样率（0~1），未命中则返回空实现
 * @param {boolean} [options.behavior=true] - 是否开启行为采集
 * @param {boolean} [options.console=true] - 是否采集 console 日志
 * @param {string} [options.collectKey=''] - 应用采集密钥
 * @param {boolean} [options.tracing=true] - 是否采集前端请求链路
 * @param {string[]} [options.traceOrigins=[]] - 允许透传 traceparent 的跨域 Origin；同源始终允许
 * @param {boolean} [options.requests=true] - 是否开启请求性能采集
 * @param {boolean} [options.exposure=true] - 是否开启曝光采集
 * @param {boolean} [options.replay=true] - 是否开启会话回放采集
 * @param {number} [options.replayMaxDuration=60000] - 单个路由页面最多录制时长（ms）
 * @param {number} [options.replayBatchSize=50] - 回放事件的批量上报数量
 * @param {object} [options.replayOptions={}] - rrweb 回放模块的附加配置
 * @param {string} [options.whiteScreenSelector='#app > *'] - 首页有效内容选择器
 * @param {number} [options.whiteScreenTimeout=5000] - 白屏判定阈值（ms）
 * @param {boolean} [options.inputTracking=false] - 是否采集输入框聚焦/失焦/输入变化
 * @param {boolean} [options.environmentInfo=true] - 是否采集设备环境指纹
 * @param {boolean|object} [options.runtimeInfo=false] - 是否采集运行时版本信息
 * @param {number} [options.memoryInterval=60000] - 内存监控采样间隔（ms），0 表示不周期性采样
 * @param {number} [options.requestBodySampling=0] - 请求/响应 body 采样率（0~1），0 表示不采集
 * @param {boolean} [options.bundleMonitoring=false] - 是否采集 Bundle 大小监控
 * @param {boolean} [options.keyboardTracking=false] - 是否采集键盘操作
 * @param {string[]} [options.keyboardTrackingKeys=['Enter','Escape']] - 键盘追踪的按键列表
 * @param {boolean} [options.touchTracking=false] - 是否采集 Touch 手势
 * @param {boolean} [options.workerMonitoring=false] - 是否监控 Web Worker 错误
 * @param {boolean} [options.serviceWorkerMonitoring=false] - 是否监控 Service Worker 状态
 * @returns {object} SDK 客户端实例，包含 track/error/metric/flush/destroy 等方法
 */
export function createEys(options = {}) {
  const sdkStartedAt = performance.now()
  // 合并调用方传入的配置对象。
  // cfg 保存 SDK 运行期间使用的最终配置。
  const cfg = {
    // endpoint 是后端采集接口地址。
    endpoint: '/api/collect',
    // appId 用于标识当前接入的应用。
    appId: 'default',
    // release 表示当前应用版本号。
    release: 'dev',
    // userId 用于标识当前登录用户。
    userId: '',
    userName: '',
    userPhone: '',
    // batchSize 表示累计多少条事件后触发一次上报。
    batchSize: 10,
    // flushInterval 表示定时批量上报的时间间隔。
    flushInterval: 60000,
    // maxQueue 表示本地队列最大可缓存事件数。
    maxQueue: 200,
    // maxRetries 表示单次上报失败后的最大重试次数。
    maxRetries: 3,
    // sampleRate 作为 session/global 基础采样率；trace 单元默认复用该值（可由 traceRate 单独指定）。
    sampleRate: 1,
    // traceRate 单独控制链路（traceId）基础采样率；默认 = sampleRate。
    traceRate: undefined,
    // errorSampleRate 控制错误链路/事件的确定性子采样率；默认 undefined = 错误始终保留（优先级）。
    errorSampleRate: undefined,
    // behavior 控制是否开启行为采集。
    behavior: true,
    console: true,
    consoleLevels: ['log', 'info', 'warn', 'error'],
    collectKey: '',
    tracing: true,
    traceOrigins: [],
    // distributedTracing 开启链路追踪的层级 span 功能
    distributedTracing: true,
    // spanExport 控制是否将 Span（根/自动请求/自定义）经 Processor/Exporter 批量写入 /api/spans。
    // 默认关闭：0.1.x 不破坏现有后端与存储成本；0.2.0-beta 起可默认开启（配合采样）。
    spanExport: false,
    // baggage 静态业务属性，会透传到所有 span
    baggage: {},
    // requests 控制是否开启请求性能采集。
    requests: true,
    // exposure 控制是否开启曝光采集。
    exposure: true,
    // replay 控制是否开启会话回放采集。
    replay: true,
    replaySegmentByRoute: true,
    replayMaxDuration: 60000,
    // replayBatchSize 控制回放事件的批量上报数量。
    replayBatchSize: 50,
    // replayOptions 传递 rrweb 等回放模块的附加配置。
    replayOptions: {},
    // SDK-209 · 分包与懒加载：rrweb 不在核心包静态打包，replay 开启时才按需加载。
    // replayLibUrl 仅 IIFE 自托管场景需要：引入外部化后的 rrweb 脚本地址，
    // 加载完成后暴露 window.rrweb；ESM 构建由 Vite 自动拆分为独立 chunk，无需此配置。
    replayLibUrl: '',
    // replayWorkerUrl 指向压缩 Worker 脚本（SDK-210）：提供则优先在 Worker 内 gzip，
    // 主线程零阻塞；不提供则回退主线程 CompressionStream。
    replayWorkerUrl: '',
    // replayCompression 控制是否对回放 payload 做 gzip（默认开启；无 CompressionStream 时自动降级 none）。
    replayCompression: true,
    // replayBufferSize / replayWindowMs：环形缓冲容量与时间窗口（SDK-210 内存护栏）。
    // 超出窗口或容量的旧事件被淘汰，保证错误前 30 秒可恢复且内存有界。
    replayBufferSize: 1500,
    replayWindowMs: 30000,
    // SDK-211 · Replay 增强：
    // replayPageSize：强制刷新（错误/分段结束/页面卸载）时单页回放事件上限，超出拆多页 → 分页加载。
    replayPageSize: 50,
    // replaySampleRate：常态回放增量采样率 [0,1]，<1 时对高频事件降本；默认 1（全保留，无回归）。
    replaySampleRate: 1,
    // replayErrorTrigger：开启后，发生错误时升至全采样并将留存窗口扩展到 replayWindowMsError（错误前更多上下文）。
    replayErrorTrigger: true,
    // replayWindowMsError：错误升采样期间的留存窗口（默认 60s，是常态 30s 的两倍）。
    replayWindowMsError: 60000,
    // replayCanvas / replayIframe：Canvas 与跨域 iframe 录制显式 opt-in（默认关闭），
    // 开启后传入 rrweb 的 recordCanvas / recordCrossOriginIframes / inlineIframes。
    // 完整 Canvas 保真度需在 replayOptions.plugins 中提供 @rrweb/rrweb-plugin-canvas 实例。
    replayCanvas: false,
    replayIframe: false,
    whiteScreenSelector: '#app > *',
    whiteScreenTimeout: 5000,
    enabled: true,
    consent: 'granted',
    environment: 'production',
    categorySampleRates: {},
    beforeSend: null,
    privacy: {},
    formTracking: false,
    rageClick: false,
    deadClick: false,
    interactionTracking: false,
    selectTracking: false,
    inputTracking: false,
    environmentInfo: true,
    runtimeInfo: false,
    memoryInterval: 60000,
    requestBodySampling: 0,
    bundleMonitoring: false,
    keyboardTracking: false,
    keyboardTrackingKeys: ['Enter', 'Escape'],
    touchTracking: false,
    workerMonitoring: false,
    serviceWorkerMonitoring: false,
    // onDiagnostic 暴露传输层自诊断事件（队列满/限流/超时/丢弃/Beacon 等），不含业务敏感数据。
    onDiagnostic: null,
    // transportTimeout 单次在线发送超时（ms），超时按网络错误重试。
    transportTimeout: 10000,
    // beaconMaxBytes 页面退出阶段单个 Beacon 批次的 UTF-8 字节上限。
    beaconMaxBytes: 60 * 1024,
    ...options
  }
  cfg.privacy ||= {}
  // Privacy v2 统一 sanitizer：默认模式 balanced（生产默认最小化采集）。
  const sanitizer = createSanitizer(cfg.privacy)
  // 解析同意分类（含 GPC / DNT 信号映射），用于按分类门控高风险采集模块（如回放、body 采样）。
  const consentMap = resolveConsent({ consent: cfg.consent, consentCategories: cfg.privacy?.consentCategories }, globalThis.navigator || {})
  // Phase 6 · 确定性采样（U06 / SDK-208）：
  // 用确定性采样器替代「Math.random 命中即整会话丢弃」的旧逻辑——
  // 同一 traceId / sessionId 永远得到一致决策，错误链路默认强制保留，
  // 且可在 sampleRate < 1 时仍可解释地按比例保留。不再整会话返回空实现。
  const sampler = createDeterministicSampler({
    sampleRate: cfg.sampleRate,
    traceRate: cfg.traceRate,
    categorySampleRates: cfg.categorySampleRates,
    errorSampleRate: cfg.errorSampleRate
  })
  // 最近一次采样决策（供 getSamplingDecision 自查，不含敏感数据）。
  let lastSamplingDecision = null

  // sessionId 标识当前页面访问会话。
  const sessionId = getId('eys_sid')
  const deviceId = getId('eys_did', true)
  // sender（ReliableSender）持久化待上报事件；recent/breadcrumbs 用于去重和错误上下文；replayRing 为回放片段的环形缓冲（SDK-210 内存护栏）。
  const recent = []
  const breadcrumbs = []
  const globalContext = {}
  const stats = { enqueued: 0, dropped: 0, droppedByConsent: 0, droppedBySample: 0, sent: 0, failed: 0 }
  const originalFetch = window.fetch?.bind(window)
  /**
   * Reliable Transport v2：内存热队列 + IndexedDB 冷队列 + Fetch/Beacon 通道。
   * - 冷队列保证刷新/崩溃/离线后事件可恢复；
   * - 在线发送带超时、退避重试与 4xx 不可重试丢弃；
   * - 页面退出走 Beacon（非破坏性，事件保留待服务端 eventId 幂等去重）。
   */
  const diagnostic = createDiagnosticSink((event) => {
    if (event.type === 'retry' || event.type === 'flush_failed' || event.type === 'dropped_non_retryable') {
      stats.failed += Number(event.count || 0)
    }
    if (typeof cfg.onDiagnostic === 'function') cfg.onDiagnostic(event)
  })
  // 跨标签页锁引用（SDK-219）：destroy 时 close() 释放 BroadcastChannel，避免进程泄漏。
  let multiTabLock = null
  const sender = new ReliableSender({
    cold: new IndexedDBQueue({ maxQueue: cfg.maxQueue * 10 }),
    transport: new FetchTransport({ endpoint: cfg.endpoint, collectKey: cfg.collectKey, fetchImpl: originalFetch, timeout: cfg.transportTimeout }),
    beacon: new BeaconTransport({ endpoint: cfg.endpoint, collectKey: cfg.collectKey, fetchImpl: originalFetch, maxBytes: cfg.beaconMaxBytes }),
    gif: imageReport,
    endpoint: cfg.endpoint,
    maxQueue: cfg.maxQueue,
    maxRetries: cfg.maxRetries,
    maxBatch: cfg.batchSize,
    collectKey: cfg.collectKey,
    diagnostic,
    // 捕获锁引用，destroy 时必须 close() 释放底层 BroadcastChannel（及其 MessagePort），
    // 否则该 ref'd 句柄会使进程/Worker 无法正常退出（资源泄漏）。详见 multitab.js。
    lock: (() => { const lock = createMultiTabLock(cfg.endpoint); multiTabLock = lock; return lock })()
  })
  // SDK-210 · 环形缓冲：回放事件的内存护栏，最近 replayWindowMs 内最多留存 replayBufferSize 条，
  // 超出容量/窗口的旧事件被惰性淘汰，保证错误前 30 秒可恢复且常驻内存有界。
  const replayRing = new ReplayRingBuffer({ maxSize: cfg.replayBufferSize, windowMs: cfg.replayWindowMs })
  // SDK-210 · 回放压缩器：Worker / 主线程 CompressionStream / 降级 none；保持主线程低开销预算。
  const replayCompressor = cfg.replayCompression
    ? createReplayCompressor({ workerUrl: cfg.replayWorkerUrl, onDiagnostic: (type, detail) => diagnostic.emit(type, detail) })
    : null
  const pageTraceId = randomHex(16)
  // 创建 Tracer 实例（当 distributedTracing 开启时）
  // 容错：链路追踪构造失败只降级关闭 tracer，不能拖垮整个 SDK 初始化。
  let tracer = null
  if (cfg.distributedTracing) {
    try {
      tracer = createTracer({
        name: 'web-eys-sdk',
        version: SDK_VERSION,
        traceId: pageTraceId,
        baggage: cfg.baggage,
        // 链路级采样由同一确定性采样器驱动，保证 trace 内父子 Span 决策一致。
        sampler
      })
    } catch (err) {
      console.warn('[web-collection] 初始化链路追踪失败，已降级关闭：', err)
    }
  }
  /** Span 导出管线：开启 spanExport 时，将根/自动请求/自定义 Span 经 Processor 批量写入 /api/spans。 */
  let spanProcessor = null
  if (cfg.spanExport && tracer) {
    try {
      const spansUrl = deriveSpansUrl(cfg.endpoint)
      const exporter = new WebCollectionSpanExporter({
        send: async (payload) => {
          if (!originalFetch) throw new Error('no fetch available for span export')
          const res = await originalFetch(spansUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(cfg.collectKey ? { 'x-app-key': cfg.collectKey } : {}) },
            body: JSON.stringify(payload),
            // keepalive：页面退出/隐藏时仍能尽力送达（spans 体积小，远未达 64KB 上限）。
            keepalive: true
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return res.json().catch(() => ({}))
        }
      })
      spanProcessor = new BatchSpanProcessor(exporter, { maxExportBatchSize: 64, scheduledDelayMillis: 5000 })
      tracer.addSpanProcessor(spanProcessor)
    } catch (err) {
      console.warn('[web-collection] 初始化 Span 导出管线失败，已降级关闭：', err)
    }
  }
  /** 回放分段：基础会话 ID 不变，发生错误/路由切换时生成新 currentReplaySessionId（如 xxx_seg2），
   *  每种 sessionId 对应一条独立的回放记录，不再互相叠加。 */
  const replayBaseSessionId = `${sessionId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  let currentReplaySessionId = replayBaseSessionId
  let replaySegIndex = 1
  /** 当前正在录制的分段结束原因，在最后一次强制 flush 时随事件一同上报。
   *  null 表示尚未触发结束（正常录制中），结束后重置。 */
  let currentSegmentEndReason = null
  let stopReplay = null
  /** 已销毁标记：destroy 后任何仍在飞行的 startReplay 加载完成时立即停录，避免 rrweb 内部定时器泄露。 */
  let disposed = false
  let replayStopTimer = 0
  let replayStartTimer = 0
  let whiteScreenTimer = 0
  /** SDK-211 · 错误触发升采样状态：错误后进入全采样窗口，窗口结束后恢复常态采样率与窗口。 */
  let errorBoosted = false
  let errorBoostUntil = 0
  /** SDK-211 · 录制质量指标：累计因常态降采样丢弃的回放事件数、上次质量诊断时间（节流）。 */
  let replaySampledDrops = 0
  let lastQualityEmit = 0
  let stopConsole = () => {}
  let stopBehavior = () => {}
  let stopRoute = () => {}
  let stopError = () => {}
  let stopExposure = () => {}
  let stopLifecycle = () => {}
  let finalizePerformance = () => {}
  let stopEnvironment = () => {}
  let stopRuntime = () => {}
  let stopMemory = () => {}
  let stopBodySampler = () => {}
  let stopKeyboard = () => {}
  let stopTouch = () => {}
  let stopWorker = () => {}
  let stopServiceWorker = () => {}
  let stopBundle = () => {}
  let captureStarted = false
  let performanceStarted = false
  const timer = setInterval(flushAll, cfg.flushInterval)
  addEventListener('pagehide', () => {
    finalizePerformance()
    currentSegmentEndReason = 'page_unload'
    stopCurrentReplay()
    flushAll(true)
  })
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return
    finalizePerformance()
    flushAll(true)
  })

  if (cfg.enabled && cfg.consent !== 'denied') startCapture()

  return {
    track,
    error,
    metric,
    log,
    setUser,
    setConsent,
    setEnabled,
    setContext,
    addBreadcrumb,
    startTransaction,
    markPageReady: () => metric('data_ready', performance.now()),
    flush,
    destroy,
    flushSpans: () => tracer?.flushSpans?.(),
    startReplay,
    stopReplay: stopReplayRecording,
    flushReplay,
    addReplayEvent: (tag, payload = {}) => addReplayEvent(tag, sanitizer.sanitizeEvent({ props: payload }).props),
    takeReplaySnapshot,
    endReplaySegment,
    // 链路追踪公共 API
    startSpan: tracer ? (name, options) => tracer.startSpan(name, options) : noopSpan,
    withSpan: tracer ? (name, fn, options) => tracer.withSpan(name, fn, options) : (name, fn) => fn(),
    getCurrentSpan: () => tracer?.getCurrentSpan?.() ?? null,
    // 隐私与同意自查
    getPrivacyMode: () => sanitizer.mode,
    getConsentCategories: () => ({ ...consentMap }),
    // 采样自查：返回最近一次采样决策（含规则/采样率/单元），用于 SDK 自诊断页（P2）与调试。
    getSamplingDecision: () => lastSamplingDecision
  }

  function startCapture() {
    if (captureStarted) return
    captureStarted = true
    // 容错包裹：任意一个子模块初始化失败，仅告警并跳过该模块，
    // 其余采集（错误/行为/页面等）继续工作，避免「一个模块挂掉 → 整个 SDK 不初始化 → 完全无上报」。
    const safe = (label, fn) => {
      try { return fn() }
      catch (err) { console.warn(`[web-collection] 初始化子模块 "${label}" 失败，已跳过：`, err); return () => {} }
    }
    // 1) 环境与运行时信息（优先采集，供后续模块使用）
    stopEnvironment = safe('environment', () => setupEnvironmentMonitor({ context: globalContext, enabled: cfg.environmentInfo }))
    stopRuntime = safe('runtime', () => setupRuntimeMonitor({ context: globalContext, config: cfg.runtimeInfo }))
    // 2) Console 日志拦截
    stopConsole = cfg.console ? safe('console', () => setupConsoleMonitor({ remember, emit: log, levels: cfg.consoleLevels })) : () => {}
    // 3) 全局错误监控
    stopError = safe('error', () => setupErrorMonitor({ error, clipSize: 500 }))
    // 4) 性能监控（单例，只初始化一次）
    if (!performanceStarted) {
      finalizePerformance = safe('performance', () => setupPerformanceMonitor({
        metric,
        error,
        endpoint: cfg.endpoint,
        originalFetch,
        requests: cfg.requests,
        tracing: cfg.tracing,
        traceOrigins: cfg.traceOrigins,
        pageTraceId,
        requestAllowlist: cfg.privacy.requestAllowlist,
        tracer
      }))
      performanceStarted = true
    }
    // 5) 内存监控
    stopMemory = safe('memory', () => setupMemoryMonitor({ metric, interval: cfg.memoryInterval }))
    // 6) 请求 body 采样（analytics 同意被拒绝时不采集，尊重 GPC/DNT）
    stopBodySampler = safe('bodySampler', () => consentMap.analytics ? setupBodySampler({ metric, sampleRate: cfg.requestBodySampling, sanitizer }) : () => {})
    // 7) 白屏检测
    safe('whiteScreen', () => observeWhiteScreen())
    // 8) JS 启动耗时（用双重 rAF 确保渲染完成后再计算）
    requestAnimationFrame(() => requestAnimationFrame(() => metric('js_boot', performance.now() - sdkStartedAt)))
    // 9) 行为监控 + 回放路由分段
    if (cfg.behavior) stopBehavior = safe('behavior', () => setupBehaviorMonitor({ push, sanitizer, onRoute: () => { const start = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => metric('route_render', performance.now() - start))); if (cfg.replaySegmentByRoute && consentMap.replay) endReplaySegment('route') }, formTracking: cfg.formTracking, rageClick: cfg.rageClick, deadClick: cfg.deadClick, interactionTracking: cfg.interactionTracking, inputTracking: cfg.inputTracking, selectTracking: cfg.selectTracking }))
    else if (cfg.replay && consentMap.replay && cfg.replaySegmentByRoute) stopRoute = safe('route', () => setupRouteMonitor({ push: () => {}, onRoute: () => endReplaySegment('route') }))
    // 10) 曝光采集
    if (cfg.exposure) stopExposure = safe('exposure', () => setupExposureMonitor({ push }))
    // 11) 网络状态变化 & App 前后台切换
    const onOnline = () => push({ type: 'behavior', name: 'network_change', props: { online: true } })
    const onOffline = () => push({ type: 'behavior', name: 'network_change', props: { online: false } })
    const onVisibility = () => push({ type: 'behavior', name: document.hidden ? 'app_background' : 'app_foreground' })
    addEventListener('online', onOnline)
    addEventListener('offline', onOffline)
    document.addEventListener('visibilitychange', onVisibility)
    push({ type: 'behavior', name: 'app_start' })
    stopLifecycle = () => {
      removeEventListener('online', onOnline)
      removeEventListener('offline', onOffline)
      document.removeEventListener('visibilitychange', onVisibility)
    }
    // 12) 回放录制（replay 同意被拒绝时不录制，尊重 GPC/DNT）
    if (cfg.replay && consentMap.replay) safe('replay', () => startReplay())
    // 13) 可选监控模块（按需开启）
    if (cfg.keyboardTracking) stopKeyboard = safe('keyboard', () => setupKeyboardMonitor({ push, keys: cfg.keyboardTrackingKeys }))
    if (cfg.touchTracking) stopTouch = safe('touch', () => setupTouchMonitor({ push }))
    if (cfg.workerMonitoring) stopWorker = safe('worker', () => setupWorkerMonitor({ error }))
    if (cfg.serviceWorkerMonitoring) stopServiceWorker = safe('serviceWorker', () => setupServiceWorkerMonitor({ metric, error }))
    if (cfg.bundleMonitoring) stopBundle = safe('bundle', () => setupBundleMonitor({ metric }))
  }

  /**
   * 白屏检测：定时检查指定选择器是否渲染出有效内容
   * - 检测到有效内容 → 上报 white_screen 耗时 + blank_screen_rate=0
   * - 超时未检测到 → 上报 blank_screen_rate=100
   */
  function observeWhiteScreen() {
    const started = performance.now()
    clearInterval(whiteScreenTimer)
    whiteScreenTimer = setInterval(() => {
      const element = document.querySelector(cfg.whiteScreenSelector)
      // 有效判定：元素存在且宽高均 > 0（排除 display:none / 空节点）
      if (element?.getBoundingClientRect().width && element.getBoundingClientRect().height) {
        clearInterval(whiteScreenTimer)
        whiteScreenTimer = 0
        metric('white_screen', performance.now())
        metric('blank_screen_rate', 0)
      } else if (performance.now() - started >= cfg.whiteScreenTimeout) {
        // 超时判定为白屏
        clearInterval(whiteScreenTimer)
        whiteScreenTimer = 0
        metric('blank_screen_rate', 100)
      }
    }, 100)
  }

  /** 自定义事件追踪（供业务代码调用） */
  function track(name, props = {}) {
    push({ type: 'track', name, props })
  }

  /** 错误上报：触发回放分段结束（原因=error）并立即发送 */
  function error(err, extra = {}) {
    // SDK-211 · 错误触发升采样：错误发生后升至全采样并扩展留存窗口，保证错误前后上下文完整可恢复。
    triggerErrorBoost()
    endReplaySegment('error')
    push({
      type: 'error',
      name: extra.name || err?.name || 'Error',
      message: err?.message || serialize(err),
      stack: err?.stack || '',
      props: { ...extra, traceId: pageTraceId },
      traceId: pageTraceId
    }, true)
  }

  /** 性能指标上报：记录耗时数据，同时对慢 API 自动上报 slow_api_rate=100 */
  function metric(name, value, props = {}) {
    // 从当前 span 上下文中提取链路追踪信息
    const currentSpan = tracer?.getCurrentSpan?.()
    const spanCtx = currentSpan?.getContext?.()
    const { __traceId: traceId, __spanId: spanId, __parentSpanId: propParentSpanId, ...details } = props
    push({
      type: 'perf',
      metric: name,
      value: Number(value),
      props: details,
      traceId: traceId ?? spanCtx?.traceId ?? pageTraceId,
      spanId,
      parentSpanId: propParentSpanId ?? spanCtx?.parentSpanId
    })
    // 自动检测慢 API（>1s），上报慢请求率指标
    if (name === 'fetch' || name === 'xhr') {
      push({ type: 'perf', metric: 'slow_api_rate', value: Number(value) > 1000 ? 100 : 0, props: { threshold: 1000 } })
    }
  }

  /** 结构化日志上报，服务端会再次执行脱敏 */
  function log(level, message, props = {}) {
    push({ type: 'log', name: String(level || 'info'), message: redact(message), props: redactLogObject(props), traceId: pageTraceId })
  }

  /**
   * 设置隐私同意状态
   * - denied → 停止采集，清空队列和回放缓存
   * - granted → 如果 enabled 则重新启动采集
   */
  function setConsent(status) {
    cfg.consent = status === 'denied' ? 'denied' : 'granted'
    // 重新解析同意分类，确保后续高风险采集模块的门控与新状态一致。
    Object.assign(consentMap, resolveConsent({ consent: cfg.consent, consentCategories: cfg.privacy?.consentCategories }, globalThis.navigator || {}))
    if (cfg.consent === 'denied') {
      stopCapture()
      replayRing.clear()
      void sender.clear()
    }
    if (cfg.consent === 'granted' && cfg.enabled) startCapture()
  }

  /** 启用/禁用 SDK */
  function setEnabled(enabled) {
    cfg.enabled = Boolean(enabled)
    if (!cfg.enabled) {
      stopCapture()
      replayRing.clear()
      void sender.clear()
    }
    if (cfg.enabled && cfg.consent !== 'denied') startCapture()
  }

  /** 停止所有采集模块，恢复默认状态 */
  function stopCapture() {
    if (!captureStarted) return
    stopEnvironment()
    stopRuntime()
    stopBehavior()
    stopRoute()
    stopError()
    stopExposure()
    stopLifecycle()
    stopConsole()
    stopMemory()
    stopBodySampler()
    stopKeyboard()
    stopTouch()
    stopWorker()
    stopServiceWorker()
    stopBundle()
    clearInterval(whiteScreenTimer)
    whiteScreenTimer = 0
    stopCurrentReplay()
    captureStarted = false
  }

  /** 设置全局上下文（脱敏后合并到所有上报事件中） */
  function setContext(context = {}) {
    Object.assign(globalContext, redactObject(context, cfg.privacy.redactKeys))
  }

  /** 添加面包屑——记录最近操作，错误发生时自动附着到错误事件上 */
  function addBreadcrumb(name, data = {}) {
    remember({ type: 'track', name: String(name || 'breadcrumb'), message: JSON.stringify(redactObject(data, cfg.privacy.redactKeys)), ts: Date.now(), url: location.href })
  }

  /**
   * 开始一个事务（Transaction）
   * 用于追踪一个完整业务流程的耗时，如"支付流程"、"表单提交"
   * @param {string} name - 事务名称
   * @param {object} [context={}] - 初始上下文
   * @returns {{ setData: Function, finish: Function }} 事务对象
   */
  function startTransaction(name, context = {}) {
    const startedAt = performance.now()
    let data = { ...context }
    let finished = false
    return {
      setData(value = {}) { data = { ...data, ...value } },
      finish(result = {}) {
        if (finished) return
        finished = true
        metric('transaction', performance.now() - startedAt, { name, ...data, ...result })
      }
    }
  }

  /** 设置用户信息，已入队事件会回填用户字段 */
  function setUser(user = {}) {
    cfg.userId = user.id || user.userId || cfg.userId || ''
    cfg.userName = user.name || user.userName || cfg.userName || ''
    cfg.userPhone = user.phone || user.userPhone || cfg.userPhone || ''
    sender.forEachItem(item => {
      item.userId ||= cfg.userId
      item.userName ||= cfg.userName
      item.userPhone ||= sanitizer.userPhone(cfg.userPhone)
    })
    sender.persist()
  }


  /**
   * 将事件推入上报队列。
   * @param {object} event - 事件对象
   * @param {boolean} [urgent=false] - 是否立即触发上报
   */
  function push(event, urgent = false) {
    if (!cfg.enabled || cfg.consent === 'denied') {
      stats.dropped++
      stats.droppedByConsent++
      return
    }
    const item = withBase(event)
    // 回放事件不参与采样丢弃：回放有独立的缓冲区与采样策略（路线图 Phase 7 / SDK-209）。
    if (item.type !== 'replay') {
      const category = eventCategory(item)
      const priority = item.type === 'error'
      // 错误事件标记其链路优先保留，保证「错误→trace」关联不被采样切断（错误会话按策略保留）。
      if (priority && item.traceId) sampler.markPriority(item.traceId)
      const decision = sampler.decide({ traceId: item.traceId, sessionId, category, priority })
      if (!decision.sampled) {
        stats.dropped++
        stats.droppedBySample++
        lastSamplingDecision = decision
        // 可解释诊断：丢弃原因带上决策规则/采样率/单元/键，不含任何业务敏感数据。
        diagnostic.emit('dropped_by_sampling', {
          rule: decision.rule,
          rate: decision.rate,
          unit: decision.unit,
          key: decision.key,
          category: decision.category,
          type: item.type,
          name: item.name,
          metric: item.metric
        })
        return
      }
      lastSamplingDecision = decision
    }
    let prepared = sanitizer.sanitizeEvent(item)
    if (typeof cfg.beforeSend === 'function') {
      try { prepared = cfg.beforeSend(prepared) } catch { prepared = false }
    }
    if (prepared && typeof prepared === 'object') prepared = sanitizer.sanitizeEvent(prepared)
    if (!prepared || typeof prepared !== 'object') {
      stats.dropped++
      return
    }
    stats.enqueued++
    remember(prepared)
    if (isDuplicate(prepared)) return
    sender.enqueue(prepared)
    if (urgent || sender.size() >= cfg.batchSize) flush(urgent)
  }

  /** 为事件附加基础信息（appId、sessionId、URL、UA、时间戳等） */
  function withBase(event) {
    return {
      sdkVersion: SDK_VERSION,
      environment: cfg.environment,
      source: eventSource(event),
      appId: cfg.appId,
      release: cfg.release,
      userId: cfg.userId,
      userName: cfg.userName,
      userPhone: sanitizer.userPhone(cfg.userPhone),
      sessionId,
      deviceId,
      url: location.href,
      path: location.pathname,
      title: document.title,
      referrer: document.referrer,
      userAgent: navigator.userAgent,
      context: { ...globalContext, ...(event.context || {}) },
      ts: Date.now(),
      retry: 0,
      breadcrumbs: event.type === 'error' ? breadcrumbs.slice(-20) : undefined,
      ...event
    }
  }

  /**
   * 事件去重：1 秒内相同指纹（type|name|metric|message|url）的事件视为重复，跳过上报。
   * 回放事件不做去重。
   */
  function isDuplicate(event) {
    if (event.type === 'replay') return false
    const now = Date.now()
    const fp = [event.type, event.name, event.metric, event.message, event.url].join('|')
    while (recent.length && now - recent[0].ts > 1000) recent.shift()
    if (recent.some(item => item.fp === fp)) return true
    recent.push({ fp, ts: now })
    return false
  }

  /**
   * 在线批量上报队列中的事件（Reliable Transport v2）。
   * 实际发送、超时、退避重试、4xx 丢弃与 GIF 兜底均由 `ReliableSender` 负责。
   * @param {boolean} [force=false] - 是否连续发送直到清空（页面退出在线兜底）
   */
  async function flush(force = false) {
    if (!cfg.enabled || cfg.consent === 'denied') return
    return sender.sendBatchOnline(force)
  }

  /**
   * 刷新所有队列（回放 + 普通事件）。
   * force=true（页面卸载/隐藏/冻结）时先走 Beacon 尽力排队（非破坏性，服务端按
   * eventId 幂等去重），再尝试在线 keepalive 兜底；并冲刷 Span 缓冲。
   * @param {boolean} [force=false]
   */
  async function flushAll(force = false) {
    if (force) {
      // 页面退出/隐藏/冻结：先把留存回放（错误前 30 秒窗口）冲刷进队列，再走 Beacon 尽力排队。
      await flushReplay(true)
      await sender.sendExitBatch()
    }
    await flush(force)
    if (force) tracer?.flushSpans?.()
  }

  /** 记录用户行为面包屑（最近 20 条），用于错误事件的上下文还原 */
  function remember(event) {
    if (!['behavior', 'track', 'perf', 'console'].includes(event.type)) return
    breadcrumbs.push({ type: event.type, name: event.name || event.metric, message: event.message, ts: event.ts, url: event.url })
    if (breadcrumbs.length > 20) breadcrumbs.shift()
  }

  /** 将回放事件写入环形缓冲，达到阈值后批量上报 */
  function queueReplay(event) {
    const now = Date.now()
    // SDK-211 · 错误触发升采样：窗口过期后退出升采样并恢复常态窗口。
    if (errorBoosted && now > errorBoostUntil) {
      errorBoosted = false
      replayRing.setWindow(cfg.replayWindowMs)
    }
    // SDK-211 · 常态降采样（replaySampleRate<1 时降本）；错误升采样期间全保留。
    if (!replayShouldKeep(cfg.replaySampleRate, errorBoosted, Math.random)) {
      replaySampledDrops++
      return
    }
    const { evicted } = replayRing.push(event)
    if (evicted > 0) diagnostic.emit('replay_buffer_full', { evicted })
    if (replayRing.size >= cfg.replayBatchSize) flushReplay()
  }

  /**
   * SDK-211 · 错误触发升采样：升至全采样并将留存窗口扩展为 replayWindowMsError，
   * 同时发出 `replay_error_triggered` 诊断，便于回放侧识别「错误会话」并优先保留。
   */
  function triggerErrorBoost() {
    if (!cfg.replayErrorTrigger) return
    errorBoosted = true
    errorBoostUntil = Date.now() + cfg.replayWindowMsError
    replayRing.setWindow(cfg.replayWindowMsError)
    diagnostic.emit('replay_error_triggered', { windowMs: cfg.replayWindowMsError, boosted: true })
  }

  /**
   * 结束当前回放分段。
   * 设定结束原因 → 刷新当前缓冲区（附带原因） → 拍全量快照 → 生成新 sessionId → 清空缓存。
   * 新 sessionId 使后续事件写入独立的回放记录，与上一段完全分开。
   * @param {'error'|'route'|'max_duration'|'page_unload'} reason - 结束原因
   */
  function endReplaySegment(reason) {
    if (!cfg.replay) return
    clearTimeout(replayStartTimer)
    stopCurrentReplay()
    currentSegmentEndReason = reason
    // flushReplay 已改为异步（含压缩），此处 fire-and-forget：错误/路由切换时确保留存窗口随分段上报。
    flushReplay(true)
    replaySegIndex++
    currentReplaySessionId = `${replayBaseSessionId}_seg${replaySegIndex}`
    currentSegmentEndReason = null
    if (reason !== 'max_duration' && reason !== 'page_unload') {
      replayStartTimer = setTimeout(() => { startReplay() }, 120)
    }
  }

  /** 启动会话回放录制（异步懒加载 rrweb，SDK-209） */
  async function startReplay() {
    if (stopReplay) return
    // 回放仅浏览器有意义；非浏览器环境（Node 测试 / SSR）直接跳过，避免加载 rrweb。
    if (typeof document === 'undefined' || typeof window === 'undefined') return
    // 懒加载 rrweb 驱动；失败时降级关闭回放，不拖垮 SDK（绝不抛出未处理 rejection）。
    try {
      await ensureDriver({ replayLibUrl: cfg.replayLibUrl })
    } catch (err) {
      console.warn('[web-collection] 加载 rrweb 失败，回放已降级关闭：', err && err.message)
      return
    }
    // 加载期间 SDK 可能已被销毁（或录制已被停止）：立即停录并返回，避免 rrweb 内部定时器泄露。
    if (stopReplay || disposed) {
      if (stopReplay) stopCurrentReplay()
      return
    }
    try {
      const blockSelector = [...(cfg.privacy.blockSelectors || []), '.eys-block'].filter(Boolean).join(',')
      const maskSelector = [...(cfg.privacy.maskSelectors || [])].filter(Boolean).join(',')
      // SDK-211 · Canvas / iframe 显式 opt-in：默认关闭，开启后透传 rrweb 的对应开关。
      // 完整 Canvas 保真度需由 replayOptions.plugins 提供 @rrweb/rrweb-plugin-canvas 实例。
      stopReplay = setupReplayMonitor({
        emit: queueReplay,
        options: {
          ...cfg.replayOptions,
          blockSelector,
          maskSelector,
          recordCanvas: cfg.replayCanvas,
          recordCrossOriginIframes: cfg.replayIframe,
          inlineIframes: cfg.replayIframe,
          // SDK-211 · 录制质量：rrweb 录制内部报错转为结构化诊断（不含 PII）。
          errorHandler: (e) => diagnostic.emit('replay_recorder_error', { message: String((e && e.message) || e || '').slice(0, 200) })
        }
      })
    } catch (err) {
      console.warn('[web-collection] 启动 rrweb 录制失败，回放已降级关闭：', err && err.message)
      return
    }
    // 极少竞态：录制刚建立即已销毁，立即停录。
    if (disposed) { stopCurrentReplay(); return }
    clearTimeout(replayStopTimer)
    if (cfg.replayMaxDuration > 0) {
      replayStopTimer = setTimeout(() => endReplaySegment('max_duration'), cfg.replayMaxDuration)
    }
  }

  /** 停止回放录制并立即刷新缓冲区 */
  async function stopReplayRecording() {
    stopCurrentReplay()
    await flushReplay(true)
  }

  /** 停止当前回放录制：清除定时器、调用 stopReplay 清理函数、置空引用 */
  function stopCurrentReplay() {
    clearTimeout(replayStopTimer)
    stopReplay?.()
    stopReplay = null
  }

  /**
   * 将环形缓冲中的回放事件推入上报队列，使用当前分段专属 sessionId。
   * 强制 flush（错误/分段结束/页面卸载）时取出**全部留存**（错误前 30 秒），非强制时按批次增量。
   * SDK-211 · 分页加载：按 replayPageSize（强制）/replayBatchSize（增量）拆分为多页，
   * 每页一条独立 replay 记录并附带 page/pageCount，回放侧可渐进加载。
   * 开启 replayCompression 时逐页 gzip（Worker / 主线程），随 compression 标记上报；失败时回退原样。
   * @param {boolean} [force=false]
   */
  async function flushReplay(force = false) {
    if (!replayRing.size) return
    const pageSize = force ? cfg.replayPageSize : cfg.replayBatchSize
    const events = force ? replayRing.drain() : replayRing.take(pageSize)
    if (!events.length) return
    const pages = paginate(events, pageSize)
    const now = Date.now()
    let compressedPages = 0
    for (let i = 0; i < pages.length; i++) {
      const pageEvents = pages[i]
      let payload = pageEvents
      let compression = 'none'
      if (replayCompressor) {
        try {
          const res = await replayCompressor.compress(pageEvents)
          payload = res.body
          compression = res.compression
          if (compression === 'gzip') {
            compressedPages++
            diagnostic.emit('replay_compressed', { bytes: payload.length })
          }
        } catch {
          payload = pageEvents
          compression = 'none'
        }
      }
      const item = withBase({ type: 'replay' })
      // 回放事件使用分段 sessionId（而非全局 sessionId），每个分段独立成一条记录。
      item.sessionId = currentReplaySessionId
      item.events = payload
      item.compression = compression
      // SDK-211 · 分页加载元数据：当前页序号与总页数（从 1 计数）。
      item.page = i + 1
      item.pageCount = pages.length
      if (force && i === pages.length - 1 && currentSegmentEndReason) {
        item.segmentEndReason = currentSegmentEndReason
      }
      sender.enqueue(item)
    }
    if (force || sender.size() >= cfg.batchSize) flush(force)
    // SDK-211 · 录制质量与丢帧指标（节流，强制刷新时必发）：缓冲水位、累计淘汰/降采样、压缩与分页概况。
    if (force || now - lastQualityEmit > 5000) {
      lastQualityEmit = now
      diagnostic.emit('replay_quality', {
        buffered: replayRing.size,
        evictedTotal: replayRing.evictedTotal,
        sampledDrops: replaySampledDrops,
        compression: replayCompressor ? 'gzip/none' : 'none',
        compressedPages,
        pages: pages.length,
        sampleRate: cfg.replaySampleRate,
        errorBoosted,
        windowMs: replayRing.windowMs
      })
    }
  }

  /** 销毁 SDK 实例：清除定时器、停止录制、刷新全部队列 */
  async function destroy() {
    disposed = true
    clearInterval(timer)
    clearTimeout(replayStartTimer)
    finalizePerformance()
    stopCapture()
    await stopReplayRecording()
    stopCurrentReplay() // 兜底停录：捕获 destroy 竞态期间才完成的 startReplay
    replayCompressor?.destroy()
    replayRing.clear()
    if (stats.dropped || stats.failed) push({ type: 'perf', metric: 'sdk_health', value: stats.enqueued, props: { ...stats }, source: 'auto' })
    await flushAll(true)
    // 关闭 Span 导出管线，冲刷剩余缓冲（根/未结束 Span），避免调用树丢失尾包。
    await tracer?.shutdownSpans?.()
    // 必须在所有发送（flushAll 内的 sendExitBatch 会再次 acquire 锁）完成之后才关闭跨标签页锁，
    // 否则 acquire 会重新创建 BroadcastChannel（PipeWrap/MessagePort），导致进程/Worker 无法退出。
    multiTabLock?.close?.()
    multiTabLock = null
  }
}

/**
 * Vue 插件安装函数。
 * 创建 SDK 实例，劫持 Vue 全局错误处理器自动上报，
 * 并将实例挂载到 `app.config.globalProperties.$eys` 供组件内调用。
 *
 * @param {import('vue').App} app - Vue 应用实例
 * @param {object} [options={}] - SDK 配置项，同 createEys
 */
export function install(app, options = {}) {
  const eys = createEys(options)
  const previous = app.config.errorHandler
  app.config.errorHandler = (err, instance, info) => {
    eys.error(err, { source: 'vue', info, component: instance?.type?.name || '' })
    previous?.(err, instance, info)
  }
  app.config.globalProperties.$eys = eys
}

/**
 * 链路追踪未启用时的降级 span
 * @returns {object}
 */
function noopSpan() {
  return {
    setAttribute() { return this },
    setAttributes() { return this },
    addEvent() {},
    recordException() {},
    setStatus() {},
    end() {},
    isEnded() { return false },
    getContext() { return {} },
    toJSON() { return {} }
  }
}

/**
 * 生成指定字节数的安全随机十六进制字符串
 * 用于 traceId（16 字节 → 32 位十六进制）等 ID 生成
 * @param {number} bytes - 字节数
 * @returns {string} 十六进制字符串
 */
function randomHex(bytes) {
  const data = new Uint8Array(bytes)
  crypto.getRandomValues(data)
  return [...data].map(value => value.toString(16).padStart(2, '0')).join('')
}

/**
 * 敏感信息脱敏（正则替换）
 * 处理两种模式：
 *   1. key=value / key: value → key=[REDACTED]
 *   2. 手机号中间四位替换为 ****
 * 结果截断到 500 字符
 * @param {*} value - 需要脱敏的值
 * @returns {string} 脱敏后字符串
 */
function redact(value) {
  return String(value).replace(/(authorization|password|token|secret|cookie)(["'\s:=]+)[^\s,;}]+/gi, '$1$2[REDACTED]').replace(/\b1\d{2}\d{4}(\d{4})\b/g, '***$1').slice(0, 500)
}

/**
 * 对日志 props 对象做脱敏
 * 遍历对象每个条目（最多 50 个），先序列化再脱敏
 * @param {object} [value={}]
 * @returns {object} 脱敏后的对象
 */
function redactLogObject(value = {}) {
  return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [key, redact(serialize(item))]))
}

/**
 * 任意值安全的 JSON 序列化
 * - 普通对象 → JSON string
 * - Error 实例 / 不可序列化对象 → "[Unserializable]"
 * @param {*} value
 * @returns {string}
 */
function serialize(value) {
  if (typeof value !== 'object' || value === null) return value
  try { return JSON.stringify(value) } catch { return '[Unserializable]' }
}

export * from './trace/index.js'
export default { createEys, install }
