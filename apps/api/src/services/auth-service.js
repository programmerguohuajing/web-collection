/**
 * @file D2 认证服务：注册 / 登录 / 登出 / 刷新 / me（FR-1/2/3）
 * 口令 scrypt（packages/auth-crypto.js）；开放注册默认关闭（邀请制），
 * 空库首个注册视为「引导 Owner」（FR-3），自动创建默认团队并授予 owner/L4。
 */
import { all, first, run } from '../db.js'
import { hashPassword, verifyPassword, signJwt, randomToken, sha256Hex } from '../../../../packages/auth-crypto.js'
import { createSession, revokeSession, validateRefreshToken, revokeAllForUser } from './session-service.js'
import { badRequest, unauthorized, forbidden } from '../utils/http-error.js'

export const ACCESS_TTL_SEC = 2 * 60 * 60          // 访问令牌 ≤2h（PRD FR-2）
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const REFRESH_COOKIE = 'eys_rt'

/** 账号体系运行时开关（默认 false，存量零破坏；开启需 ACCOUNTS_ENABLED=1） */
export function isAccountsEnabled() {
  return process.env.ACCOUNTS_ENABLED === '1' || process.env.ACCOUNTS_ENABLED === 'true'
}

/** 严格鉴权开关：true 时未登录访问受控管理接口返回 401（默认 false，前端登录页就绪后再开） */
export function isAccountsEnforced() {
  return process.env.ACCOUNTS_ENFORCE === '1' || process.env.ACCOUNTS_ENFORCE === 'true'
}

/** 开放注册开关（默认关闭，邀请制 + 首个 Owner 引导，PRD D1） */
export function isOpenRegisterEnabled() {
  return process.env.ACCOUNTS_OPEN_REGISTER === '1' || process.env.ACCOUNTS_OPEN_REGISTER === 'true'
}

function jwtSecret() {
  const secret = process.env.ACCOUNTS_JWT_SECRET
  if (!secret) throw new Error('账号体系已开启但缺少 ACCOUNTS_JWT_SECRET 环境变量')
  return secret
}

/** 登录失败限流：5 次 / 15 分钟 / 邮箱+IP（FR-16），进程内实现（多实例部署建议外置） */
const loginAttempts = new Map()
function checkLoginRate(key) {
  const now = Date.now()
  const windowMs = 15 * 60 * 1000
  const entry = loginAttempts.get(key)
  if (!entry || now - entry.start > windowMs) { loginAttempts.set(key, { start: now, count: 1 }); return true }
  entry.count += 1
  return entry.count <= 5
}
function recordLoginFailure(key) { checkLoginRate(key) }

