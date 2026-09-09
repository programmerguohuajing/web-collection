/**
 * @file D2 会话服务（服务端可撤销，PRD D8）
 * sessions 表：不透明刷新令牌只存 sha256 哈希；撤销 = revoked_at 置值。
 * 访问 JWT（≤2h）携带 sid，resolveAuth 校验会话未撤销/未过期 → 登出即刻生效。
 */
import { all, first, run } from '../db.js'
import { randomToken, sha256Hex } from '../../../../packages/auth-crypto.js'

/** 会话默认有效期 7 天（刷新令牌） */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** 创建会话：返回 { id, refreshToken }（refreshToken 仅此一次可见，库内存哈希） */
export async function createSession(userId, { ip, userAgent, ttlMs = SESSION_TTL_MS } = {}) {
  const id = randomToken(12)
  const refreshToken = randomToken(32)
  const now = Date.now()
  await run(`insert into sessions (id, user_id, token_hash, expires_at, ip, user_agent, created_at)
    values (?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, sha256Hex(refreshToken), now + ttlMs, clip(ip, 64), clip(userAgent, 255), now])
  return { id, refreshToken, expiresAt: now + ttlMs }
}

/** 按会话 id 取有效会话（已撤销/过期 → null） */
export async function getActiveSession(id) {
  if (!id) return null
  const row = await first('select * from sessions where id = ?', [String(id).slice(0, 32)])
  if (!row || row.revoked_at || Number(row.expires_at) < Date.now()) return null
  return row
}

/** 校验不透明令牌是否对应有效会话（刷新流程用） */
export async function validateRefreshToken(refreshToken) {
  if (!refreshToken) return null
  const row = await first('select * from sessions where token_hash = ?', [sha256Hex(refreshToken)])
  if (!row || row.revoked_at || Number(row.expires_at) < Date.now()) return null
  return row
}

/** 撤销单个会话（登出） */
export async function revokeSession(id) {
  await run('update sessions set revoked_at = ? where id = ? and revoked_at is null', [Date.now(), String(id).slice(0, 32)])
}

/** 撤销某用户全部会话（改密 / 踢下线全部） */
export async function revokeAllForUser(userId) {
  await run('update sessions set revoked_at = ? where user_id = ? and revoked_at is null', [Date.now(), String(userId).slice(0, 32)])
}

/** 会话列表（「踢下线」管理视图，FR-16） */
export async function listSessions(userId) {
  const rows = await all(`select id, ip, user_agent, expires_at, revoked_at, created_at
    from sessions where user_id = ? order by created_at desc limit 50`, [String(userId).slice(0, 32)])
  return rows.map(row => ({
    id: row.id,
    ip: row.ip || '',
    userAgent: row.user_agent || '',
    expiresAt: Number(row.expires_at),
    revokedAt: row.revoked_at ? Number(row.revoked_at) : null,
    createdAt: Number(row.created_at)
  }))
}

/** 清理过期会话（保留 ≤30 天，PRD §4.1 保留期） */
export async function cleanupSessions() {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
  return run('delete from sessions where expires_at < ?', [cutoff])
}

function clip(value, max) {
  const s = String(value || '')
  return s ? s.slice(0, max) : null
}
