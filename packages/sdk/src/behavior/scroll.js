/**
 * 初始化滚动深度监控。
 * 使用 passive 监听全局 scroll 事件，实时计算当前滚动深度百分比和最大深度。
 * 采用 500ms 防抖策略，避免滚动过程中频繁上报。
 *
 * @param {object} opts
 * @param {Function} opts.push - SDK 主实例的事件推入方法
 */
export function setupScrollMonitor({ push }) {
  let maxDepth = 0
  let scrollTimer = 0
  const onScroll = () => {
    const total = document.documentElement.scrollHeight - innerHeight
    const depth = total > 0 ? Math.round((scrollY / total) * 100) : 0
    maxDepth = Math.max(maxDepth, depth)
    clearTimeout(scrollTimer)
    scrollTimer = setTimeout(() => push({ type: 'behavior', name: 'scroll', props: { depth, maxDepth } }), 500)
  }
  addEventListener('scroll', onScroll, { passive: true })
  return () => { clearTimeout(scrollTimer); removeEventListener('scroll', onScroll, { passive: true }) }
}
