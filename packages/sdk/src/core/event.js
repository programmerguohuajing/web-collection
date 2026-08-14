/**
 * 当前 SDK 版本号。
 * 构建时由 Vite `define` 注入真实版本（取自 package.json），确保运行时上报的
 * sdkVersion 与发包版本始终一致，杜绝手写常量漏改导致的版本失真。
 * 测试 / 直引 src（无 define 注入）时回退占位值，不影响逻辑。
 */
export const SDK_VERSION =
  typeof __SDK_VERSION__ !== 'undefined' ? __SDK_VERSION__ : '0.0.0-dev'

// Privacy v2：脱敏能力统一下沉到 sanitizer.js（single source of truth）。
// 这里 import 供本模块 sanitizeEvent 使用，并 re-export 以保持对既有调用方（platform/core.js、测试）的兼容。
import {
  DEFAULT_REDACT_KEYS,
  redactObject,
  redactText,
  createSanitizer
} from './sanitizer.js'

export {
  DEFAULT_REDACT_KEYS,
  redactObject,
  redactText,
  createSanitizer
}

/**
 * 判断事件来源：手动上报（manual）还是自动采集（auto）
 * 若事件已显式设置 source 字段则直接返回，否则根据 type 推断
 * @param {{ type: string, source?: string }} event
 * @returns {'manual' | 'auto'}
 */
export function eventSource(event) {
  if (event.source) return event.source
  // track 类型为用户主动调用，归为手动上报
  if (event.type === 'track') return 'manual'
  // behavior / perf / error / replay / log 均为 SDK 自动采集
  if (event.type === 'behavior' || event.type === 'perf' || event.type === 'error' || event.type === 'replay' || event.type === 'log') return 'auto'
  return 'manual'
}

/**
 * 将事件映射到采样分类（category），用于按类别独立控制采样率
 * - error  → error
 * - replay → replay
 * - behavior（含 exposure）→ exposure / behavior
 * - perf（网络请求类 metric）→ requests，其余指标 → performance
 * @param {{ type: string, name?: string, metric?: string }} event
 * @returns {string | undefined}
 */
export function eventCategory(event) {
  if (event.type === 'error') return 'error'
  if (event.type === 'replay') return 'replay'
  // exposure 是行为监控的子类型，单独拆分为独立分类以便精细控制采样
  if (event.type === 'behavior') return event.name === 'exposure' ? 'exposure' : 'behavior'
  if (event.type === 'perf') return ['fetch', 'xhr', 'websocket', 'sse', 'fetch_body', 'xhr_body'].includes(event.metric) ? 'requests' : 'performance'
  return undefined
}

/**
 * 根据分类和配置的采样率表，计算当前事件是否应被采样
 * - 优先使用按 category 配置的采样率，否则使用全局 fallback
 * - 结果被钳位在 [0, 1] 范围内，非数字回退为 1（全量采集）
 * @param {string} [category]
 * @param {Record<string, number>} [rates]
 * @param {number} [fallback=1]
 * @returns {number}
 */
export function sampleRateFor(category, rates = {}, fallback = 1) {
  const value = category && rates[category] != null ? Number(rates[category]) : Number(fallback)
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1
}

/**
 * 对事件整体做隐私清洗：props、context、breadcrumbs 及字符串 message 中的敏感字段全部脱敏。
 * 兼容旧调用 `sanitizeEvent(event, privacy)`：当传入 privacy 时按 Privacy v2 策略清洗
 * （默认 balanced：字段脱敏 + 值级 PII 文本脱敏 + 用户手机号不可逆 hash + URL query 敏感参数剥离）。
 * @param {object} event
 * @param {{ redactKeys?: string[] } | object} [privacy={}]
 * @returns {object} 脱敏后的事件副本
 */
export function sanitizeEvent(event, privacy = {}) {
  const sanitizer = createSanitizer(privacy)
  return sanitizer.sanitizeEvent(event)
}
