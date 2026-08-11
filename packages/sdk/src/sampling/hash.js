/**
 * @fileoverview 确定性哈希工具
 *
 * 用于「基于 traceId / sessionId 的确定性采样」：把任意字符串映射为一个
 * 稳定、均匀分布在 [0,1) 的浮点数。相同输入永远得到相同输出，因此同一
 * trace / session 内所有事件与 Span 会得到一致的采样决策，避免父子 Span
 * 或同会话事件被随机地一部分采一部分丢（路线图 U06 / SDK-208）。
 *
 * 选用 cyrb53：53-bit 非加密哈希，速度快、分布质量足够、无外部依赖，
 * 且在浏览器与 Node 行为一致（纯 JS 整数运算，不依赖 Math.random）。
 */

/**
 * cyrb53 哈希：返回非负 53-bit 整数（实际范围约 [0, 2^53)）。
 * @param {string} str - 待哈希字符串
 * @param {number} [seed=0] - 可选盐值，用于在同一字符串上派生不同序列
 * @returns {number}
 */
export function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/**
 * 将 53-bit 哈希折叠为 [0,1) 均匀分布浮点数（取低 32 位）。
 * @param {number} hash - cyrb53 输出
 * @returns {number} [0,1)
 */
export function foldUnit(hash) {
  return (hash >>> 0) / 4294967296
}

/**
 * 直接将字符串哈希并折叠为 [0,1) 单元值（确定性）。
 * @param {string} str
 * @param {number} [seed=0]
 * @returns {number} [0,1)
 */
export function hashUnit(str, seed = 0) {
  return foldUnit(cyrb53(String(str), seed))
}
