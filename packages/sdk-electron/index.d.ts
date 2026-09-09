/**
 * @web-collection/sdk-electron 类型声明（主进程入口）
 * 完整内核 API 面见 @web-collection/sdk/platform 的 platform.d.ts。
 */
import type { PlatformEysClient } from '@web-collection/sdk/platform'

/** 依赖注入的 Electron 运行时（本包绝不 import 'electron'，全部由宿主传入） */
export interface ElectronRuntime {
  /** 主进程 fetch（Electron ≥ 22 有全局 fetch；缺省回落 globalThis.fetch） */
  fetch?: typeof fetch
  /** 同步存储 { get(key), set(key, value) }（推荐 createJsonFileStorage 产物） */
  storage?: { get: (key: string) => any; set: (key: string, value: any) => void }
  /** Electron app 对象（生命周期插桩：ready / focus / blur / window-all-closed / before-quit） */
  app?: any
  /** 主进程 process（崩溃监控；缺省 globalThis.process） */
  nodeProcess?: any
  /** 自定义上报上下文 */
  getContext?: () => { path: string; url: string; title: string; referrer: string; userAgent: string }
  /** 主进程错误钩子（注入后内核自动注册；崩溃监控始终独立接管 process 事件） */
  onError?: (listener: (reason: unknown) => void) => () => void
  onUnhandledRejection?: (listener: (event: { reason?: unknown }) => void) => () => void
  /** 自动挂载开关（默认 true；false 后由 client.start() 手动挂载） */
  autoLifecycle?: boolean
  autoCrash?: boolean
  /** 渲染进程看门狗：单个 / 数组 webContents 或即时快照函数 */
  webContents?: any
  getAllWebContents?: () => any[]
  /** 冷启动耗时来源（缺省 process.uptime() * 1000） */
  processUptimeMs?: () => number
  /** 设备上下文覆盖项 */
  appVersion?: string
  electronVersion?: string
  /** 诊断出口（onDiagnostic） */
  onDiagnostic?: (event: { name: string; ts: number } & Record<string, unknown>) => void
}

export interface ElectronEysClient extends PlatformEysClient {
  /** 手动挂载生命周期 + 崩溃插桩（autoLifecycle/autoCrash=false 时使用；幂等） */
  start: () => void
  /** 卸载插桩并销毁内核 client（退出前调用；幂等） */
  dispose: () => void
  /** 内部装配信息（调试用；降级 noop 时含 degraded: true） */
  __eysElectron: Record<string, unknown>
}

/** 创建 Electron SDK 客户端（主进程） */
export declare function createElectronEys(options?: Record<string, any>, runtime?: ElectronRuntime): ElectronEysClient
export declare function createElectronEysWithCore(
  options: Record<string, any>,
  runtime: ElectronRuntime,
  core: { createPlatformEys: (options: Record<string, any>, adapter: any) => PlatformEysClient } | null,
  moduleInitTs?: number
): ElectronEysClient

/** JSON 文件持久化存储（主进程；fs 由调用方注入） */
export declare function createJsonFileStorage(options: {
  readFile: (file: string, encoding: 'utf-8') => string
  writeFile: (file: string, data: string) => void
  file: string
}): { get: (key: string) => any; set: (key: string, value: any) => void }
export declare function createMemoryStorage(): { get: (key: string) => any; set: (key: string, value: any) => void }
export declare function createAsyncStorageAdapter(sync: { get: (key: string) => any; set: (key: string, value: any) => void } | undefined):
  { getStorage: (key: string) => Promise<any>; setStorage: (key: string, value: any) => Promise<void> } | undefined

/** 渲染进程事件 IPC 桥（主进程侧 sink）：接收 preload 转发的载荷并代理上报 */
export declare function attachIpcSink(options: {
  ipcMain: any
  channel?: string
  endpoint: string
  collectKey?: string
  fetch?: typeof fetch
  diagnostics?: { emit?: (name: string, detail?: Record<string, unknown>) => void }
}): { dispose: () => void; readonly mode: 'handle' | 'on' | 'off' }

/** 渲染进程看门狗（render-process-gone / preload-error → error 事件） */
export declare function attachRendererWatchdog(webContents: any, client: PlatformEysClient, diagnostics?: { emit?: Function }): () => void
