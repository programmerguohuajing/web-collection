/**
 * @file Web Collection SDK 入口模块
 * 前端监控 SDK，提供错误监控、性能采集、用户行为追踪、元素曝光和会话回放能力。
 * 支持 Vue 插件安装（install）和独立调用（createEys）两种接入方式。
 */

import { setupBehaviorMonitor } from './behavior/index.js'
import { setupConsoleMonitor } from './behavior/console.js'
import { setupRouteMonitor } from './behavior/route.js'
import { setupErrorMonitor } from './error/index.js'
import { setupExposureMonitor } from './exposure/index.js'
import { setupPerformanceMonitor } from './performance/index.js'
import { addReplayEvent, setupReplayMonitor, takeReplaySnapshot } from './replay/index.js'
import { imageReport } from './core/report.js'
import { getId } from './utils/id.js'

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
    ...options
  }
  // 采样未命中时直接返回一个空实现客户端。
  if (Math.random() > cfg.sampleRate) return noopClient()

  // sessionId 标识当前页面访问会话。
  const sessionId = getId('eys_sid')
  const deviceId = getId('eys_did', true)
  // queue 持久化待上报事件；recent/breadcrumbs 用于去重和错误上下文；replayEvents 用于临时缓存回放片段。
  const queue = loadQueue(cfg.maxQueue)
  const recent = []
  const breadcrumbs = []
  const originalFetch = window.fetch?.bind(window)
  const replayEvents = []
  const pageTraceId = randomHex(16)
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
  const stopConsole = cfg.console ? setupConsoleMonitor({ remember, emit: log, levels: cfg.consoleLevels }) : () => {}

  const timer = setInterval(flushAll, cfg.flushInterval)
  addEventListener('pagehide', () => {
    currentSegmentEndReason = 'page_unload'
    stopCurrentReplay()
    flushAll(true)
  })
  document.addEventListener('visibilitychange', () => document.hidden && flushAll(true))

  setupErrorMonitor({ error, clipSize: 500 })
  setupPerformanceMonitor({ metric, error, endpoint: cfg.endpoint, originalFetch, requests: cfg.requests, tracing: cfg.tracing, traceOrigins: cfg.traceOrigins, pageTraceId })
  observeWhiteScreen()
  requestAnimationFrame(() => requestAnimationFrame(() => metric('js_boot', performance.now() - sdkStartedAt)))
  if (cfg.behavior) setupBehaviorMonitor({ push, onRoute: () => { const start = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => metric('route_render', performance.now() - start))); if (cfg.replaySegmentByRoute) endReplaySegment('route') } })
  else if (cfg.replay && cfg.replaySegmentByRoute) setupRouteMonitor({ push: () => {}, onRoute: () => endReplaySegment('route') })
  if (cfg.exposure) setupExposureMonitor({ push })
  if (cfg.replay) startReplay()

  return { track, error, metric, log, setUser, markPageReady: () => metric('data_ready', performance.now()), flush, destroy, startReplay, stopReplay: stopReplayRecording, flushReplay, addReplayEvent, takeReplaySnapshot, endReplaySegment }

  function observeWhiteScreen() {
    const started = performance.now()
    const timer = setInterval(() => {
      const element = document.querySelector(cfg.whiteScreenSelector)
      if (element?.getBoundingClientRect().width && element.getBoundingClientRect().height) {
        clearInterval(timer)
        metric('white_screen', performance.now())
        metric('blank_screen_rate', 0)
      } else if (performance.now() - started >= cfg.whiteScreenTimeout) {
        clearInterval(timer)
        metric('blank_screen_rate', 100)
      }
    }, 100)
  }

  /** 自定义事件追踪 */
  function track(name, props = {}) {
    push({ type: 'track', name, props })
  }

  /** 错误上报，触发回放分段结束（原因=error）并立即上报 */
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

  /** 性能指标上报 */
  function metric(name, value, props = {}) {
    const { __traceId: traceId, __spanId: spanId, ...details } = props
    push({ type: 'perf', metric: name, value: Number(value), props: details, traceId, spanId })
    if (name === 'fetch' || name === 'xhr') {
      push({ type: 'perf', metric: 'slow_api_rate', value: Number(value) > 1000 ? 100 : 0, props: { threshold: 1000 } })
    }
  }

  /** 结构化日志；服务端会再次执行脱敏。 */
  function log(level, message, props = {}) {
    push({ type: 'log', name: String(level || 'info'), message: redact(message), props: redactObject(props), traceId: pageTraceId })
  }

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
    const item = withBase(event)
    remember(item)
    if (isDuplicate(item)) return
    queue.push(item)
    if (queue.length > cfg.maxQueue) queue.splice(0, queue.length - cfg.maxQueue)
    saveQueue()
    if (urgent || queue.length >= cfg.batchSize) flush(urgent)
  }

  /** 为事件附加基础信息（appId、sessionId、URL、UA、时间戳等） */
  function withBase(event) {
    return {
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
   * force=true 时优先使用 sendBeacon（适合页面卸载场景），
   * 否则使用 fetch；两者都不可用时降级为 GIF 图片上报。
   * 上报失败后增加 retry 计数，超过最大重试次数的事件会被丢弃。
   * @param {boolean} [force=false] - 是否强制立即上报（页面卸载等场景）
   */
  async function flush(force = false) {
    if (flushing || !queue.length) return
    flushing = true
    const batch = queue.slice(0, cfg.batchSize)
    const body = JSON.stringify({ events: batch })
    try {
      if (force && navigator.sendBeacon && body.length < 64000) {
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
    } catch {
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
    stopReplay = setupReplayMonitor({ emit: queueReplay, options: cfg.replayOptions })
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
    stopConsole()
    stopReplayRecording()
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

/** 从 localStorage 加载之前持久化的事件队列 */
function loadQueue(maxQueue) {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]').slice(-maxQueue) } catch { return [] }
}

/** 采样未命中时返回的空实现客户端，所有方法均为 no-op */
function noopClient() {
  return { track() {}, error() {}, metric() {}, log() {}, setUser() {}, markPageReady() {}, flush() {}, destroy() {}, startReplay() {}, stopReplay() {}, flushReplay() {}, addReplayEvent() {}, takeReplaySnapshot() {}, endReplaySegment() {} }
}

function randomHex(bytes) {
  const data = new Uint8Array(bytes)
  crypto.getRandomValues(data)
  return [...data].map(value => value.toString(16).padStart(2, '0')).join('')
}

function redact(value) {
  return String(value).replace(/(authorization|password|token|secret|cookie)(["'\s:=]+)[^\s,;}]+/gi, '$1$2[REDACTED]').replace(/\b1\d{2}\d{4}(\d{4})\b/g, '***$1').slice(0, 500)
}

function redactObject(value = {}) {
  return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [key, redact(serialize(item))]))
}

function serialize(value) {
  if (typeof value !== 'object' || value === null) return value
  try { return JSON.stringify(value) } catch { return '[Unserializable]' }
}

export default { createEys, install }
