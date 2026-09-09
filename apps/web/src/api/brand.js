/**
 * D4 · 白标（PRD 16）—— 品牌配置端点封装。
 * 走 authApi：自动注入 Bearer / x-team-id（accounts=false 部署下头为空、行为与裸 api 一致）。
 * GET /api/brand 后端为公开端点（登录页未登录也要白标），authApi 仍可正常调用。
 */
import { authApi } from '../composables/useAuth'

/** GET /api/brand：归一化后的品牌对象（含 updatedBy / updatedAt）。 */
export function getBrand() {
  return authApi('/api/brand')
}

/** PUT /api/brand：保存品牌配置（brandManage 权限 + whiteLabel 能力位由后端把关）。 */
export function saveBrand(brand) {
  return authApi('/api/brand', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(brand || {})
  })
}

/** POST /api/brand/reset：清除 brand 块，回落到 env/内置默认。 */
export function resetBrand() {
  return authApi('/api/brand/reset', { method: 'POST' })
}
