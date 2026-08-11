/**
 * @fileoverview Trace Module 入口
 *
 * 导出 trace 模块的所有公共 API：
 * - TraceContext: 链路上下文
 * - Span, SpanKind, SpanStatusCode: Span 相关
 * - Tracer, createTracer: 追踪器
 * - Sampler, createSampler: 采样器
 * - injectHeaders, extractContext: 传播工具
 */

export { TraceContext, randomHex } from './context.js'
export { Span, SpanKind, SpanStatusCode } from './span.js'
export { Tracer, createTracer, getCurrentSpan, getCurrentContext } from './tracer.js'
export {
  SpanProcessor,
  BatchSpanProcessor,
  SpanExporter,
  WebCollectionSpanExporter,
  DEFAULT_RESOURCE
} from './processor.js'
export { Sampler, createSampler, isSampled } from './sampler.js'
export {
  injectHeaders,
  injectTraceParent,
  injectTraceState,
  injectBaggage,
  extractContext,
  extractTraceParent,
  extractTraceState,
  extractBaggage,
  createTracedRequest,
  TRACE_PARENT,
  TRACE_STATE,
  BAGGAGE_PREFIX
} from './propagation.js'

export { default } from './tracer.js'