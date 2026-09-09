/**
 * @file A3 实验分析——一致性分桶纯函数（PRD 14 §6.2）
 *
 * SDK（packages/sdk）/ Node API（apps/api）/ Cloudflare Worker（cloudflare/worker.js）
 * 三端共享同一实现，零依赖（FNV-1a 32bit 自实现，避免引入 fnv-plus 之类微依赖）。
 *
 * 分桶算法（双栈与 SDK 三端一致）：
 *   bucket = fnv1a32(`${salt}:${key}:${bucketingId}`) % 10000   // 0..9999
 *   variants 按 weight 降序（control 优先）累积：
 *     cum += weight / totalWeight * trafficPct（换算为桶单位 ×100）
 *   bucket < cum → 命中该变体；bucket ≥ trafficPct*100 → 未入组（variant=null）
 *
 * 失效安全：任何非法入参都返回 { variant: null, bucket: 0 }，调用方按「不参与实验」处理。
 */

/** FNV-1a 32 位偏移基值（offset basis） */
const FNV_OFFSET = 0x811c9dc5
/** FNV-1a 32 位素数（prime） */
const FNV_PRIME = 0x01000193

/**
 * FNV-1a 32bit 哈希（自实现，零依赖；SDK / Node / Worker 三端逐字节一致）。
 * 使用 Math.imul 保证 32 位乘法语义，>>>0 保持无符号位模式。
 * @param {string} str - 待哈希字符串
 * @returns {number} uint32 哈希值
 */
export function fnv1a32(str) {
  let hash = FNV_OFFSET
  const text = String(str ?? '')
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, FNV_PRIME) >>> 0
  }
  return hash >>> 0
}

/**
 * 规范化变体列表：合法项过滤 + 权重取整钳位 + 排序（weight 降序，control 优先）。
 * 排序保证三端在相同输入下累积顺序一致（分桶结果可复现）。
 * @param {Array<{name: string, weight: number}>} variants
 * @returns {Array<{name: string, weight: number}>}
 */
function normalizeVariants(variants) {
  if (!Array.isArray(variants)) return []
  return variants
    .map(item => ({
      name: String(item?.name || '').trim().slice(0, 32),
      weight: Math.max(0, Math.floor(Number(item?.weight) || 0))
    }))
    .filter(item => item.name)
    .sort((a, b) => (b.weight - a.weight) || (a.name === 'control' ? -1 : b.name === 'control' ? 1 : 0))
}

/**
 * 一致性分桶：给定实验定义与分桶 ID，返回稳定命中的变体。
 * 同一 visitor 任意次调用结果一致；权重或 trafficPct 变更视为实验修改（cohort 不漂移由服务端状态机保证）。
 *
 * @param {object} input
 * @param {string} input.salt - 分桶盐（防 key 可预测）
 * @param {string} input.key - 实验 key（^[a-z0-9_-]{2,64}$）
 * @param {number} input.trafficPct - 0-100，参与实验的流量占比
 * @param {Array<{name: string, weight: number}>} input.variants - 变体列表（必含 control）
 * @param {string} input.bucketingId - 分桶 ID（anonymousId，降级 sessionId）
 * @returns {{variant: string|null, bucket: number}} variant 为 null 表示未入组（不参与实验）
 */
export function assignVariant({ salt, key, trafficPct, variants, bucketingId }) {
  const sorted = normalizeVariants(variants)
  const traffic = Math.max(0, Math.min(100, Math.floor(Number(trafficPct) || 0)))
  if (!salt || !key || !bucketingId || !sorted.length || traffic <= 0) {
    return { variant: null, bucket: 0 }
  }
  const bucket = fnv1a32(`${salt}:${key}:${bucketingId}`) % 10000
  if (bucket >= traffic * 100) return { variant: null, bucket }
  const totalWeight = sorted.reduce((sum, item) => sum + item.weight, 0)
  if (totalWeight <= 0) return { variant: null, bucket }
  let cum = 0
  for (const item of sorted) {
    cum += (item.weight / totalWeight) * traffic * 100
    if (bucket < cum) return { variant: item.name, bucket }
  }
  return { variant: null, bucket }
}
