/**
 * @file Next Horizon A1 — 留存 / 同期群分析（Retention & Cohort）
 *
 * 数据源：events 中 `behavior/pv` 事件。按"用户首次访问日"分群（cohort），
 * 统计该群用户在后续第 N 天是否回访，即 N 日留存。
 *
 * 口径（口径透明原则，前端需在页头展示）：
 * - 用户标识：优先 user_id，缺失回退 device_id，两者皆空回退 session_id（与产品分析 V2 一致）。
 * - 日切：UTC 天，day = floor(ts / 86400000)。day0 = 用户首次访问当日，故 day0 留存恒为 100%。
 * - 留存定义：cohort 首访日 + offset 天当天**有任意 PV** 即计为留存（不去重单日多次访问）。
 * - 窗口未成熟：若 cohortDay + maxOffset 超出查询结束日，该群的远期留存被低估，返回 complete=false 提示。
 *
 * 部署说明：产品分析 V2 能力仅 Node/PostgreSQL 部署支持（Cloudflare Worker 保留原有产品分析），
 * 与 engagement-service / journey-service 同层。
 */
import { all } from '../db.js'

const DAY_MS = 86400000
const MIN_SAMPLE = 30
const DEFAULT_OFFSETS = [0, 1, 2, 3, 7, 14, 30]
const MAX_OFFSETS = 12

function finiteOr(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeOffsets(input) {
  const text = String(input == null ? '' : input).trim()
  if (!text) return [...DEFAULT_OFFSETS] // 空串/空白：走默认档位（避免 Number('')===0 的误判）
  const raw = text
    .split(',')
    .map(part => Number(part.trim()))
    .filter(num => Number.isInteger(num) && num >= 0 && num <= 365)
  if (!raw.length) return [...DEFAULT_OFFSETS]
  const merged = [...new Set([0, ...raw])]
  return merged.sort((a, b) => a - b).slice(0, MAX_OFFSETS)
}

function roundRate(value) {
  return Math.round(value * 10000) / 10000
}

/** 取集合中最小值（避免 Math.min(...set) 在超大集合上爆栈） */
function minDay(daySet) {
  let min = Infinity
  for (const day of daySet) if (day < min) min = day
  return min
}

function dayToDate(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10)
}

/**
 * 留存 / 同期群报表。
 *
 * @param {{appId?:string, startTime?:number, endTime?:number, offsets?:string, page?:number, pageSize?:number}} input
 * @param {Function} [query] - 注入点，默认使用 db.all（便于单测）
 * @returns {Promise<{total:number, items:Array, average:Array, offsets:number[], caliber:string, minSample:number}>}
 */
export async function listRetention(input = {}, query = all) {
  const start = finiteOr(input.startTime, Date.now() - 30 * DAY_MS)
  const end = finiteOr(input.endTime, Date.now())
  const offsets = normalizeOffsets(input.offsets)
  const maxOffset = offsets[offsets.length - 1]
  const endDay = Math.floor(end / DAY_MS)

  const rows = await query(
    `select coalesce(nullif(user_id, ''), nullif(device_id, ''), session_id) as uid,
            (ts / 86400000)::integer as day
     from events
     where type = 'behavior' and name = 'pv' and ts >= ? and ts <= ? ${input.appId ? 'and app_id = ?' : ''}`,
    input.appId ? [start, end, String(input.appId).slice(0, 64)] : [start, end]
  )

  // uid -> Set(活跃日)
  const daysByUser = new Map()
  for (const row of rows) {
    const uid = row && row.uid
    if (!uid) continue
    const day = Number(row.day)
    if (!Number.isFinite(day)) continue
    let set = daysByUser.get(uid)
    if (!set) daysByUser.set(uid, (set = new Set()))
    set.add(day)
  }

  // 按首访日分群
  const cohorts = new Map()
  for (const daySet of daysByUser.values()) {
    const first = minDay(daySet)
    if (!Number.isFinite(first)) continue
    let cohort = cohorts.get(first)
    if (!cohort) {
      cohort = { size: 0, retained: new Map(offsets.map(offset => [offset, 0])) }
      cohorts.set(first, cohort)
    }
    cohort.size += 1
    for (const offset of offsets) {
      if (daySet.has(first + offset)) cohort.retained.set(offset, cohort.retained.get(offset) + 1)
    }
  }

  const totalUsers = [...cohorts.values()].reduce((sum, cohort) => sum + cohort.size, 0)
  const retainedTotals = new Map(offsets.map(offset => [offset, 0]))
  for (const cohort of cohorts.values()) {
    for (const offset of offsets) retainedTotals.set(offset, retainedTotals.get(offset) + cohort.retained.get(offset))
  }

  let items = [...cohorts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, cohort]) => ({
      cohortDay: day,
      cohortDate: dayToDate(day),
      size: cohort.size,
      complete: day + maxOffset <= endDay,
      retention: offsets.map(offset => {
        const users = cohort.retained.get(offset) || 0
        return { day: offset, users, rate: cohort.size ? roundRate(users / cohort.size) : 0 }
      })
    }))

  const page = Math.max(1, Number(input.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(input.pageSize) || 20))
  items = items
    .slice((page - 1) * pageSize, page * pageSize)
    .map(item => ({ ...item, sampleNote: item.size < MIN_SAMPLE ? '样本量不足，仅供参考' : '' }))

  const average = offsets.map(offset => {
    const users = retainedTotals.get(offset) || 0
    return { day: offset, users, rate: totalUsers ? roundRate(users / totalUsers) : 0 }
  })

  return {
    total: cohorts.size,
    totalUsers,
    offsets,
    average,
    items,
    minSample: MIN_SAMPLE,
    caliber: '用户标识优先 userId，缺失回退 deviceId，再回退 session_id；日切按 UTC；day0=首访当日（恒 100%）；留存=首访日+第 N 天有 PV。'
  }
}
