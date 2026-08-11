/**
 * @fileoverview Propagation - W3C Trace Context 头部注入与提取
 *
 * 实现 W3C Trace Context 规范中的：
 * - traceparent: 主要传播字段（已标准）
 * - tracestate: 跨厂商状态透传（已标准，本文件增加规范化）
 * - baggage: 业务属性透传 —— 使用 W3C **标准单一 `baggage` Header**（不再是自定义的 `baggage-*` 多个头）
 *
 * 规范参考:
 * - Trace Context: https://www.w3.org/TR/trace-context/
 * - Baggage: https://www.w3.org/TR/baggage/
 *
 * 互操作性：标准 baggage / tracestate / traceparent 可被 OpenTelemetry、Elastic、Grafana Faro 等
 * 直接识别，无需自定义解析。
 */

import { TraceContext } from './context.js'

/**
 * W3C Trace Context 头部名
 */
export const TRACE_PARENT = 'traceparent'
export const TRACE_STATE = 'tracestate'
/** W3C 标准 baggage 单一 Header 名 */
export const BAGGAGE = 'baggage'
/**
 * @deprecated 旧版本使用的多个自定义 `baggage-<key>` 头前缀。
 * 仅保留用于**向后兼容提取**（服务端仍能解析历史客户端发送的多头 baggage）；
 * 新版本注入统一使用标准 `baggage` 单一 Header。
 */
export const BAGGAGE_PREFIX = 'baggage-'

/** tracestate 成员长度硬上限（W3C 建议不超过 512 字符） */
const MAX_TRACESTATE_LENGTH = 512

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
 * 将 tracestate 规范化后注入到请求头（单一标准 Header）
 * @param {TraceContext} context
 * @param {Headers} [headers]
 * @returns {Headers}
 */
export function injectTraceState(context, headers = new Headers()) {
  const value = normalizeTraceState(context.traceState)
  if (value) headers.set(TRACE_STATE, value)
  return headers
}

/**
 * 规范化 tracestate 字符串：
 * - 对每个 member 做 trim 并丢弃空白 member
 * - 超过上限时按完整 member 从前往后截断（不破坏 member 边界）
 * @param {string} value
 * @returns {string}
 */
export function normalizeTraceState(value) {
  if (!value) return ''
  const members = String(value).split(',').map(m => m.trim()).filter(Boolean)
  const joined = members.join(',')
  if (joined.length <= MAX_TRACESTATE_LENGTH) return joined
  const kept = []
  let len = 0
  for (const m of members) {
    const next = len === 0 ? m.length : len + 1 + m.length
    if (next > MAX_TRACESTATE_LENGTH) break
    kept.push(m)
    len = next
  }
  return kept.join(',')
}

/**
 * 将 baggage（Map 或普通对象）序列化为 W3C 标准 baggage Header 值。
 * 格式：`key1=value1,key2=value2`（成员间逗号分隔；值使用 encodeURIComponent 编码）。
 * @param {Map<string,string>|object} baggage
 * @returns {string}
 */
