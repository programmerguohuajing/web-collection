/**
 * @fileoverview Span Processor 与 Span Exporter
 *
 * 实现与 OpenTelemetry 对齐的处理器/导出器模型：
 * - `SpanProcessor`：Span 生命周期钩子（onStart/onEnd/forceFlush/shutdown）
 * - `BatchSpanProcessor`：缓冲 Span，达到批量上限或定时后批量导出
 * - `SpanExporter`：将一批 Span 发送到远端（抽象）
 * - `WebCollectionSpanExporter`：批量写入本平台 `/api/spans`（Span Envelope v2）
 *
 * 目标：让页面根 Span、自动请求 Span、自定义 Span 都经由同一管线导出，
 * 后端分布式调用树不再依赖 perf event「猜」Span。
 */

import { SDK_VERSION } from '../core/event.js'

/**
 * 前端 Span 统一资源信息：serviceName 与后端 `buildDistributedTrace` 中
 * 前端事件节点保持一致（均为 `frontend`），便于调用树按服务着色。
 */
export const DEFAULT_RESOURCE = {
  serviceName: 'frontend',
  sdkName: 'web-collection-sdk',
  sdkVersion: SDK_VERSION
}

/**
 * Span Processor 接口（抽象基类）
 * @abstract
 */
export class SpanProcessor {
  /** @param {import('./span.js').Span} _span */
  onStart(_span) {}
  /** @param {import('./span.js').Span} _span */
  onEnd(_span) {}
  /** @returns {Promise<void>} */
  async forceFlush() {}
  /** @returns {Promise<void>} */
  async shutdown() {}
}

/**
 * 批量 Span 处理器：缓冲 Span，达到 `maxExportBatchSize` 或 `scheduledDelayMillis`
 * 到期时调用 Exporter 批量导出。
 */
export class BatchSpanProcessor extends SpanProcessor {
  /**
   * @param {SpanExporter} exporter - 实际发送 Span 的导出器
   * @param {object} [options]
   * @param {number} [options.maxExportBatchSize=64] - 缓冲达到该数量立即触发导出
   * @param {number} [options.scheduledDelayMillis=5000] - 定时刷新间隔（ms）
   * @param {number} [options.maxQueueSize=512] - 缓冲上限，超出丢弃最旧（保护内存）
   */
  constructor(exporter, { maxExportBatchSize = 64, scheduledDelayMillis = 5000, maxQueueSize = 512 } = {}) {
    super()
    if (!exporter || typeof exporter.export !== 'function') {
      throw new Error('BatchSpanProcessor requires a SpanExporter with an export() method')
    }
    this.exporter = exporter
    this.maxExportBatchSize = maxExportBatchSize
    this.scheduledDelayMillis = scheduledDelayMillis
    this.maxQueueSize = maxQueueSize
    /** @type {import('./span.js').Span[]} */
    this._buffer = []
    this._timer = null
    this._shutdown = false
  }

  onStart() {}

  onEnd(span) {
    if (this._shutdown) return
    this._buffer.push(span)
    // 超出队列上限：丢弃最旧，避免内存膨胀（优先保留最近的 Span）。
    if (this._buffer.length > this.maxQueueSize) this._buffer.shift()
    if (this._buffer.length >= this.maxExportBatchSize) {
      this.forceFlush()
    } else if (!this._timer) {
      this._timer = setTimeout(() => this.forceFlush(), this.scheduledDelayMillis)
    }
  }

  async forceFlush() {
    if (this._shutdown || !this._buffer.length) return
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
    const batch = this._buffer
    this._buffer = []
    try {
      await this.exporter.export(batch)
    } catch {
      // 导出失败由 Exporter 自身记录诊断，这里不让 flush 抛出影响调用方。
    }
  }

  async shutdown() {
    this._shutdown = true
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
    const pending = this._buffer
    this._buffer = []
    if (pending.length) {
      try { await this.exporter.export(pending) } catch {}
    }
  }
}

/**
 * Span Exporter 接口（抽象基类）
 * @abstract
 */
export class SpanExporter {
  /**
   * 导出一批 Span
   * @param {import('./span.js').Span[]} _spans
   * @returns {Promise<{ ok: boolean, count: number, error?: string, result?: any }>}
   */
  async export(_spans) {
    throw new Error('SpanExporter.export() not implemented')
  }
}

/**
 * Web Collection Span Exporter：将 Span 批量写入本平台 `/api/spans`。
 * 发送的载荷为 Span Envelope v2：`{ schemaVersion: 2, resource, spans }`。
 */
export class WebCollectionSpanExporter extends SpanExporter {
  /**
   * @param {object} options
   * @param {(payload: object) => Promise<any>} options.send - 实际发送函数（注入以便测试与复用 SDK 传输层鉴权）
   * @param {object} [options.resource] - 资源信息，默认 {@link DEFAULT_RESOURCE}
   */
  constructor({ send, resource = DEFAULT_RESOURCE } = {}) {
    super()
    this._send = typeof send === 'function' ? send : null
    this.resource = resource
  }

  async export(spans) {
    if (!this._send || !Array.isArray(spans) || spans.length === 0) {
      return { ok: true, count: 0 }
    }
    const records = spans.map((span) => (typeof span.toExport === 'function' ? span.toExport(this.resource) : span))
    try {
      const result = await this._send({ schemaVersion: 2, resource: this.resource, spans: records })
      return { ok: true, count: records.length, result }
    } catch (err) {
      return { ok: false, count: 0, error: String(err?.message || err) }
    }
  }
}

export default BatchSpanProcessor
