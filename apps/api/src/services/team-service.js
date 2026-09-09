/**
 * @file D2 团队服务：团队 CRUD、成员管理、邀请、应用归属、审计（FR-4/5/7/14/15）
 * 不变量统一走 packages/rbac.js：不得授予高于自身角色/等级；团队须保留 ≥1 active Owner。
 */
import { all, first, run } from '../db.js'
import { randomToken, sha256Hex } from '../../../../packages/auth-crypto.js'
import { checkRoleChange, checkLevelChange, hasPermission, isRole, defaultLevelForRole, ROLES } from '../../../../packages/rbac.js'
import { writeTeamAudit, acceptInvitationForUser, INVITE_TTL_MS } from './auth-service.js'
import { badRequest, forbidden, notFound } from '../utils/http-error.js'

/** 创建团队（创建者自动 Owner/派生等级） */
export async function createTeam(auth, input = {}) {
  requireAuth(auth)
  const name = String(input.name || '').trim().slice(0, 64)
  if (!name) throw badRequest('团队名称不能为空', 'BAD_REQUEST')
  const slug = slugify(input.slug || name)
  if (await first('select 1 as ok from teams where slug = ?', [slug])) throw badRequest('slug 已存在', 'BAD_REQUEST')
  const now = Date.now()
  const teamId = `t_${randomToken(9)}`
  await run(`insert into teams (id, name, slug, created_by, created_at, updated_at) values (?, ?, ?, ?, ?, ?)`,
    [teamId, name, slug, auth.userId, now, now])
  const level = defaultLevelForRole('owner')
  await run(`insert into team_members (team_id, user_id, role, access_level, status, joined_at, created_at, updated_at)
    values (?, ?, 'owner', ?, 'active', ?, ?, ?)`, [teamId, auth.userId, level, now, now, now])
  await writeTeamAudit({ teamId, actorUserId: auth.userId, actorEmail: auth.email, action: 'team_update', targetType: 'team', targetId: teamId, detail: { name, slug } })
  return { id: teamId, name, slug, role: 'owner', level }
}

export async function getTeam(auth, teamId) {
  const member = await requireTeamMember(auth, teamId)
  const team = await first('select id, name, slug, created_by, created_at, updated_at from teams where id = ?', [teamId])
  if (!team) throw notFound('团队不存在', 'NOT_FOUND')
  return { ...team, role: member.role, level: member.access_level }
}

export async function updateTeam(auth, teamId, input = {}) {
  const member = await requireTeamMember(auth, teamId)
  if (!hasPermission(member.role, 'manageTeam')) throw forbidden('仅 Owner 可修改团队设置', 'FORBIDDEN')
  const name = String(input.name || '').trim().slice(0, 64)
  if (!name) throw badRequest('团队名称不能为空', 'BAD_REQUEST')
  const slug = slugify(input.slug || name)
  const conflict = await first('select id from teams where slug = ? and id != ?', [slug, teamId])
  if (conflict) throw badRequest('slug 已存在', 'BAD_REQUEST')
  await run('update teams set name = ?, slug = ?, updated_at = ? where id = ?', [name, slug, Date.now(), teamId])
  await writeTeamAudit({ teamId, actorUserId: auth.userId, actorEmail: auth.email, action: 'team_update', targetType: 'team', targetId: teamId, detail: { name, slug } })
  return { ok: true }
}

/** 成员列表（含邀请中占位行，FR-18/P1） */
export async function listTeamMembers(auth, teamId) {
  await requireTeamMember(auth, teamId)
  const rows = await all(`select m.user_id, m.role, m.access_level, m.status, m.joined_at,
      u.email, u.name, u.last_login_at, u.status as user_status
    from team_members m left join users u on u.id = m.user_id
    where m.team_id = ? order by m.created_at`, [teamId])
  return rows.map(row => ({
    userId: row.user_id,
    email: row.email || null,
    name: row.name || (row.email ? row.email.split('@')[0] : '待认领'),
    role: row.role,
    level: row.access_level,
    status: row.status,
    lastActiveAt: row.last_login_at ? Number(row.last_login_at) : null,
    joinedAt: row.joined_at ? Number(row.joined_at) : null
  }))
}

/** 变更角色（Admin+；不可改 Owner；不高于自身；末位 Owner 保护） */
export async function changeMemberRole(auth, teamId, targetUserId, input = {}) {
  const actor = await requireTeamMember(auth, teamId)
  const target = await getMemberRow(teamId, targetUserId)
  const nextRole = String(input.role || '')
  const check = checkRoleChange(actor.role, target.role, nextRole)
  if (!check.ok) throw forbidden(check.reason, 'FORBIDDEN')
  await run('update team_members set role = ?, access_level = ?, updated_at = ? where team_id = ? and user_id = ?',
    [nextRole, defaultLevelForRole(nextRole), Date.now(), teamId, targetUserId])
  await writeTeamAudit({ teamId, actorUserId: auth.userId, actorEmail: auth.email, action: 'role_change', targetType: 'member', targetId: targetUserId, detail: { from: target.role, to: nextRole } })
  return { ok: true, role: nextRole, level: defaultLevelForRole(nextRole) }
}

