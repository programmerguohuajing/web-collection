/**
 * @file issues 表数据访问层
 * 提供错误聚合记录的查询、插入（upsert）和解决操作。
 */

import { all, run, scalar } from '../db.js'

/** 查询所有 issue 记录 */
export async function listIssueRows(filters = {}, limit = 100, offset = 0) {
  const { where, params } = issueWhere(filters)
  return all(`select * from issues ${where} order by last_seen desc limit ? offset ?`, [...params, limit, offset])
}

export async function countIssueRows(filters = {}) {
  const { where, params } = issueWhere(filters)
  return scalar(`select count(*) as count from issues ${where}`, params)
}

/**
 * 按指纹查询单个 issue。
 * @param {string} fingerprint - issue 指纹
 * @returns {Promise<object|null>} issue 行或 null
 */
export async function getIssueRow(fingerprint) {
  const rows = await all('select * from issues where fingerprint = ? limit 1', [fingerprint])
  return rows[0] || null
}

function issueWhere(filters = {}) {
  const parts = []
  const params = []
  addRange(parts, params, 'last_seen', filters.startTime, filters.endTime)
  addEq(parts, params, 'app_id', filters.appId)
  addEq(parts, params, 'release', filters.release)
  addEq(parts, params, 'status', filters.status)
  addLike(parts, params, 'url', filters.url || filters.path)
  if (filters.userId || filters.userName || filters.userPhone) {
    const value = filters.userId || filters.userName || filters.userPhone
    parts.push('users_json::text ilike ?')
    params.push(`%${value}%`)
  }
  if (filters.keyword) {
    params.push(`%${filters.keyword}%`)
    parts.push('(name ilike ? or message ilike ? or stack ilike ? or props_json::text ilike ?)')
    params.push(params.at(-1), params.at(-1), params.at(-1))
  }
  return { where: parts.length ? `where ${parts.join(' and ')}` : '', params }
}

function addRange(parts, params, field, start, end) {
  if (start) { parts.push(`${field} >= ?`); params.push(Number(start)) }
  if (end) { parts.push(`${field} <= ?`); params.push(Number(end)) }
}

function addEq(parts, params, field, value) {
  if (!value) return
  parts.push(`${field} = ?`)
  params.push(value)
}

function addLike(parts, params, field, value) {
  if (!value) return
  parts.push(`${field} ilike ?`)
  params.push(`%${value}%`)
}

/**
 * 将 issue 标记为已解决。
 * @param {string} fingerprint - issue 指纹
 * @param {number} resolvedAt - 解决时间戳
 */
export async function resolveIssueRow(fingerprint, resolvedAt) {
  await run('update issues set status = ?, resolved_at = ? where fingerprint = ?', ['resolved', resolvedAt, fingerprint])
}

/**
 * 插入或更新 issue 记录（upsert）。
 * 冲突时更新所有字段，JSONB 字段使用 ::jsonb 类型转换。
 * @param {object} issue - issue 对象
 */
export async function upsertIssueRow(issue) {
  await run(
    `insert into issues (
      fingerprint, status, app_id, release, name, message, stack, url, props_json, breadcrumbs_json, original_json, users_json, affected_users, count, first_seen, last_seen, resolved_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, ?, ?, ?, ?, ?)
    on conflict(fingerprint) do update set
      status = excluded.status,
      app_id = excluded.app_id,
      release = excluded.release,
      name = excluded.name,
      message = excluded.message,
      stack = excluded.stack,
      url = excluded.url,
      props_json = excluded.props_json,
      breadcrumbs_json = excluded.breadcrumbs_json,
      original_json = excluded.original_json,
      users_json = excluded.users_json,
      affected_users = excluded.affected_users,
      count = excluded.count,
      first_seen = excluded.first_seen,
      last_seen = excluded.last_seen,
      resolved_at = excluded.resolved_at`,
    [
      issue.fingerprint,
      issue.status,
      issue.appId,
      issue.release,
      issue.name,
      issue.message,
      issue.stack,
      issue.url,
      JSON.stringify(issue.props ?? null),
      JSON.stringify(issue.breadcrumbs ?? null),
      JSON.stringify(issue.original ?? null),
      JSON.stringify(issue.users ?? []),
      issue.affectedUsers,
      issue.count,
      issue.firstSeen,
      issue.lastSeen,
      issue.resolvedAt
    ]
  )
}
