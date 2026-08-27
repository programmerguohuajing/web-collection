/**
 * 初始化页面访问（PV）与页面参与度监控（PRD 06）。
 *
 * - 页面加载时立即上报一次 PV 事件，并携带来源页 referrer；
 * - visibilitychange→hidden 时上报 page_leave：兼容保留 props.stayTime，
 *   并在 context 携带参与度字段 dwell_ms（可见停留）/ scroll_max / scroll_buckets /
 *   tab_hidden_ms / interacted，供页面参与度报表消费；旧字段不受影响。
 *
 * @param {object} opts
 * @param {Function} opts.push - SDK 主实例的事件推入方法
 */
export function setupPvMonitor({ push }) {
  let enterTime = Date.now()
  // 参与度累计状态（每次可见周期重置）
  let dwellMs = 0
  let visibleSince = Date.now()
  let tabHiddenMs = 0
  let hiddenSince = 0
  let interacted = false
  const scrollBuckets = { s25: false, s50: false, s75: false, s100: false }
  let scrollMax = 0

  const onScroll = () => {
    const doc = document.documentElement
    const scrollable = doc.scrollHeight - window.innerHeight
    if (scrollable <= 0) return
    const depth = Math.max(0, Math.min(1, (window.scrollY || doc.scrollTop || 0) / scrollable))
    if (depth > scrollMax) scrollMax = depth
    if (depth >= 0.25) scrollBuckets.s25 = true
    if (depth >= 0.5) scrollBuckets.s50 = true
    if (depth >= 0.75) scrollBuckets.s75 = true
    if (depth >= 0.999) scrollBuckets.s100 = true
  }
  const onInteract = () => { interacted = true }

  const onVisibilityChange = () => {
    if (document.hidden) {
      const now = Date.now()
      const stayed = now - enterTime
      dwellMs += now - visibleSince
      if (hiddenSince) tabHiddenMs += now - hiddenSince
      hiddenSince = now
      push({
        type: 'behavior',
        name: 'page_leave',
        props: { stayTime: stayed },
        context: {
          dwell_ms: dwellMs,
          scroll_max: Number(scrollMax.toFixed(3)),
          scroll_buckets: { ...scrollBuckets },
          tab_hidden_ms: tabHiddenMs,
          interacted
        }
      })
    } else {
      enterTime = Date.now()
      visibleSince = Date.now()
      hiddenSince = 0
      // 新的可见周期重新累计参与度
      dwellMs = 0
      tabHiddenMs = 0
      scrollMax = 0
      for (const key of Object.keys(scrollBuckets)) scrollBuckets[key] = false
      interacted = false
    }
  }

  push({ type: 'behavior', name: 'pv', props: { referrer: document.referrer } })
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('scroll', onScroll, { passive: true, capture: true })
  window.addEventListener('click', onInteract, { capture: true, passive: true })
  window.addEventListener('keydown', onInteract, { capture: true, passive: true })
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('scroll', onScroll, { capture: true })
    window.removeEventListener('click', onInteract, { capture: true })
    window.removeEventListener('keydown', onInteract, { capture: true })
  }
}