/** 变更数据等级（Admin+ 且 ≤ 自身；写审计，FR-8/FR-15） */
export async function changeMemberLevel(auth, teamId, targetUserId, input = {}) {
  const actor = await requireTeamMember(auth, teamId)
  const target = await getMemberRow(teamId, targetUserId)
  const nextLevel = String(input.level || '')
  const check = checkLevelChange(actor.role, actor.access_level, nextLevel)
  if (!check.ok) throw forbidden(check.reason, 'FORBIDDEN')
  await run('update team_members set access_level = ?, updated_at = ? where team_id = ? and user_id = ?',
    [nextLevel, Date.now(), teamId, targetUserId])
  await writeTeamAudit({ teamId, actorUserId: auth.userId, actorEmail: auth.email, action: 'level_change', targetType: 'member', targetId: targetUserId, detail: { from: target.access_level, to: nextLevel } })
  return { ok: true, level: nextLevel }
}

/** 移除成员（Admin+；末位 active Owner 不可移除，FR-5） */
export async function removeMember(auth, teamId, targetUserId) {
  const actor = await requireTeamMember(auth, teamId)
  if (!hasPermission(actor.role, 'manageMembers')) throw forbidden('需要 Admin 及以上角色', 'FORBIDDEN')
  const target = await getMemberRow(teamId, targetUserId)
  if (target.role === 'owner') {
    const owners = await countActiveOwners(teamId)
    if (owners <= 1) throw forbidden('团队须保留至少 1 个 Owner（先转让后再移除）', 'FORBIDDEN')
  }
  await run('delete from team_members where team_id = ? and user_id = ?', [teamId, targetUserId])
  await writeTeamAudit({ teamId, actorUserId: auth.userId, actorEmail: auth.email, action: 'member_remove', targetType: 'member', targetId: targetUserId, detail: { email: target.email } })
  return { ok: true }
}

