/**
 * @fileoverview Span - 链路追踪中的最小工作单元
 *
 * Span 代表一次操作（如 HTTP 请求、函数调用、数据库查询等），
 * 包含开始时间、结束时间、属性、状态等信息。
 *
 * OpenTelemetry Span 规范对齐实现。
 */

import { TraceContext } from './context.js'

/**
 * Span 状态码
 */
export const SpanStatusCode = {
  OK: 'OK',
  ERROR: 'ERROR',
  UNSET: 'UNSET'
}

/**
 * Span 类型（跨进程/内部）
 */
export const SpanKind = {
  SERVER: 'SERVER',      // 服务端接收请求
  CLIENT: 'CLIENT',      // 客户端发送请求
  PRODUCER: 'PRODUCER',  // 消息生产者
  CONSUMER: 'CONSUMER',  // 消息消费者
  INTERNAL: 'INTERNAL'   // 内部操作
}

/**
 * Span 类
 */
export class Span {
  /**
   * @param {object} options
   * @param {string} options.name - span 名称
   * @param {TraceContext} options.context - trace 上下文
   * @param {SpanKind} [options.kind=SpanKind.INTERNAL] - span 类型
   * @param {object} [options.attributes={}] - 初始属性
   */
  constructor({ name, context, kind = SpanKind.INTERNAL, attributes = {} }) {
    if (!(context instanceof TraceContext)) {
      throw new Error('Span requires a TraceContext instance')
    }
    this.name = name
    this.context = context
    this.kind = kind
    this.attributes = new Map(Object.entries(attributes))
    this.events = []
    this.status = { code: SpanStatusCode.UNSET, message: '' }
    this.startTime = performance.now()
    // 绝对时间戳（epoch ms）：后端 spans 表 start_ts 使用 epoch，与 performance.now() 页面相对值区分。
    this.startEpoch = Date.now()
    this.endTime = null
    this.endEpoch = null
    this._ended = false
  }

  /**
   * 设置属性
   * @param {string} key
   * @param {*} value
   * @returns {Span} this
   */
  setAttribute(key, value) {
    this.attributes.set(key, value)
    return this
  }

  /**
   * 批量设置属性
   * @param {object} attributes
   * @returns {Span} this
   */
  setAttributes(attributes) {
    for (const [key, value] of Object.entries(attributes)) {
      this.attributes.set(key, value)
    }
    return this
  }

  /**
   * 添加 span 事件（带时间戳的标注点）
   * @param {string} name - 事件名称
   * @param {object} [attributes={}] - 事件属性
   */
  addEvent(name, attributes = {}) {
    this.events.push({
      name,
      timestamp: performance.now(),
      attributes: { ...attributes }
    })
  }

  /**
   * 记录异常
   * @param {Error} error
   * @param {object} [attributes={}]
   */
  recordException(error, attributes = {}) {
    const message = error?.message || String(error)
    this.addEvent('exception', {
      'exception.type': error?.name || 'Error',
      'exception.message': message,
      'exception.stacktrace': error?.stack || '',
      ...attributes
    })
    this.status = { code: SpanStatusCode.ERROR, message }
  }

  /**
   * 设置 span 状态
   * @param {SpanStatusCode} code
   * @param {string} [message='']
   */
  setStatus(code, message = '') {
    this.status = { code, message }
  }

  /**
   * 结束 span
   * @param {object} [options]
   * @param {number} [options.endTime] - 结束时间（ms），不指定则使用当前时间
   */
  end(options = {}) {
    if (this._ended) return
    this._ended = true
    this.endTime = options.endTime ?? performance.now()
    this.endEpoch = options.endTimeEpoch ?? Date.now()
  }

  /**
   * 获取 span 持续时间
   * @returns {number} 持续时间（ms）
   */
  duration() {
    if (this.endTime === null) return null
    return this.endTime - this.startTime
  }

  /**
   * 检查 span 是否已结束
   * @returns {boolean}
   */
  isEnded() {
    return this._ended
  }

  /**
   * 获取上下文信息
   * @returns {object} { traceId, spanId, parentSpanId, traceFlags }
   */
  getContext() {
    return {
      traceId: this.context.traceId,
      spanId: this.context.spanId,
      parentSpanId: this.context.parentSpanId,
      traceFlags: this.context.traceFlags
    }
  }

  /**
   * 转换为可序列化对象
   * @returns {object}
   */
  toJSON() {
    return {
      name: this.name,
      traceId: this.context.traceId,
      spanId: this.context.spanId,
      parentSpanId: this.context.parentSpanId,
      kind: this.kind,
      attributes: Object.fromEntries(this.attributes),
      events: this.events,
      status: this.status,
      startTime: this.startTime,
      endTime: this.endTime,
      duration: this.duration()
    }
  }

  /**
   * 转换为后端 Span Envelope v2 的记录（供 SpanExporter 批量写入 `/api/spans`）。
   * 字段名与 `apps/api` 的 `normalizeSpan` 一一对齐：后端按 `traceId`/`spanId`/`parentSpanId`/
   * `serviceName`/`operationName`/`kind`/`startTime`(epoch ms)/`duration`/`statusCode`/
   * `statusMessage`/`attributes` 读取，`id` 用于服务端幂等去重。
   *
   * @param {object} [resource] - 资源信息，通常来自 Exporter 的 `resource`
   * @param {string} [resource.serviceName='frontend'] - 服务名，前端 Span 统一为 `frontend`
   * @returns {object}
   */
  toExport(resource = {}) {
    const duration = this.endEpoch != null ? Math.max(0, this.endEpoch - this.startEpoch) : 0
    return {
      id: `${this.context.traceId}-${this.context.spanId}`,
      traceId: this.context.traceId,
      spanId: this.context.spanId,
      parentSpanId: this.context.parentSpanId || '',
      serviceName: resource.serviceName || 'frontend',
      operationName: this.name,
      kind: this.kind,
      startTime: this.startEpoch,
      duration,
      statusCode: this.status.code,
      statusMessage: this.status.message,
      attributes: Object.fromEntries(this.attributes)
    }
  }
}

export default Span