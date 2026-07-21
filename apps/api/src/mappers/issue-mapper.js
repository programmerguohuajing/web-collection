import { parseJson } from '../utils/json.js'

/**
 * 将数据库行映射为前端 issue 对象（驼峰命名）。
 * 解析 JSONB 字段（props、breadcrumbs、original、users）。
 *
 * @param {object} row - 数据库行
 * @returns {object} 前端格式的 issue 对象
 */
export function mapIssue(row) {
  return {
    fingerprint: row.fingerprint,
    status: row.status,
    appId: row.app_id,
    release: row.release,
    name: row.name,
    message: row.message,
    stack: row.stack,
    url: row.url,
    props: parseJson(row.props_json),
    breadcrumbs: parseJson(row.breadcrumbs_json),
    original: parseJson(row.original_json),
    users: parseJson(row.users_json) || [],
    affectedUsers: Number(row.affected_users),
    count: Number(row.count),
    firstSeen: Number(row.first_seen),
    lastSeen: Number(row.last_seen),
    resolvedAt: row.resolved_at == null ? null : Number(row.resolved_at)
  }
}
