/**
 * Service Worker 状态监控模块。
 *
 * 采集 Service Worker 的注册状态、更新和错误事件。
 *
 * @param {object} opts
 * @param {Function} opts.metric - SDK 主实例的 metric 方法
 * @param {Function} opts.error - SDK 主实例的 error 方法
 */
export function setupServiceWorkerMonitor({ metric, error }) {
  if (!('serviceWorker' in navigator)) return () => {}

  // 注册状态
  if (navigator.serviceWorker.controller) {
    reportSwState(navigator.serviceWorker.controller?.scriptURL, 'active')
  }

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (navigator.serviceWorker.controller) {
      reportSwState(navigator.serviceWorker.controller.scriptURL, 'updated')
    }
  })

  navigator.serviceWorker.addEventListener('messageerror', event => {
    error(new Error('ServiceWorkerMessageError'), {
      name: 'ServiceWorkerError',
      source: 'messageerror'
    })
  })

  return () => {}
}

/**
 * 上报 Service Worker 状态变化
 * @param {string} scriptURL - Service Worker 脚本地址
 * @param {'active'|'updated'} state - 当前状态（已激活 / 已更新）
 */
function reportSwState(scriptURL, state) {
  if (!scriptURL) return
  metric('service_worker_' + state, 0, { scriptURL })
}
