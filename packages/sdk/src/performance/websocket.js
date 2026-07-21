export function setupWebSocketMonitor({ metric, error }) {
  const NativeWebSocket = window.WebSocket
  if (!NativeWebSocket) return

  window.WebSocket = function (url, protocols) {
    const start = performance.now()
    const socket = protocols == null ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols)
    const target = String(url)
    let messages = 0
    let bytes = 0

    socket.addEventListener('open', () => {
      metric('websocket', performance.now() - start, { url: target, phase: 'open', protocol: socket.protocol })
    }, { once: true })
    socket.addEventListener('message', event => {
      messages++
      bytes += payloadSize(event.data)
    })
    socket.addEventListener('close', event => {
      metric('websocket', performance.now() - start, { url: target, phase: 'close', code: event.code, reason: event.reason, wasClean: event.wasClean, messages, bytes })
    }, { once: true })
    socket.addEventListener('error', event => {
      error(new Error('WebSocketError'), { name: 'WebSocketError', source: target, readyState: socket.readyState, eventType: event.type })
    }, { once: true })

    return socket
  }
  window.WebSocket.prototype = NativeWebSocket.prototype
  window.WebSocket.CONNECTING = NativeWebSocket.CONNECTING
  window.WebSocket.OPEN = NativeWebSocket.OPEN
  window.WebSocket.CLOSING = NativeWebSocket.CLOSING
  window.WebSocket.CLOSED = NativeWebSocket.CLOSED
}

function payloadSize(data) {
  if (typeof data === 'string') return data.length
  if (data?.byteLength) return data.byteLength
  if (data?.size) return data.size
  return 0
}
