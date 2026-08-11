/**
 * @fileoverview DeterministicSampler —— 确定性、可解释的采样决策
 *
 * 设计目标（路线图 U06 / SDK-208）：
 *  1. 基于 traceId / sessionId 的「哈希一致性」采样：同一 traceId（链路）或
 *     sessionId（会话）永远得到相同决策，保证 trace 内父子 Span 一致、同会话
 *     事件一致，不再用 Math.random 做会断裂关联的随机决策。
 *  2. 优先级保留：错误事件（及其关联 traceId）默认强制保留，实现「错误会话
 *     按策略保留」，且不破坏 trace 关联性；可配置 errorSampleRate 对错误做
 *     确定性子采样以约束体量。
 *  3. 可解释：每次决策都返回 { sampled, rate, rule, unit, key, ... }，丢弃时
 *     通过 onDiagnostic('dropped_by_sampling') 带上 rule/rate/unit/key，并可经
 *     getSamplingDecision() 自查。
 *
 * 决策优先级：
 *  - priority（错误等）：标记保留；若配置 errorSampleRate 则按单元确定性子采样。
 *  - 远端权重（traceState 的 sampling_weight）：tail-based 预留，按单元一致。
 *  - base 决策：trace 单元用 traceRate，session/global 单元用 sampleRate。
 *  - 分类子采样（categorySampleRates）：仅收窄 session 级决策，绝不破坏 trace。
 */

import { cyrb53, foldUnit } from './hash.js'

const REMOTE_WEIGHT_RE = /sampling_weight=(\d+\.?\d*)/

/** 将任意值钳位到 [0,1]，非数字回退为 1（全量）。 */
function clamp01(value, fallback = 1) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(1, n))
}

/** 规范化分类采样率表：非数字/越界项剔除。 */
function normalizeRates(rates) {
  const out = {}
  if (rates && typeof rates === 'object') {
    for (const [k, v] of Object.entries(rates)) {
      const n = clamp01(v, NaN)
      if (Number.isFinite(n)) out[k] = n
    }
  }
  return out
}

/**
 * 采样决策结果（可解释）
 * @typedef {Object} SamplingDecision
 * @property {boolean} sampled - 是否保留
 * @property {number}  rate    - 应用的基础采样率
 * @property {string}  rule    - 决策规则：priority | error_rate | remote | trace | session | session_category
 * @property {string}  unit    - 决策单元：trace | session | global
 * @property {string}  key     - 实际参与哈希的单元键（traceId / sessionId / 'global'）
 * @property {string} [category]       - 命中的事件分类
 * @property {number} [categoryRate]   - 命中的分类采样率（session_category 时）
 */

export class DeterministicSampler {
  /**
   * @param {object} [options]
   * @param {number} [options.sampleRate=1]          - session/global 基础采样率（0~1）
   * @param {number} [options.traceRate]             - trace 基础采样率（默认 = sampleRate）
   * @param {Record<string, number>} [options.categorySampleRates={}] - 分类采样率（仅收窄 session 级）
   * @param {number} [options.errorSampleRate]       - 错误子采样率（默认 undefined = 错误始终保留）
   * @param {string} [options.traceState='']         - 远端传入的 tracestate（解析 sampling_weight）
   * @param {string} [options.salt='']               - 哈希盐，隔离不同接入方/部署的哈希空间
   */
  constructor(options = {}) {
    this.sampleRate = clamp01(options.sampleRate, 1)
    this.traceRate = clamp01(options.traceRate, this.sampleRate)
    this.categorySampleRates = normalizeRates(options.categorySampleRates)
    // undefined => 错误始终保留（优先级）；设置 <1 则对错误做确定性子采样
    this.errorSampleRate = options.errorSampleRate == null ? null : clamp01(options.errorSampleRate)
    this.traceState = options.traceState || ''
    this.salt = options.salt || ''
    /** @type {Set<string>} 被显式标记为优先保留的 traceId / sessionId */
    this._priorityKeys = new Set()
  }

  /**
   * 把单元键 + 可选盐折叠为 [0,1) 确定性单元值。
   * @param {string} key
   * @param {string} [salt='']
   * @returns {number}
   * @private
   */
  _unit(key, salt = '') {
    const base = this.salt ? `${this.salt}:${key}` : key
    const s = salt ? `${base}:${salt}` : base
    return foldUnit(cyrb53(s))
  }

