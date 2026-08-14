/**
 * 页面生命周期 & bfcache 监控模块（MDN: Page Lifecycle / back/forward cache）。
 *
 * 采集后台冻结(freeze/resume)与 bfcache 命中/未命中，用于量化二次访问速度
 * 与后台冻结体验。当前 SDK 仅在 pagehide 做冲刷、不区分是否走 bfcache。
 *
 * 上报为 `page_lifecycle` 指标，state ∈
 *   freeze / resume / bfcache_restore / bfcache_attempt / page_unload
 *
 * @param {object} opts
 * @param {Function} opts.metric - SDK 性能/指标上报方法
 */
export function setupLifecycleMonitor({ metric }) {
  if (typeof document === 'undefined') return () => {}
  if (typeof addEventListener === 'undefined') return () => {}

  const emit = (state, extra = {}) => metric('page_lifecycle', 0, { state, ...extra })

  const onPageShow = (e) => {
    // pageshow.persisted === true 表示页面来自 bfcache（前进/后退缓存命中）
    emit(e.persisted ? 'bfcache_restore' : 'pageshow', { persisted: !!e.persisted })
  }
  const onPageHide = (e) => {
    // pagehide.persisted === true 表示页面正进入 bfcache（缓存尝试）
    emit(e.persisted ? 'bfcache_attempt' : 'page_unload', { persisted: !!e.persisted })
  }
  const onFreeze = () => emit('freeze')
  const onResume = () => emit('resume')

  addEventListener('pageshow', onPageShow, { passive: true })
  addEventListener('pagehide', onPageHide, { passive: true })
  // freeze/resume 挂在 document 上（Page Lifecycle 规范）
  document.addEventListener('freeze', onFreeze, { passive: true })
  document.addEventListener('resume', onResume, { passive: true })

  return () => {
    removeEventListener('pageshow', onPageShow)
    removeEventListener('pagehide', onPageHide)
    document.removeEventListener('freeze', onFreeze)
    document.removeEventListener('resume', onResume)
  }
}
