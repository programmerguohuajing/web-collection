/**
 * @file 应用生命周期插桩：Electron app 事件 → 内核 behavior / perf 事件
 *
 * 事件映射（全部复用后端事件类型白名单，语义在 name/props 上）：
 *   app 'ready'                → behavior('app_start', {platform, electronVersion, appVersion})
 *                                 + perf(metric='app_ready', value=进程启动→ready 毫秒)  // 冷启动
 *   app 'browser-window-focus' → behavior('app_foreground')
 *   app 'browser-window-blur'  → behavior('app_background')
 *   app 'window-all-closed'    → flush(true)（会话收尾，不销毁——应用可能被单例重新拉起窗口）
 *   app 'before-quit'          → flush(true)（退出前强制冲刷，杜绝尾部事件丢失）
 *
 * 所有监听经 guard 包装：回调异常只记诊断，绝不影响 app 自身事件派发。
 */
import { METRIC_APP_READY } from './constants.js'
import { guard } from './guard.js'

/**
 * 创建生命周期插桩器
 * @param {object} options
 * @param {object} options.app              Electron app 对象（依赖注入）
 * @param {object} options.client           平台内核 client（behavior/metric/flush）
 * @param {{ emit?: Function }} [options.diagnostics] 诊断出口
 * @param {() => number} [options.processUptimeMs] 进程已运行毫秒（缺省读 nodeProcess.uptime()*1000）
 * @param {object} [options.deviceContext]  附着在 app_start props 上的设备信息
 * @returns {{ install: () => void, dispose: () => void }}
 */
export function createLifecycleInstrumentor(options = {}) {
  const app = options.app
  const client = options.client
  const diagnostics = options.diagnostics || null
  const deviceContext = options.deviceContext || {}
  const uptimeMs = options.processUptimeMs || defaultUptimeMs
  const disposers = []
  let installed = false
  let readyReported = false
  let lastForeground = null  // 去抖：连续 focus/blur 抖动只报状态真实切换

  return {
    install,
    dispose
  }

  function install() {
    if (installed || !app || typeof app.on !== 'function' || !client) return
    installed = true
    on(app, 'ready', () => {
      if (readyReported) return
      readyReported = true
      client.behavior('app_start', { ...deviceContext })
      client.metric(METRIC_APP_READY, uptimeMs(), { ...deviceContext })
    })
    on(app, 'browser-window-focus', () => {
      if (lastForeground === true) return
      lastForeground = true
      client.behavior('app_foreground')
    })
    on(app, 'browser-window-blur', () => {
      if (lastForeground === false) return
      lastForeground = false
      client.behavior('app_background')
    })
    on(app, 'window-all-closed', () => {
      try { client.flush(true) } catch { /* flush 内部已兜底，双保险 */ }
    })
    on(app, 'before-quit', () => {
      try { client.flush(true) } catch { /* 双保险 */ }
    })
  }

  function dispose() {
    disposers.splice(0).forEach(dispose => dispose?.())
    installed = false
  }

  /** 订阅 app 事件（Electron 移除监听需要原始函数引用，此处统一管理并登记 disposer） */
  function on(target, event, handler) {
    const wrapped = guard(handler, `lifecycle.${event}`, diagnostics)
    try {
      target.on(event, wrapped)
      disposers.push(() => {
        try { target.removeListener(event, wrapped) } catch { /* 静默 */ }
      })
    } catch (error) {
      try { diagnostics?.emit?.('sdk_internal_error', { module: `lifecycle.${event}`, reason: error?.name || 'Error' }) } catch { /* 静默 */ }
    }
  }
}

function defaultUptimeMs() {
  const proc = globalThis.process
  try {
    return Math.round((proc?.uptime?.() || 0) * 1000)
  } catch {
    return 0
  }
}
