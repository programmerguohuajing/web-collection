/**
 * @file 会话回放双模式逻辑层（T02 · 纯 JS 无 DOM / React Native 依赖）
 *
 * 提供手势轨迹 (pointer_event) 与 画面快照 (canvas_snapshot) 的事件生成与上报逻辑。
 * 红线：本文件内严禁 import 'react' / 'react-native'（no-web-globals 测试强制）。
 */

/**
 * 记录触控与手势轨迹事件（方案二 · 默认提供）
 * @param {object} client 客户端实例
 * @param {{ kind: 'down'|'move'|'up', x: number, y: number, pointerId?: number|string }} data
 * @returns {boolean} 是否上报成功
 */
export function recordPointerEvent(client, data = {}) {
  if (!client) return false
  const sendFn = typeof client.recordReplay === 'function' ? client.recordReplay : client.track
  if (typeof sendFn !== 'function') return false

  const kind = ['down', 'move', 'up'].includes(data.kind) ? data.kind : 'down'
  const x = Number(data.x)
  const y = Number(data.y)
  const pointerId = data.pointerId != null ? data.pointerId : 1

  const props = {
    kind,
    pointer_id: pointerId,
    x: Number.isFinite(x) ? Number(x.toFixed(1)) : 0,
    y: Number.isFinite(y) ? Number(y.toFixed(1)) : 0,
    platform: 'react-native'
  }

  try {
    sendFn.call(client, 'pointer_event', props)
    return true
  } catch {
    return false
  }
}

/**
 * 记录画面快照事件（方案一 · 用户可选）
 * @param {object} client 客户端实例
 * @param {{ imageData: string, width: number, height: number }} data
 * @returns {boolean} 是否上报成功
 */
export function recordSnapshotEvent(client, data = {}) {
  if (!client) return false
  const sendFn = typeof client.recordReplay === 'function' ? client.recordReplay : client.track
  if (typeof sendFn !== 'function') return false

  const imageData = typeof data.imageData === 'string' ? data.imageData : ''
  if (!imageData) return false

  const width = Math.max(1, Math.round(Number(data.width) || 375))
  const height = Math.max(1, Math.round(Number(data.height) || 667))

  const props = {
    snapshot_type: 'image_png',
    width,
    height,
    image_data: imageData,
    platform: 'react-native'
  }

  try {
    sendFn.call(client, 'canvas_snapshot', props)
    return true
  } catch {
    return false
  }
}
