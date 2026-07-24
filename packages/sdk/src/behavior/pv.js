/**
 * 初始化页面访问（PV）监控。
 * 页面加载时立即上报一次 PV 事件，并携带来源页 referrer。
 * 同时监听 visibilitychange，在页面隐藏时上报停留时长（page_leave），
 * 页面恢复可见时重置计时器。
 *
 * @param {object} opts
 * @param {Function} opts.push - SDK 主实例的事件推入方法
 */
export function setupPvMonitor({ push }) {
  let enterTime = Date.now()
  const onVisibilityChange = () => {
    if (document.hidden) push({ type: 'behavior', name: 'page_leave', props: { stayTime: Date.now() - enterTime } })
    else enterTime = Date.now()
  }
  push({ type: 'behavior', name: 'pv', props: { referrer: document.referrer } })
  document.addEventListener('visibilitychange', onVisibilityChange)
  return () => document.removeEventListener('visibilitychange', onVisibilityChange)
}
