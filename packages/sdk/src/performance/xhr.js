/**
 * 初始化 XMLHttpRequest 请求监控。
 * 通过劫持 `open` 和 `send` 方法，在请求发送时记录起始时间，
 * 在 `loadend` 事件中计算总耗时并上报。
 * 过滤掉自身采集接口的请求，避免循环上报。
 *
 * @param {object} opts
 * @param {string} opts.endpoint - 采集接口地址，用于过滤
 * @param {Function} opts.metric - 性能指标上报方法
 */
export function setupXhrMonitor({ endpoint, metric, error, tracing, traceOrigins, pageTraceId, requestAllowlist = [] }) {
  const xhrOpen = XMLHttpRequest.prototype.open
  const xhrSend = XMLHttpRequest.prototype.send

  // 劫持 open：记录请求方法和 URL
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__eys = { method, url: String(url), start: 0 }
    return xhrOpen.call(this, method, url, ...rest)
  }

  // 劫持 send：记录起始时间，在 loadend 时计算耗时
  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__eys) {
      const spanId = randomHex(8)
      const traced = tracing && allowedRequest(this.__eys.url, requestAllowlist) && canTrace(this.__eys.url, traceOrigins)
      if (traced) this.setRequestHeader('traceparent', `00-${pageTraceId}-${spanId}-01`)
      this.__eys.start = performance.now()
      const markFailure = type => { this.__eys.failureType ||= type }
      this.addEventListener('timeout', () => markFailure('timeout'), { once: true })
      this.addEventListener('abort', () => markFailure('aborted'), { once: true })
      this.addEventListener('error', () => markFailure('network'), { once: true })
      this.addEventListener('loadend', () => {
        if (!this.__eys.url.includes(endpoint) && allowedRequest(this.__eys.url, requestAllowlist)) {
          const status = this.status || 0
          const errorType = this.__eys.failureType || (status === 0 ? 'network' : undefined)
          metric('xhr', performance.now() - this.__eys.start, { url: this.__eys.url, method: this.__eys.method, status, statusClass: status ? `${Math.floor(status / 100)}xx` : 'network_error', errorType, responseSize: Number(this.getResponseHeader?.('content-length') || 0) || undefined, __traceId: traced ? pageTraceId : undefined, __spanId: traced ? spanId : undefined })
          if (errorType) error?.(new Error(`XHR ${errorType}`), { name: 'XhrError', source: this.__eys.url, status, errorType })
        }
      }, { once: true })
    }
    return xhrSend.apply(this, args)
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

function canTrace(value, origins = []) { try { const url = new URL(value, location.href); return url.origin === location.origin || origins.includes(url.origin) } catch { return false } }
function randomHex(bytes) { const data = new Uint8Array(bytes); crypto.getRandomValues(data); return [...data].map(value => value.toString(16).padStart(2, '0')).join('') }
