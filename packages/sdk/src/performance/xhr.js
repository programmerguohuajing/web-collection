/**
 * 初始化 XMLHttpRequest 请求监控。
 * 通过劫持 `open` 和 `send` 方法，在请求发送时记录起始时间，
 * 在 `loadend` 事件中计算总耗时并上报。
 * 过滤掉自身采集接口的请求，避免循环上报。
 *
 * @param {object} opts
 * @param {string} opts.endpoint - 采集接口地址，用于过滤
 * @param {Function} opts.metric - 性能指标上报方法
 * @param {object} [opts.tracer] - Tracer 实例（可选，用于链路追踪）
 */
export function setupXhrMonitor({ endpoint, metric, error, tracing, traceOrigins, pageTraceId, requestAllowlist = [], serverTiming, tracer }) {
  const xhrOpen = XMLHttpRequest.prototype.open
  const xhrSend = XMLHttpRequest.prototype.send

  // 劫持 open：记录请求方法和 URL
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__eys = { method, url: String(url), start: 0, span: null, spanContext: null }
    return xhrOpen.call(this, method, url, ...rest)
  }

  // 劫持 send：记录起始时间，在 loadend 时计算耗时
  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__eys) {
      const { method, url } = this.__eys
      const traced = tracing && allowedRequest(url, requestAllowlist) && canTrace(url, traceOrigins)

      // 使用 Tracer 创建层级 span（如果可用）
      let activeSpan = null
      if (tracer && traced) {
        activeSpan = tracer.startSpan('xhr ' + url, {
          kind: 'CLIENT',
          attributes: {
            'http.url': url,
            'http.method': method
          }
        })
        this.__eys.span = activeSpan
        this.__eys.spanContext = activeSpan.getContext()
      }

      // 注入 traceparent 头
      if (this.__eys.spanContext) {
        const { traceId, spanId, traceFlags } = this.__eys.spanContext
        this.setRequestHeader('traceparent', `00-${traceId}-${spanId}-${traceFlags}`)
        // 注入 baggage
        if (activeSpan?.context?.baggage?.size > 0) {
          for (const [key, value] of activeSpan.context.baggage) {
            this.setRequestHeader('baggage-' + encodeURIComponent(key), encodeURIComponent(value))
          }
        }
      } else if (traced) {
        // 降级：使用 pageTraceId 生成简单 traceparent
        const spanId = randomHex(8)
        this.setRequestHeader('traceparent', `00-${pageTraceId}-${spanId}-01`)
        this.__eys.spanContext = { traceId: pageTraceId, spanId, parentSpanId: '', traceFlags: '01' }
      }

      this.__eys.start = performance.now()
      const markFailure = type => { this.__eys.failureType ||= type }
      this.addEventListener('timeout', () => markFailure('timeout'), { once: true })
      this.addEventListener('abort', () => markFailure('aborted'), { once: true })
      this.addEventListener('error', () => markFailure('network'), { once: true })
      this.addEventListener('loadend', () => {
        if (!this.__eys.url.includes(endpoint) && allowedRequest(this.__eys.url, requestAllowlist)) {
          const status = this.status || 0
          const errorType = this.__eys.failureType || (status === 0 ? 'network' : status >= 400 ? 'http' : undefined)
          const { spanContext, span } = this.__eys
          metric('xhr', performance.now() - this.__eys.start, {
            url: this.__eys.url,
            method: this.__eys.method,
            status,
            statusClass: status ? `${Math.floor(status / 100)}xx` : 'network_error',
            errorType,
            responseSize: Number(this.getResponseHeader?.('content-length') || 0) || undefined,
            // 链路追踪字段
            __traceId: spanContext?.traceId,
            __spanId: spanContext?.spanId,
            __parentSpanId: spanContext?.parentSpanId
          })
          if (errorType) {
            error?.(new Error(errorType === 'http' ? `HTTP ${status}` : `XHR ${errorType}`), { name: 'XhrError', source: this.__eys.url, status, errorType })
          }
          // 记录异常到 span
          if (errorType && span) {
            span.recordException(new Error(errorType === 'http' ? `HTTP ${status}` : errorType))
          }
        }
        // 结束 span
        if (this.__eys.span) {
          this.__eys.span.end()
          tracer?.endSpan(this.__eys.span)
        }
      }, { once: true })
    }
    return xhrSend.apply(this, args)
  }
}

/** 检查请求 URL 是否在白名单内（与 fetch.js 共用逻辑：空名单全允许，否则前缀/同源匹配） */
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

/** 判断请求 URL 是否允许注入链路追踪 header（同源或白名单内 origin） */
function canTrace(value, origins = []) { try { const url = new URL(value, location.href); return url.origin === location.origin || origins.includes(url.origin) } catch { return false } }

/** 生成指定字节数的安全随机十六进制字符串（用于 spanId） */
function randomHex(bytes) { const data = new Uint8Array(bytes); crypto.getRandomValues(data); return [...data].map(value => value.toString(16).padStart(2, '0')).join('') }
