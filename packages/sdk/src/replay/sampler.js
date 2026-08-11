/**
 * Replay 采样与分页工具（SDK-211 · Replay 增强）。
 *
 * 两项纯函数，便于单测与在 `src/index.js` 管线中复用：
 *   - `replayShouldKeep`：错误触发升采样下的事件取舍决策（确定性可注入 rng）。
 *   - `paginate`：将回放事件数组按页拆分，支撑「分页加载」（SDK-211 规模化能力）。
 */

/**
 * 判断一条回放增量事件是否保留。
 *
 * 逻辑：
 *   - errorBoosted（错误触发升采样）期间：全保留（rate 被提升到 1.0）。
 *   - rate >= 1：全保留（默认行为，无成本回归）。
 *   - rate <= 0：全丢弃。
 *   - 其余：以 rate 概率保留（用于常态下对高频回放事件降本）。
 *
 * @param {number} sampleRate - 常态采样率 [0,1]
 * @param {boolean} boosted - 是否处于错误升采样窗口
 * @param {Function} [rng=Math.random] - 随机数源（测试可注入确定性序列）
 * @returns {boolean}
 */
export function replayShouldKeep(sampleRate, boosted, rng = Math.random) {
  if (boosted) return true
  if (sampleRate >= 1) return true
  if (sampleRate <= 0) return false
  return rng() < sampleRate
}

/**
 * 将事件数组按 pageSize 拆分为多页（最后一页可能不足 pageSize）。
 * @param {object[]} events
 * @param {number} pageSize - 每页事件数（<=0 时按 1 处理）
 * @returns {object[][]}
 */
export function paginate(events, pageSize) {
  const size = Math.max(1, pageSize | 0)
  const pages = []
  for (let i = 0; i < events.length; i += size) {
    pages.push(events.slice(i, i + size))
  }
  return pages
}
