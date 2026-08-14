/**
 * Service Worker 状态监控模块。
 *
 * 采集 Service Worker 的注册状态、更新和错误事件。
 * 在原始 active/updated 基础上补齐完整生命周期：installing / installed / waiting /
 * redundant / updatefound / controllerchange / messageerror（MDN: Service Worker API）。
 *
 * @param {object} opts
 * @param {Function} opts.metric - SDK 主实例的 metric 方法
 * @param {Function} opts.error - SDK 主实例的 error 方法
 */
export function setupServiceWorkerMonitor({ metric, error }) {
  if (!('serviceWorker' in navigator)) return () => {}

  const reportSwState = (scriptURL, state) => {
    if (!scriptURL) return
    metric('service_worker_' + state, 0, { scriptURL })
  }

  const attachRegistration = (registration) => {
    if (!registration) return
    const onChange = (state) => reportSwState(registration.active?.scriptURL || registration.installing?.scriptURL || registration.waiting?.scriptURL || '', state)
    if (registration.installing) reportSwState(registration.installing.scriptURL, 'installing')
    if (registration.waiting) reportSwState(registration.waiting.scriptURL, 'waiting')
    if (registration.active) reportSwState(registration.active.scriptURL, 'activated')

    // 监听注册更新（新 SW 被发现）
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing
      reportSwState(installing?.scriptURL, 'updatefound')
      if (installing) {
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed') reportSwState(installing.scriptURL, 'installed')
          if (installing.state === 'redundant') reportSwState(installing.scriptURL, 'redundant')
        })
      }
    })
    void onChange
  }

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

  // 已有权衡：等待 ready 解析出 registration，补全 installing/waiting/activated 状态
  let stopped = false
  if (navigator.serviceWorker.ready && typeof navigator.serviceWorker.ready.then === 'function') {
    navigator.serviceWorker.ready.then(registration => {
      if (!stopped) attachRegistration(registration)
    }).catch(() => {})
    navigator.serviceWorker.getRegistrations?.().then(regs => {
      if (stopped) return
      for (const reg of regs) attachRegistration(reg)
    }).catch(() => {})
  }

  return () => { stopped = true }
}
