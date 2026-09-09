/**
 * @file 崩溃捕获：主进程未捕获异常 + 渲染进程崩溃 / preload 失败
 *
 * 事件映射（type 全部为后端白名单 'error'，crash 来源在 props.crash_source 上）：
 *   process 'uncaughtException'    → error(err,  { crash_source: 'main_uncaughtException' })
 *   process 'unhandledRejection'   → error(err,  { crash_source: 'main_unhandledRejection' })
 *   webContents 'render-process-gone' → error(Error, { crash_source: 'renderer_gone', reason, exitCode })
 *   webContents 'preload-error'       → error(err,  { crash_source: 'preload_error', file })
 *
 * ⚠️ uncaughtException 处理器**只采集不吞异常**：上报后按 Electron 官方建议交还默认行为
 *    （参数 rethrow 默认 false 时仅记录；宿主可传 onFatal 决定是否退出）。
 *    本模块绝不调用 process.exit / app.quit —— 退出决策权在宿主。
 */
import { guard } from './guard.js'

/**
 * 创建主进程崩溃监控
 * @param {object} options
 * @param {object} options.nodeProcess       主进程 process 对象（依赖注入；Electron 主进程即 globalThis.process）
 * @param {object} options.client            平台内核 client（error()）
 * @param {{ emit?: Function }} [options.diagnostics] 诊断出口
 * @returns {{ install: () => void, dispose: () => void }}
 */
export function createCrashMonitor(options = {}) {
  const proc = options.nodeProcess || globalThis.process
  const client = options.client
  const diagnostics = options.diagnostics || null
  const disposers = []
  let installed = false

  return {
    install,
    dispose
  }

  function install() {
    if (installed || !proc || !client) return
    installed = true
    // 进程级崩溃：只读采集，不改变宿主退出行为。
    listen(proc, 'uncaughtException', (err) => {
      client.error(err instanceof Error ? err : new Error(String(err)), { crash_source: 'main_uncaughtException' })
    })
    listen(proc, 'unhandledRejection', (reason) => {
      client.error(reason instanceof Error ? reason : new Error(String(reason)), { crash_source: 'main_unhandledRejection' })
    })
  }

  function dispose() {
    disposers.splice(0).forEach(dispose => dispose?.())
    installed = false
  }

  function listen(target, event, handler) {
    const wrapped = guard(handler, `crash.${event}`, diagnostics)
    try {
      target.on(event, wrapped)
      disposers.push(() => {
        try { target.removeListener(event, wrapped) } catch { /* 静默 */ }
      })
    } catch (error) {
      try { diagnostics?.emit?.('sdk_internal_error', { module: `crash.${event}`, reason: error?.name || 'Error' }) } catch { /* 静默 */ }
    }
  }
}

/**
 * 渲染进程看门狗：挂到某个 webContents 上，捕获渲染进程崩溃与 preload 加载失败。
 * 主进程为每个窗口调用一次；新窗口在 'browser-window-created' 后自行补挂。
 * @param {object} webContents Electron webContents 对象（依赖注入）
 * @param {object} client      平台内核 client
 * @param {{ emit?: Function }} [diagnostics] 诊断出口
 * @returns {() => void} 取消监听函数
 */
export function attachRendererWatchdog(webContents, client, diagnostics = null) {
  if (!webContents || typeof webContents.on !== 'function' || !client) return () => {}
  const disposers = []
  const on = (event, handler) => {
    const wrapped = guard(handler, `crash.renderer.${event}`, diagnostics)
    try {
      webContents.on(event, wrapped)
      disposers.push(() => {
        try { webContents.removeListener(event, wrapped) } catch { /* 静默 */ }
      })
    } catch (error) {
      try { diagnostics?.emit?.('sdk_internal_error', { module: `crash.renderer.${event}`, reason: error?.name || 'Error' }) } catch { /* 静默 */ }
    }
  }
  on('render-process-gone', (event, details = {}) => {
    client.error(new Error(`renderer process gone: ${details.reason || 'unknown'}`), {
      crash_source: 'renderer_gone',
      reason: details.reason || '',
      exitCode: Number(details.exitCode ?? 0)
    })
  })
  on('preload-error', (event, path, err) => {
    client.error(err instanceof Error ? err : new Error(String(err)), {
      crash_source: 'preload_error',
      file: typeof path === 'string' ? path : ''
    })
  })
  return () => disposers.splice(0).forEach(dispose => dispose?.())
}
