/**
 * @fileoverview Tracer - 链路追踪的核心追踪器
 *
 * 负责：
 * - 管理当前活动 span 栈（模拟 zone）
 * - 创建新的 span（startSpan）
 * - 自动设置父子关系
 * - 上下文传播到 HTTP 请求头
 */

import { Span, SpanKind, SpanStatusCode } from './span.js'
import { TraceContext, randomHex } from './context.js'
import { Sampler } from './sampler.js'
import { injectHeaders, extractContext } from './propagation.js'

/** 模块级当前 span 栈（支持嵌套 span） */
const spanStack = []

/**
 * 获取当前活动 span
 * @returns {Span|null}
 */
export function getCurrentSpan() {
  return spanStack.length > 0 ? spanStack[spanStack.length - 1] : null
}

/**
 * 获取当前 trace 上下文
 * @returns {TraceContext|null}
 */
export function getCurrentContext() {
  const span = getCurrentSpan()
  return span ? span.context : null
}

/**
 * Tracer 类
 */
export class Tracer {
  /**
   * @param {object} options
   * @param {string} options.name - tracer 名称
   * @param {string} [options.version] - tracer 版本
   * @param {string} [options.traceId] - 页面级 traceId
   * @param {Sampler} [options.sampler] - 采样器实例
   * @param {object} [options.baggage] - 静态 baggage
   */
  constructor({ name, version, traceId, sampler, baggage = {} }) {
    this.name = name || 'web-eys-sdk'
    this.version = version
    this.traceId = traceId || randomHex(16)
    this.sampler = sampler || new Sampler()
    this.baggage = new Map(Object.entries(baggage))

    /** 根 span（页面加载时创建） */
    this._rootSpan = null
  }

  /**
   * 创建根 span（页面加载时调用一次）
   * @param {string} [name='page']
   * @param {object} [attributes]
   * @returns {Span}
   */
  createRootSpan(name = 'page', attributes = {}) {
    if (this._rootSpan) {
      console.warn('[Tracer] Root span already exists, returning existing root.')
      return this._rootSpan
    }

    const traceFlags = this.sampler.getTraceFlags('performance')
    const context = new TraceContext({
      traceId: this.traceId,
      spanId: randomHex(8),
      parentSpanId: '',
      traceFlags,
      traceState: '',
      baggage: this.baggage
    })

    this._rootSpan = new Span({
      name,
      context,
      kind: SpanKind.INTERNAL,
      attributes
    })

    // 自动激活根 span
    this._activateSpan(this._rootSpan)
    return this._rootSpan
  }

  /**
   * 获取根 span
   * @returns {Span|null}
   */
  getRootSpan() {
    return this._rootSpan
  }

  /**
   * 创建新 span
   * @param {string} name - span 名称
   * @param {object} [options]
   * @param {Span} [options.parent] - 父 span，不指定则使用当前活动 span
   * @param {SpanKind} [options.kind=SpanKind.INTERNAL]
   * @param {object} [options.attributes={}]
   * @returns {Span}
   */
  startSpan(name, options = {}) {
    const parentSpan = options.parent || getCurrentSpan()
    const parentContext = parentSpan?.context

    // 创建新 context，继承父 context 的 traceId 和 baggage
    const traceFlags = options.traceFlags ?? this.sampler.getTraceFlags()
    const context = new TraceContext({
      traceId: parentContext?.traceId || this.traceId,
      spanId: randomHex(8),
      parentSpanId: parentContext?.spanId || '',
      traceFlags,
      traceState: parentContext?.traceState || '',
      baggage: parentContext?.baggage || this.baggage
    })

    const span = new Span({
      name,
      context,
      kind: options.kind || SpanKind.INTERNAL,
      attributes: options.attributes || {}
    })

    // 自动激活
    this._activateSpan(span)
    return span
  }

  /**
   * 在 span 内执行函数，自动结束 span
   * @param {string} name - span 名称
   * @param {Function} fn - 要执行的函数
   * @param {object} [options]
   * @returns {*} fn 的返回值
   */
  withSpan(name, fn, options = {}) {
    const span = this.startSpan(name, options)
    try {
      const result = fn(span)
      // 同步函数：立即结束
      if (result instanceof Promise) {
        // 异步函数：返回 promise 链
        return result
          .then(v => { span.end(); return v })
          .catch(e => {
            span.recordException(e)
            span.end()
            throw e
          })
      }
      span.end()
      return result
    } catch (e) {
      span.recordException(e)
      span.end()
      throw e
    }
  }

  /**
   * 创建 HTTP CLIENT span 并注入 trace 头
   * @param {string} name - span 名称
   * @param {object} options
   * @param {RequestInit} [options.requestInit] - fetch init
   * @param {string} [options.method='GET']
   * @param {string} [options.url]
   * @returns {{ span: Span, requestInit: RequestInit }}
   */
  startSpanWithHeaders(name, options = {}) {
    const span = this.startSpan(name, {
      kind: SpanKind.CLIENT,
      attributes: {
        'http.method': options.method || 'GET',
        'http.url': options.url || '',
        ...options.attributes
      }
    })

    // 注入 trace 头到 requestInit
    const { requestInit = {} } = options
    const headers = new Headers(requestInit.headers)
    injectHeaders(span.context, { headers })

    return { span, requestInit: { ...requestInit, headers } }
  }

  /**
   * 从响应头提取并更新 span 上下文
   * @param {Span} span - 当前 span
   * @param {Headers} headers - 响应头
   */
  extractResponse(span, headers) {
    const context = extractContext(headers, span.context)
    if (context) {
      // 创建新的 context 对象（不可变更新）
      span.context = context
    }
  }

  /**
   * 激活 span（压入栈顶）
   * @private
   */
  _activateSpan(span) {
    spanStack.push(span)
  }

  /**
   * 结束当前 span 并从栈中弹出
   * @param {Span} span - 要结束的 span
   */
  endSpan(span) {
    const idx = spanStack.lastIndexOf(span)
    if (idx !== -1) {
      spanStack.splice(idx, 1)
    }
    if (!span.isEnded()) {
      span.end()
    }
  }

  /**
   * 获取当前活动 span（外部调用）
   * @returns {Span|null}
   */
  getCurrentSpan() {
    return getCurrentSpan()
  }

  /**
   * 获取当前 trace 上下文
   * @returns {TraceContext|null}
   */
  getCurrentContext() {
    return getCurrentContext()
  }

  /**
   * 静默执行函数（不创建 span）
   * @param {Function} fn
   * @returns {*}
   */
  batch(fn) {
    return fn()
  }
}

/**
 * 创建 Tracer 实例
 * @param {object} options
 * @returns {Tracer}
 */
export function createTracer(options = {}) {
  return new Tracer(options)
}

export default Tracer