/**
 * 安全解析 JSON 字符串。
 * 输入为 null/undefined 时原样返回，输入为对象时直接返回，
 * 字符串解析失败时返回 null 而不抛出异常。
 *
 * @param {*} value - 待解析的值
 * @returns {*} 解析后的对象或原始值
 */
export function parseJson(value) {
  if (value == null) return value
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
