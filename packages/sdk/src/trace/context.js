/**
 * @fileoverview TraceContext - W3C Trace Context 标准实现
 *
 * TraceContext 封装了一条链路追踪的上下文信息，包括：
 * - traceId: 32 位十六进制链路唯一标识
 * - spanId: 16 位十六进制当前 span 唯一标识
 * - parentSpanId: 父 span ID（根 span 为空）
 * - traceFlags: 采样标志（'01' = sampled, '00' = not sampled）
 * - traceState: 跨厂商状态透传
 * - baggage: 跨服务业务属性
 *
 * W3C Trace Context 规范: https://www.w3.org/TR/trace-context/
 * traceparent 格式: version-traceId-spanId-traceFlags
 */

/**
 * 生成指定字节数的安全随机十六进制字符串
 * @param {number} bytes - 字节数
 * @returns {string} 十六进制字符串
 */
export function randomHex(bytes) {
  const data = new Uint8Array(bytes)
  crypto.getRandomValues(data)
  return [...data].map(v => v.toString(16).padStart(2, '0')).join('')
}

/**
 * TraceContext 类 - 封装链路追踪上下文
 */
export class TraceContext {
  /**
   * @param {object} options
   * @param {string} [options.traceId] - 32 位十六进制 traceId
   * @param {string} [options.spanId] - 16 位十六进制 spanId
   * @param {string} [options.parentSpanId] - 父 span ID（根 span 为空）
   * @param {string} [options.traceFlags='01'] - 采样标志 '01' 或 '00'
   * @param {string} [options.traceState=''] - traceState 字符串
   * @param {Map<string, string>} [options.baggage] - baggage 键值对
   */
  constructor({ traceId, spanId, parentSpanId = '', traceFlags = '01', traceState = '', baggage = new Map() } = {}) {
    this.traceId = traceId || randomHex(16)  // 32 位十六进制
    this.spanId = spanId || randomHex(8)       // 16 位十六进制
    this.parentSpanId = parentSpanId
    this.traceFlags = traceFlags  // '01' = sampled, '00' = not sampled
    this.traceState = traceState
    this.baggage = baggage instanceof Map ? baggage : new Map(baggage)
  }

  /**
   * 创建根 Span 的上下文（无父 span）
   * @param {string} [traceId] - 可选指定 traceId，不指定则自动生成
   * @returns {TraceContext}
   */
  static createRoot(traceId) {
    const ctx = new TraceContext({
      traceId: traceId || randomHex(16),
      spanId: randomHex(8)
    })
    return ctx
  }

  /**
   * 从 traceparent 字符串解析 TraceContext
   * @param {string} traceparent - traceparent 头值（如 '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'）
   * @returns {TraceContext}
   */
  static fromTraceParent(traceparent) {
    if (!traceparent) return null
    const parts = traceparent.split('-')
    if (parts.length < 4) return null
    const [version, traceId, spanId, flags] = parts
    // 版本校验（仅支持 '00'）
    if (version !== '00') return null
    return new TraceContext({ traceId, spanId, traceFlags: flags })
  }

  /**
   * 生成 traceparent 字符串
   * @returns {string}
   */
  toTraceParent() {
    return `00-${this.traceId}-${this.spanId}-${this.traceFlags}`
  }

  /**
   * 设置 baggage 条目
   * @param {string} key
   * @param {string} value
   * @returns {TraceContext} 新上下文（不可变）
   */
  setBaggage(key, value) {
    const newBaggage = new Map(this.baggage)
    newBaggage.set(key, value)
    return new TraceContext({ ...this, baggage: newBaggage })
  }

  /**
   * 获取 baggage 条目
   * @param {string} key
   * @returns {string|undefined}
   */
  getBaggage(key) {
    return this.baggage.get(key)
  }

  /**
   * 获取 baggage 对象（用于 header 注入）
   * @returns {object}
   */
  getBaggageObject() {
    return Object.fromEntries(this.baggage)
  }

  /**
   * 转换为纯对象（用于序列化）
   * @returns {object}
   */
  toObject() {
    return {
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      traceFlags: this.traceFlags,
      traceState: this.traceState,
      baggage: Object.fromEntries(this.baggage)
    }
  }

  /**
   * 检查是否为根 span（无父 span）
   * @returns {boolean}
   */
  isRoot() {
    return !this.parentSpanId
  }

  /**
   * 创建子 span 的上下文
   * @param {string} childSpanId - 子 span ID
   * @returns {TraceContext}
   */
  child(childSpanId) {
    return new TraceContext({
      traceId: this.traceId,
      spanId: childSpanId || randomHex(8),
      parentSpanId: this.spanId,
      traceFlags: this.traceFlags,
      traceState: this.traceState,
      baggage: this.baggage
    })
  }
}

export default TraceContext
