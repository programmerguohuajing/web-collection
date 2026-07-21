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
    `select id::text as "replayId",
            session_id as "sessionId",
            1 as count,
            coalesce(user_id, (select user_id from replay_events x where x.session_id = replay_events.session_id and x.user_id is not null order by x.created_at desc limit 1)) as "userId",
            coalesce(user_name, (select user_name from replay_events x where x.session_id = replay_events.session_id and x.user_name is not null order by x.created_at desc limit 1)) as "userName",
            coalesce(user_phone, (select user_phone from replay_events x where x.session_id = replay_events.session_id and x.user_phone is not null order by x.created_at desc limit 1)) as "userPhone",
            created_at as "firstSeen",
            created_at as "lastSeen",
            url,
            release,
            end_reason as "endReason"
     from replay_events
     ${where}
       ${where ? 'and' : 'where'} ${fullSnapshotWhere}
     order by created_at desc
     limit ? offset ?`,
    [...params, limit, offset]
  )
}

export async function countReplaySessions(filters = {}) {
  const { where, params } = replayWhere(filters)
  return scalar(
    `select count(*) as count from replay_events ${where}
       ${where ? 'and' : 'where'} ${fullSnapshotWhere}`,
    params
  )
}

/**
 * 按创建时间正序查询指定会话的所有回放事件详情。
 * @param {string} sessionId - 会话 ID
 * @returns {Promise<Array>} 包含 events_json 的行数组
 */
export async function listReplayEventRows(idOrSessionId) {
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
       order by created_at asc`,
      [idOrSessionId, idOrSessionId, idOrSessionId, idOrSessionId]
    )
  }
  return all('select events_json from replay_events where session_id = ? order by created_at asc', [idOrSessionId])
}

/** 插入一条回放事件详情记录 */
export async function insertReplayEventRow({ sessionId, userId, userName, userPhone, createdAt, url, release, endReason, eventsJson }) {
  await run(
    'insert into replay_events (session_id, user_id, user_name, user_phone, created_at, url, release, end_reason, events_json) values (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)',
    [sessionId, userId || null, userName || null, userPhone || null, createdAt, url, release, endReason || null, eventsJson]
  )
}

function replayWhere(filters = {}) {
  const parts = []
  const params = []
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
