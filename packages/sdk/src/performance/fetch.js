/**
 * 初始化 Fetch 请求监控。
 * 通过劫持 `window.fetch` 方法，在不影响原有逻辑的前提下记录请求耗时和状态。
 * 过滤掉自身采集接口的请求，避免循环上报。
 *
 * @param {object} opts
 * @param {Function} opts.originalFetch - 原始 fetch 引用
 * @param {string} opts.endpoint - 采集接口地址，用于过滤
 * @param {Function} opts.metric - 性能指标上报方法
 * @param {Function} opts.error - 错误上报方法
 */
export function setupFetchMonitor({ originalFetch, endpoint, metric, error, tracing, traceOrigins, pageTraceId, requestAllowlist = [], serverTiming }) {
  if (!originalFetch) return

  window.fetch = async (input, init = {}) => {
    const url = String(input?.url || input)
    const start = performance.now()
    const spanId = randomHex(8)
    const traced = tracing && allowedRequest(url, requestAllowlist) && canTrace(url, traceOrigins)
    const requestInit = traced ? { ...init, headers: withTraceHeader(input, init, pageTraceId, spanId) } : init
    try {
      const res = await originalFetch(input, requestInit)
      if (!url.includes(endpoint) && allowedRequest(url, requestAllowlist)) {
        const timing = performance.getEntriesByName(new URL(url, location.href).href).at(-1)
        const fetchProps = { url, method: init.method || input?.method || 'GET', status: res.status, statusClass: `${Math.floor(res.status / 100)}xx`, ok: res.ok, responseSize: Number(res.headers?.get?.('content-length') || 0) || undefined, dns: timing ? timing.domainLookupEnd - timing.domainLookupStart : undefined, tcp: timing ? timing.connectEnd - timing.connectStart : undefined, ttfb: timing?.responseStart, __traceId: traced ? pageTraceId : undefined, __spanId: traced ? spanId : undefined }
        const serverTimingHeader = res.headers?.get?.('server-timing')
        if (serverTiming && serverTimingHeader) fetchProps.serverTiming = serverTiming.parse(serverTimingHeader)
        metric('fetch', performance.now() - start, fetchProps)
        if (!res.ok) error(new Error(`HTTP ${res.status}`), { name: 'FetchError', source: url, status: res.status, errorType: 'http' })
      }
      return res
    } catch (err) {
      if (!url.includes(endpoint) && allowedRequest(url, requestAllowlist)) {
        const errorType = err?.name === 'AbortError' ? 'aborted' : err?.name === 'TimeoutError' ? 'timeout' : 'network'
        error(err, { name: 'FetchError', source: url, errorType, aborted: errorType === 'aborted' })
      }
      throw err
    }
  }
}

/**
 * 检查请求 URL 是否在白名单内
 * 规则：白名单为空 → 全部允许；非空 → 前缀匹配或同源匹配
 * @param {string} value     - 请求 URL
 * @param {string[]} allowlist - 白名单列表
 * @returns {boolean} 是否允许监控此请求
 */
function allowedRequest(value, allowlist) {
  if (!allowlist?.length) return true
  const target = String(value || '')
  return allowlist.some(rule => {
    const normalized = String(rule || '')
    if (!normalized) return false
    if (target.startsWith(normalized)) return true
    try { return new URL(target, location.href).origin === new URL(normalized, location.href).origin } catch { return false }
  })
}

/**
 * 构造带 traceparent 头部的新 headers 对象（W3C Trace Context 标准）
 * traceparent 格式：00-{traceId}-{spanId}-01
 * @param {Request|string} input  - fetch 的 input 参数
 * @param {RequestInit} init      - fetch 的 init 参数
 * @param {string} traceId        - 32 位十六进制 traceId
 * @param {string} spanId         - 16 位十六进制 spanId
 * @returns {Headers} 合并了 traceparent 的新 headers
 */
function withTraceHeader(input, init, traceId, spanId) {
  const headers = new Headers(init.headers || input?.headers)
  headers.set('traceparent', `00-${traceId}-${spanId}-01`)
  return headers
}

/**
 * 判断请求 URL 是否允许注入链路追踪 header
 * 同源请求始终允许，跨域请求仅当 origin 在 traceOrigins 白名单内才允许
 * @param {string} value          - 请求 URL
 * @param {string[]} [origins=[]] - 允许透传 traceparent 的跨域 origin 列表
 * @returns {boolean}
 */
function canTrace(value, origins = []) {
  try { const url = new URL(value, location.href); return url.origin === location.origin || origins.includes(url.origin) } catch { return false }
}

/**
 * 生成指定字节数的安全随机十六进制字符串（用于 traceId / spanId）
 * @param {number} bytes - 字节数（如 8 → 16 位十六进制，16 → 32 位）
 * @returns {string} 十六进制字符串
 */
function randomHex(bytes) {
  const data = new Uint8Array(bytes)
  crypto.getRandomValues(data)
  return [...data].map(value => value.toString(16).padStart(2, '0')).join('')
}
