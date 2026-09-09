/**
 * @fileoverview OTLP/HTTP + JSON Trace Exporter（C1 · OpenTelemetry 导出）
 *
 * 将 SDK 内部 `Span` 模型映射为标准 OTLP/HTTP JSON 格式，直接 POST 到客户自有的
 * 可观测性栈（Grafana / Datadog / Prometheus OTel Collector 等），实现 ToB「门票」能力。
 *
 * 设计要点（与现有采集解耦、增量导出）：
 * - 仅新增一条「增量导出」管线，**不改动**任何现有采集 / 落库逻辑；
 * - 复用现有 `Span` 模型、`W3C traceparent` 上下文与确定性采样层（`DeterministicSampler`）；
 * - 优先采用 OTLP/HTTP + JSON：无重型 protobuf 依赖，契合 IIFE 交付的体积约束；
 * - 导出位置决策：**浏览器内直接 fetch 到客户 OTLP/HTTP 端点**（详见报告），不经由本平台 Worker 桥接；
 * - 默认关闭：必须经 SDK 初始化选项或 `/sdk-config` 显式开启，且 `credentials: 'omit'` 不泄露 Cookie。
 *
 * 协议参考：
 * - OTLP/HTTP JSON traces：https://opentelemetry.io/docs/specs/otlp/#otlphttp
 * - OTLP 数据模型（Span / Resource / Status / Kind 枚举）：https://opentelemetry.io/docs/specs/otel/trace/
 *
 * @see SpanExporter 抽象基类定义见 ./processor.js
 */

import { SpanExporter, DEFAULT_RESOURCE } from './processor.js'
import { SpanKind, SpanStatusCode } from './span.js'
import { SDK_VERSION } from '../core/event.js'
import { DeterministicSampler } from '../sampling/index.js'

/** OTLP SpanKind 枚举（OpenTelemetry proto Span.SpanKind）。 */
const SPAN_KIND_TO_OTLP = {
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
  PRODUCER: 4,
  CONSUMER: 5
}

/** OTLP Status_StatusCode 枚举（0 UNSET / 1 OK / 2 ERROR）。 */
const STATUS_TO_OTLP = {
  [SpanStatusCode.UNSET]: 0,
  [SpanStatusCode.OK]: 1,
  [SpanStatusCode.ERROR]: 2
}

/** OTLP 导出统一 instrumentation scope（instrumentation scope / library）。 */
export const DEFAULT_OTLP_SCOPE = { name: 'web-collection-sdk', version: SDK_VERSION }

/** 把任意 JS 值编码为 OTLP `AnyValue`（OTLP 用字符串承载 int/double/bool，避免类型歧义）。 */
function otlpAnyValue(value) {
  if (typeof value === 'boolean') return { boolValue: value }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { stringValue: String(value) }
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
  }
  if (value == null) return { stringValue: '' }
  if (typeof value === 'object') {
    try {
      return { stringValue: JSON.stringify(value) }
    } catch {
      return { stringValue: '[Unserializable]' }
    }
  }
  return { stringValue: String(value) }
}

/** 把 Map / 普通对象转为 OTLP `KeyValue` 数组。 */
function otlpAttributes(mapOrObj) {
  const entries = mapOrObj instanceof Map ? [...mapOrObj.entries()] : Object.entries(mapOrObj || {})
  const out = []
  for (const [key, value] of entries) {
    if (key == null) continue
    out.push({ key: String(key), value: otlpAnyValue(value) })
  }
  return out
}

/** 把 [0,1] 区间外的值钳位为合法采样率（默认 1 = 全量）。 */
function clampRate(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 1
  return Math.max(0, Math.min(1, n))
}

/** 规范化自定义 OTLP 头（仅保留 string 值，供客户携带鉴权信息，如 Datadog-... / Authorization）。 */
export function normalizeHeaders(headers) {
  const out = {}
  if (headers && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      if (value == null) continue
      out[String(key)] = String(value)
    }
  }
  return out
}

