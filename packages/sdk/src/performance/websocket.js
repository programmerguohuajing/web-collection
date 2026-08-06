/**
 * WebSocket 性能监控
 * 通过 monkey-patch 原生 WebSocket 构造函数，拦截所有 WebSocket 连接并记录：
 *   - open 耗时（连接建立时间）
 *   - 收发消息数 & 字节数
 *   - close 连接总时长、关闭码
 *   - error 异常事件
 *
 * @param {{ metric: Function, error: Function }} options
 */
export function setupWebSocketMonitor({ metric, error }) {
  // 保存原生 WebSocket 构造函数引用
  const NativeWebSocket = window.WebSocket
  if (!NativeWebSocket) return

  // 用自定义构造函数替换原生 WebSocket
  window.WebSocket = function (url, protocols) {
    const start = performance.now()
    // 根据是否传 protocols 参数，调用对应原生构造函数创建实例
    const socket = protocols == null ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols)
    const target = String(url)
    let messages = 0  // 累计消息数
    let bytes = 0     // 累计字节数

    // 连接打开：上报建连耗时
    socket.addEventListener('open', () => {
      metric('websocket', performance.now() - start, { url: target, phase: 'open', protocol: socket.protocol })
    }, { once: true })

    // 收到消息：累加计数
    socket.addEventListener('message', event => {
      messages++
      bytes += payloadSize(event.data)
    })

    // 连接关闭：上报总时长及统计信息
    socket.addEventListener('close', event => {
      metric('websocket', performance.now() - start, { url: target, phase: 'close', code: event.code, reason: event.reason, wasClean: event.wasClean, messages, bytes })
    }, { once: true })

    // 连接异常：上报错误信息
    socket.addEventListener('error', event => {
      error(new Error('WebSocketError'), { name: 'WebSocketError', source: target, readyState: socket.readyState, eventType: event.type })
    }, { once: true })

    return socket
  }
  // 恢复原型链及静态常量，保证 instanceof 和常量引用正常
  window.WebSocket.prototype = NativeWebSocket.prototype
  window.WebSocket.CONNECTING = NativeWebSocket.CONNECTING
  window.WebSocket.OPEN = NativeWebSocket.OPEN
  window.WebSocket.CLOSING = NativeWebSocket.CLOSING
  window.WebSocket.CLOSED = NativeWebSocket.CLOSED
}

/**
 * 计算 WebSocket 消息载荷大小（字节）
 * - String  → 字符数（近似字节数）
 * - Blob/ArrayBuffer → byteLength
 * - 其他（如 ArrayBufferView）→ size 属性
 * @param {*} data
 * @returns {number}
 */
function payloadSize(data) {
  if (typeof data === 'string') return data.length
  if (data?.byteLength) return data.byteLength
  if (data?.size) return data.size
  return 0
}
