import { setupFetchMonitor } from './fetch.js'
import { setupSseMonitor } from './sse.js'
import { setupWebSocketMonitor } from './websocket.js'
import { setupXhrMonitor } from './xhr.js'
import { observe, onReady } from '../utils/performance.js'

/**
 * 初始化性能监控模块。
 *
 * 采集以下 Web Vitals 和性能指标：
 * - TTFB：首字节时间（来自 Navigation Timing）
 * - FCP / FP：首次内容绘制 / 首次绘制（Paint Timing）
 * - LCP：最大内容绘制
 * - FID：首次输入延迟
 * - INP：交互延迟
 * - CLS：累积布局偏移（会话级窗口聚合）
 * - LongTask：长任务
 * - Resource：资源加载耗时
 * - Fetch / XHR：请求耗时（可选）
 *
 * @param {object} opts
 * @param {Function} opts.metric - SDK 主实例的 metric 方法，用于推入性能事件
 * @param {Function} opts.error - SDK 主实例的 error 方法，用于上报请求错误
 * @param {string} opts.endpoint - 采集接口地址，用于过滤自身请求避免循环上报
 * @param {Function} opts.originalFetch - 原始 fetch 引用，用于请求监控
 * @param {boolean} opts.requests - 是否开启请求（Fetch + XHR）性能监控
 */
export function setupPerformanceMonitor({ metric, error, endpoint, originalFetch, requests, tracing, traceOrigins, pageTraceId }) {
  // 页面加载完成后采集 Navigation Timing 指标
  onReady(() => {
    const nav = performance.getEntriesByType('navigation')[0]
    if (nav) {
      const values = navigationMetrics(nav)
      metric('navigation', nav.duration, { ...values, __traceId: pageTraceId, __spanId: pageTraceId.slice(0, 16) })
      for (const [name, value] of Object.entries(values)) metric(name, value)
    }
  })

  // Web Vitals 核心指标
  observe('paint', e => metric(e.name === 'first-contentful-paint' ? 'fcp' : 'fp', e.startTime))
  observe('largest-contentful-paint', e => {
    const props = { element: e.element?.tagName }
    metric('lcp', e.startTime, props)
    metric('first_screen', e.startTime, props)
  })
  observe('first-input', e => metric('fid', e.processingStart - e.startTime, { name: e.name }))
  observe('event', e => metric('inp', e.duration, { name: e.name }))
  let blockingTime = 0
  observe('longtask', e => { blockingTime += Math.max(0, e.duration - 50); metric('longtask', e.duration, { name: e.name }); metric('tbt', blockingTime) })
  observeCls(metric)
  // 资源加载监控，过滤掉自身采集接口的请求
  let resources = 0
  let cacheHits = 0
  let resourceFailures = 0
  observe('resource', e => {
    if (String(e.name).includes(endpoint)) return
    resources++
    if (e.transferSize === 0 && e.decodedBodySize > 0) cacheHits++
    metric('cache_hit_rate', cacheHits / resources * 100)
    metric('resource_failure_rate', resourceFailures / (resources + resourceFailures) * 100)
    metric('resource', e.duration, { name: e.name, initiatorType: e.initiatorType, transferSize: e.transferSize, ttfb: e.responseStart })
  })
  addEventListener('error', event => {
    if (!event.target?.src && !event.target?.href) return
    resourceFailures++
    metric('resource_failure_rate', resourceFailures / (resources + resourceFailures) * 100)
  }, true)

  if (requests) {
    setupFetchMonitor({ originalFetch, endpoint, metric, error, tracing, traceOrigins, pageTraceId })
    setupXhrMonitor({ endpoint, metric, tracing, traceOrigins, pageTraceId })
    setupWebSocketMonitor({ metric, error })
    setupSseMonitor({ metric, error })
  }
}

export function navigationMetrics(nav) {
  return {
    dns: nav.domainLookupEnd - nav.domainLookupStart,
    tcp: nav.connectEnd - nav.connectStart,
    tls: nav.secureConnectionStart > 0 ? nav.connectEnd - nav.secureConnectionStart : 0,
    request: nav.responseStart - nav.requestStart,
    download: nav.responseEnd - nav.responseStart,
    ttfb: nav.responseStart,
    dom_ready: nav.domContentLoadedEventEnd,
    page_load: nav.loadEventEnd,
    redirect: nav.redirectEnd > 0 ? nav.redirectEnd - nav.redirectStart : 0,
    redirect_count: nav.redirectCount || 0
  }
}

/**
 * 观察并计算 CLS（累积布局偏移）。
 * 使用会话窗口策略：1 秒内连续偏移累加，5 秒窗口上限，
 * 取所有会话窗口中的最大值作为最终 CLS。
 * 忽略有用户输入（hadRecentInput）触发的偏移。
 *
 * @param {Function} metric - SDK 主实例的 metric 方法
 */
function observeCls(metric) {
  let cls = 0
  let sessionValue = 0
  let first = 0
  let last = 0
  observe('layout-shift', e => {
    if (e.hadRecentInput) return
    if (sessionValue && e.startTime - last < 1000 && e.startTime - first < 5000) {
      sessionValue += e.value
    } else {
      sessionValue = e.value
      first = e.startTime
    }
    last = e.startTime
    if (sessionValue > cls) {
      cls = sessionValue
      metric('cls', Number(cls.toFixed(4)))
    }
  })
}
