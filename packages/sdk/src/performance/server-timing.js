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
  // 此模块提供解析工具，供 fetch.js 和 xhr.js 调用
  return {
    /**
     * 解析 Server-Timing header 值，提取每个指标的 name / description / duration
     * 格式参见 W3C Server-Timing 规范：https://w3c.github.io/server-timing/
     * 示例 header: "db;dur=53.2, cache;desc=hit;dur=0, app;dur=47.3"
     *
     * @param {string} headerValue - Server-Timing header 原始值
     * @returns {Array<{name: string, description: string, duration: number}>} 解析后的指标列表（最多 20 条）
     */
    parse(headerValue) {
      if (!headerValue) return []
      const entries = []
      const parts = headerValue.split(',')
      for (const part of parts) {
        const trimmed = part.trim()
        // 匹配结构：name[;desc=xxx][;dur=xxx]
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
