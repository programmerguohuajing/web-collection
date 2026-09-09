/**
 * @web-collection/sdk-electron/preload 类型声明（渲染进程 / preload 入口）
 */
import type { PlatformAdapter } from '@web-collection/sdk/platform'

/** 创建渲染进程 IPC 平台适配器（对接内核 PlatformAdapter 契约，request 经 IPC 交主进程代理上报） */
export declare function createElectronIpcAdapter(options: {
  ipcRenderer: any
  channel?: string
}): PlatformAdapter & { name: 'electron-renderer' }

/** preload 桥接暴露：window.__EYS_IPC__ = { channel, send(payload) } */
export declare function exposeEysBridge(ipcRenderer: any, channel?: string): void
