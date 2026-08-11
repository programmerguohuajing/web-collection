/**
 * @file replay_events 表数据访问层
 * 会话回放列表通过 GROUP BY 直接从 replay_events 查询，无需冗余汇总表。
 */

import { all, run, scalar } from '../db.js'

const fullSnapshotWhere = `exists (
  select 1
  from jsonb_array_elements(case when jsonb_typeof(events_json) = 'array' then events_json else '[]'::jsonb end) event
  where event->>'type' = '2'
)`

/**
 * 按最后活跃时间倒序查询回放会话列表（GROUP BY 聚合）。
 * 直接从 replay_events 表分组，不再依赖独立的 replays 汇总表。
 * @param {number} [limit=20] - 返回条数上限
 * @returns {Promise<Array>} 会话摘要行数组（已使用 AS 别名转为 camelCase）
 */
export async function listReplaySessions(limit = 20, filters = {}, offset = 0) {
  const { where, params } = replayWhere(filters)
  return all(
    `select max(id)::text as "replayId",
            session_id as "sessionId",
            count(*)::integer as count,
            (array_agg(user_id order by created_at desc, id desc) filter(where user_id is not null))[1] as "userId",
            (array_agg(user_name order by created_at desc, id desc) filter(where user_name is not null))[1] as "userName",
            (array_agg(user_phone order by created_at desc, id desc) filter(where user_phone is not null))[1] as "userPhone",
            min(created_at) as "firstSeen",
            max(created_at) as "lastSeen",
            (array_agg(url order by created_at desc, id desc) filter(where url is not null))[1] as url,
            (array_agg(release order by created_at desc, id desc) filter(where release is not null))[1] as release,
            (array_agg(end_reason order by created_at desc, id desc) filter(where end_reason is not null))[1] as "endReason"
     from replay_events
     ${where}
       ${where ? 'and' : 'where'} ${fullSnapshotWhere}
     group by app_id, session_id
     order by max(created_at) desc
     limit ? offset ?`,
    [...params, limit, offset]
  )
}

export async function countReplaySessions(filters = {}) {
  const { where, params } = replayWhere(filters)
  return scalar(
    `select count(*) as count from (
       select app_id, session_id
       from replay_events ${where}
       ${where ? 'and' : 'where'} ${fullSnapshotWhere}
       group by app_id, session_id
     ) sessions`,
    params
  )
}

/**
 * 按创建时间正序查询指定会话的所有回放事件详情。
 * @param {string} sessionId - 会话 ID
 * @returns {Promise<Array>} 包含 events_json 的行数组
 */
export async function listReplayEventRows(idOrSessionId, limit = 500) {
  const rowLimit = safeLimit(limit, 500, 1, 5000)
  if (/^\d+$/.test(String(idOrSessionId))) {
    return all(
      `select events_json
       from replay_events
       where session_id = (select session_id from replay_events where id = ?)
         and id >= ?
         and id < coalesce((
           select id from replay_events
           where session_id = (select session_id from replay_events where id = ?)
             and id > ?
             and ${fullSnapshotWhere}
           order by id asc
           limit 1
         ), 9223372036854775807)
       order by created_at asc, id asc
       limit ?`,
      [idOrSessionId, idOrSessionId, idOrSessionId, idOrSessionId, rowLimit]
    )
  }
  // 优先精确匹配；若精确匹配无结果，再用 ILIKE 前缀匹配（兼容分段扩展 sessionId）。
  let rows = await all('select events_json from replay_events where session_id = ? order by created_at asc, id asc limit ?', [idOrSessionId, rowLimit])
  if (!rows.length) {
    rows = await all('select events_json from replay_events where session_id ilike ? order by created_at asc, id asc limit ?', [`${idOrSessionId}%`, rowLimit])
  }
  return rows
}

/** 插入一条回放事件详情记录 */
export async function insertReplayEventRow({ appId, sessionId, userId, userName, userPhone, createdAt, url, release, endReason, eventsJson }) {
  await run(
    'insert into replay_events (app_id, session_id, user_id, user_name, user_phone, created_at, url, release, end_reason, events_json) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)',
    [appId || 'default', sessionId, userId || null, userName || null, userPhone || null, createdAt, url, release, endReason || null, eventsJson]
  )
}

function replayWhere(filters = {}) {
  const parts = []
  const params = []
  addEq(parts, params, 'app_id', filters.appId)
  addRange(parts, params, 'created_at', filters.startTime, filters.endTime)
  addEq(parts, params, 'release', filters.release)
  addEq(parts, params, 'user_id', filters.userId)
  addLike(parts, params, 'user_name', filters.userName)
  addLike(parts, params, 'user_phone', filters.userPhone)
  addLike(parts, params, 'url', filters.url || filters.path)
  if (filters.keyword) {
    params.push(`%${filters.keyword}%`)
    parts.push('(session_id ilike ? or url ilike ? or events_json::text ilike ?)')
    params.push(params.at(-1), params.at(-1))
  }
  return { where: parts.length ? `where ${parts.join(' and ')}` : '', params }
}

function addRange(parts, params, field, start, end) {
  const startValue = finiteTimestamp(start)
  const endValue = finiteTimestamp(end)
  if (startValue != null) { parts.push(`${field} >= ?`); params.push(startValue) }
  if (endValue != null) { parts.push(`${field} <= ?`); params.push(endValue) }
}

function safeLimit(value, fallback, min, max) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback
}

function finiteTimestamp(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
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
