/**
 * 初始化路由变化监控。
 * 劫持 history.pushState / replaceState 方法，并监听 hashchange 和 popstate 事件，
 * 在 SPA 路由切换时上报 from → to 的路由变更事件。
 * 同时触发 onRoute 回调用于回放事件分段。
 *
 * @param {object} opts
 * @param {Function} opts.push - SDK 主实例的事件推入方法
 * @param {Function} [opts.onRoute] - 路由变化时的回调（用于回放分段切割）
 */
export function setupRouteMonitor({ push, onRoute }) {
  let last = location.href
  const restores = [wrapHistory('pushState'), wrapHistory('replaceState')]
  const onHashChange = event => route(event.oldURL, event.newURL, 'hashchange')
  const onPopState = () => route(last, location.href, 'popstate')
  addEventListener('hashchange', onHashChange)
  addEventListener('popstate', onPopState)

  /**
   * 劫持 history 方法，在原始调用后触发路由变更事件。
   * @param {'pushState'|'replaceState'} method - history 方法名
   */
  function wrapHistory(method) {
    const original = history[method]
    history[method] = function (...args) {
      const from = location.href
      const result = original.apply(this, args)
      route(from, location.href, method)
      return result
    }
    return () => { history[method] = original }
  }

  /**
   * 推入一条路由变更事件，并在页面切换时触发回放分段。
   * @param {string} from - 来源 URL
   * @param {string} to - 目标 URL
   * @param {string} name - 触发方式（pushState / replaceState / hashchange / popstate）
   */
  function route(from, to, name) {
    last = to
    // 页面切换时结束当前回放段，开启新段
    if (typeof onRoute === 'function') onRoute(from, to, name)
    push({ type: 'behavior', name, props: { from, to } })
  }
  return () => {
    restores.forEach(restore => restore())
    removeEventListener('hashchange', onHashChange)
    removeEventListener('popstate', onPopState)
  }
}