/** 创建邀请：一次性 token（库内只存哈希）、7 天过期（FR-14），返回一次性明文链接 token */
export async function createInvitation(auth, teamId, input = {}) {
  const actor = await requireTeamMember(auth, teamId)
  if (!hasPermission(actor.role, 'manageMembers')) throw forbidden('需要 Admin 及以上角色', 'FORBIDDEN')
  const email = String(input.email || '').trim().toLowerCase().slice(0, 160)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('邮箱格式不正确', 'BAD_REQUEST')
  const role = isRole(input.role) ? input.role : 'member'
  const level = String(input.accessLevel || defaultLevelForRole(role))
  const check = checkLevelChange(actor.role, actor.access_level, level)
  if (!check.ok) throw forbidden(`邀请等级越权：${check.reason}`, 'FORBIDDEN')
  const token = randomToken(24)
  const now = Date.now()
  const id = `i_${randomToken(9)}`
  await run(`insert into invitations (id, team_id, email, role, access_level, token_hash, expires_at, invited_by, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, teamId, email, role, level, sha256Hex(token), now + INVITE_TTL_MS, auth.userId, now])
  await writeTeamAudit({ teamId, actorUserId: auth.userId, actorEmail: auth.email, action: 'member_invite', targetType: 'invitation', targetId: id, detail: { email, role, level } })
  return { id, email, role, level, token, expiresAt: now + INVITE_TTL_MS }
}

export async function listInvitations(auth, teamId) {
  const actor = await requireTeamMember(auth, teamId)
  if (!hasPermission(actor.role, 'manageMembers')) throw forbidden('需要 Admin 及以上角色', 'FORBIDDEN')
  const rows = await all(`select id, email, role, access_level, expires_at, accepted_at, revoked_at, created_at
    from invitations where team_id = ? order by created_at desc limit 100`, [teamId])
  return rows.map(row => ({
    id: row.id, email: row.email, role: row.role, level: row.access_level,
    expiresAt: Number(row.expires_at), acceptedAt: row.accepted_at ? Number(row.accepted_at) : null,
    revokedAt: row.revoked_at ? Number(row.revoked_at) : null, createdAt: Number(row.created_at)
  }))
}

/** 撤销邀请 */
export async function revokeInvitation(auth, teamId, invitationId) {
  const actor = await requireTeamMember(auth, teamId)
  if (!hasPermission(actor.role, 'manageMembers')) throw forbidden('需要 Admin 及以上角色', 'FORBIDDEN')
  const row = await first('select * from invitations where id = ? and team_id = ?', [String(invitationId).slice(0, 32), teamId])
  if (!row) throw notFound('邀请不存在', 'NOT_FOUND')
  await run('update invitations set revoked_at = ? where id = ?', [Date.now(), row.id])
  await writeTeamAudit({ teamId, actorUserId: auth.userId, actorEmail: auth.email, action: 'member_invite', targetType: 'invitation', targetId: row.id, detail: { revoked: true, email: row.email } })
  return { ok: true }
}

/** 应用归属：把 appId 归入/移动到团队（Admin+；SDK 写入侧零改动，FR-7） */
export async function assignApplication(auth, teamId, input = {}) {
  const actor = await requireTeamMember(auth, teamId)
  if (!hasPermission(actor.role, 'manageApplications')) throw forbidden('需要 Admin 及以上角色', 'FORBIDDEN')
  const appId = String(input.appId || '').trim().slice(0, 64)
  if (!appId) throw badRequest('appId 不能为空', 'BAD_REQUEST')
  const app = await first('select app_id, team_id from applications where app_id = ?', [appId])
  if (!app) throw notFound('应用不存在', 'NOT_FOUND')
  await run('update applications set team_id = ? where app_id = ?', [teamId, appId])
  await writeTeamAudit({ teamId, actorUserId: auth.userId, actorEmail: auth.email, action: 'app_move', targetType: 'application', targetId: appId, detail: { from: app.team_id || null, to: teamId } })
  return { ok: true, appId, teamId }
}

/** 团队审计查询（Admin+，仅本团队，FR-15） */
export async function listTeamAudit(auth, teamId) {
  const actor = await requireTeamMember(auth, teamId)
  if (!hasPermission(actor.role, 'viewAudit')) throw forbidden('需要 Admin 及以上角色', 'FORBIDDEN')
  const rows = await all(`select id, actor_user_id, actor_email, action, target_type, target_id, detail_json, ip, created_at
    from audit_logs where team_id = ? order by created_at desc limit 200`, [teamId])
  return rows.map(row => ({
    id: Number(row.id), actorUserId: row.actor_user_id, actorEmail: row.actor_email,
    action: row.action, targetType: row.target_type, targetId: row.target_id,
    detail: safeParse(row.detail_json), ip: row.ip || '', createdAt: Number(row.created_at)
  }))
}

/** 一次性迁移脚本入口：members 登记项 → 默认团队（无邮箱标「待认领」，不自动生成账号） */
export async function migrateMembersToDefaultTeam() {
  const team = await first('select id from teams where slug = ?', ['default'])
  if (!team) return { ok: false, reason: '默认团队尚未创建（首个 Owner 注册后自动建立）' }
  const members = await all('select * from members').catch(() => [])
  let moved = 0
  for (const member of members) {
    const exists = await first('select 1 as ok from team_members where team_id = ? and user_id = ?', [team.id, member.id])
    if (exists) continue
    const now = Date.now()
    await run(`insert into team_members (team_id, user_id, role, access_level, status, joined_at, created_at, updated_at)
      values (?, ?, ?, ?, 'active', ?, ?, ?)`,
      [team.id, member.id, isRole(member.role) ? member.role : 'member', member.access_level || 'L2', now, now, now])
    moved += 1
  }
  return { ok: true, teamId: team.id, moved, note: '无邮箱登记项以 members.id 为 user_id 占位（待认领），不自动生成账号' }
}

/** 接受邀请（登录态路由包装；未注册用户走 register 携带 inviteToken） */
export async function acceptInvitationService(auth, token) {
  if (!auth?.userId) throw forbidden('请先登录或注册后再接受邀请', 'UNAUTHORIZED')
  return acceptInvitationForUser(token, auth.userId, auth.email)
}

// ---------- 内部工具 ----------

function requireAuth(auth) {
  if (!auth?.userId) throw forbidden('账号体系未开启或未登录', 'UNAUTHORIZED')
}

async function requireTeamMember(auth, teamId) {
  requireAuth(auth)
  const row = await first(`select m.role, m.access_level, u.email from team_members m
    left join users u on u.id = m.user_id
    where m.team_id = ? and m.user_id = ? and m.status = 'active'`, [teamId, auth.userId])
  if (!row) throw forbidden('非本团队成员', 'FORBIDDEN')
  return { ...row, email: row.email || auth.email || null }
}

async function getMemberRow(teamId, userId) {
  const row = await first('select user_id, role, access_level, email from team_members m left join users u on u.id = m.user_id where m.team_id = ? and m.user_id = ?', [teamId, String(userId).slice(0, 32)])
  if (!row) throw notFound('成员不存在', 'NOT_FOUND')
  return row
}

async function countActiveOwners(teamId) {
  const rows = await all(`select count(*) as count from team_members where team_id = ? and role = 'owner' and status = 'active'`, [teamId])
  return Number(rows[0]?.count || 0)
}

function slugify(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'team'
}

function safeParse(value) {
  try { return typeof value === 'string' ? JSON.parse(value) : value ?? null } catch { return null }
}
