/**
 * @file Electron SDK 主进程入口
 *
 * 用法（主进程 main.js）：
 *   import { app } from 'electron'
 *   import { readFileSync, writeFileSync } from 'node:fs'
 *   import { join } from 'node:path'
 *   import { createElectronEys, createJsonFileStorage, attachIpcSink } from '@web-collection/sdk-electron'
 *
 *   const eys = createElectronEys({
 *     endpoint: 'https://your-host/api/collect',
 *     appId: 'my-electron-app',
 *     release: '1.0.0'
 *   }, {
 *     app,
 *     storage: createJsonFileStorage({
 *       readFile: readFileSync,
 *       writeFile: writeFileSync,
 *       file: join(app.getPath('userData'), 'eys-storage.json')
 *     })
 *   })
 *
 * 自动采集（零额外代码）：app_start / app_ready 冷启动 / app_foreground|background /
 * 主进程 uncaughtException·unhandledRejection / 渲染进程崩溃·preload 失败 / 退出前强制冲刷。
 * 渲染进程事件经 IPC 汇聚（file:// / CORS 场景）见 README「渲染进程桥接」。
 */
import { createPlatformEys } from '@web-collection/sdk/platform'
import { createElectronEysWithCore } from './factory.js'
import { createJsonFileStorage, createMemoryStorage, createAsyncStorageAdapter } from './storage.js'
import { attachIpcSink } from './ipc-sink.js'
import { createElectronIpcAdapter, exposeEysBridge } from './preload.js'
import { attachRendererWatchdog } from './crash.js'

/**
 * 创建 Electron SDK 客户端（主进程）
 * @param {object} [options={}] 内核配置（endpoint/appId/release/sampleRate/privacy 等）
 * @param {object} [runtime={}] Electron 运行时（依赖注入，见 factory.js）
 * @returns {object} Electron 客户端
 */
export function createElectronEys(options = {}, runtime = {}) {
  return createElectronEysWithCore(options, runtime, { createPlatformEys })
}

export {
  createElectronEysWithCore,
  createJsonFileStorage,
  createMemoryStorage,
  createAsyncStorageAdapter,
  attachIpcSink,
  attachRendererWatchdog,
  createElectronIpcAdapter,
  exposeEysBridge
}
export default createElectronEys
