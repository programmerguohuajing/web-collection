/**
 * 回放列表深链工具（Next Horizon B4：分析 → 回放）。
 *
 * 仅使用回放查询 API 真实支持的过滤参数：path / userId / userName
 * （Node 端 replays-repo.replayWhere 与 Worker 端 replayFilters 均已支持）。
 * 时间范围沿用全局筛选 store.range，由 queryFromFilters 自动带上，
 * 因此这里不传 startTime / endTime，避免臆造参数。
 */

/**
 * 构造「带过滤条件打开回放列表」的路由 query。
 * 跳转后由 Layout 的 applyRoutePrefill 写入全局 filters，回放列表即按这些条件过滤。
 *
 * @param {object} source - 数据来源对象，识别 url / path / userId / userName 字段
 * @returns {object} 路由 query（仅包含有值的真实过滤参数）
 */
export function buildReplayQuery(source = {}) {
  // 防御显式传入 null/undefined：默认参数只在 undefined 时生效。
  const input = source || {}
  const query = {}
  const path = input.url || input.path
  if (path) query.path = path
  if (input.userId) query.userId = input.userId
  if (input.userName) query.userName = input.userName
  return query
}

/**
 * 跳转到回放列表并应用过滤条件。
 *
 * @param {import('vue-router').Router} router - vue-router 实例
 * @param {object} source - 同 buildReplayQuery
 */
export function openReplays(router, source = {}) {
  router.push({ path: '/replays', query: buildReplayQuery(source) })
}
