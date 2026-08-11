/**
 * 事件唯一标识生成。
 *
 * 每个进入发送队列的事件都会获得稳定的 `eventId`：
 * - SDK 侧据此在「Beacon 退出发送」与「下一会话常规发送」之间实现 at-least-once
 *   去重（服务端按 eventId + TTL 幂等入库，见 API-220）。
 * - 也用于本地去重与诊断追溯。
 *
 * 统一前缀 `e-` 的 `time-counter-random` 格式，保证浏览器与 Node 一致可解析。
 *
 * @returns {string} 稳定且全局唯一的事件 ID
 */
export function createEventId() {
  let rand
  try {
    if (globalThis.crypto?.getRandomValues) {
      const bytes = new Uint8Array(8)
      globalThis.crypto.getRandomValues(bytes)
      rand = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
    }
  } catch {}
  if (!rand) rand = Math.random().toString(36).slice(2, 18)
  const time = Date.now().toString(36)
  const counter = (createEventId._c = ((createEventId._c || 0) + 1) % 1e6).toString(36)
  return `e-${time}-${counter}-${rand}`
}
