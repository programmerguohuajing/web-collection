/**
 * D3 · 用量计量 & 套餐/定价（PRD 15）——管理面端点封装（Node 与 Worker 同路径同契约）。
 *
 * 所有封装走 authApi：自动注入 Bearer / x-team-id（accounts=false 部署下头为空，
 * 行为与裸 api 一致）。能力位未开启时后端返回 503（{ error: '...' }），由页面层显式提示，
 * 本层不做静默吞掉。
 *
 * 端点清单（对齐 outputs/d3-metering-architecture.md §4）：
 *   GET  /api/metering/usage         当前（或指定 YYYY-MM）周期用量 + 配额 + 百分比 + 超限标记
 *   GET  /api/metering/usage/daily   按日序列（MiniLineChart 数据源）
 *   GET  /api/metering/usage/by-app  按应用拆分（按 events 降序，Top 50）
 *   GET  /api/metering/plans         档位列表（含 quota / softLimitPct / hardAction）
 *   GET  /api/metering/plan          当前团队档位 + 生效配额（含 override 标记）+ 变更人/时间
 *   GET  /api/metering/quota-events  超限历史（按周期过滤）
 *   PUT  /api/metering/plan          变更档位或写 per-team 覆盖（降配额由前端二次确认）
 */
import { authApi } from '../composables/useAuth'

/** GET /api/metering/usage：当前（或指定 YYYY-MM）周期用量 + 配额 + 百分比 + 超限标记。 */
export function getUsage(period) {
  const search = period ? `?period=${encodeURIComponent(period)}` : ''
  return authApi(`/api/metering/usage${search}`)
}

/** GET /api/metering/usage/daily：按日序列（MiniLineChart 数据源）。 */
export function getDaily(params = {}) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
  }
  const qs = search.toString()
  return authApi(`/api/metering/usage/daily${qs ? `?${qs}` : ''}`)
}

/** GET /api/metering/usage/by-app：按应用拆分（按 events 降序，Top 50）。 */
export function getByApp(period) {
  const search = period ? `?period=${encodeURIComponent(period)}` : ''
  return authApi(`/api/metering/usage/by-app${search}`)
}

/** GET /api/metering/plans：档位列表（含 quota / softLimitPct / hardAction），用于对比表。 */
export function getPlans() {
  return authApi('/api/metering/plans')
}

/** GET /api/metering/plan：当前团队档位 + 生效配额（含 override 标记）+ 变更人/时间。 */
export function getCurrentPlan() {
  return authApi('/api/metering/plan')
}

/** GET /api/metering/quota-events：超限历史（按周期过滤）。 */
export function getQuotaEvents(period) {
  const search = period ? `?period=${encodeURIComponent(period)}` : ''
  return authApi(`/api/metering/quota-events${search}`)
}

/**
 * PUT /api/metering/plan：变更档位或写 per-team 覆盖（降配额由前端 ElMessageBox 二次确认）。
 * @param {{planCode?:string, quotaOverride?:object|null}} body
 */
export function putPlan(body = {}) {
  return authApi('/api/metering/plan', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

/**
 * 便捷封装：取当前（或指定）周期的席位维度。
 * 席位已包含在 getUsage 返回的 metrics 内（metric='seats'），本函数仅做语义抽取，避免重复请求。
 * @param {string} [period] 'YYYY-MM'
 */
export async function getSeats(period) {
  const usage = await getUsage(period)
  const seats = Array.isArray(usage?.metrics)
    ? usage.metrics.find(item => item.metric === 'seats')
    : null
  return seats || { metric: 'seats', used: null, quota: null, pct: null, level: 'ok', unlimited: true }
}
