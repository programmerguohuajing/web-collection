/**
 * @file 留存 / 同期群分析（Retention & Cohort）—— 纯计算真相源
 *
 * Next Horizon A1 能力。本文件只做「行 → 报表」的纯聚合，不含任何 SQL / 运行时依赖，
 * 由两个后端共用，杜绝双端口径漂移：
 *   - Node / PostgreSQL：apps/api/src/services/retention-service.js（PG 方言取行）
 *   - Cloudflare Worker / D1：cloudflare/worker.js（SQLite 方言取行）
 *
 * 口径（口径透明原则，前端在页头通过 caliber 字段展示）：
 * - 用户标识：优先 user_id，缺失回退 device_id，两者皆空回退 session_id（与产品分析 V2 一致）。
 * - 日切：UTC 天，day = floor(ts / 86400000)。day0 = 用户首次访问当日，故 day0 留存恒为 100%。
 * - 留存定义：cohort 首访日 + offset 天当天**有任意 PV** 即计为留存（不去重单日多次访问）。
 * - 窗口未成熟：若 cohortDay + maxOffset 超出查询结束日，该群的远期留存被低估，返回 complete=false 提示。
 */

/** 一天的毫秒数（UTC 日切基准）。 */
export const RETENTION_DAY_MS = 86400000
/** 样本量提示阈值：同期群规模小于该值时给出 sampleNote。 */
export const RETENTION_MIN_SAMPLE = 30
/** 默认留存档位（天）。 */
export const RETENTION_DEFAULT_OFFSETS = [0, 1, 2, 3, 7, 14, 30]
/** 自定义档位上限：防止 offsets=0,1,2,...,365 把响应撑爆。 */
export const RETENTION_MAX_OFFSETS = 12
/** 口径说明，随响应返回供前端展示。 */
export const RETENTION_CALIBER = '用户标识优先 userId，缺失回退 deviceId，再回退 session_id；日切按 UTC；day0=首访当日（恒 100%）；留存=首访日+第 N 天有 PV。'

/** 取正有限数，否则回落默认值。 */
function finiteOr(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * 解析 offsets 查询参数：恒含 0、去重、升序、截断。
 *
 * @param {string|number|null|undefined} input 形如 '1,3,7,30'
 * @returns {number[]} 升序档位数组
 */
export function normalizeRetentionOffsets(input) {
  const text = String(input == null ? '' : input).trim()
  // 空串/空白：走默认档位（避免 Number('')===0 的误判）
  if (!text) return [...RETENTION_DEFAULT_OFFSETS]
  const raw = text
    .split(',')
    .map(part => Number(part.trim()))
    .filter(num => Number.isInteger(num) && num >= 0 && num <= 365)
  if (!raw.length) return [...RETENTION_DEFAULT_OFFSETS]
  const merged = [...new Set([0, ...raw])]
  return merged.sort((a, b) => a - b).slice(0, RETENTION_MAX_OFFSETS)
}

/** 留存率保留 4 位小数。 */
function roundRate(value) {
  return Math.round(value * 10000) / 10000
}

/** 取集合中最小值（避免 Math.min(...set) 在超大集合上爆栈）。 */
function minDay(daySet) {
  let min = Infinity
  for (const day of daySet) if (day < min) min = day
  return min
}

/**
 * day（UTC 天序号）→ 'YYYY-MM-DD'。
 *
 * 注意：极端脏数据（如 day=2e8）乘以 DAY_MS 后超出 Date 可表示范围（±8.64e15 ms），
 * 此时 `new Date(...)` 得到 Invalid Date，`toISOString()` 会抛
 * `RangeError: Invalid time value` —— 一行脏数据会打挂整个留存接口（500）。
 * 因此先校验时间戳有效性，非法时降级回显原值，保证可读且不中断。
 *
 * @param {number} day UTC 天序号（floor(ts / 86400000)）
 * @returns {string} 'YYYY-MM-DD'，非法时返回原值的字符串形式
 */
export function retentionDayToDate(day) {
  const d = new Date(Number(day) * RETENTION_DAY_MS)
  if (!Number.isFinite(d.getTime())) return String(day)
  return d.toISOString().slice(0, 10)
}

/**
 * 由「(uid, day) 明细行」构建留存 / 同期群报表（纯函数，双端共用）。
 *
 * @param {Array<{uid?:string|null, day?:number|string|null}>} rows 明细行；同一 (uid, day) 重复出现不影响结果
 * @param {{startTime?:number, endTime?:number, offsets?:string, page?:number|string, pageSize?:number|string}} [input]
 * @returns {{total:number, totalUsers:number, items:Array, average:Array, offsets:number[], caliber:string, minSample:number}}
 */
export function buildRetentionReport(rows, input = {}) {
  const list = Array.isArray(rows) ? rows : []
  const start = finiteOr(input.startTime, Date.now() - 30 * RETENTION_DAY_MS)
  const end = finiteOr(input.endTime, Date.now())
  const offsets = normalizeRetentionOffsets(input.offsets)
  const maxOffset = offsets[offsets.length - 1]
  const endDay = Math.floor(end / RETENTION_DAY_MS)

  // uid -> Set(活跃日)
  const daysByUser = new Map()
  for (const row of list) {
    const uid = row && row.uid
    if (!uid) continue
    // day 缺测时必须跳过：Number(null)===0、Number('')===0 会造出「1970-01-01」幽灵同期群，
    // 污染 totalUsers 与按群规模加权的 average。
    if (row.day == null || row.day === '') continue
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

  const page = Math.max(1, Number(input.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(input.pageSize) || 20))
  const items = [...cohorts.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice((page - 1) * pageSize, page * pageSize)
    .map(([day, cohort]) => ({
      cohortDay: day,
      cohortDate: retentionDayToDate(day),
      size: cohort.size,
      complete: day + maxOffset <= endDay,
      sampleNote: cohort.size < RETENTION_MIN_SAMPLE ? '样本量不足，仅供参考' : '',
      retention: offsets.map(offset => {
        const users = cohort.retained.get(offset) || 0
        return { day: offset, users, rate: cohort.size ? roundRate(users / cohort.size) : 0 }
      })
    }))

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
    minSample: RETENTION_MIN_SAMPLE,
    caliber: RETENTION_CALIBER
  }
}
