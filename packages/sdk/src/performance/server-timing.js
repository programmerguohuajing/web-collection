/**
 * Server-Timing 采集模块。
 *
 * 读取 fetch 和 XHR 响应的 Server-Timing header，
 * 附加到对应的 metric 事件 props 中。
 *
 * @param {object} opts
 * @param {Function} opts.metric - SDK 主实例的 metric 方法（用于直接附加 serverTiming）
 */
export function setupServerTimingMonitor({ metric }) {
  // Server-Timing 数据通过 fetch/xhr 拦截器直接附加到对应 metric 的 props 中
  // 此模块提供了解析工具，供 fetch.js 和 xhr.js 调用
  return {
    parse(headerValue) {
      if (!headerValue) return []
      const entries = []
      const parts = headerValue.split(',')
      for (const part of parts) {
        const trimmed = part.trim()
        const match = trimmed.match(/^([^;=]+)(?:;desc=([^;]+))?(?:;dur=([\d.]+))?/)
        if (match) {
          entries.push({
            name: match[1].trim(),
            description: match[2] ? decodeURIComponent(match[2].trim()) : '',
            duration: match[3] ? parseFloat(match[3]) : 0
          })
        }
      }
      return entries.slice(0, 20)
    }
  }
}
