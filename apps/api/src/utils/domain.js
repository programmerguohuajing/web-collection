/**
 * @file 领域工具函数
 * 提供错误指纹生成、百分位计算和性能评分等业务领域逻辑。
 */

import { createHash } from 'node:crypto'

/**
 * 生成错误事件的指纹（fingerprint）。
 * 基于 appId + name + message + stack（前 8 行）计算 SHA-1，取前 16 位。
 * 相同指纹的错误归为同一个 issue。
 *
 * @param {object} event - 错误事件
 * @returns {string} 16 位十六进制指纹
 */
export function fingerprint(event) {
  return createHash('sha1')
    .update([event.appId, event.name, event.message, trimStack(event.stack)].filter(Boolean).join('|'))
    .digest('hex')
    .slice(0, 16)
}

/**
 * 计算数组的百分位数。
 * @param {number[]} values - 数值数组
 * @param {number} p - 百分位（0~100）
 * @returns {number|null} 对应百分位的值
 */
export function percentile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil((p / 100) * sorted.length) - 1]
}

/**
 * 计算 Web Vitals 性能评分。
 * 对 FCP、LCP、INP、CLS、TTFB 五项指标分别按 good/poor 阈值打分，
 * 加权汇总后映射为 A~F 等级。
 *
 * @param {object} perf - 性能指标对象
 * @returns {{ score: number, grade: string, details: object }} 评分结果
 */
export function scorePerf(perf) {
  const checks = [
    ['fcp', 1800, 3000, 10],
    ['lcp', 2500, 4000, 25],
    ['inp', 200, 500, 25],
    ['cls', 0.1, 0.25, 25],
    ['ttfb', 800, 1800, 15]
  ]
  let score = 0
  const details = {}
  for (const [name, good, poor, weight] of checks) {
    const value = perf[name]
    if (value == null) continue
    details[name] = value <= good ? 'good' : value <= poor ? 'needs-improvement' : 'poor'
    score += details[name] === 'good' ? weight : details[name] === 'needs-improvement' ? weight / 2 : 0
  }
  return { score: Math.round(score), grade: score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 50 ? 'C' : score >= 25 ? 'D' : 'F', details }
}

/** 截取堆栈前 8 行，用于指纹计算时统一格式 */
function trimStack(stack = '') {
  return String(stack).split('\n').slice(0, 8).join('\n')
}
