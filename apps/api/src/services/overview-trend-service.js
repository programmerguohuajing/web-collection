/**
 * @file 概览看板趋势服务
 * 提供 24 小时维度「错误数」与「请求数」时序聚合计算。
 */

import { all } from '../db.js'

function finiteTimestamp(val) {
  if (val == null || val === '') return null
  const num = Number(val)
  return Number.isFinite(num) && num > 0 ? num : null
}

/**
 * 获取概览看板的 24 桶趋势数据（错误数、请求数、受影响用户数）。
 * @param {object} filters - 筛选条件 { appId, release, startTime, endTime }
 * @returns {Promise<Array<{ ts: number, label: string, errors: number, requests: number, users: number }>>}
 */
export async function getOverviewTrend(filters = {}) {
  const now = Date.now()
  let rangeEnd = finiteTimestamp(filters.endTime) || now
  let rangeStart = finiteTimestamp(filters.startTime) || (rangeEnd - 24 * 3600000)
  if (rangeStart >= rangeEnd) rangeStart = rangeEnd - 24 * 3600000
  const span = Math.max(1, rangeEnd - rangeStart)
  const bucketSpan = span / 24

  const whereParts = ['ts >= ?', 'ts <= ?']
  const params = [rangeStart, rangeEnd]

  if (filters.appId) {
    whereParts.push('app_id = ?')
    params.push(String(filters.appId))
  }
  if (filters.release) {
    whereParts.push('release_name = ?')
    params.push(String(filters.release))
  }

  const where = `where ${whereParts.join(' and ')}`

  const sql = `
    select 
      floor((ts - ?) / ?)::integer as bucket_idx,
      type,
      metric,
      count(*)::integer as count,
      count(distinct coalesce(nullif(user_id, ''), device_id))::integer as users
    from events ${where}
    group by bucket_idx, type, metric
  `

  const buckets = Array.from({ length: 24 }, (_, i) => {
    const bucketTs = rangeStart + i * bucketSpan
    const d = new Date(bucketTs)
    const label = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    return { ts: Math.round(bucketTs), label, errors: 0, requests: 0, users: 0 }
  })

  try {
    const rows = await all(sql, [rangeStart, bucketSpan, ...params])
    for (const row of rows) {
      const idx = Math.min(23, Math.max(0, Number(row.bucket_idx)))
      const bucket = buckets[idx]
      if (!bucket) continue
      const count = Number(row.count) || 0
      const users = Number(row.users) || 0

      if (row.type === 'error') {
        bucket.errors += count
      }
      if (
        row.type === 'api' ||
        row.metric === 'fetch' ||
        row.metric === 'xhr' ||
        (row.type === 'perf' && (row.metric === 'fetch' || row.metric === 'xhr'))
      ) {
        bucket.requests += count
      }
      bucket.users = Math.max(bucket.users, users)
    }
  } catch (err) {
    // Return empty buckets if db query fails
  }

  return buckets
}
