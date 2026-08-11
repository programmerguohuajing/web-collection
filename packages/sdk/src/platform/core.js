/**
 * @file 平台层核心 SDK
 * 提供 createPlatformEys 工厂函数，通过适配器模式抽象掉不同宿主环境的差异，
 * 实现统一的埋点、错误追踪、网络请求监控、页面生命周期插桩。
 * 与 Web 端 SDK 共享 core/event.js 中的事件分类、采样、脱敏等核心逻辑。
 */
import { SDK_VERSION, eventCategory, eventSource, redactObject, sampleRateFor, sanitizeEvent } from '../core/event.js'

/** 存储队列和 deviceId 的 localStorage key */
const QUEUE_KEY = '__web_collection_platform_queue__'
const DEVICE_KEY = '__web_collection_device_id__'

/**
 * 创建平台 SDK 实例
 * @param {object}   options - 平台配置项
 * @param {import('../../platform.d.ts').PlatformAdapter} adapter - 平台适配器
 * @returns {import('../../platform.d.ts').PlatformEysClient}
 */
export function createPlatformEys(options = {}, adapter) {
  if (!adapter?.request) throw new Error('Web Collection: platform request adapter is required')
  const startedAt = Date.now()

  // ========== 合并配置 ==========
  const cfg = {
    endpoint: '/api/collect',
    appId: 'default',
    release: 'dev',
    userId: '',
    userName: '',
    userPhone: '',
    batchSize: 10,
    flushInterval: 60000,
    maxQueue: 200,
    maxRetries: 3,
    sampleRate: 1,
    collectKey: '',
    enabled: true,
    consent: 'granted',
    environment: 'production',
    categorySampleRates: {},
    beforeSend: null,
    privacy: {},
    ...options
  }
  cfg.privacy ||= {}
  // 采样判断：随机数大于采样率则返回空操作客户端（不上报任何数据）
  if (Math.random() > cfg.sampleRate) return noopClient()

  // ========== 实例状态 ==========
  const sessionId = id()
  const pageTraceId = id().replace(/-/g, '').slice(0, 32)  // 页面级 TraceId，用于链路追踪
  const queue = []              // 事件上报队列
  const breadcrumbs = []        // 面包屑（最近事件快照，错误上报时附带）
  const pageStarts = new WeakMap()  // 页面开始时间记录（WeakMap 自动 GC，无内存泄漏）
  const disposers = []          // 清理函数集合
  let deviceId = id()
  let flushing = false          // 是否正在上报
  let flushAllRequested = false // 是否请求了全量上报
  let destroyed = false
  let persistence = Promise.resolve()
  let lastError = { fingerprint: '', ts: 0 }  // 错误去重：相同错误 1 秒内不重复上报
  const globalContext = {}
  const stats = { enqueued: 0, dropped: 0, droppedByConsent: 0, droppedBySample: 0, sent: 0, failed: 0 }
  let errorsRegistered = false

  // ========== 初始化 ==========
  const ready = hydrate()                    // 从存储恢复队列和 deviceId
  const timer = setInterval(flush, cfg.flushInterval)  // 定时上报
  if (cfg.enabled && cfg.consent !== 'denied') registerGlobalErrors()  // 注册全局错误监听

  // ========== 公开 API ==========
  return {
    track,
    error,
    metric,
    behavior,
    setConsent,
    setEnabled,
    setContext,
    addBreadcrumb,
    startTransaction,
    pageView,
    pageLeave,
    markPageReady: () => metric('data_ready', Date.now() - startedAt),
    setUser,
    flush,
    destroy,
    wrapRequest,
    wrapFetch,
    instrumentApp,
    instrumentPage
  }

  // ================================================================
  //  核心方法
  // ================================================================

  function track(name, props = {}) {
    push({ type: 'track', name, props })
  }

  function behavior(name, props = {}) {
    push({ type: 'behavior', name, props, source: 'platform' })
  }

  function metric(name, value, props = {}) {
    // 提取 __traceId / __spanId 作为独立字段，实现链路追踪串联
    const { __traceId: traceId = pageTraceId, __spanId: spanId, ...details } = props
    push({ type: 'perf', metric: name, value: Number(value), props: details, traceId, spanId, source: 'platform' })
  }

  function error(reason, extra = {}) {
    const err = normalizeError(reason)
    const fingerprint = `${err.name}|${err.message}|${err.stack}`
    const now = Date.now()
    // 错误去重：相同指纹的错误在 1 秒内只上报一次
    if (lastError.fingerprint === fingerprint && now - lastError.ts < 1000) return
    lastError = { fingerprint, ts: now }
    push({ type: 'error', name: err.name, message: err.message, stack: err.stack, props: extra, traceId: pageTraceId, source: 'platform' }, true)
  }

  function setConsent(status) {
    cfg.consent = status === 'denied' ? 'denied' : 'granted'
    // 拒绝时清空队列并持久化
    if (cfg.consent === 'denied') {
      queue.length = 0
      void persist()
    }
    if (cfg.consent === 'granted' && cfg.enabled) registerGlobalErrors()
  }

  function setEnabled(enabled) {
    cfg.enabled = Boolean(enabled)
    if (!cfg.enabled) {
      queue.length = 0
      void persist()
    }
    if (cfg.enabled && cfg.consent !== 'denied') registerGlobalErrors()
  }

  function setContext(context = {}) { Object.assign(globalContext, redactObject(context, cfg.privacy.redactKeys)) }

  function addBreadcrumb(name, data = {}) {
    breadcrumbs.push({ type: 'track', name: String(name || 'breadcrumb'), message: JSON.stringify(redactObject(data, cfg.privacy.redactKeys)), ts: Date.now(), url: adapter.getContext?.().url || '' })
    // 最多保留 20 条面包屑
    if (breadcrumbs.length > 20) breadcrumbs.shift()
  }

  function startTransaction(name, context = {}) {
    const startedAt = Date.now()
    let data = { ...context }
    let finished = false
    return {
      setData(value = {}) { data = { ...data, ...value } },
      finish(result = {}) {
        if (finished) return  // 防止重复结束
        finished = true
        metric('transaction', Date.now() - startedAt, { name, ...data, ...result })
      }
    }
  }

  function pageView(path, props = {}) {
    behavior('pv', { path, ...props })
  }

  function pageLeave(path, stayTime, props = {}) {
    behavior('page_leave', { path, stayTime: Math.max(0, Number(stayTime) || 0), ...props })
  }

  function setUser(user = {}) {
    cfg.userId = user.id || user.userId || cfg.userId
    cfg.userName = user.name || user.userName || cfg.userName
    cfg.userPhone = user.phone || user.userPhone || cfg.userPhone
    // 将用户信息回填到已入队的事件中
    queue.forEach(item => {
      item.userId ||= cfg.userId
      item.userName ||= cfg.userName
      item.userPhone ||= cfg.userPhone
    })
    persist()
  }

  /**
   * 事件入队核心方法
   * 经过采样、脱敏、beforeSend 钩子后进入队列
   * @param {object} event  - 原始事件对象
   * @param {boolean} [urgent=false] - 是否立即发送
   */
  function push(event, urgent = false) {
    if (destroyed) return
    // 禁用或拒绝时直接丢弃
    if (!cfg.enabled || cfg.consent === 'denied') {
      stats.dropped++
      stats.droppedByConsent++
      return
    }
    const context = adapter.getContext?.() || {}
    let item = {
      sdkVersion: SDK_VERSION,
      environment: cfg.environment,
      source: event.source || (event.type === 'track' ? 'manual' : eventSource(event)),
      appId: cfg.appId,
      release: cfg.release,
      userId: cfg.userId,
      userName: cfg.userName,
      userPhone: cfg.userPhone,
      sessionId,
      deviceId,
      url: context.url || context.path || '',
      path: context.path || '',
      title: context.title || '',
      referrer: context.referrer || '',
      userAgent: context.userAgent || adapter.name || 'unknown',
      context: { ...globalContext, ...(event.context || {}) },
      ts: Date.now(),
      retry: 0,
      breadcrumbs: event.type === 'error' ? breadcrumbs.slice(-20) : undefined,  // 仅错误事件附带面包屑
      ...event
    }
    // 按事件分类采样
    if (Math.random() > sampleRateFor(eventCategory(item), cfg.categorySampleRates, 1)) {
      stats.dropped++
      stats.droppedBySample++
      return
    }
    // 脱敏处理
    item = sanitizeEvent(item, cfg.privacy)
    // beforeSend 钩子：返回 false 拦截，返回对象替换
    if (typeof cfg.beforeSend === 'function') {
      try { item = cfg.beforeSend(item) } catch { item = false }
    }
    // 钩子处理后可能返回了含敏感数据的新对象，因此需要再次脱敏
    if (item && typeof item === 'object') item = sanitizeEvent(item, cfg.privacy)
    if (!item || typeof item !== 'object') { stats.dropped++; return }
    stats.enqueued++
    // 将非 error 事件写入面包屑
    if (['track', 'behavior', 'perf'].includes(item.type)) {
      breadcrumbs.push({ type: item.type, name: item.name || item.metric, ts: item.ts, url: item.url })
      if (breadcrumbs.length > 20) breadcrumbs.shift()
    }
    queue.push(item)
    // 队列溢出保护
    if (queue.length > cfg.maxQueue) queue.splice(0, queue.length - cfg.maxQueue)
    persist()
    // 紧急事件或队列超过批次大小时立即发送
    if (urgent || queue.length >= cfg.batchSize) void flush()
  }

  // ================================================================
  //  网络层
  // ================================================================

  async function flush(force = false) {
    await ready
    if (!cfg.enabled || cfg.consent === 'denied') return
    // 防止并发发送
    if (flushing) {
      flushAllRequested ||= force
      return
    }
    if (!queue.length) return
    flushing = true
    try {
      do {
        // 分批发送，每批不超过 100 条
        const batch = queue.slice(0, Math.min(cfg.batchSize, 100))
        try {
          const response = await adapter.request({
            url: cfg.endpoint,
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(cfg.collectKey ? { 'x-app-key': cfg.collectKey } : {}) },
            data: { events: batch }
          })
          const status = response?.statusCode ?? response?.status ?? 200
          if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`)
          // 成功：从队列中移除已发送的事件
          queue.splice(0, batch.length)
          stats.sent += batch.length
        } catch {
          stats.failed += batch.length
          // 增加重试计数，超过 maxRetries 的事件会被丢弃
          batch.forEach(item => item.retry++)
          queue.splice(0, batch.length, ...batch.filter(item => item.retry <= cfg.maxRetries))
          break
        }
        await persist()
      } while ((force || flushAllRequested) && queue.length)
    } finally {
      flushing = false
      flushAllRequested = false
      await persist()
    }
  }

  /**
   * 包装平台原生 Request，自动注入性能埋点和错误追踪
   * 支持 Promise 和 callback 两种风格
   */
  function wrapRequest(request = adapter.rawRequest, kind = 'request') {
    if (typeof request !== 'function') throw new Error('Web Collection: request function is required')
    return function monitoredRequest(options = {}) {
      // SDK 自身上报不监控，白名单过滤
      if (String(options.url || '').startsWith(cfg.endpoint) || !allowedRequest(options.url, cfg.privacy.requestAllowlist)) return request(options)
      const startedAt = Date.now()
      const spanId = id().replace(/-/g, '').slice(0, 16)
      let recorded = false  // 防止 success/fail 双重回调
      const record = (response, failed) => {
        if (recorded) return
        recorded = true
        const status = response?.statusCode ?? response?.status
        const errorType = failed ? (response?.name === 'AbortError' ? 'aborted' : response?.name === 'TimeoutError' ? 'timeout' : 'network') : (status >= 400 ? 'http' : undefined)
        metric(kind, Date.now() - startedAt, { url: options.url || '', method: options.method || 'GET', status, statusClass: status ? `${Math.floor(status / 100)}xx` : 'network_error', responseSize: Number(response?.headers?.['content-length'] || response?.headers?.get?.('content-length') || 0) || undefined, failed: Boolean(failed || status >= 400), errorType, __traceId: pageTraceId, __spanId: spanId })
        if (failed || status >= 400) error(response || new Error(`HTTP ${status}`), { name: `${kind[0].toUpperCase()}${kind.slice(1)}Error`, source: options.url || '', method: options.method || 'GET', status, errorType })
      }
      const wrapped = {
        ...options,
        success(response) { record(response, false); options.success?.(response) },
        fail(reason) { record(reason, true); options.fail?.(reason) }
      }
      try {
        const result = request(wrapped)
        // 若返回 Promise，则通过 then/catch 自动埋点
        return result?.then
          ? result.then(response => { record(response, false); return response }, reason => { record(reason, true); throw reason })
          : result
      } catch (reason) {
        record(reason, true)
        throw reason
      }
    }
  }

  /** 包装原生 Fetch，自动注入性能埋点和错误追踪 */
  function wrapFetch(fetchImpl = globalThis.fetch) {
    if (typeof fetchImpl !== 'function') throw new Error('Web Collection: fetch function is required')
    return async function monitoredFetch(input, init = {}) {
      const url = typeof input === 'string' ? input : input?.url || ''
      if (url.startsWith(cfg.endpoint) || !allowedRequest(url, cfg.privacy.requestAllowlist)) return fetchImpl(input, init)
      const startedAt = Date.now()
      const spanId = id().replace(/-/g, '').slice(0, 16)
      try {
        const response = await fetchImpl(input, init)
        metric('fetch', Date.now() - startedAt, { url, method: init.method || 'GET', status: response.status, statusClass: `${Math.floor(response.status / 100)}xx`, responseSize: Number(response.headers?.get?.('content-length') || 0) || undefined, errorType: response.ok ? undefined : 'http', __traceId: pageTraceId, __spanId: spanId })
        if (!response.ok) error(new Error(`HTTP ${response.status}`), { name: 'FetchError', source: 'fetch', url, status: response.status, errorType: 'http' })
        return response
      } catch (reason) {
        const errorType = reason?.name === 'AbortError' ? 'aborted' : reason?.name === 'TimeoutError' ? 'timeout' : 'network'
        error(reason, { name: 'FetchError', source: 'fetch', url, method: init.method || 'GET', errorType })
        throw reason
      }
    }
  }

  // ================================================================
  //  小程序 / 跨平台框架 生命周期插桩
  // ================================================================

  /**
   * 插桩 App 生命周期（小程序 onLaunch / onShow / onError / onHide 等）
   * 在原生命周期函数基础上附加行为上报，保留原有调用
   */
  function instrumentApp(config = {}) {
    return {
      ...config,
      onLaunch(...args) { behavior('app_start'); return config.onLaunch?.apply(this, args) },
      onShow(...args) { behavior('app_foreground'); return config.onShow?.apply(this, args) },
      onError(message) { error(message, { source: 'app' }); return config.onError?.call(this, message) },
      onUnhandledRejection(event) { error(event?.reason || event, { source: 'unhandledrejection' }); return config.onUnhandledRejection?.call(this, event) },
      onHide(...args) { behavior('app_background'); void flush(true); return config.onHide?.apply(this, args) }
    }
  }

  /**
   * 插桩 Page 生命周期（小程序 onLoad / onShow / onHide / onUnload）
   * 自动计算页面停留时间并上报 pageView / pageLeave
   */
  function instrumentPage(config = {}) {
    const enter = function (query) {
      pageStarts.set(this, Date.now())
      pageView(pagePath(this), { query })
    }
    const leave = function (reason) {
      const startedAt = pageStarts.get(this)
      if (!startedAt) return
      pageStarts.delete(this)
      pageLeave(pagePath(this), Date.now() - startedAt, { reason })
    }
    return {
      ...config,
      onLoad(query) { enter.call(this, query); return config.onLoad?.call(this, query) },
      onShow(...args) { if (!pageStarts.has(this)) enter.call(this); return config.onShow?.apply(this, args) },
      onHide(...args) { leave.call(this, 'hide'); return config.onHide?.apply(this, args) },
      onUnload(...args) { leave.call(this, 'unload'); return config.onUnload?.apply(this, args) }
    }
  }

  /** 获取页面路径 */
  function pagePath(page) {
    return page?.route || page?.$page?.fullPath || adapter.getContext?.().path || ''
  }

  /** 注册全局错误和状态变化监听（通过适配器的 onError/onUnhandledRejection 等） */
  function registerGlobalErrors() {
    if (errorsRegistered) return
    errorsRegistered = true
    if (adapter.onError) disposers.push(adapter.onError(reason => error(reason, { source: 'global' })))
    if (adapter.onUnhandledRejection) disposers.push(adapter.onUnhandledRejection(event => error(event?.reason || event, { source: 'unhandledrejection' })))
    if (adapter.onNetworkStatusChange) disposers.push(adapter.onNetworkStatusChange(event => behavior('network_change', { network: event?.networkType || event?.type || event?.detail })))
    if (adapter.onNavigationStateChange) disposers.push(adapter.onNavigationStateChange(event => behavior('navigation_change', { route: event?.route || event?.name || event?.state?.routes?.at?.(-1)?.name || '' })))
  }

  // ================================================================
  //  持久化
  // ================================================================

  /** 从存储中恢复上次会话的队列和 deviceId */
  async function hydrate() {
    try {
      const [storedQueue, storedDeviceId] = await Promise.all([adapter.getStorage?.(QUEUE_KEY), adapter.getStorage?.(DEVICE_KEY)])
      if (Array.isArray(storedQueue)) queue.unshift(...storedQueue.slice(-cfg.maxQueue))
      // 回填用户信息
      queue.forEach(item => {
        item.userId ||= cfg.userId
        item.userName ||= cfg.userName
        item.userPhone ||= cfg.userPhone
      })
      if (storedDeviceId) {
        deviceId = storedDeviceId
        queue.forEach(item => { item.deviceId = storedDeviceId })
      }
      else await adapter.setStorage?.(DEVICE_KEY, deviceId)
    } catch {}
  }

  /** 持久化当前队列到存储，使用链式 Promise 保证顺序写入 */
  async function persist() {
    await ready
    const snapshot = queue.slice(-cfg.maxQueue)
    // 链式 Promise：确保上一次写入完成后再写下一次
    persistence = persistence.then(() => adapter.setStorage?.(QUEUE_KEY, snapshot)).catch(() => {})
    await persistence
  }

  function destroy() {
    clearInterval(timer)
    disposers.forEach(dispose => dispose?.())
    // 上报 SDK 健康指标（丢弃/失败统计等）
    if (stats.dropped || stats.failed) push({ type: 'perf', metric: 'sdk_health', value: stats.enqueued, props: { ...stats }, source: 'auto' })
    void flush(true)  // 销毁前最后一次强制上报
    destroyed = true
  }
}

// ================================================================
//  工具函数
// ================================================================

/** 标准化错误对象（兼容 Error 实例、类 Error 对象、原始值） */
function normalizeError(reason) {
  if (reason instanceof Error) return { name: reason.name || 'Error', message: reason.message, stack: reason.stack || '' }
  if (reason && typeof reason === 'object') {
    return { name: reason.name || 'Error', message: reason.message || reason.errMsg || JSON.stringify(reason), stack: reason.stack || '' }
  }
  return { name: 'Error', message: String(reason), stack: '' }
}

/** 生成唯一 ID（优先 crypto.randomUUID，降级为时间戳+随机数） */
function id() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
}

/**
 * 检查请求 URL 是否在允许白名单内
 * 白名单为空时允许所有请求；非空时按字符串前缀匹配或同源检查
 */
function allowedRequest(value, allowlist = []) {
  if (!allowlist.length) return true
  const target = String(value || '')
  return allowlist.some(rule => {
    const normalized = String(rule || '')
    if (!normalized) return false
    if (target.startsWith(normalized)) return true
    try { return new URL(target, globalThis.location?.href || 'http://localhost').origin === new URL(normalized, globalThis.location?.href || 'http://localhost').origin } catch { return false }
  })
}

/** 返回一个所有方法均为空操作的客户端（采样未命中或未适配时使用） */
function noopClient() {
  const noop = () => {}
  return { track: noop, error: noop, metric: noop, behavior: noop, setConsent: noop, setEnabled: noop, setContext: noop, addBreadcrumb: noop, startTransaction: () => ({ setData: noop, finish: noop }), pageView: noop, pageLeave: noop, markPageReady: noop, setUser: noop, flush: noop, destroy: noop, wrapRequest: request => request, wrapFetch: fetch => fetch, instrumentApp: value => value, instrumentPage: value => value }
}
