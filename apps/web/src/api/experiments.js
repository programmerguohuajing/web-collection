/**
 * A3 · 实验分析（PRD 14）——管理面端点封装（六端点，Node 与 Worker 同路径同契约）。
 * 走 authApi：自动注入 Bearer / x-team-id（accounts=false 部署下头为空、行为与裸 api 一致）。
 */
import { authApi } from '../composables/useAuth'

/** GET /api/experiments：列表（appId 必填 + 分页 + 可选 status 过滤），含曝光数摘要。 */
export function listExperiments(params = {}) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
  }
  return authApi(`/api/experiments?${search}`)
}

/** GET /api/experiments/:id：详情（variants/goalMetric 已解析为对象）。 */
export function getExperiment(id) {
  return authApi(`/api/experiments/${encodeURIComponent(id)}`)
}

/** GET /api/experiments/:id/report：分析报告（变体指标对比 + 样本量提示 + 配置比 vs 实际比 + 按天序列）。 */
export function getExperimentReport(id) {
  return authApi(`/api/experiments/${encodeURIComponent(id)}/report`)
}

/** POST /api/experiments：创建（body 无 id）/更新（body 带 id，saveFunnel 风格 upsert）。 */
export function saveExperiment(body) {
  return authApi('/api/experiments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

/** POST /api/experiments/:id/status：状态迁移（draft→running→paused⇄running→completed→archived）。 */
export function changeExperimentStatus(id, status) {
  return authApi(`/api/experiments/${encodeURIComponent(id)}/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status })
  })
}

/** DELETE /api/experiments/:id：物理删除（仅 archived；级联删曝光）。 */
export function deleteExperiment(id) {
  return authApi(`/api/experiments/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
