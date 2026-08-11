/**
 * 重试与退避策略（Reliable Transport v2）。
 *
 * 设计要点：
 * - 指数退避 + 等抖动（equal jitter），避免多客户端「重试风暴」同步。
 * - 识别可重试状态码（408/425/429/5xx）与不可重试的 4xx 契约错误。
 * - 遵守 `Retry-After`（秒或 HTTP-date）。
 */

/**
 * 计算第 `attempt` 次失败后的重试延迟（毫秒）。
 * @param {number} attempt - 已失败次数（从 0 开始）
 * @param {object} [opts]
 * @param {number} [opts.base=500] - 基础延迟（ms）
 * @param {number} [opts.max=30000] - 最大延迟上限（ms）
 * @param {number} [opts.factor=2] - 指数底数
 * @param {number} [opts.jitter=0.5] - 抖动系数（0~1），0 表示固定延迟，1 表示完全抖动
 * @param {() => number} [opts.rng=Math.random] - 可注入随机数，便于测试
 * @returns {number} 延迟毫秒（整数）
 */
export function computeBackoff(attempt, opts = {}) {
  const { base = 500, max = 30000, factor = 2, jitter = 0.5, rng = Math.random } = opts
  const exp = Math.min(max, base * Math.pow(factor, Math.max(0, attempt)))
  // 等抖动：[exp*(1-jitter), exp]
  const low = exp * (1 - Math.min(1, Math.max(0, jitter)))
  const span = exp - low
  return Math.round(low + span * rng())
}

/**
 * 解析 `Retry-After` 头，返回毫秒延迟。
 * 支持「秒数」与「HTTP-date」两种格式；非法值回退到 fallback。
 * @param {string|number|null} headerValue
 * @param {number} [fallback=0] - 解析失败时的回退值（ms）
 * @returns {number} 毫秒
 */
export function parseRetryAfter(headerValue, fallback = 0) {
  if (headerValue == null) return fallback
  const s = String(headerValue).trim()
  if (!s) return fallback
  const sec = Number(s)
  if (!Number.isNaN(sec) && sec >= 0) return Math.max(0, Math.min(86400000, Math.round(sec * 1000)))
  const date = Date.parse(s)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return fallback
}

/**
 * 根据 HTTP 状态码与服务端响应头对发送结果分类。
 * @param {number} status - HTTP 状态码（0 表示网络层失败，由调用方单独处理）
 * @param {object} [headers] - 响应头（用于未来扩展，如带 Retry-After 的 429）
 * @returns {'success'|'retry'|'drop'}
 *   - success：2xx，已成功入库，移除队列。
 *   - retry：408/425/429/5xx，可重试，保留并按退避重试。
 *   - drop：其余 4xx 契约错误，不可重试，永久丢弃。
 */
export function classifyResponse(status, _headers = {}) {
  const code = Number(status)
  if (code >= 200 && code < 300) return 'success'
  if (code === 429) return 'retry'
  if (code === 408 || code === 425) return 'retry'
  if (code >= 500 && code < 600) return 'retry'
  // 其余 4xx（含 400/401/403/404/413 等）均为契约错误，不可重试。
  return 'drop'
}
