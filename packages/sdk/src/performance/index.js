import { setupFetchMonitor } from './fetch.js'
import { setupSseMonitor } from './sse.js'
import { setupWebSocketMonitor } from './websocket.js'
import { setupXhrMonitor } from './xhr.js'
import { setupTtiMonitor } from './tti.js'
import { setupServerTimingMonitor } from './server-timing.js'
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
 * @param {object} [opts.tracer] - Tracer 实例（用于链路追踪）
 */
export function setupPerformanceMonitor({ metric, error, endpoint, originalFetch, requests, tracing, traceOrigins, pageTraceId, requestAllowlist = [], tracer }) {
  // 创建 Page Root Span（作为页面加载的根 span）
  const rootSpan = tracer?.createRootSpan?.('page', { 'page.url': location.href })
  const rootContext = rootSpan?.getContext()

  // 页面加载完成后采集 Navigation Timing 指标
  onReady(() => {
    const nav = performance.getEntriesByType('navigation')[0]
    if (nav) {
      const values = navigationMetrics(nav)
      metric('navigation', nav.duration, {
        ...values,
        // 链路追踪字段
        __traceId: rootContext?.traceId ?? pageTraceId,
        __spanId: rootContext?.spanId,
        __parentSpanId: rootContext?.parentSpanId
      })
      for (const [name, value] of Object.entries(values)) metric(name, value)
    }
  })

  // Web Vitals 核心指标
  observe('paint', e => metric(e.name === 'first-contentful-paint' ? 'fcp' : 'fp', e.startTime))
  let lcpEntry
  observe('largest-contentful-paint', e => { lcpEntry = e })
  observe('first-input', e => metric('fid', e.processingStart - e.startTime, { name: e.name }))
  let inp = 0
  let inpEntry
  observe('event', e => { if (e.interactionId && e.duration > inp) { inp = e.duration; inpEntry = e } })
  let blockingTime = 0
  observe('longtask', e => { blockingTime += Math.max(0, e.duration - 50); metric('longtask', e.duration, { name: e.name, attribution: e.attribution?.slice?.(0, 3).map(item => ({ name: item.name, containerType: item.containerType, containerName: item.containerName })) }); metric('tbt', blockingTime) })
  const cls = observeCls()
  // 资源加载监控，过滤掉自身采集接口的请求
  observe('resource', e => {
    if (String(e.name).includes(endpoint)) return
    metric('cache_hit_rate', e.transferSize === 0 && e.decodedBodySize > 0 ? 100 : 0)
    metric('resource_failure_rate', 0)
    metric('resource', e.duration, { name: e.name, initiatorType: e.initiatorType, transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize, ttfb: e.responseStart })
  })
  addEventListener('error', event => {
    if (!event.target?.src && !event.target?.href) return
    metric('resource_failure_rate', 100)
  }, true)

  if (requests) {
    const serverTiming = setupServerTimingMonitor({ metric })
    setupFetchMonitor({ originalFetch, endpoint, metric, error, tracing, traceOrigins, pageTraceId, requestAllowlist, serverTiming, tracer })
    setupXhrMonitor({ endpoint, metric, error, tracing, traceOrigins, pageTraceId, requestAllowlist, serverTiming, tracer })
    setupWebSocketMonitor({ metric, error })
    setupSseMonitor({ metric, error })
  }

  let finalized = false
  const finalizeTti = setupTtiMonitor({ metric })
  return () => {
    if (finalized) return
    finalized = true
    // 结束页面根 Span：必须走 tracer.endSpan（而非 span.end）以通知 SpanProcessor 导出，
    // 否则分布式调用树会缺少根节点。
    if (rootSpan && tracer?.endSpan) tracer.endSpan(rootSpan)
    if (lcpEntry) {
      const props = { element: lcpEntry.element?.tagName, elementPath: elementPath(lcpEntry.element) }
      metric('lcp', lcpEntry.startTime, props)
      metric('first_screen', lcpEntry.startTime, props)
    }
    if (inp) metric('inp', inp, { name: inpEntry?.name, elementPath: elementPath(inpEntry?.target) })
    metric('cls', Number(cls.value().toFixed(4)), { sources: cls.sources() })
    finalizeTti()
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
 * 使用会话窗口策略：1 秒内连续偏移视为同一会话窗口并累加，单个窗口上限 5 秒。
 * 取所有会话窗口中的最大值作为最终 CLS。
 * 忽略有用户输入（hadRecentInput）触发的偏移，因为那是用户主动操作导致的。
 *
 * @returns {{ value: () => number, sources: () => string[] }}
 *   value - 返回当前 CLS 值的函数
 *   sources - 返回布局偏移源元素路径列表的函数
 */
function observeCls() {
  let cls = 0           // 全局最大 CLS 值
  let sessionValue = 0  // 当前会话窗口内的累计偏移值
  let first = 0         // 当前会话窗口的第一个偏移时间
  let last = 0          // 当前会话窗口的最后一个偏移时间
  const sources = []    // 引发偏移的源元素路径
  observe('layout-shift', e => {
    if (e.hadRecentInput) return  // 忽略用户交互触发的偏移
    // 会话窗口策略：距上次偏移 <1s 且窗口 <5s → 同一窗口累加；否则开启新窗口
    if (sessionValue && e.startTime - last < 1000 && e.startTime - first < 5000) {
      sessionValue += e.value
    } else {
      sessionValue = e.value
      first = e.startTime
    }
    last = e.startTime
    if (sessionValue > cls) cls = sessionValue
    // 收集偏移源元素（最多 3 个/次），去重加入来源列表
    e.sources?.slice(0, 3).forEach(source => {
      const path = elementPath(source.node)
      if (path && !sources.includes(path)) sources.push(path)
    })
  })
  return { value: () => cls, sources: () => sources.slice(0, 10) }
}

/**
 * 构建元素的可读路径（tag#id.class）
 * 用于 CLS 偏移源定位和 LCP 元素标识
 * @param {Element} element - DOM 元素
 * @returns {string} 截断到 240 字符的元素路径
 */
function elementPath(element) {
  if (!element) return ''
  const tag = String(element.tagName || '').toLowerCase()
  const id = element.id ? `#${element.id}` : ''
  // 仅取前 2 个 class 名，防止超长
  const classes = typeof element.className === 'string' ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(name => `.${name}`).join('') : ''
  return `${tag}${id}${classes}`.slice(0, 240)
}
