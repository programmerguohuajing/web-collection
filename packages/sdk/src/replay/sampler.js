/**
 * Replay 采样与分页工具（SDK-211 · Replay 增强）。
 *
 * 两项纯函数，便于单测与在 `src/index.js` 管线中复用：
 *   - `replayShouldKeep`：错误触发升采样下的事件取舍决策（确定性可注入 rng）。
 *   - `paginate`：将回放事件数组按页拆分，支撑「分页加载」（SDK-211 规模化能力）。
 */

/**
 * rr-web 增量事件（type=3）的 source 枚举（与 rrweb 官方一致）：
 *   0 Mutation（DOM 变更） 1 MouseMove 2 MouseInteraction（点击）
 *   3 Scroll 4 ViewportResize 5 Input 6 TouchMove 7 MediaInteraction
 *   8 StyleSheetRule 9 CanvasMutation 10 Font 11 Log 12 Drag
 *
 * 仅高频且不改变页面状态的事件可参与采样：鼠标移动、触摸移动、控制台日志。
 * 其余（DOM 变更、点击、滚动、输入、样式规则等）一旦丢弃，回放就无法重建
 * 页面状态——表现为只有全量快照、画面静止/空白（2026-10-14 线上事故：
 * 服务端 replay:0.05 均匀采样丢掉 95% 增量事件，所有回放只剩快照）。
 */
export const REPLAY_SAMPLABLE_SOURCES = new Set([1, 6, 11])

/**
 * 判断一条回放事件是否可参与采样丢弃。
 * type=2（全量快照）、type=4（Meta）、type=5（自定义）、type=6（插件）永不参与；
 * type=3 中仅高频非状态事件（MouseMove/TouchMove/Log）可参与。
 * @param {object} event - rr-web 事件
 * @returns {boolean}
 */
export function isReplayEventSamplable(event) {
  if (!event || event.type !== 3) return false
  return REPLAY_SAMPLABLE_SOURCES.has(Number(event?.data?.source))
}

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
