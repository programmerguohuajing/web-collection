import { elementInfo } from '../utils/dom.js'

/**
 * 初始化元素曝光监控。
 *
 * 使用 IntersectionObserver 监听带有 `data-track-exposure` 属性的元素，
 * 当元素可见面积 ≥ 50% 且持续 1 秒时判定为有效曝光并上报。
 * 同时通过 MutationObserver 监听 DOM 变化，动态注册新增的曝光元素。
 * 已曝光过的元素不会重复上报（WeakSet 去重）。
 *
 * @param {object} opts
 * @param {Function} opts.push - SDK 主实例的事件推入方法
 */
export function setupExposureMonitor({ push }) {
  if (!('IntersectionObserver' in window)) return () => {}
  const seen = new WeakSet()
  const timers = new WeakMap()
  const timerIds = new Set()
  const io = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (seen.has(entry.target)) return
      if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
        // 可见且占比 ≥ 50%，启动 1 秒计时器，避免快速滚动误判
        const timer = setTimeout(() => {
          seen.add(entry.target)
          timerIds.delete(timer)
          push({ type: 'behavior', name: 'exposure', props: elementInfo(entry.target) })
        }, 1000)
        timers.set(entry.target, timer)
        timerIds.add(timer)
      } else {
        // 不可见或占比不足，取消计时
        const timer = timers.get(entry.target)
        clearTimeout(timer)
        timerIds.delete(timer)
      }
    })
  }, { threshold: [0.5] })

  // 初始扫描已有 DOM 节点
  observeNode(document)
  // 监听 DOM 变化，动态注册新增的曝光元素
  const mutationObserver = new MutationObserver(list => list.forEach(item => item.addedNodes.forEach(observeNode)))
  mutationObserver.observe(document.documentElement, { childList: true, subtree: true })

  /**
   * 检查节点是否包含曝光标记，如果是则注册到 IntersectionObserver。
   * @param {Node} node - DOM 节点
   */
  function observeNode(node) {
    if (node.nodeType !== 1 && node !== document) return
    if (node.matches?.('[data-track-exposure]')) io.observe(node)
    node.querySelectorAll?.('[data-track-exposure]').forEach(el => io.observe(el))
  }
  return () => {
    io.disconnect()
    mutationObserver.disconnect()
    timerIds.forEach(timer => clearTimeout(timer))
    timerIds.clear()
  }
}
