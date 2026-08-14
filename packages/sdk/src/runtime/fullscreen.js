/**
 * 全屏状态监控模块（MDN: Fullscreen API）。
 *
 * 监听全屏进入/退出（视频/沉浸式应用常用），上报为 `fullscreen_change` 指标。
 *
 * @param {object} opts
 * @param {Function} opts.metric - SDK 性能/指标上报方法
 */
export function setupFullscreenMonitor({ metric }) {
  if (typeof document === 'undefined' || !('fullscreenEnabled' in document)) return () => {}

  const emit = () => {
    let tag = ''
    try {
      const el = document.fullscreenElement || document.webkitFullscreenElement
      tag = el && el.tagName ? String(el.tagName).toLowerCase() : ''
    } catch {}
    metric('fullscreen_change', 0, {
      isFullscreen: !!(document.fullscreenElement || document.webkitFullscreenElement),
      element: tag
    })
  }

  document.addEventListener('fullscreenchange', emit)
  document.addEventListener('webkitfullscreenchange', emit)

  return () => {
    document.removeEventListener('fullscreenchange', emit)
    document.removeEventListener('webkitfullscreenchange', emit)
  }
}