/**
 * 构造 OTLP Resource 属性（对齐 OpenTelemetry 语义约定）。
 * - service.name：默认 `frontend`（与后端 `buildDistributedTrace` 前端节点着色一致）；
 * - telemetry.sdk.*：标识本导出器自身，避免与客户 OTel 数据混淆。
 * @param {object} [resource] - 通常来自 Exporter 的 `resource`
 * @param {string} [resource.serviceName='frontend']
 * @param {string} [resource.sdkVersion]
 * @param {string} [environment='production']
 * @returns {Array<{key:string, value:object}>}
 */
export function buildOtlpResourceAttributes(resource = {}, environment = 'production') {
  return otlpAttributes({
    'service.name': resource.serviceName || 'frontend',
    'service.version': resource.sdkVersion || SDK_VERSION,
    'deployment.environment': environment || 'production',
    'telemetry.sdk.name': 'web-collection-sdk',
    'telemetry.sdk.language': 'webjs',
    'telemetry.sdk.version': SDK_VERSION
  })
}

/**
 * 将单个 SDK `Span` 转换为 OTLP Span JSON。
 * 时间戳统一以 epoch 纳秒（string）表达，与 OTLP 规范一致；Span 事件相对 `performance.now()`
 * 的时间经 `startEpoch` 偏移交回绝对纳秒。
 * @param {import('./span.js').Span} span
 * @param {object} [resource]
 * @returns {object} OTLP Span JSON
 */
export function spanToOtlp(span, resource = {}) {
  const ctx = span.context || {}
  const startEpoch = span.startEpoch != null ? span.startEpoch : Date.now()
  const endEpoch = span.endEpoch != null ? span.endEpoch : startEpoch
  const otlp = {
    traceId: ctx.traceId || '',
    spanId: ctx.spanId || '',
    name: span.name || '',
    kind: SPAN_KIND_TO_OTLP[span.kind] != null ? SPAN_KIND_TO_OTLP[span.kind] : SPAN_KIND_TO_OTLP.INTERNAL,
    startTimeUnixNano: String(Math.round(startEpoch * 1e6)),
    endTimeUnixNano: String(Math.round(endEpoch * 1e6)),
    attributes: otlpAttributes(span.attributes),
    status: {
      code: STATUS_TO_OTLP[span.status?.code] != null ? STATUS_TO_OTLP[span.status.code] : 0,
      message: span.status?.message || ''
    }
  }
  if (ctx.parentSpanId) otlp.parentSpanId = ctx.parentSpanId
  if (Array.isArray(span.events) && span.events.length) {
    const startRel = Number.isFinite(span.startTime) ? span.startTime : 0
    otlp.events = span.events.map((ev) => {
      const rel = Number.isFinite(ev.timestamp) ? ev.timestamp : 0
      const evEpochNs = Math.round((startEpoch + (rel - startRel)) * 1e6)
      return {
        name: ev.name || '',
        timeUnixNano: String(evEpochNs),
        attributes: otlpAttributes(ev.attributes)
      }
    })
  }
  return otlp
}

/**
 * 将一批 `Span` 组装为 OTLP/HTTP JSON traces 载荷（resourceSpans → scopeSpans → spans）。
 * @param {import('./span.js').Span[]} spans
 * @param {object} [resource]
 * @param {object} [scope]
 * @param {string} [environment]
 * @returns {object}
 */
export function spansToOtlpJson(spans, resource = DEFAULT_RESOURCE, scope = DEFAULT_OTLP_SCOPE, environment = 'production') {
  return {
    resourceSpans: [
      {
        resource: { attributes: buildOtlpResourceAttributes(resource, environment) },
        scopeSpans: [
          {
            scope: { name: scope.name, version: scope.version },
            spans: (Array.isArray(spans) ? spans : []).map((s) => spanToOtlp(s, resource))
          }
        ]
      }
    ]
  }
}

