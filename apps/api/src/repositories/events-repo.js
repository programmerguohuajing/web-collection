/**
 * @file events 表数据访问层
 * 提供事件记录的插入、查询、计数和裁剪操作。
 */

import { all, run, scalar } from '../db.js'

/**
 * 插入一条事件记录。
 * @param {object} event - 事件对象（字段已映射为 snake_case）
 */
export async function insertEventRow(event) {
  await run(
    `insert into events (
      id, ts, type, app_id, release_name, user_id, user_name, user_phone, session_id, device_id, trace_id, span_id, url, path, title, referrer, user_agent, browser, os, device, name, metric, value, message, stack, props_json, breadcrumbs_json
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.id,
      event.ts,
      event.type,
      event.appId,
      event.release,
      event.userId || null,
      event.userName || null,
      event.userPhone || null,
      event.sessionId || null,
      event.deviceId || null,
      event.traceId || null,
      event.spanId || null,
      event.url || null,
      event.path || null,
      event.title || null,
      event.referrer || null,
      event.userAgent || null,
      event.browser || null,
      event.os || null,
      event.device || null,
      event.name || null,
      event.metric || null,
      event.value ?? null,
      event.message || null,
      event.stack || null,
      JSON.stringify(event.props ?? null),
      JSON.stringify(event.breadcrumbs ?? null)
    ]
  )
}

/**
 * 按时间倒序查询事件列表。
 * @param {number} [limit=100] - 返回条数上限
 * @returns {Promise<Array>} 事件行数组
 */
export async function listEventRows(limit = 100, filters = {}, offset = 0) {
  const { where, params } = eventWhere(filters)
  return all(`select * from events ${where} order by ts desc limit ? offset ?`, [...params, limit, offset])
}

/** 统计事件表总行数 */
export async function countEventRows(filters = {}) {
  const { where, params } = eventWhere(filters)
  return scalar(`select count(*) as count from events ${where}`, params)
}

/**
 * 裁剪最旧的指定数量事件记录。
 * @param {number} extra - 需要删除的条数
 */
export async function trimEventRows(extra) {
  if (extra <= 0) return
  await run(
    `delete from events where id in (
      select id from events order by ts asc limit ?
    )`,
    [extra]
  )
}

function eventWhere(filters = {}) {
  const parts = []
  const params = []
  addRange(parts, params, 'ts', filters.startTime, filters.endTime)
  addEq(parts, params, 'app_id', filters.appId)
  addEq(parts, params, 'release_name', filters.release)
  addEq(parts, params, 'type', filters.type)
  addEq(parts, params, 'user_id', filters.userId)
  addLike(parts, params, 'user_name', filters.userName)
  addLike(parts, params, 'user_phone', filters.userPhone)
  addLike(parts, params, 'path', filters.path)
  addLike(parts, params, 'url', filters.url)
  if (filters.keyword) {
    params.push(`%${filters.keyword}%`)
    parts.push(`(name ilike ? or metric ilike ? or message ilike ? or stack ilike ? or props_json::text ilike ?)`)
    params.push(params.at(-1), params.at(-1), params.at(-1), params.at(-1))
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
