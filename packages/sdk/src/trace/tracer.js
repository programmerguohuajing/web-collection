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

/**
 * 全局活跃 Tracer：模块级便捷函数 `getCurrentSpan`/`getCurrentContext` 委托给它。
 * 每个 Tracer 实例维护自己独立的活动 span 栈（保存在实例上），多实例之间互不污染；
 * 模块级函数只返回「最后一个 createTracer 创建的实例」的当前上下文，用于无实例引用的场景。
 */
let activeTracer = null

/** 设置全局活跃 Tracer（由 createTracer 调用） */
export function setActiveTracer(tracer) { activeTracer = tracer }

/**
 * 获取当前活动 span（委托给全局活跃 Tracer）
 * @returns {Span|null}
 */
export function getCurrentSpan() {
  return activeTracer ? activeTracer.getCurrentSpan() : null
}

/**
 * 获取当前 trace 上下文（委托给全局活跃 Tracer）
 * @returns {TraceContext|null}
 */
export function getCurrentContext() {
  return activeTracer ? activeTracer.getCurrentContext() : null
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
    /** 实例级活动 span 栈（支持嵌套 span，与其他 Tracer 实例隔离） */
    this._spanStack = []
    /** 实例级 Span Processor 列表（Span 结束时会通知它们，用于导出） */
    this._processors = []
  }

  /**
   * 注册一个 SpanProcessor（如 BatchSpanProcessor），Span 结束时会通知它。
   * @param {import('./processor.js').SpanProcessor} processor
   */
  addSpanProcessor(processor) {
    if (processor && typeof processor.onEnd === 'function') {
      this._processors.push(processor)
    }
    return this
  }

  /**
   * 获取已注册的 SpanProcessor 列表
   * @returns {import('./processor.js').SpanProcessor[]}
   */
  getSpanProcessors() {
    return this._processors.slice()
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
    const parentSpan = options.parent || this.getCurrentSpan()
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
    // 统一收尾：记录异常（如有）并结束 span（从活动栈弹出 + span.end），
    // 保证同步、Promise resolve/reject、thenable 和异常路径都能恢复父上下文。
    const settle = (err) => {
      if (err) span.recordException(err)
      this.endSpan(span)
    }
    try {
      const result = fn(span)
      if (result && typeof result.then === 'function') {
        return result.then(
          (value) => { settle(null); return value },
          (err) => { settle(err); throw err }
        )
      }
      settle(null)
      return result
    } catch (err) {
      settle(err)
      throw err
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
   * 激活 span（压入实例栈顶），并通知所有 Processor 的 onStart。
   * @private
   */
  _activateSpan(span) {
    this._spanStack.push(span)
    for (const p of this._processors) {
      try { p.onStart(span) } catch {}
    }
  }

  /**
   * 结束当前 span 并从实例栈中弹出（连同其上方所有未关闭的子 span），
   * 结束后通知所有 Processor 的 onEnd（用于导出）。
   * @param {Span} span - 要结束的 span
   */
  endSpan(span) {
    const idx = this._spanStack.lastIndexOf(span)
    if (idx !== -1) {
      this._spanStack.splice(idx, this._spanStack.length - idx)
    }
    if (!span.isEnded()) {
      span.end()
    }
    for (const p of this._processors) {
      try { p.onEnd(span) } catch {}
    }
  }

  /**
   * 刷新所有 SpanProcessor 的缓冲（不关闭它们）。
   * @returns {Promise<void>}
   */
  async flushSpans() {
    await Promise.all(this._processors.map((p) => p.forceFlush().catch(() => {})))
  }

  /**
   * 关闭所有 SpanProcessor（刷新剩余缓冲后停止接收）。
   * @returns {Promise<void>}
   */
  async shutdownSpans() {
    await Promise.all(this._processors.map((p) => p.shutdown().catch(() => {})))
  }

  /**
   * 获取当前活动 span（外部调用）
   * @returns {Span|null}
   */
  getCurrentSpan() {
    return this._spanStack.length > 0 ? this._spanStack[this._spanStack.length - 1] : null
  }

  /**
   * 获取当前 trace 上下文
   * @returns {TraceContext|null}
   */
  getCurrentContext() {
    const span = this.getCurrentSpan()
    return span ? span.context : null
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
  const tracer = new Tracer(options)
  setActiveTracer(tracer)
  return tracer
}

export default Tracer