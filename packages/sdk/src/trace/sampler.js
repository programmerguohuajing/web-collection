/**
 * @fileoverview Sampler - 链路追踪采样决策
 *
 * 实现 head-based sampling（在请求入口处做采样决策），
 * 决策结果体现在 traceFlags 中：
 * - '01': sampled（采集此链路）
 * - '00': not sampled（不采集）
 *
 * 支持：
 * - 全局 sampleRate 配置
 * - 基于 category 的分类采样率
 * - 从 traceState 读取远端采样权重（tail sampling 预留）
 */

/**
 * 采样器类
 */
export class Sampler {
  /**
   * @param {object} options
   * @param {number} [options.sampleRate=1] - 全局采样率（0-1）
   * @param {object} [options.categorySampleRates={}] - 分类采样率 { error: 0.1, perf: 1 }
   * @param {string} [options.traceState] - 从远端传入的 traceState（如 'sampling_priority=1'）
   */
  constructor({ sampleRate = 1, categorySampleRates = {}, traceState = '' } = {}) {
    this.sampleRate = sampleRate
    this.categorySampleRates = categorySampleRates
    this.traceState = traceState
  }

  /**
   * 获取分类采样率
   * @param {string} [category]
   * @returns {number}
   */
  _getCategoryRate(category) {
    if (category && this.categorySampleRates[category] != null) {
      return Number(this.categorySampleRates[category])
    }
    return this.sampleRate
  }

  /**
   * 从 traceState 解析远端采样权重
   * 格式：'sampling_weight=0.5' 或 'tracestate-client=foo,sampling_priority=1'
   * @returns {number|null}
   */
  _parseRemoteWeight() {
    if (!this.traceState) return null
    // 匹配 sampling_weight=X 格式
    const match = this.traceState.match(/sampling_weight=(\d+\.?\d*)/)
    if (match) {
      const weight = parseFloat(match[1])
      if (weight >= 0 && weight <= 1) return weight
    }
    return null
  }

  /**
   * 决策是否采样
   * @param {string} [category] - 事件分类
   * @returns {boolean}
   */
  shouldSample(category) {
    // 1. 优先使用远端采样权重
    const remoteWeight = this._parseRemoteWeight()
    if (remoteWeight !== null) {
      return Math.random() < remoteWeight
    }
    // 2. 使用本地分类采样率
    const rate = this._getCategoryRate(category)
    return Math.random() < rate
  }

  /**
   * 获取 traceFlags
   * @param {string} [category]
   * @returns {string} '01' = sampled, '00' = not sampled
   */
  getTraceFlags(category) {
    return this.shouldSample(category) ? '01' : '00'
  }

  /**
   * 创建新的 Sampler 实例（支持链式调用更新配置）
   * @param {object} options
   * @returns {Sampler}
   */
  with(options) {
    return new Sampler({
      sampleRate: options.sampleRate ?? this.sampleRate,
      categorySampleRates: options.categorySampleRates ?? this.categorySampleRates,
      traceState: options.traceState ?? this.traceState
    })
  }
}

/**
 * 创建采样器实例
 * @param {object} options
 * @returns {Sampler}
 */
export function createSampler(options = {}) {
  return new Sampler(options)
}

/**
 * 决策函数：给定采样率，返回是否采样
 * @param {number} [rate=1]
 * @returns {boolean}
 */
export function isSampled(rate = 1) {
  return Math.random() < rate
}

export default Sampler