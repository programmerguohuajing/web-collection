/**
 * @fileoverview Propagation - W3C Trace Context 头部注入与提取
 *
 * 实现 W3C Trace Context 规范中的：
 * - traceparent: 主要传播字段
 * - tracestate: 跨厂商状态透传
 * - baggage: 自定义业务属性透传
 *
 * 规范参考: https://www.w3.org/TR/trace-context/
 */

import { TraceContext } from './context.js'

/**
 * W3C Trace Context 头部名
 */
export const TRACE_PARENT = 'traceparent'
export const TRACE_STATE = 'tracestate'
export const BAGGAGE_PREFIX = 'baggage-'

/**
 * 将 TraceContext 注入到 HTTP 请求头
 * @param {TraceContext} context
 * @param {object} [options]
 * @param {Headers} [options.headers] - 已有 headers 对象
 * @returns {Headers}
 */
export function injectTraceParent(context, { headers = new Headers() } = {}) {
  headers.set(TRACE_PARENT, context.toTraceParent())
  return headers
}

/**
 * 将 tracestate 注入到请求头
 * @param {TraceContext} context
 * @param {Headers} [headers]
 * @returns {Headers}
 */
export function injectTraceState(context, headers = new Headers()) {
  if (context.traceState) {
    headers.set(TRACE_STATE, context.traceState)
  }
  return headers
}

/**
 * 将 baggage 注入到请求头
 * 每个 baggage 条目以 'baggage-' 前缀注入
 * @param {TraceContext} context
 * @param {Headers} [headers]
 * @returns {Headers}
 */
export function injectBaggage(context, headers = new Headers()) {
  for (const [key, value] of context.baggage) {
    headers.set(BAGGAGE_PREFIX + encodeURIComponent(key), encodeURIComponent(value))
  }
  return headers
}

/**
 * 注入所有链路追踪头
 * @param {TraceContext} context
 * @param {object} [options]
 * @param {Headers} [options.headers] - 已有 headers 对象
 * @returns {Headers}
 */
export function injectHeaders(context, options = {}) {
  let { headers = new Headers() } = options
  headers = injectTraceParent(context, { headers })
  headers = injectTraceState(context, headers)
  headers = injectBaggage(context, headers)
  return headers
}

/**
 * 从响应头提取 traceparent
 * @param {Headers} headers
 * @returns {string|null}
 */
export function extractTraceParent(headers) {
  return headers.get?.(TRACE_PARENT) || headers[TRACE_PARENT] || null
}

/**
 * 从响应头提取 tracestate
 * @param {Headers} headers
 * @returns {string|null}
 */
export function extractTraceState(headers) {
  return headers.get?.(TRACE_STATE) || headers[TRACE_STATE] || null
}

/**
 * 从响应头提取 baggage（返回 Map）
 * @param {Headers} headers
 * @returns {Map<string, string>}
 */
export function extractBaggage(headers) {
  const baggage = new Map()
  // 遍历所有 header，匹配 baggage- 前缀
  if (headers.forEach) {
    headers.forEach((value, key) => {
      if (key.toLowerCase().startsWith(BAGGAGE_PREFIX)) {
        const bagKey = decodeURIComponent(key.slice(BAGGAGE_PREFIX.length))
        baggage.set(bagKey, decodeURIComponent(value))
      }
    })
  } else if (typeof headers.entries === 'function') {
    for (const [key, value] of headers.entries()) {
      if (key.toLowerCase().startsWith(BAGGAGE_PREFIX)) {
        const bagKey = decodeURIComponent(key.slice(BAGGAGE_PREFIX.length))
        baggage.set(bagKey, decodeURIComponent(value))
      }
    }
  } else {
    // 兼容简单对象（如 from fetch 响应的 headers）
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase().startsWith(BAGGAGE_PREFIX)) {
        const bagKey = decodeURIComponent(key.slice(BAGGAGE_PREFIX.length))
        baggage.set(bagKey, decodeURIComponent(value))
      }
    }
  }
  return baggage
}

/**
 * 从响应头提取完整的 TraceContext
 * @param {Headers} headers
 * @param {TraceContext} parentContext - 当前 span 的上下文（用于继承 traceId）
 * @returns {TraceContext|null}
 */
export function extractContext(headers, parentContext) {
  const traceparent = extractTraceParent(headers)
  if (!traceparent) return null

  const context = TraceContext.fromTraceParent(traceparent)
  if (!context) return null

  // 继承原 traceId（服务端返回的 traceparent 可能包含新的 traceId）
  const traceState = extractTraceState(headers)
  const baggage = extractBaggage(headers)

  return new TraceContext({
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId || parentContext?.spanId,
    traceFlags: context.traceFlags,
    traceState,
    baggage
  })
}

/**
 * 构造带 traceparent 的 fetch init 对象
 * @param {Request|string} input - fetch input
 * @param {RequestInit} init - fetch init
 * @param {TraceContext} context - trace 上下文
 * @returns {RequestInit} 合并后的 init
 */
export function createTracedRequest(input, init, context) {
  const originalHeaders = new Headers(init.headers || input?.headers)
  injectHeaders(context, { headers: originalHeaders })
  return { ...init, headers: originalHeaders }
}

export default {
  injectHeaders,
  extractContext,
  extractTraceParent,
  extractTraceState,
  extractBaggage,
  createTracedRequest,
  TRACE_PARENT,
  TRACE_STATE,
  BAGGAGE_PREFIX
}