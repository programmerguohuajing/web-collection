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
import { addReplayEvent, setupReplayMonitor, takeReplaySnapshot } from './replay/index.js'
import { setupServiceWorkerMonitor } from './runtime/sw.js'
import { imageReport } from './core/report.js'
import { SDK_VERSION, eventCategory, eventSource, redactObject, sampleRateFor, sanitizeEvent } from './core/event.js'
import { getId } from './utils/id.js'
import { setupEnvironmentMonitor } from './utils/environment.js'
import { setupRuntimeMonitor } from './utils/runtime.js'
// 链路追踪模块
import { createTracer, createSampler, Tracer, getCurrentSpan, Span, SpanKind } from './trace/index.js'

/** localStorage 中持久化待上报事件队列的键名 */
const STORE_KEY = '__web_collection_queue__'

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
 * @param {number} [options.flushInterval=5000] - 定时批量上报的时间间隔（ms）
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
    flushInterval: 5000,
    // maxQueue 表示本地队列最大可缓存事件数。
    maxQueue: 200,
    // maxRetries 表示单次上报失败后的最大重试次数。
    maxRetries: 3,
    // sampleRate 控制当前会话是否命中采样。
    sampleRate: 1,
    // behavior 控制是否开启行为采集。
    behavior: true,
    console: true,
    consoleLevels: ['log', 'info', 'warn', 'error'],
    collectKey: '',
    tracing: true,
    traceOrigins: [],
    // distributedTracing 开启链路追踪的层级 span 功能
    distributedTracing: true,
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
    ...options
  }
  cfg.privacy ||= {}
  // 采样未命中时直接返回一个空实现客户端。
  if (Math.random() > cfg.sampleRate) return noopClient()

  // sessionId 标识当前页面访问会话。
  const sessionId = getId('eys_sid')
  const deviceId = getId('eys_did', true)
  // queue 持久化待上报事件；recent/breadcrumbs 用于去重和错误上下文；replayEvents 用于临时缓存回放片段。
  const queue = loadQueue(cfg.maxQueue)
  const recent = []
  const breadcrumbs = []
  const globalContext = {}
  const stats = { enqueued: 0, dropped: 0, droppedByConsent: 0, droppedBySample: 0, sent: 0, failed: 0 }
  const originalFetch = window.fetch?.bind(window)
  const replayEvents = []
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
        sampler: createSampler({ sampleRate: cfg.sampleRate, categorySampleRates: cfg.categorySampleRates })
      })
    } catch (err) {
      console.warn('[web-collection] 初始化链路追踪失败，已降级关闭：', err)
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
  let flushing = false
  let stopReplay = null
  let replayStopTimer = 0
  let replayStartTimer = 0
  let whiteScreenTimer = 0
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
    startReplay,
    stopReplay: stopReplayRecording,
    flushReplay,
    addReplayEvent,
    takeReplaySnapshot,
    endReplaySegment,
    // 链路追踪公共 API
    startSpan: tracer ? (name, options) => tracer.startSpan(name, options) : noopSpan,
    withSpan: tracer ? (name, fn, options) => tracer.withSpan(name, fn, options) : (name, fn) => fn(),
    getCurrentSpan: () => tracer?.getCurrentSpan?.() ?? null
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
    // 6) 请求 body 采样
    stopBodySampler = safe('bodySampler', () => setupBodySampler({ metric, sampleRate: cfg.requestBodySampling }))
    // 7) 白屏检测
    safe('whiteScreen', () => observeWhiteScreen())
    // 8) JS 启动耗时（用双重 rAF 确保渲染完成后再计算）
    requestAnimationFrame(() => requestAnimationFrame(() => metric('js_boot', performance.now() - sdkStartedAt)))
    // 9) 行为监控 + 回放路由分段
    if (cfg.behavior) stopBehavior = safe('behavior', () => setupBehaviorMonitor({ push, onRoute: () => { const start = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => metric('route_render', performance.now() - start))); if (cfg.replaySegmentByRoute) endReplaySegment('route') }, formTracking: cfg.formTracking, rageClick: cfg.rageClick, deadClick: cfg.deadClick, interactionTracking: cfg.interactionTracking, inputTracking: cfg.inputTracking, selectTracking: cfg.selectTracking }))
    else if (cfg.replay && cfg.replaySegmentByRoute) stopRoute = safe('route', () => setupRouteMonitor({ push: () => {}, onRoute: () => endReplaySegment('route') }))
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
    // 12) 回放录制
    if (cfg.replay) safe('replay', () => startReplay())
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
    if (cfg.consent === 'denied') {
      stopCapture()
      queue.length = 0
      replayEvents.length = 0
      saveQueue()
    }
    if (cfg.consent === 'granted' && cfg.enabled) startCapture()
  }

  /** 启用/禁用 SDK */
  function setEnabled(enabled) {
    cfg.enabled = Boolean(enabled)
    if (!cfg.enabled) {
      stopCapture()
      queue.length = 0
      replayEvents.length = 0
      saveQueue()
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
    queue.forEach(item => {
      item.userId ||= cfg.userId
      item.userName ||= cfg.userName
      item.userPhone ||= cfg.userPhone
    })
    saveQueue()
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
    if (Math.random() > sampleRateFor(eventCategory(item), cfg.categorySampleRates, 1)) {
      stats.dropped++
      stats.droppedBySample++
      return
    }
    let prepared = sanitizeEvent(item, cfg.privacy)
    if (typeof cfg.beforeSend === 'function') {
      try { prepared = cfg.beforeSend(prepared) } catch { prepared = false }
    }
    if (prepared && typeof prepared === 'object') prepared = sanitizeEvent(prepared, cfg.privacy)
    if (!prepared || typeof prepared !== 'object') {
      stats.dropped++
      return
    }
    stats.enqueued++
    remember(prepared)
    if (isDuplicate(prepared)) return
    queue.push(prepared)
    if (queue.length > cfg.maxQueue) queue.splice(0, queue.length - cfg.maxQueue)
    saveQueue()
    if (urgent || queue.length >= cfg.batchSize) flush(urgent)
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
      userPhone: cfg.userPhone,
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
   * 批量上报队列中的事件。
   * force=true 且未配置采集密钥时优先使用 sendBeacon（适合页面卸载场景），
   * 配置 collectKey 后改用 fetch + keepalive，以便携带 x-app-key。
   * 否则使用 fetch；两者都不可用时降级为 GIF 图片上报。
   * 上报失败后增加 retry 计数，超过最大重试次数的事件会被丢弃。
   * @param {boolean} [force=false] - 是否强制立即上报（页面卸载等场景）
   */
  async function flush(force = false) {
    if (!cfg.enabled || cfg.consent === 'denied' || flushing || !queue.length) return
    flushing = true
    const batch = queue.slice(0, cfg.batchSize)
    const body = JSON.stringify({ events: batch })
    try {
      if (force && !cfg.collectKey && navigator.sendBeacon && body.length < 64000) {
        if (!navigator.sendBeacon(cfg.endpoint, new Blob([body], { type: 'application/json' }))) throw new Error('beacon failed')
      } else if (originalFetch) {
        const res = await originalFetch(cfg.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(cfg.collectKey ? { 'x-app-key': cfg.collectKey } : {}) },
          body,
          keepalive: force && body.length < 64000
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
      } else {
        batch.forEach(item => imageReport(item))
      }
      queue.splice(0, batch.length)
      stats.sent += batch.length
    } catch {
      stats.failed += batch.length
      batch.forEach(item => item.retry++)
      queue.splice(0, batch.length, ...batch.filter(item => item.retry <= cfg.maxRetries))
    } finally {
      saveQueue()
      flushing = false
    }
  }

  /** 记录用户行为面包屑（最近 20 条），用于错误事件的上下文还原 */
  function remember(event) {
    if (!['behavior', 'track', 'perf', 'console'].includes(event.type)) return
    breadcrumbs.push({ type: event.type, name: event.name || event.metric, message: event.message, ts: event.ts, url: event.url })
    if (breadcrumbs.length > 20) breadcrumbs.shift()
  }

  /** 将回放事件加入临时缓存，达到阈值后批量上报 */
  function queueReplay(event) {
    replayEvents.push(event)
    if (replayEvents.length >= cfg.replayBatchSize) flushReplay()
  }

  /**
   * 结束当前回放分段。
   * 设定结束原因 → 刷新当前缓冲区（附带原因） → 拍全量快照 → 生成新 sessionId → 清空缓存。
   * 新 sessionId 使后续事件写入独立的回放记录，与上一段完全分开。
   * @param {'error'|'route'} reason - 结束原因
   */
  function endReplaySegment(reason) {
    if (!cfg.replay) return
    clearTimeout(replayStartTimer)
    stopCurrentReplay()
    currentSegmentEndReason = reason
    flushReplay(true)
    replaySegIndex++
    currentReplaySessionId = `${replayBaseSessionId}_seg${replaySegIndex}`
    currentSegmentEndReason = null
    if (reason !== 'max_duration' && reason !== 'page_unload') {
      replayStartTimer = setTimeout(startReplay, 120)
    }
  }

  /** 启动会话回放录制 */
  function startReplay() {
    if (stopReplay) return
    const blockSelector = [...(cfg.privacy.blockSelectors || []), '.eys-block'].filter(Boolean).join(',')
    const maskSelector = [...(cfg.privacy.maskSelectors || [])].filter(Boolean).join(',')
    stopReplay = setupReplayMonitor({ emit: queueReplay, options: { ...cfg.replayOptions, blockSelector, maskSelector } })
    clearTimeout(replayStopTimer)
    if (cfg.replayMaxDuration > 0) {
      replayStopTimer = setTimeout(() => endReplaySegment('max_duration'), cfg.replayMaxDuration)
    }
  }

  /** 停止回放录制并立即刷新缓冲区 */
  function stopReplayRecording() {
    stopCurrentReplay()
    flushReplay(true)
  }

  /** 停止当前回放录制：清除定时器、调用 stopReplay 清理函数、置空引用 */
  function stopCurrentReplay() {
    clearTimeout(replayStopTimer)
    stopReplay?.()
    stopReplay = null
  }

  /** 将缓存的回放事件推入上报队列，使用当前分段专属 sessionId。
   *  强制 flush 时附带 segmentEndReason 以标记该段为什么结束。 */
  function flushReplay(force = false) {
    if (!replayEvents.length) return
    const size = force ? replayEvents.length : cfg.replayBatchSize
    const item = withBase({ type: 'replay' })
    // 回放事件使用分段 sessionId（而非全局 sessionId），每个分段独立成一条记录
    item.sessionId = currentReplaySessionId
    item.events = replayEvents.splice(0, size)
    if (force && currentSegmentEndReason) {
      item.segmentEndReason = currentSegmentEndReason
    }
    queue.push(item)
    saveQueue()
    if (force || queue.length >= cfg.batchSize) flush(force)
  }

  /** 刷新所有队列（回放 + 普通事件） */
  function flushAll(force = false) {
    flushReplay(force)
    flush(force)
  }

  /** 销毁 SDK 实例：清除定时器、停止录制、刷新全部队列 */
  function destroy() {
    clearInterval(timer)
    clearTimeout(replayStartTimer)
    finalizePerformance()
    stopCapture()
    stopReplayRecording()
    if (stats.dropped || stats.failed) push({ type: 'perf', metric: 'sdk_health', value: stats.enqueued, props: { ...stats }, source: 'auto' })
    flushAll(true)
  }

  /** 将队列持久化到 localStorage，防止页面刷新丢失 */
  function saveQueue() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(queue.slice(-cfg.maxQueue))) } catch {}
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
 * 从 localStorage 加载之前持久化的事件队列
 * @param {number} maxQueue - 最大保留条数
 * @returns {object[]} 恢复的事件数组
 */
function loadQueue(maxQueue) {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]').slice(-maxQueue) } catch { return [] }
}

/**
 * 采样未命中时返回的空实现客户端
 * 所有方法均为 no-op，无任何副作用。ID 生成器等透传方法则原样返回。
 * @returns {object} 空操作的客户端对象
 */
function noopClient() {
  return {
    track() {},
    error() {},
    metric() {},
    log() {},
    setUser() {},
    setConsent() {},
    setEnabled() {},
    setContext() {},
    addBreadcrumb() {},
    startTransaction() { return { setData() {}, finish() {} } },
    markPageReady() {},
    flush() {},
    destroy() {},
    startReplay() {},
    stopReplay() {},
    flushReplay() {},
    addReplayEvent() {},
    takeReplaySnapshot() {},
    endReplaySegment() {},
    startSpan() { return noopSpan() },
    withSpan(name, fn) { return fn() },
    getCurrentSpan() { return null }
  }
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

export default { createEys, install }