function normalizeEmail(email) {
  const value = String(email || '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw badRequest('邮箱格式不正确', 'BAD_REQUEST')
  return value.slice(0, 160)
}

function checkPasswordStrength(password) {
  const value = String(password || '')
  if (value.length < 8) throw badRequest('口令至少 8 位', 'BAD_REQUEST')
  if (!/[a-zA-Z]/.test(value) || !/[0-9]/.test(value)) throw badRequest('口令需同时包含字母与数字', 'BAD_REQUEST')
  return value
}

async function createUserWithDefaultTeam({ email, name, password }) {
  const userId = `u_${randomToken(9)}`
  const now = Date.now()
  await run(`insert into users (id, email, name, password_hash, status, created_at, updated_at)
    values (?, ?, ?, ?, 'active', ?, ?)`, [userId, email, name, hashPassword(password), now, now])
  // 首个用户创建默认团队（slug=default，PRD D6：存量应用迁入默认团队）
  let teamId = null
  const hasTeam = await first('select id from teams where slug = ?', ['default'])
  if (!hasTeam) {
    teamId = `t_${randomToken(9)}`
    await run(`insert into teams (id, name, slug, created_by, created_at, updated_at)
      values (?, ?, 'default', ?, ?, ?)`, [teamId, name || '默认团队', userId, now, now])
    await run(`insert into team_members (team_id, user_id, role, access_level, status, joined_at, created_at, updated_at)
      values (?, ?, 'owner', 'L4', 'active', ?, ?, ?)`, [teamId, userId, now, now, now])
    await writeTeamAudit({ teamId, actorUserId: userId, actorEmail: email, action: 'team_update', targetType: 'team', targetId: teamId, detail: { bootstrap: true } })
  } else {
    teamId = hasTeam.id
    await run(`insert into team_members (team_id, user_id, role, access_level, status, joined_at, created_at, updated_at)
      values (?, ?, 'member', 'L2', 'active', ?, ?, ?)`, [teamId, userId, now, now, now])
  }
  return { userId, teamId }
}

/**
 * 注册：空库首个注册 = 引导 Owner（恒允许）；其余需开放注册开关或邀请令牌。
 * @returns {{userId, teamId}}
 */
export async function register(input = {}) {
  const email = normalizeEmail(input.email)
  const password = checkPasswordStrength(input.password)
  const name = String(input.name || email.split('@')[0]).trim().slice(0, 64) || '用户'
  if (await first('select 1 as ok from users where email = ?', [email])) throw badRequest('该邮箱已注册', 'BAD_REQUEST')
  const userCount = await scalarUsers()
  const inviteToken = input.inviteToken ? String(input.inviteToken) : null
  if (userCount > 0 && !isOpenRegisterEnabled() && !inviteToken) {
    throw forbidden('开放注册已关闭，请使用邀请链接或联系管理员', 'FORBIDDEN')
  }
  const created = await createUserWithDefaultTeam({ email, name, password })
  if (inviteToken) await acceptInvitationForUser(inviteToken, created.userId, email)
  return created
}

/** 登录：返回 { accessToken, expiresIn, user }，并经 Set-Cookie 下发刷新令牌（由路由层写入） */
export async function login(input = {}, { ip, userAgent } = {}) {
  const email = normalizeEmail(input.email)
  const rateKey = `${email}:${ip || '-'}`
  if (!checkLoginRate(rateKey)) throw new Error('登录尝试过于频繁，请 15 分钟后再试')
  const user = await first('select * from users where email = ? and status = ?', [email, 'active'])
  if (!user || !verifyPassword(input.password, user.password_hash)) {
    recordLoginFailure(rateKey)
    throw unauthorized('邮箱或口令不正确', 'UNAUTHORIZED')
  }
  const now = Date.now()
  await run('update users set last_login_at = ?, updated_at = ? where id = ?', [now, now, user.id])
  const session = await createSession(user.id, { ip, userAgent })
  const accessToken = signJwt({ sub: user.id, sid: session.id }, jwtSecret(), ACCESS_TTL_SEC)
  // Finding-1：login 审计补用户默认团队 teamId，避免孤儿记录在任何团队审计中不可见（无团队保持 null）
  const membership = await first("select team_id from team_members where user_id = ? and status = 'active' order by created_at limit 1", [user.id])
  await writeTeamAudit({ teamId: membership?.team_id || null, actorUserId: user.id, actorEmail: user.email, action: 'login', targetType: 'user', targetId: user.id, ip, userAgent })
  return {
    accessToken, expiresIn: ACCESS_TTL_SEC, refreshToken: session.refreshToken,
    user: { id: user.id, email: user.email, name: user.name }
  }
}

/** 刷新访问令牌（校验会话未撤销，D8） */
export async function refresh(refreshToken, { ip, userAgent } = {}) {
  const session = await validateRefreshToken(refreshToken)
  if (!session) throw unauthorized('会话已失效，请重新登录', 'UNAUTHORIZED')
  const user = await first('select * from users where id = ? and status = ?', [session.user_id, 'active'])
  if (!user) throw unauthorized('账号不可用', 'UNAUTHORIZED')
  const accessToken = signJwt({ sub: user.id, sid: session.id }, jwtSecret(), ACCESS_TTL_SEC)
  return { accessToken, expiresIn: ACCESS_TTL_SEC }
}

/** 登出：撤销当前会话 */
export async function logout(sessionId) {
  if (sessionId) await revokeSession(sessionId)
  return { ok: true }
}

/** 修改口令：需旧口令确认；成功后撤销全部会话（FR-17） */
export async function changePassword(userId, input = {}) {
  const user = await first('select * from users where id = ?', [String(userId).slice(0, 32)])
  if (!user || !verifyPassword(input.oldPassword, user.password_hash)) throw unauthorized('旧口令不正确', 'UNAUTHORIZED')
  const next = checkPasswordStrength(input.newPassword)
  await run('update users set password_hash = ?, updated_at = ? where id = ?', [hashPassword(next), Date.now(), user.id])
  await revokeAllForUser(user.id)
  // Finding-1：改密审计同样补默认团队 teamId（凡 user 必有默认团队，register 时建/加入）
  const membership = await first("select team_id from team_members where user_id = ? and status = 'active' order by created_at limit 1", [user.id])
  await writeTeamAudit({ teamId: membership?.team_id || null, actorUserId: user.id, actorEmail: user.email, action: 'password_change', targetType: 'user', targetId: user.id })
  return { ok: true }
}

/** /api/me：用户 + 所属团队 + 角色/等级 */
export async function getMe(auth) {
  if (!auth?.userId) throw unauthorized('未登录', 'UNAUTHORIZED')
  const user = await first('select id, email, name, status, last_login_at from users where id = ?', [auth.userId])
  if (!user) throw unauthorized('账号不存在', 'UNAUTHORIZED')
  const teams = await all(`select t.id, t.name, t.slug, m.role, m.access_level, m.status
    from team_members m join teams t on t.id = m.team_id
    where m.user_id = ? and m.status = 'active' order by t.created_at`, [auth.userId])
  return {
    user: { id: user.id, email: user.email, name: user.name },
    teams: teams.map(row => ({ id: row.id, name: row.name, slug: row.slug, role: row.role, level: row.access_level })),
    currentTeamId: auth.teamId || teams[0]?.id || null,
    role: auth.role || null,
    level: auth.level || null
  }
}

/** 接受邀请（登录/注册后调用）：一次性 token、7 天过期、可撤销（FR-14） */
export async function acceptInvitationForUser(token, userId, email) {
  const invitation = await first('select * from invitations where token_hash = ?', [sha256Hex(token)])
  if (!invitation || invitation.revoked_at || invitation.accepted_at || Number(invitation.expires_at) < Date.now()) {
    throw badRequest('邀请无效或已过期', 'BAD_REQUEST')
  }
  if (String(invitation.email).toLowerCase() !== String(email).toLowerCase()) {
    throw badRequest('邀请与当前账号邮箱不一致', 'BAD_REQUEST')
  }
  const now = Date.now()
  const exists = await first('select 1 as ok from team_members where team_id = ? and user_id = ?', [invitation.team_id, userId])
  if (!exists) {
    await run(`insert into team_members (team_id, user_id, role, access_level, status, joined_at, created_at, updated_at)
      values (?, ?, ?, ?, 'active', ?, ?, ?)`, [invitation.team_id, userId, invitation.role, invitation.access_level, now, now, now])
  }
  await run('update invitations set accepted_at = ? where id = ?', [now, invitation.id])
  await writeTeamAudit({ teamId: invitation.team_id, actorUserId: userId, actorEmail: email, action: 'member_join', targetType: 'member', targetId: userId })
  return { teamId: invitation.team_id, role: invitation.role, level: invitation.access_level }
}

async function scalarUsers() {
  const rows = await all('select count(*) as count from users')
  return Number(rows[0]?.count || 0)
}

/** 团队审计写入（audit_logs；失败不阻塞业务） */
export async function writeTeamAudit({ teamId, actorUserId, actorEmail, action, targetType, targetId, detail, ip, userAgent }) {
  try {
    await run(`insert into audit_logs (team_id, actor_user_id, actor_email, action, target_type, target_id, detail_json, ip, user_agent, created_at)
      values (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?)`,
      [teamId || null, actorUserId || null, actorEmail || null, String(action).slice(0, 32),
        targetType || null, targetId ? String(targetId).slice(0, 64) : null,
        JSON.stringify(detail || {}), clip(ip), clip(userAgent), Date.now()])
  } catch { /* 审计失败不阻塞业务响应 */ }
}

function clip(value, max = 64) {
  const s = String(value || '')
  return s ? s.slice(0, max) : null
}
