/**
 * @file Next Horizon A1 — 留存 / 同期群分析（Retention & Cohort）
 *
 * 数据源：events 中 `behavior/pv` 事件。按"用户首次访问日"分群（cohort），
 * 统计该群用户在后续第 N 天是否回访，即 N 日留存。
 *
 * 口径（口径透明原则，前端需在页头展示）见 packages/retention.js 头部注释。
 *
 * 部署说明：聚合逻辑与 Cloudflare Worker/D1 端共用 packages/retention.js（纯函数，双端同源，
 * 口径零漂移）；本文件只负责 PostgreSQL 方言取行（D1 端见 cloudflare/worker.js 的 retentionList）。
 */
import { all } from '../db.js'
import { RETENTION_DAY_MS, buildRetentionReport } from '../../../../packages/retention.js'

/**
 * 留存 / 同期群报表（Node / PostgreSQL 实现）。
 *
 * @param {{appId?:string, startTime?:number, endTime?:number, offsets?:string, page?:number, pageSize?:number}} input
 * @param {Function} [query] - 注入点，默认使用 db.all（便于单测）
 * @returns {Promise<{total:number, items:Array, average:Array, offsets:number[], caliber:string, minSample:number}>}
 */
export async function listRetention(input = {}, query = all) {
  const startTime = Number(input.startTime), endTime = Number(input.endTime)
  const start = Number.isFinite(startTime) && startTime > 0 ? startTime : Date.now() - 30 * RETENTION_DAY_MS
  const end = Number.isFinite(endTime) && endTime > 0 ? endTime : Date.now()
  const rows = await query(
    `select coalesce(nullif(user_id, ''), nullif(device_id, ''), session_id) as uid,
            (ts / 86400000)::integer as day
     from events
     where type = 'behavior' and name = 'pv' and ts >= ? and ts <= ? ${input.appId ? 'and app_id = ?' : ''}`,
    input.appId ? [start, end, String(input.appId).slice(0, 64)] : [start, end]
  )
  // 聚合交给共享真相源：与 Worker/D1 端同一份实现，保证两端数字一致。
  return buildRetentionReport(rows, { ...input, startTime: start, endTime: end })
}
