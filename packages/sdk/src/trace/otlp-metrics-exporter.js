/**
 * @fileoverview OTLP/HTTP + JSON Metrics Exporter（C1 · OpenTelemetry 导出 · RUM 指标）
 *
 * 把 SDK 已采集的 RUM 指标（`metric(name, value, props)`）以标准 OTLP Metrics JSON 增量导出到客户
 * 可观测性栈。与 trace 导出共用同一轻量 OTLP/HTTP + JSON 协议与 Resource/Scope 约定。
 *
 * 约束（与现有采集解耦）：
 * - 增量导出，**不改动** `metric()` 既有入队逻辑；仅在其后并行喂入 OTLP 缓冲；
 * - 不携带任何 PII：仅导出 指标名 / 数值 / 时间戳 + Resource（service.name 等），不含 props 业务字段；
 * - 沿用已采 RUM 字段，不新增采集面。
 *
 * 协议参考：https://opentelemetry.io/docs/specs/otlp/#otlphttp （/v1/metrics）
 *
 * @see buildOtlpResourceAttributes 资源构造见 ./otlp-trace-exporter.js
 */

import { SDK_VERSION } from '../core/event.js'
import { buildOtlpResourceAttributes, normalizeHeaders as normalizeOtlpHeaders } from './otlp-trace-exporter.js'

/** OTLP 导出统一 instrumentation scope（与 trace 导出一致）。 */
const DEFAULT_OTLP_SCOPE = { name: 'web-collection-sdk', version: SDK_VERSION }

/**
 * OTLP/HTTP + JSON Metrics Exporter。
 * `export(points)` 接收已转换的 metric 数据点（name / value / timeUnixNano / attributes），
 * 组装为 `resourceMetrics` 载荷并 POST。
 */
export class OtlpMetricsExporter {
  /**
   * @param {object} options
   * @param {string} options.endpoint - 客户 OTLP/HTTP metrics 端点（如 https://otlp.example.com/v1/metrics）
   * @param {Record<string,string>} [options.headers] - 自定义请求头（鉴权）
   * @param {object} [options.resource] - 资源信息
   * @param {object} [options.scope] - instrumentation scope
   * @param {(input: string|Request, init?: object) => Promise<any>} [options.fetchImpl]
   * @param {number} [options.timeout=10000]
   */
  constructor({ endpoint, headers = {}, resource, scope, fetchImpl, timeout = 10000 } = {}) {
    if (!endpoint || typeof endpoint !== 'string') {
      throw new Error('OtlpMetricsExporter requires a string endpoint')
    }
    this.endpoint = endpoint
    this.headers = normalizeOtlpHeaders(headers)
    this.resource = resource || {}
    this.scope = scope || DEFAULT_OTLP_SCOPE
    this.timeout = Number.isFinite(Number(timeout)) && Number(timeout) > 0 ? Number(timeout) : 10000
    this.fetchImpl = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null)
  }

  /**
   * 导出一批 RUM 指标点。
   * @param {Array<{name:string, value:number, timeUnixNano?:string, attributes?:Array<object>}>} points
   * @returns {Promise<{ ok: boolean, count: number, error?: string }>}
   */
  async export(points) {
    if (!this.fetchImpl || !Array.isArray(points) || points.length === 0) {
      return { ok: true, count: 0 }
    }
    const metrics = points.map((p) => ({
      name: String(p.name || 'unknown'),
      // RUM 多为点现值（lcp/fps/cls/ttfb…），以 gauge 表达，OTel Collector 可无损转 Prometheus/Grafana。
      gauge: {
        dataPoints: [
          {
            asDouble: Number(p.value) || 0,
            timeUnixNano: p.timeUnixNano || String(Math.round(Date.now() * 1e6)),
            attributes: Array.isArray(p.attributes) ? p.attributes : []
          }
        ]
      }
    }))
    const body = {
      resourceMetrics: [
        {
          resource: { attributes: buildOtlpResourceAttributes(this.resource) },
          scopeMetrics: [
            {
              scope: { name: this.scope.name, version: this.scope.version },
              metrics
            }
          ]
        }
      ]
    }
    try {
      await this._post(JSON.stringify(body))
      return { ok: true, count: points.length }
    } catch (err) {
      return { ok: false, count: 0, error: String((err && err.message) || err) }
    }
  }

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

/**
 * RUM 指标 OTLP 缓冲批处理器：轻量内存缓冲 + 定时/达量刷新。
 * 不持有 SDK 运行时状态，仅负责把 `metric()` 调用攒批后交给 {@link OtlpMetricsExporter}。
 */
export class RumMetricBatcher {
  /**
   * @param {OtlpMetricsExporter} exporter
   * @param {object} [options]
   * @param {number} [options.flushIntervalMillis=10000] - 定时刷新间隔（ms），0 关闭定时
   * @param {number} [options.maxBatchSize=200] - 达量立即触发刷新
   */
  constructor(exporter, { flushIntervalMillis = 10000, maxBatchSize = 200 } = {}) {
    if (!exporter || typeof exporter.export !== 'function') {
      throw new Error('RumMetricBatcher requires an OtlpMetricsExporter with export()')
    }
    this.exporter = exporter
    this.flushIntervalMillis = flushIntervalMillis
    this.maxBatchSize = maxBatchSize
    this._buffer = []
    this._shutdown = false
    this._timer = null
    if (this.flushIntervalMillis > 0 && typeof setInterval === 'function') {
      this._timer = setInterval(() => {
        this.flush().catch(() => {})
      }, this.flushIntervalMillis)
      if (typeof this._timer.unref === 'function') this._timer.unref()
    }
  }

  /**
   * 追加一个 RUM 指标点（增量、非阻塞）。
   * @param {string} name - 指标名
   * @param {number} value - 指标值
   * @param {number} [ts=Date.now()] - epoch 毫秒
   */
  add(name, value, ts = Date.now()) {
    if (this._shutdown) return
    this._buffer.push({ name, value: Number(value) || 0, timeUnixNano: String(Math.round(ts * 1e6)) })
    if (this._buffer.length >= this.maxBatchSize) {
      this.flush().catch(() => {})
    }
  }

  /**
   * 冲刷当前缓冲（不关闭定时器、不改变 `_shutdown` 状态）。
   * 注意：此处**不能**用 `_shutdown` 做早退判断 —— 否则 `shutdown()` 置位后再调本方法
   * 会立即返回、剩余 buffer 全部丢失（曾致远程配置重装配时整批 metrics 丢弃）。
   * 缓冲已被上一次 flush 清空，故重复调用天然幂等（count: 0）。
   */
  async flush() {
    if (!this._buffer.length) return { ok: true, count: 0 }
    const batch = this._buffer
    this._buffer = []
    try {
      return await this.exporter.export(batch)
    } catch (err) {
      return { ok: false, count: 0, error: String((err && err.message) || err) }
    }
  }

  /**
   * 关闭：先冲刷剩余缓冲，再置位停止接收（页面退出 / 销毁 / 管线拆卸时调用）。
   * 顺序是关键：**必须先 flush 后置位**，保证剩余 metrics 真正发出；
   * 置位后 `add()` 拒绝新点，重复 `shutdown()` 因缓冲已空而幂等返回 count: 0。
   */
  async shutdown() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    const result = await this.flush()
    this._shutdown = true
    return result
  }
}

export default OtlpMetricsExporter
