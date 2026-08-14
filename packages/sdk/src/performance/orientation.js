/**
 * 屏幕方向变化监控模块（MDN: Screen Orientation API）。
 *
 * 环境指纹已采集方向快照；本模块补充 `orientationchange` 事件，
 * 实时上报方向类型与角度变化。
 *
 * 上报为 `orientation_change` 指标。
 *
 * @param {object} opts
 * @param {Function} opts.metric - SDK 性能/指标上报方法
 */
export function setupOrientationMonitor({ metric }) {
  if (typeof screen === 'undefined') return () => {}
  const orientation = screen.orientation
  if (!orientation || typeof orientation.addEventListener !== 'function') {
    // 旧浏览器回退到 window.orientationchange
    if (typeof addEventListener === 'undefined') return () => {}
    const onWinChange = () => metric('orientation_change', 0, { angle: (typeof window !== 'undefined' && window.orientation) || 0 })
    addEventListener('orientationchange', onWinChange)
    return () => removeEventListener('orientationchange', onWinChange)
  }

  const onOrient = () => metric('orientation_change', 0, { type: orientation.type || '', angle: orientation.angle || 0 })
  orientation.addEventListener('change', onOrient)
  return () => { try { orientation.removeEventListener('change', onOrient) } catch {} }
}