  /** 从 traceState 解析远端采样权重（sampling_weight=X）。 */
  _parseRemoteWeight() {
    if (!this.traceState) return null
    const m = this.traceState.match(REMOTE_WEIGHT_RE)
    if (!m) return null
    const w = parseFloat(m[1])
    return Number.isFinite(w) && w >= 0 && w <= 1 ? w : null
  }

  /**
   * 标记某个 traceId / sessionId 为优先保留（如发生错误）。
   * 其下所有 Span / 事件均保留，从而保留错误→trace 的关联性。
   * @param {string|undefined|null} key
   * @returns {this}
   */
  markPriority(key) {
    if (key != null) this._priorityKeys.add(String(key))
    return this
  }

  /**
   * 给定 traceId 返回一致的 traceFlags（'01' = sampled，'00' = not sampled）。
   * 同一 traceId 任意次调用结果相同 —— 这是「trace 内父子 Span 决策一致」的关键。
   * @param {string} [traceId]
   * @returns {'01' | '00'}
   */
  getTraceFlagsForTraceId(traceId) {
    return this.decide({ traceId: traceId || undefined }).sampled ? '01' : '00'
  }

  /**
   * 核心决策：基于 traceId（优先）或 sessionId 的确定性一致性采样 + 优先级保留。
   * @param {object} [ctx]
   * @param {string} [ctx.traceId]    - 链路 ID；存在时作为决策单元（保证 trace 一致性）
   * @param {string} [ctx.sessionId]  - 会话 ID；无 traceId 时作为决策单元
   * @param {string} [ctx.category]   - 事件分类（用于分类子采样）
   * @param {boolean} [ctx.priority=false] - 是否优先级事件（如 error）
   * @returns {SamplingDecision}
   */
  decide({ traceId, sessionId, category, priority = false } = {}) {
    const key = traceId != null ? String(traceId) : (sessionId != null ? String(sessionId) : 'global')
    const unit = traceId != null ? 'trace' : (sessionId != null ? 'session' : 'global')

    // 1) 优先级：被显式标记（如错误链路）或本身就是优先级事件 → 保留。
    if (this._priorityKeys.has(key) || priority) {
      // 若配置了 errorSampleRate，对错误仍做确定性子采样（单元级一致，便于约束体量）。
      if (this.errorSampleRate != null && !this._priorityKeys.has(key)) {
        const sampled = this._unit(key) < this.errorSampleRate
        return { sampled, rate: this.errorSampleRate, rule: 'error_rate', unit, key, category: category || 'error' }
      }
      return { sampled: true, rate: 1, rule: 'priority', unit, key, category: category || 'error' }
    }

    // 2) 远端采样权重（tail-based 预留）：按 trace/session 单元一致。
    const remote = this._parseRemoteWeight()
    if (remote !== null) {
      const sampled = this._unit(key) < remote
      return { sampled, rate: remote, rule: 'remote', unit, key }
    }

    // 3) 确定性 base 决策。
    const baseRate = unit === 'trace' ? this.traceRate : this.sampleRate

    // 分类子采样：仅收窄 session 级决策（绝不破坏 trace 一致性）。
    const catRate = category != null && this.categorySampleRates[category] != null
      ? this.categorySampleRates[category]
      : null
    if (catRate != null && unit !== 'trace') {
      const uSampled = this._unit(key) < baseRate
      const cSampled = this._unit(key, category) < catRate
      return {
        sampled: uSampled && cSampled,
        rate: baseRate,
        rule: 'session_category',
        unit,
        key,
        category,
        categoryRate: catRate
      }
    }

    const sampled = this._unit(key) < baseRate
    return {
      sampled,
      rate: baseRate,
      rule: unit === 'trace' ? 'trace' : 'session',
      unit,
      key,
      category
    }
  }

  /**
   * 便捷布尔决策（同 decide().sampled）。
   * @param {object} [ctx]
   * @returns {boolean}
   */
  shouldSample(ctx) {
    return this.decide(ctx).sampled
  }

  /**
   * 兼容旧 Sampler 接口：不传入 traceId 时按 global 单元决策（确定性）。
   * @param {string} [category]
   * @returns {'01' | '00'}
   */
  getTraceFlags(category) {
    const d = this.decide({ category })
    return d.sampled ? '01' : '00'
  }
}

/**
 * 创建确定性采样器实例。
 * @param {object} [options]
 * @returns {DeterministicSampler}
 */
export function createDeterministicSampler(options = {}) {
  return new DeterministicSampler(options)
}

export default DeterministicSampler
