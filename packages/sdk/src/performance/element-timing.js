/**
 * 元素级性能监控模块（MDN: PerformanceElementTiming）。
 *
 * 订阅 PerformanceObserver 的 'element' 条目，采集被页面用 `elementtiming`
 * 属性标记的关键元素（通常含 LCP 元素）的耗时与归属，补足当前 LCP 仅有时间点、
 * 不给元素的缺口。
 *
 * 上报为 `element_timing` 指标：name(identifier) / renderTime / loadTime / size / tagName。
 *
 * @param {object} opts
 * @param {Function} opts.metric - SDK 性能/指标上报方法
 */
export function setupElementTimingMonitor({ metric }) {
  if (typeof PerformanceObserver === 'undefined') return () => {}
  try {
    if (!Array.isArray(PerformanceObserver.supportedEntryTypes) || !PerformanceObserver.supportedEntryTypes.includes('element')) {
      return () => {}
    }
  } catch { return () => {} }

  let observer
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        let tagName = ''
        try { tagName = entry.element && entry.element.tagName ? String(entry.element.tagName).toLowerCase() : '' } catch {}
        metric('element_timing', entry.startTime || 0, {
          name: entry.identifier || entry.name || '',
          renderTime: entry.renderTime || 0,
          loadTime: entry.loadTime || 0,
          size: entry.size || 0,
          tagName
        })
      }
    })
    observer.observe({ type: 'element', buffered: true })
  } catch {
    return () => {}
  }

  return () => { try { observer.disconnect() } catch {} }
}
