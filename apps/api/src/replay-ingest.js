/**
 * @file 回放入库 / 读取的纯函数：解压与分段重组。
 *
 * 对齐 SDK Phase 7 / SDK-214 的回放数据契约：
 *   - 默认开启 gzip 压缩：`compression === 'gzip'` 时 `events` 为 gzip 字节的 base64 字符串；
 *   - 回放按 `page`/`pageCount` 分页，每条独立记录共享同一分段 `sessionId`。
 *
 * 平台侧此前只接受 `events` 数组、忽略 `compression`/`page`，导致 SDK 默认配置下
 * 回放被静默存空（`Array.isArray(字符串)` 为 false → `[]`）。这里统一在服务端解压并按
 * 事件时间顺序重组，前端播放器无需改动即可播放完整回放。
 *
 * 本模块为纯函数、不依赖数据库，可独立单测。
 */

import { gunzipSync } from 'node:zlib'
import { parseJson } from './utils/json.js'

/**
 * 将单条 SDK 上报的 replay 记录解压为 rrweb 事件数组。
 * @param {object} event - /api/collect 收到的 replay 载荷（含 events / compression / page / pageCount 等）
 * @returns {Array<object>} 事件数组（任何异常或非法格式均返回空数组，避免整条入库失败）
 */
export function decompressReplayEvents(event) {
  if (!event) return []
  if (event.compression === 'gzip' && typeof event.events === 'string') {
    try {
      const buf = gunzipSync(Buffer.from(event.events, 'base64'))
      const parsed = parseJson(buf.toString('utf8'))
      if (Array.isArray(parsed)) return parsed
    } catch {
      return []
    }
    return []
  }
  if (Array.isArray(event.events)) return event.events
  return []
}

/**
 * 将同一分段的多条回放记录（可能分页、到达乱序）重组成有序事件流。
 *
 * - 按事件 `timestamp` 升序还原时间线（收包乱序也能正确拼接）；同时间戳按入库顺序稳定排序；
 * - 上限 `cap` 防止异常超大回放拖垮前端。
 *
 * 注：真实 SDK 录制首事件即为 rrweb 全量快照（type === 2），无需额外裁剪；
 * 此处保持「返回该分段全部事件（按时间有序）」的既有契约，避免破坏既有回放读取行为。
 *
 * @param {Array<{events_json:any}>} rows 数据库行（events_json 为 rrweb 事件数组或已解析对象）
 * @param {number} [cap=100000] 返回事件数上限
 * @returns {Array<object>}
 */
export function reassembleReplayEvents(rows, cap = 100000) {
  const merged = []
  let seq = 0
  for (const row of rows || []) {
    const arr = parseJson(row?.events_json)
    if (!Array.isArray(arr)) continue
    for (const e of arr) merged.push({ e, seq: seq++ })
  }
  if (!merged.length) return []
  merged.sort((a, b) => (Number(a.e?.timestamp) - Number(b.e?.timestamp)) || (a.seq - b.seq))
  return merged.slice(0, cap).map((x) => x.e)
}
