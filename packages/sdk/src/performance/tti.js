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

  let lcpTime = 0             // LCP（最大内容绘制）时间点
  let lastBlockingEnd = 0     // 最后一个 longtask 结束时间
  let totalBlockingAfterLcp = 0  // LCP 之后的累计阻塞时间（>50ms 部分）
  let inQuietWindow = false   // 是否处于 5 秒静默窗口检测中
  let quietStart = 0           // 静默窗口起始时间
  let quietAccum = 0           // 当前静默窗口内累计阻塞时间
  let ttiValue = null          // 最终 TTI 估算值

  // 捕获 LCP 时间点
  try {
    const lcpObs = new PerformanceObserver(list => {
      const entry = list.getEntries().at(-1)
      if (entry) lcpTime = entry.startTime
    })
    lcpObs.observe({ type: 'largest-contentful-paint', buffered: true })
  } catch {}

  // 持续监听 longtask（>50ms 的执行任务）
  try {
    const ltObs = new PerformanceObserver(list => {
      list.getEntries().forEach(entry => {
        const end = entry.startTime + entry.duration
        lastBlockingEnd = Math.max(lastBlockingEnd, end)
        const blocking = Math.max(0, entry.duration - 50)  // 只计超过 50ms 的部分（TBT 定义）

        // 仅统计 LCP 之后的 longtask
        if (lcpTime > 0 && end > lcpTime) {
          totalBlockingAfterLcp += blocking

          // 5 秒静默窗口检测：若静默窗口内出现 longtask，重置窗口
          if (inQuietWindow && entry.startTime - quietStart > 5000) {
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

  /**
   * 延迟检测静默窗口：在 LCP 之后若 5 秒内无 longtask，则 TTI ≈ 最后一个 longtask 的结束时间
   * 这是 TTI 的"无 longtask"情况下的简化估算
   */
  const checkQuiet = () => {
    if (ttiValue !== null || lcpTime === 0) return
    if (totalBlockingAfterLcp === 0 && lastBlockingEnd > 0) {
      ttiValue = Math.round(lastBlockingEnd)
    }
  }

  // 在 LCP 后 6 秒检查（预留 1s 余量），若 LCP 未知则 10 秒后检查
  const lcpTimer = setTimeout(() => checkQuiet(), lcpTime > 0 ? lcpTime + 6000 : 10000)

  return () => {
    clearTimeout(lcpTimer)
    if (ttiValue !== null) {
      metric('tti', ttiValue, { method: 'longtask-estimate', cpuBusyTime: Math.round(totalBlockingAfterLcp) })
    }
  }
}
