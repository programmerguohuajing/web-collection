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
  const userStart = finiteTimestamp(filters.startTime)
  const userEnd = finiteTimestamp(filters.endTime)

  let rangeEnd = userEnd || now
  let rangeStart = userStart || (rangeEnd - 24 * 3600000)

  // 若未指定自定义时间范围，且在 [now - 24h, now] 范围内无数据，
  // 从数据库最新事件时间戳推导 24h 时间窗，避免 Demo/测试数据时间戳偏早绘制空画布。
  if (!userStart && !userEnd) {
    try {
      const maxRow = await all(`select max(ts) as max_ts from events`).catch(() => [])
      const maxTs = Number(maxRow[0]?.max_ts || 0)
      const hasRecent = await all(`select 1 from events where ts >= ? and ts <= ? limit 1`, [rangeStart, rangeEnd]).catch(() => [])
      if (!hasRecent.length && maxTs > 0) {
        rangeEnd = maxTs
        rangeStart = Math.max(0, maxTs - 24 * 3600000)
      }
    } catch {
      // ignore fallback error
    }
  }

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
      name,
      count(*)::integer as count,
      count(distinct coalesce(nullif(user_id, ''), device_id))::integer as users
    from events ${where}
    group by bucket_idx, type, metric, name
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

      if (
        row.type === 'error' ||
        row.metric === 'error' ||
        row.name === 'error' ||
        (row.type === 'log' && (row.metric === 'error' || row.name === 'error'))
      ) {
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

    // 若 events 表错误数为 0 但 issues 表在对应窗口内有活跃/未解决问题，按 issues 发生时间映射
    const totalErrors = buckets.reduce((sum, b) => sum + b.errors, 0)
    if (totalErrors === 0) {
      const issueWhereParts = ['last_seen >= ?', 'last_seen <= ?']
      const issueParams = [rangeStart, rangeEnd]
      if (filters.appId) { issueWhereParts.push('app_id = ?'); issueParams.push(filters.appId) }
      if (filters.release) { issueWhereParts.push('release = ?'); issueParams.push(filters.release) }
      const issueRows = await all(`select floor((last_seen - ?) / ?)::integer as bucket_idx, sum(count)::integer as count from issues where ${issueWhereParts.join(' and ')} group by bucket_idx`, [rangeStart, bucketSpan, ...issueParams]).catch(() => [])
      for (const row of issueRows) {
        const idx = Math.min(23, Math.max(0, Number(row.bucket_idx)))
        if (buckets[idx]) buckets[idx].errors += Number(row.count || 1)
      }
    }
  } catch (err) {
    // Return empty buckets if db query fails
  }

  return buckets
}
