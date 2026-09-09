/**
 * 模板内共用的防御式取值工具。
 *
 * 后端不同数据源（rest / d1）与不同版本的返回字段可能存在缺失或类型抖动，
 * 模板一律通过这些helper取值并给定默认值，保证：
 * 1. 任何字段缺失都不会让模板抛异常（报告类模板宁可少一项，也不整体失败）；
 * 2. 不臆造字段——取不到的字段输出为 null/0，并在报告中体现为「无数据」。
 */

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** 取数值；不可解析时回落 fallback。 */
export function num(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(n) ? n : fallback
}

/** 取数值；不可解析时返回 null（用于「该项无数据」区别于 0）。 */
export function numOrNull(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(n) ? n : null
}

export function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

/** 统一从「分页结果」中取 items：支持 {items:[]} 与裸数组两种形态。 */
export function itemsOf(paged: unknown): unknown[] {
  if (Array.isArray(paged)) return paged
  const items = asRecord(paged).items
  return Array.isArray(items) ? items : []
}

/** 统一从「分页结果」中取 total。 */
export function totalOf(paged: unknown, fallback = 0): number {
  if (Array.isArray(paged)) return paged.length
  const total = numOrNull(asRecord(paged).total)
  return total === null ? fallback : total
}

/** 截断长文本，避免结论体过大（如 stack / message）冲击 MCP 返回体。 */
export function clip(value: string, max = 200): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}…`
}

/** 保留 2 位小数，避免浮点噪音。 */
export function round(value: number, digits = 2): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** 把时间戳格式化为 YYYY-MM-DD（UTC），用于报告标题/去重键。 */
export function formatDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}
