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
  // SDK 在不支持 CompressionStream 的环境会 fallback 为 compression:'none' + base64(JSON(events))；
  // 后端若只接受数组会导致这些回放被静默丢弃，列表/详情均无数据。
  if (event.compression === 'none' && typeof event.events === 'string') {
    try {
      const parsed = parseJson(Buffer.from(event.events, 'base64').toString('utf8'))
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
 * 将同一回放会话的多条记录（可能分页、到达乱序、跨多个录制实例）重组成可播放事件流。
 *
 * 关键：rrweb 的 node id 空间按「录制实例」独立，而同一 `base_session_id` 下可能混有
 * 多个实例（多次页面加载 / 多次 startReplay）。若把不同实例的事件混排（尤其把 A 实例的
 * 全量快照塞进 B 实例的增量流），rrweb 重建镜像树时 node id 对不上 → 回放窗口空白。
 * 因此按 `session_id`（= 录制实例）分组，各自独立处理后再依次拼接：
 *   - 实例内按事件 `timestamp` 升序还原时间线（容忍分页乱序到达），同时间戳按入库顺序稳定排序；
 *   - 每个实例只从「它自己的」首个全量快照（type === 2）开始输出，快照之前的增量丢弃；
 *   - 实例若完全没有自身全量快照 → 整段跳过（不可重建，强行借用他段快照只会让画面崩坏）；
 *   - 缺失 `session_id` 的行按同一默认实例处理，保持旧调用方的兼容性。
 * - 上限 `cap` 防止异常超大回放拖垮前端。
 *
 * @param {Array<{session_id?:string, events_json:any}>} rows 数据库行（events_json 为 rrweb 事件数组或已解析对象）
 * @param {number} [cap=100000] 返回事件数上限
 * @returns {Array<object>}
 */
export function reassembleReplayEvents(rows, cap = 100000) {
  const list = Array.isArray(rows) ? rows : []
  // 按录制实例（session_id）分组，保持首次出现顺序（SQL 已按 created_at,id 正序，即录制顺序）。
  const instances = new Map()
  for (const row of list) {
    const arr = parseJson(row?.events_json)
    if (!Array.isArray(arr) || !arr.length) continue
    const sid = row?.session_id || '__default__'
    if (!instances.has(sid)) instances.set(sid, [])
    instances.get(sid).push(arr)
  }
  const merged = []
  for (const pages of instances.values()) {
    const flat = []
    let seq = 0
    for (const arr of pages) for (const e of arr) flat.push({ e, seq: seq++ })
    flat.sort((a, b) => (Number(a.e?.timestamp) - Number(b.e?.timestamp)) || (a.seq - b.seq))
    const idx = flat.findIndex((x) => x.e?.type === 2)
    if (idx < 0) continue // 该实例无自身全量快照：跳过，避免污染整条时间线导致画面空白
    // 保留紧邻全量快照之前的 Meta（type:4）：它携带 viewport 尺寸 / href，属同一实例，
    // 是 rrweb 事件流的规范开头（Meta → FullSnapshot）。只裁掉快照之前的增量。
    let start = idx
    if (start > 0 && flat[start - 1]?.e?.type === 4) start--
    for (let i = start; i < flat.length; i++) merged.push(flat[i].e)
  }
  return merged.slice(0, cap)
}

/** 回放跨度截断上限（30 分钟）：标签页常开的旧 SDK 会话可达十几小时，
 *  其中大片挂机空白；与 Cloudflare Worker 端 REPLAY_SPAN_LIMIT_MS 保持一致。 */
export const REPLAY_SPAN_LIMIT_MS = 30 * 60 * 1000

/**
 * 回放时长截断：跨度超限时截取最近 limitMs，截断点后移到首个全量快照（含其紧邻
 * Meta），保证输出流仍以可重建的快照开头；窗口内找不到快照则不截断（宁可超长也不黑屏）。
 * @param {Array<object>} events 已重组的 rrweb 事件流（按 timestamp 升序）
 * @param {number} [limitMs] 截断窗口，默认 30 分钟
 * @returns {{events: Array<object>, truncated: boolean, originalSpanMs: number, spanMs: number}}
 */
export function truncateReplaySpan(events, limitMs = REPLAY_SPAN_LIMIT_MS) {
  const list = Array.isArray(events) ? events : []
  const originalSpanMs = list.length >= 2 ? Number(list[list.length - 1].timestamp) - Number(list[0].timestamp) : 0
  if (list.length < 2 || originalSpanMs <= limitMs) {
    return { events: list, truncated: false, originalSpanMs, spanMs: originalSpanMs }
  }
  const cutoff = Number(list[list.length - 1].timestamp) - limitMs
  let start = list.findIndex(e => Number(e?.timestamp) >= cutoff)
  if (start < 0) start = 0
  let snapIdx = -1
  for (let i = start; i < list.length; i++) {
    if (list[i] && list[i].type === 2) { snapIdx = i; break }
  }
  // 窗口内无自身快照：不截断，避免输出无法重建的黑屏流
  if (snapIdx < 0 || start === 0) {
    return { events: list, truncated: false, originalSpanMs, spanMs: originalSpanMs }
  }
  if (snapIdx > 0 && list[snapIdx - 1] && list[snapIdx - 1].type === 4) snapIdx--
  const out = list.slice(snapIdx)
  return { events: out, truncated: true, originalSpanMs, spanMs: Number(out[out.length - 1].timestamp) - Number(out[0].timestamp) }
}
