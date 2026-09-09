/**
 * @file 设备上下文：从注入的 Electron 运行时构建 device / app 维度上下文
 *
 * 注入约定（本包绝不 import 'electron'，红线：保持可单测）：
 *   runtime.app            Electron app 对象（可缺省，缺省字段回落 ''）
 *   runtime.nodeProcess    Electron 主进程 process（可缺省，回落 globalThis.process）
 *   runtime.appVersion     应用版本号（优先；缺省回落 app.getVersion()）
 *   runtime.electronVersion Electron 版本（优先；缺省回落 process.versions.electron）
 */

/** 构建设备上下文（setContext 一次性注入，随后随每条事件上报） */
export function buildDeviceContext(runtime = {}) {
  const proc = runtime.nodeProcess || globalThis.process
  const app = runtime.app || {}
  let appVersion = ''
  let appName = ''
  try {
    appVersion = runtime.appVersion || (typeof app.getVersion === 'function' ? app.getVersion() : '')
    appName = typeof app.getName === 'function' ? app.getName() : ''
  } catch {
    // app API 不可用（如非 Electron 环境单测）→ 空字符串回落。
  }
  const electronVersion = runtime.electronVersion || proc?.versions?.electron || ''
  const nodeVersion = proc?.versions?.node || ''
  return {
    appName,
    appVersion,
    electronVersion,
    nodeVersion,
    platform: proc?.platform || '',
    arch: proc?.arch || ''
  }
}

/** 组装内核 getContext() 的静态部分（url/path 留空——主进程无页面概念，窗口信息走 behavior props） */
export function buildMainContext(runtime = {}) {
  const device = buildDeviceContext(runtime)
  return {
    path: '',
    url: '',
    title: '',
    referrer: '',
    userAgent: `Electron/${device.electronVersion || 'unknown'} ${device.platform || ''} ${device.appName || ''}`.trim()
  }
}
