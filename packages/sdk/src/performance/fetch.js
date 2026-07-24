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
export function setupFetchMonitor({ originalFetch, endpoint, metric, error, tracing, traceOrigins, pageTraceId, requestAllowlist = [] }) {
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
        metric('fetch', performance.now() - start, { url, method: init.method || input?.method || 'GET', status: res.status, statusClass: `${Math.floor(res.status / 100)}xx`, ok: res.ok, responseSize: Number(res.headers?.get?.('content-length') || 0) || undefined, dns: timing ? timing.domainLookupEnd - timing.domainLookupStart : undefined, tcp: timing ? timing.connectEnd - timing.connectStart : undefined, ttfb: timing?.responseStart, __traceId: traced ? pageTraceId : undefined, __spanId: traced ? spanId : undefined })
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

function withTraceHeader(input, init, traceId, spanId) {
  const headers = new Headers(init.headers || input?.headers)
  headers.set('traceparent', `00-${traceId}-${spanId}-01`)
  return headers
}

function canTrace(value, origins = []) {
  try { const url = new URL(value, location.href); return url.origin === location.origin || origins.includes(url.origin) } catch { return false }
}

function randomHex(bytes) {
  const data = new Uint8Array(bytes)
  crypto.getRandomValues(data)
  return [...data].map(value => value.toString(16).padStart(2, '0')).join('')
}
