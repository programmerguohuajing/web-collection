/**
 * SSE（Server-Sent Events）性能监控
 * 通过 monkey-patch 原生 EventSource 构造函数，拦截所有 SSE 连接并记录：
 *   - open 耗时（连接建立时间）
 *   - 收到消息数 & 字节数
 *   - close 时人工调用 close 的连通时长 & 统计
 *   - error 连接异常（附带调用栈信息，便于定位发起方）
 *
 * 注意：SSE 的 close 是主动行为，不触发 close 事件，因此需要重写 close 方法来记录。
 *
 * @param {{ metric: Function, error: Function }} options
 */
export function setupSseMonitor({ metric, error }) {
  const NativeEventSource = window.EventSource
  if (!NativeEventSource) return

  // 用自定义构造函数替换原生 EventSource
  window.EventSource = function (url, init) {
    const start = performance.now()
    // 捕获调用方堆栈，去前 2 帧（构造函数自身帧），用于错误定位
    const stack = new Error('SseError').stack?.split('\n') || []
    const callerStack = [stack[0], ...stack.slice(2)].filter(Boolean).join('\n')
    const source = new NativeEventSource(url, init)
    const target = String(url)
    let messages = 0  // 累计消息数
    let bytes = 0     // 累计字节数
    const close = source.close  // 保存原生 close 引用

    // 连接打开：上报建连耗时
    source.addEventListener('open', () => {
      metric('sse', performance.now() - start, { url: target, phase: 'open', withCredentials: source.withCredentials })
    }, { once: true })

    // 收到消息：累加计数
    source.addEventListener('message', event => {
      messages++
      bytes += String(event.data || '').length
    })

    // 连接异常：上报错误（附调用方堆栈，方便定位是哪个业务代码发起的 SSE）
    source.addEventListener('error', event => {
      const failure = new Error('SseError')
      if (callerStack) failure.stack = callerStack
      error(failure, { name: 'SseError', source: target, readyState: source.readyState, eventType: event.type })
    })

    // 重写 close：在关闭前上报统计信息
    source.close = function () {
      metric('sse', performance.now() - start, { url: target, phase: 'close', messages, bytes })
      return close.call(source)
    }

    return source
  }
  // 恢复原型链及静态常量
  window.EventSource.prototype = NativeEventSource.prototype
  window.EventSource.CONNECTING = NativeEventSource.CONNECTING
  window.EventSource.OPEN = NativeEventSource.OPEN
  window.EventSource.CLOSED = NativeEventSource.CLOSED
}
