/**
 * 内存使用监控模块。
 *
 * 采集 Chrome 提供的 performance.memory 数据，监控 JS 堆内存使用情况。
 * 不支持时静默跳过，不报错。
 *
 * @param {object} opts
 * @param {Function} opts.metric - SDK 主实例的 metric 方法
 * @param {number} [opts.interval=60000] - 周期性采样间隔（ms），0 表示不周期性采样
 */
export function setupMemoryMonitor({ metric, interval = 60000 }) {
  const mem = typeof performance !== 'undefined' ? performance.memory : null
  if (!mem) return () => {}

  let timer = 0

  /**
   * 上报当前内存使用快照
   * @param {'periodic'|'final'} phase - 上报时机：periodic（周期采样）/ final（销毁时最后一次）
   */
  function report(phase) {
    metric('memory', mem.usedJSHeapSize, {
      totalJSHeapSize: mem.totalJSHeapSize,
      jsHeapSizeLimit: mem.jsHeapSizeLimit,
      phase
    })
  }

  if (interval > 0) {
    timer = setInterval(() => report('periodic'), interval)
  }

  return () => {
    clearInterval(timer)
    report('final')  // 销毁前最后一次采样
  }
}
