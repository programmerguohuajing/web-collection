/**
 * 将数据库行映射为前端回放摘要对象（驼峰命名）。
 * 兼容 snake_case 和 camelCase 两种列名格式。
 *
 * @param {object} row - 数据库行
 * @returns {object} 前端格式的回放摘要对象
 */
export function mapReplay(row) {
  return {
    replayId: row.id ?? row.replayId,
    sessionId: row.session_id ?? row.sessionId,
    userId: row.user_id ?? row.userId,
    userName: row.user_name ?? row.userName,
    userPhone: maskPhone(row.user_phone ?? row.userPhone),
    count: Number(row.count),
    firstSeen: Number(row.first_seen ?? row.firstSeen),
    lastSeen: Number(row.last_seen ?? row.lastSeen),
    url: row.url,
    release: row.release,
    endReason: row.end_reason ?? row.endReason ?? null
  }
}

function maskPhone(phone = '') {
  return String(phone).replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2')
}
