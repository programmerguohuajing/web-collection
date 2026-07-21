export function setupSseMonitor({ metric, error }) {
  const NativeEventSource = window.EventSource
  if (!NativeEventSource) return

  window.EventSource = function (url, init) {
    const start = performance.now()
    const source = new NativeEventSource(url, init)
    const target = String(url)
    let messages = 0
    let bytes = 0
    const close = source.close

    source.addEventListener('open', () => {
      metric('sse', performance.now() - start, { url: target, phase: 'open', withCredentials: source.withCredentials })
    }, { once: true })
    source.addEventListener('message', event => {
      messages++
      bytes += String(event.data || '').length
    })
    source.addEventListener('error', event => {
      error(new Error('SseError'), { name: 'SseError', source: target, readyState: source.readyState, eventType: event.type })
    })
    source.close = function () {
      metric('sse', performance.now() - start, { url: target, phase: 'close', messages, bytes })
      return close.call(source)
    }

    return source
  }
  window.EventSource.prototype = NativeEventSource.prototype
  window.EventSource.CONNECTING = NativeEventSource.CONNECTING
  window.EventSource.OPEN = NativeEventSource.OPEN
  window.EventSource.CLOSED = NativeEventSource.CLOSED
}
