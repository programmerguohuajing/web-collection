/**
 * @file PRD 07 数据访问等级——Node(PG) 服务
 * 账号体系（决策 D3）立项前的最小实现：全局等级走环境变量，
 * members 表可手工维护；等级调整与 L4 敏感查看写审计。
 */
import { all, first, run } from '../db.js'
import { LEVEL_META, normalizeLevel } from '../../../../packages/access-level.js'
import { badRequest } from '../utils/http-error.js'

/** 当前生效的全局等级：无账号体系阶段由环境变量 DATA_ACCESS_LEVEL 配置 */
export function currentAccessLevel() {
  return normalizeLevel(process.env.DATA_ACCESS_LEVEL)
}

export async function listMembers() {
  const rows = await all(`select id, name, role, access_level, last_active_at, created_at, updated_at
    from members order by updated_at desc limit 200`).catch(() => [])
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    role: row.role || '',
    level: normalizeLevel(row.access_level),
    lastActiveAt: row.last_active_at ? Number(row.last_active_at) : null,
    updatedAt: Number(row.updated_at || 0)
  }))
}

/** 邀请/更新成员（无邮件体系，登记制） */
export async function saveMember(input = {}) {
  const name = String(input.name || '').trim().slice(0, 64)
  if (!name) throw badRequest('成员名称不能为空', "BAD_REQUEST")
  const level = normalizeLevel(input.level)
  const role = String(input.role || LEVEL_META[level]?.role || '').slice(0, 64)
  const id = String(input.id || `m_${name.replace(/\s+/g, '_').slice(0, 24)}`).slice(0, 32)
  const now = Date.now()
  await run(`
    insert into members (id, name, role, access_level, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?)
    on conflict (id) do update set name = excluded.name, role = excluded.role,
      access_level = excluded.access_level, updated_at = excluded.updated_at`,
    [id, name, role, level, now, now])
  await writeAudit({ memberId: id, action: 'level_change', target: `${name}:${level}` })
  return { ok: true, id }
}

/** 等级调整（仅 L4 可操作——当前部署单管理员模型，接口层不重复校验身份） */
export async function saveMemberLevel(id, input = {}) {
  const level = normalizeLevel(input?.level)
  const member = await first(`select * from members where id = ?`, [String(id).slice(0, 32)])
  if (!member) throw badRequest('成员不存在', "BAD_REQUEST")
  await run(`update members set access_level = ?, updated_at = ? where id = ?`, [level, Date.now(), member.id])
  await writeAudit({ memberId: member.id, action: 'level_change', target: `${member.name}: ${member.access_level} → ${level}` })
  return { ok: true, level }
}

export async function writeAudit({ memberId, action, target, detail }) {
  try {
    await run(`insert into data_access_audit (member_id, action, target, detail_json, created_at)
      values (?, ?, ?, ?::jsonb, ?)`,
      [memberId ? String(memberId).slice(0, 32) : null, String(action).slice(0, 32), String(target || '').slice(0, 128),
        JSON.stringify(detail || {}), Date.now()])
  } catch {
    // 审计失败不阻塞业务响应（但生产应监控该错误）
  }
}

export async function listDataAccessAudit() {
  const rows = await all(`select id, member_id, action, target, detail_json, created_at
    from data_access_audit order by created_at desc limit 200`)
  return rows.map(row => ({
    id: Number(row.id),
    memberId: row.member_id,
    action: row.action,
    target: row.target,
    detail: safeParse(row.detail_json),
    createdAt: Number(row.created_at)
  }))
}

function safeParse(value) {
  try { return typeof value === 'string' ? JSON.parse(value) : value ?? null } catch { return null }
}