export function serializeBaggage(baggage) {
  if (!baggage) return ''
  const entries = baggage instanceof Map ? baggage.entries() : Object.entries(baggage)
  const parts = []
  for (const [rawKey, rawValue] of entries) {
    // key 不允许包含空格/逗号/等号/分号（baggage 语法），用下划线替换非法字符
    const key = String(rawKey).replace(/[\s,;="]/g, '_').trim()
    if (!key) continue
    parts.push(`${key}=${encodeURIComponent(String(rawValue ?? ''))}`)
  }
  return parts.join(',')
}

/**
 * 解析 W3C 标准 baggage Header 值为 Map。
 * 兼容 `key=value` 与带 member 属性的 `key=value;prop=val`（属性被忽略，只取 value）。
 * value 若存在百分号编码则解码。
 * @param {string} headerValue
 * @returns {Map<string,string>}
 */
export function parseBaggage(headerValue) {
  const baggage = new Map()
  if (!headerValue) return baggage
  for (const member of String(headerValue).split(',')) {
    const [pair] = member.split(';')
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    const key = pair.slice(0, eq).trim()
    if (!key) continue
    let value = pair.slice(eq + 1).trim()
    try { value = decodeURIComponent(value) } catch {}
    baggage.set(key, value)
  }
  return baggage
}

/**
 * 将 baggage 注入到请求头（单一标准 `baggage` Header）。
 * 无 baggage 时不写入，避免污染空头。
 * @param {TraceContext} context
 * @param {Headers} [headers]
 * @returns {Headers}
 */
export function injectBaggage(context, headers = new Headers()) {
  const value = serializeBaggage(context?.baggage)
  if (value) headers.set(BAGGAGE, value)
  return headers
}

/**
 * 兼容多种 headers 表示的遍历：Headers 实例 / 含 entries 的对象 / 普通对象
 * @param {*} headers
 * @param {(value:string, key:string) => void} cb
 */
function forEachHeader(headers, cb) {
  if (!headers) return
  if (typeof headers.forEach === 'function') {
    headers.forEach((v, k) => cb(v, k))
  } else if (typeof headers.entries === 'function') {
    for (const [k, v] of headers.entries()) cb(v, k)
  } else {
    for (const [k, v] of Object.entries(headers)) cb(v, k)
  }
}

/**
 * 从响应头提取 baggage（返回 Map）。
 * 优先读取标准 `baggage` Header；同时为向后兼容旧版客户端发送的多个 `baggage-*` Header，
 * 也会收集它们（键名去除前缀并解码）。
 * @param {Headers|object} headers
 * @returns {Map<string,string>}
 */
export function extractBaggage(headers) {
  const baggage = new Map()
  forEachHeader(headers, (value, key) => {
    const lower = String(key).toLowerCase()
    if (lower === BAGGAGE) {
      extractInto(baggage, parseBaggage(value))
    } else if (lower.startsWith(BAGGAGE_PREFIX)) {
      // 仅用 lower 做前缀匹配，键名保留原始大小写（与历史行为一致）
      const rawKey = String(key).slice(BAGGAGE_PREFIX.length)
      try {
        baggage.set(decodeURIComponent(rawKey), decodeURIComponent(String(value)))
      } catch {
        baggage.set(rawKey, String(value))
      }
    }
  })
  return baggage
}

function extractInto(target, source) {
  for (const [k, v] of source) target.set(k, v)
}

/**
 * 注入所有链路追踪头：traceparent + tracestate + 标准 baggage
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
 * @param {Headers|object} headers
 * @returns {string|null}
 */
export function extractTraceParent(headers) {
  return headers.get?.(TRACE_PARENT) || headers[TRACE_PARENT] || null
}

/**
 * 从响应头提取 tracestate（已规范化）
 * @param {Headers|object} headers
 * @returns {string|null}
 */
export function extractTraceState(headers) {
  const raw = headers.get?.(TRACE_STATE) || headers[TRACE_STATE] || null
  return normalizeTraceState(raw) || null
}

/**
 * 从响应头提取完整的 TraceContext
 * @param {Headers|object} headers
 * @param {TraceContext} parentContext - 当前 span 的上下文（用于继承 traceId）
 * @returns {TraceContext|null}
 */
export function extractContext(headers, parentContext) {
  const traceparent = extractTraceParent(headers)
  if (!traceparent) return null

  const context = TraceContext.fromTraceParent(traceparent)
  if (!context) return null

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

/**
 * 判断某个 origin 是否匹配 traceOrigins 规则。
 * 支持三种规则形态：
 * - string：与 origin 精确相等（如 'https://api.example.com'）
 * - RegExp：用正则测试 origin（如 /^https:\/\/.*\.example\.com$/）
 * - function：接收 origin 字符串，返回 boolean（自定义逻辑，如仅允许特定路径）
 * @param {string} origin - 请求目标 origin（绝对 URL 的 origin 部分）
 * @param {string|RegExp|((origin:string)=>boolean)|null|undefined} rule
 * @returns {boolean}
 */
export function matchesTraceOrigin(origin, rule) {
  if (rule == null) return false
  if (typeof rule === 'function') return !!rule(origin)
  if (rule instanceof RegExp) return rule.test(origin)
  return String(rule) === origin
}

/**
 * 判断请求 URL 是否允许注入链路追踪 header（traceparent / tracestate / baggage）。
 * 规则：
 * - 同源请求永远允许；
 * - 跨域请求仅在 origin 命中 `traceOrigins` 中任一规则时才允许；
 * - 非法 URL 或非字符串一律拒绝（避免配置错误向任意第三方域泄露 baggage）。
 *
 * @param {string} value - 请求 URL
 * @param {Array<string|RegExp|((origin:string)=>boolean)>} [origins=[]] - 允许透传的跨域 origin 规则
 * @param {string} [baseHref] - 当前页面 base（默认取浏览器 location.href；Node 测试时显式传入）
 * @returns {boolean}
 */
export function canTrace(value, origins = [], baseHref) {
  const base = baseHref || (typeof location !== 'undefined' ? location.href : 'http://localhost/')
  let url
  try {
    url = new URL(value, base)
  } catch {
    return false
  }
  let baseOrigin
  try {
    baseOrigin = new URL(base).origin
  } catch {
    return false
  }
  if (url.origin === baseOrigin) return true
  return (origins || []).some(rule => matchesTraceOrigin(url.origin, rule))
}

export default {
  injectHeaders,
  extractContext,
  extractTraceParent,
  extractTraceState,
  extractBaggage,
  injectTraceParent,
  injectTraceState,
  injectBaggage,
  serializeBaggage,
  parseBaggage,
  createTracedRequest,
  matchesTraceOrigin,
  canTrace,
  TRACE_PARENT,
  TRACE_STATE,
  BAGGAGE,
  BAGGAGE_PREFIX
}
