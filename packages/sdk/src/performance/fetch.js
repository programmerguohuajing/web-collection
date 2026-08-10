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
 * @param {object} [opts.tracer] - Tracer 实例（可选，用于链路追踪）
 */
export function setupFetchMonitor({ originalFetch, endpoint, metric, error, tracing, traceOrigins, pageTraceId, requestAllowlist = [], serverTiming, tracer }) {
  if (!originalFetch) return

  window.fetch = async (input, init = {}) => {
    const url = String(input?.url || input)
    const start = performance.now()
    const method = init.method || input?.method || 'GET'
    const traced = tracing && allowedRequest(url, requestAllowlist) && canTrace(url, traceOrigins)

    // 使用 Tracer 创建层级 span（如果可用）
    let activeSpan = null
    let spanContext = null
    if (tracer && traced) {
      activeSpan = tracer.startSpan('fetch ' + url, {
        kind: 'CLIENT',
        attributes: {
          'http.url': url,
          'http.method': method
        }
      })
      spanContext = activeSpan.getContext()
    }

    // 构建请求头
    const requestInit = init
    if (spanContext) {
      const headers = new Headers(init.headers || input?.headers)
      headers.set('traceparent', `00-${spanContext.traceId}-${spanContext.spanId}-${spanContext.traceFlags}`)
      // 注入 baggage（如果有）
      if (activeSpan?.context?.baggage?.size > 0) {
        for (const [key, value] of activeSpan.context.baggage) {
          headers.set('baggage-' + encodeURIComponent(key), encodeURIComponent(value))
        }
      }
      requestInit = { ...init, headers }
    }

    try {
      const res = await originalFetch(input, requestInit)
      if (!url.includes(endpoint) && allowedRequest(url, requestAllowlist)) {
        const timing = performance.getEntriesByName(new URL(url, location.href).href).at(-1)
        const fetchProps = {
          url,
          method,
          status: res.status,
          statusClass: `${Math.floor(res.status / 100)}xx`,
          ok: res.ok,
          responseSize: Number(res.headers?.get?.('content-length') || 0) || undefined,
          dns: timing ? timing.domainLookupEnd - timing.domainLookupStart : undefined,
          tcp: timing ? timing.connectEnd - timing.connectStart : undefined,
          ttfb: timing?.responseStart,
          // 链路追踪字段
          __traceId: spanContext?.traceId ?? (traced ? pageTraceId : undefined),
          __spanId: spanContext?.spanId,
          __parentSpanId: spanContext?.parentSpanId
        }
        const serverTimingHeader = res.headers?.get?.('server-timing')
        if (serverTiming && serverTimingHeader) fetchProps.serverTiming = serverTiming.parse(serverTimingHeader)
        metric('fetch', performance.now() - start, fetchProps)
        if (!res.ok) error(new Error(`HTTP ${res.status}`), { name: 'FetchError', source: url, status: res.status, errorType: 'http' })

        // 从响应头提取后端返回的 trace 上下文
        if (activeSpan) {
          const responseTraceparent = res.headers?.get?.('traceresponse') || res.headers?.get?.('traceparent')
          if (responseTraceparent) {
            const parts = responseTraceparent.split('-')
            if (parts.length >= 4) {
              // 更新 span，记录服务端返回的 spanId
              activeSpan.setAttribute('http.response_trace_id', parts[1])
            }
          }
        }
      }
      return res
    } catch (err) {
      if (!url.includes(endpoint) && allowedRequest(url, requestAllowlist)) {
        const errorType = err?.name === 'AbortError' ? 'aborted' : err?.name === 'TimeoutError' ? 'timeout' : 'network'
        error(err, { name: 'FetchError', source: url, errorType, aborted: errorType === 'aborted' })
        // 记录异常到 span
        if (activeSpan) {
          activeSpan.recordException(err)
        }
      }
      throw err
    } finally {
      // 结束 span
      if (activeSpan) {
        activeSpan.end()
        tracer?.endSpan(activeSpan)
      }
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
 * 判断请求 URL 是否允许注入链路追踪 header
 * 同源请求始终允许，跨域请求仅当 origin 在 traceOrigins 白名单内才允许
 * @param {string} value          - 请求 URL
 * @param {string[]} [origins=[]] - 允许透传 traceparent 的跨域 origin 列表
 * @returns {boolean}
 */
function canTrace(value, origins = []) {
  try { const url = new URL(value, location.href); return url.origin === location.origin || origins.includes(url.origin) } catch { return false }
}
