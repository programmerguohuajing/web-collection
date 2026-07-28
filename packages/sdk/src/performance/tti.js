/**
 * TTI（Time to Interactive）估算模块。
 *
 * 通过持续监听 longtask 条目，在页面卸载时估算 TTI。
 * 估算逻辑：LCP 时间点之后，若连续 5 秒内无超过 50ms 的 longtask，
 * 则 TTI ≈ 最后一个 longtask 结束时间 + 后续 5s 窗口内的阻塞时间。
 * 如浏览器不支持 longtask，降级为不上报。
 *
 * @param {object} opts
 * @param {Function} opts.metric - SDK 主实例的 metric 方法
 */
export function setupTtiMonitor({ metric }) {
  if (typeof window === 'undefined' || !('PerformanceObserver' in window)) return () => {}

  let lcpTime = 0
  let lastBlockingEnd = 0
  let totalBlockingAfterLcp = 0
  let inQuietWindow = false
  let quietStart = 0
  let quietAccum = 0
  let ttiValue = null

  // 捕获 LCP 时间点
  try {
    const lcpObs = new PerformanceObserver(list => {
      const entry = list.getEntries().at(-1)
      if (entry) lcpTime = entry.startTime
    })
    lcpObs.observe({ type: 'largest-contentful-paint', buffered: true })
  } catch {}

  // 监听 longtask
  try {
    const ltObs = new PerformanceObserver(list => {
      list.getEntries().forEach(entry => {
        const end = entry.startTime + entry.duration
        lastBlockingEnd = Math.max(lastBlockingEnd, end)
        const blocking = Math.max(0, entry.duration - 50)

        // 仅统计 LCP 之后的 longtask
        if (lcpTime > 0 && end > lcpTime) {
          totalBlockingAfterLcp += blocking

          // 5 秒静默窗口检测
          if (inQuietWindow && entry.startTime - quietStart > 5000) {
            // 超过 5 秒仍有 longtask，重置静默窗口
            inQuietWindow = false
          }
          if (!inQuietWindow) {
            inQuietWindow = true
            quietStart = entry.startTime
            quietAccum = blocking
          } else {
            quietAccum += blocking
          }
        }
      })
    })
    ltObs.observe({ type: 'longtask', buffered: true })
  } catch {}

  // 延迟检测静默窗口：LCP 后 5s 无 longtask 则估算 TTI
  const checkQuiet = () => {
    if (ttiValue !== null || lcpTime === 0) return
    // 如果 LCP 已发生且之后没有任何 longtask，直接估算
    if (totalBlockingAfterLcp === 0 && lastBlockingEnd > 0) {
      ttiValue = Math.round(lastBlockingEnd)
    }
  }

  // 在 LCP 后 6 秒检查（留 1s 余量）
  const lcpTimer = setTimeout(() => checkQuiet(), lcpTime > 0 ? lcpTime + 6000 : 10000)

  return () => {
    clearTimeout(lcpTimer)
    if (ttiValue !== null) {
      metric('tti', ttiValue, { method: 'longtask-estimate', cpuBusyTime: Math.round(totalBlockingAfterLcp) })
    }
  }
}
