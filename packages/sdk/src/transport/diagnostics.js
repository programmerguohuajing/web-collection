/**
 * Transport v2 诊断事件。
 *
 * 对外暴露 `onDiagnostic(event)`，让业务侧能够观测 SDK 自身的发送健康度，
 * 例如队列满、被限流、超时、契约错误、存储配额、采样丢弃、Beacon 拒绝/超限/回退等。
 * 诊断事件不包含任何业务敏感数据，只携带原因计数与状态码。
 */

/** 所有受支持的传输诊断事件类型。 */
export const DIAGNOSTIC_TYPES = Object.freeze([
  'queue_full', // 本地队列溢出，丢弃最旧事件
  'rate_limited', // 收到 429，进入退避重试
  'timeout', // 单次发送超过超时阈值被中止
  'invalid_payload', // 服务端判定载荷非法（4xx 契约错误）
  'storage_quota', // 持久化队列写入失败（IndexedDB / storage 配额）
  'dropped_by_sampling', // 被采样策略丢弃
  'beacon_rejected', // navigator.sendBeacon 返回 false
  'beacon_oversize', // 单条事件超过 Beacon 字节上限，无法发送
  'beacon_fallback', // Beacon 不可用或需鉴权，回退 fetch keepalive
  'beacon_queued', // Beacon 已接受排队（不代表服务端已入库）
  'beacon_attempted', // 尝试走 Beacon 通道
  'next_session_recovered', // 下一会话从持久队列恢复的事件数
  'server_deduplicated', // 服务端按 eventId 去重（来自后端指标，SDK 仅透传）
  'flush_attempt', // 发起一次在线发送
  'flush_success', // 在线发送成功入库
  'flush_failed', // 在线发送失败（不可重试被丢弃）
  'retry', // 可重试错误（429/5xx/超时），保留并重试
  'dropped_non_retryable', // 超过最大重试次数或 4xx 契约错误，永久丢弃
  'offline' // 处于离线状态，暂缓发送
])

/**
 * 创建诊断事件分发器。
 * 若调用方未提供 `onDiagnostic` 回调，则静默丢弃（不影响主流程）。
 * @param {(event: object) => void} [onDiagnostic]
 * @returns {{ emit: (type: string, detail?: object) => void }}
 */
export function createDiagnosticSink(onDiagnostic) {
  return {
    emit(type, detail = {}) {
      if (typeof onDiagnostic !== 'function') return
      // 诊断回调异常绝不能影响主发送链路。
      try {
        onDiagnostic({ type, ...detail, ts: Date.now() })
      } catch {}
    }
  }
}
