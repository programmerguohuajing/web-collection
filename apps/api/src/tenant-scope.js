import { first } from './db.js'
import { forbidden, notFound } from './utils/http-error.js'
import { isAccountsEnabled } from './services/auth-service.js'

export function teamIdForAuth(auth) {
  return isAccountsEnabled() && auth?.via === 'session' && auth.teamId
    ? String(auth.teamId).slice(0, 32)
    : ''
}

export function scopeFilters(filters = {}, auth) {
  const teamId = teamIdForAuth(auth)
  return teamId ? { ...filters, teamId } : { ...filters }
}

export async function assertAppAccess(auth, appId, { allowUnassigned = false } = {}) {
  const teamId = teamIdForAuth(auth)
  if (!teamId) return null
  const id = String(appId || '').trim().slice(0, 64)
  if (!id) throw forbidden('缺少应用标识', 'FORBIDDEN')
  const app = await first('select app_id, team_id from applications where app_id = ?', [id])
  if (!app) throw notFound('应用不存在', 'NOT_FOUND')
  if (!app.team_id && allowUnassigned) return app
  if (app.team_id !== teamId) throw forbidden('无权访问该应用（跨团队）', 'FORBIDDEN')
  return app
}