/**
 * OTLP/HTTP + JSON Trace Exporter（增量导出到客户自有可观测性栈）。
 * 复用 `BatchSpanProcessor` 触发，按 traceId 做**确定性导出采样**，保证同链路父子 Span 一致保留/丢弃。
 *
 * ⚠️ Span 结束方式（既有 SDK 语义，非本导出器特有，`WebCollectionSpanExporter` 同此约束）：
 * 必须经 `tracer.withSpan(name, fn)` 或 `tracer.endSpan(span)` 结束 Span——只有这两条路径会
 * 通知 SpanProcessor。直接调用 `span.end()` **不会**通知任何 Processor，该 Span 不会进入任何
 * 导出管线（既不到 /api/spans，也不到 OTLP），表现为「静默丢失」。请勿据此改动既有语义。
 */
export class OtlpTraceExporter extends SpanExporter {
  /**
   * @param {object} options
   * @param {string} options.endpoint - 客户 OTLP/HTTP traces 端点（如 https://otlp.example.com/v1/traces）
   * @param {Record<string,string>} [options.headers] - 自定义请求头（鉴权），随请求发送
   * @param {object} [options.resource] - 资源信息，默认 {@link DEFAULT_RESOURCE}
   * @param {object} [options.scope] - instrumentation scope，默认 {@link DEFAULT_OTLP_SCOPE}
   * @param {number} [options.samplingRate=1] - 导出采样率 [0,1]（按 traceId 确定性决策）
   * @param {string} [options.environment='production'] - deployment.environment 资源属性
   * @param {(input: string|Request, init?: object) => Promise<any>} [options.fetchImpl] - 注入 fetch（复用 SDK 传输层）
   * @param {number} [options.timeout=10000] - 单次导出超时（ms）
   */
  constructor({ endpoint, headers = {}, resource, scope, samplingRate = 1, environment = 'production', fetchImpl, timeout = 10000 } = {}) {
    super()
    if (!endpoint || typeof endpoint !== 'string') {
      throw new Error('OtlpTraceExporter requires a string endpoint')
    }
    this.endpoint = endpoint
    this.headers = normalizeHeaders(headers)
    this.resource = resource || DEFAULT_RESOURCE
    this.scope = scope || DEFAULT_OTLP_SCOPE
    this.environment = environment
    this.timeout = Number.isFinite(Number(timeout)) && Number(timeout) > 0 ? Number(timeout) : 10000
    this.fetchImpl = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null)
    // 复用现有确定性采样层：按 traceId 单元一致决策，避免同链路父子 Span 被随机拆分。
    this._sampler = new DeterministicSampler({ traceRate: clampRate(samplingRate) })
    this._stats = { exported: 0, droppedBySample: 0 }
  }

  /** @returns {{exported:number, droppedBySample:number}} 导出统计（不含敏感数据） */
  getStats() {
    return { ...this._stats }
  }

  /**
   * 导出一批 Span 到 OTLP/HTTP 端点。
   * @param {import('./span.js').Span[]} spans
   * @returns {Promise<{ ok: boolean, count: number, droppedBySample?: number, error?: string, result?: any }>}
   */
  async export(spans) {
    if (!this.fetchImpl || !Array.isArray(spans) || spans.length === 0) {
      return { ok: true, count: 0 }
    }
    const kept = []
    for (const span of spans) {
      const traceId = span?.context?.traceId
      if (this._sampler.shouldSample({ traceId })) kept.push(span)
      else this._stats.droppedBySample++
    }
    if (kept.length === 0) {
      return { ok: true, count: 0, droppedBySample: spans.length }
    }
    const payload = spansToOtlpJson(kept, this.resource, this.scope, this.environment)
    try {
      await this._post(JSON.stringify(payload))
      this._stats.exported += kept.length
      return { ok: true, count: kept.length }
    } catch (err) {
      return { ok: false, count: 0, error: String((err && err.message) || err) }
    }
  }

  /** 带超时 + keepalive + 不带凭证的 POST（避免向客户端点泄露 Cookie）。 */
  async _post(body) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.headers },
        body,
        keepalive: true,
        credentials: 'omit',
        signal: controller.signal
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res
    } finally {
      clearTimeout(timer)
    }
  }
}

export default OtlpTraceExporter
