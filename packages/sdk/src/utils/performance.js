/**
 * 创建 PerformanceObserver 并观察指定类型的性能条目。
 * `buffered: true` 确保能获取到观察器创建之前已产生的条目。
 * try-catch 包裹防止浏览器不支持的类型抛出异常。
 *
 * @param {string} type - PerformanceObserver 支持的条目类型（如 'paint', 'largest-contentful-paint'）
 * @param {Function} handler - 每个性能条目的回调函数
 */
export function observe(type, handler) {
  try {
    new PerformanceObserver(list => list.getEntries().forEach(handler)).observe({ type, buffered: true })
  } catch {}
}

/**
 * 在页面完全加载后执行回调。
 * 如果页面已经加载完成则同步执行，否则监听 load 事件。
 *
 * @param {Function} fn - 页面就绪后的回调
 */
export function onReady(fn) {
  if (document.readyState === 'complete') fn()
  else addEventListener('load', fn, { once: true })
}
