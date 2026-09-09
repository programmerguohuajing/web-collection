/**
 * @file 测试用假 Electron 运行时：EventEmitter 驱动的 app / process / webContents
 * 全部可同步 emit 触发（node:test 子测试并发安全——每个测试用例创建独立实例）。
 */
import { EventEmitter } from 'node:events'

export function createFakeRuntime(overrides = {}) {
  const fetches = []
  const store = new Map()
  const fetchImpl = async (url, init) => {
    fetches.push({ url, init, body: init?.body ? JSON.parse(init.body) : null })
    return { status: 200 }
  }

  const app = new EventEmitter()
  const nodeProcess = new EventEmitter()
  nodeProcess.uptime = () => 1.25
  nodeProcess.platform = process.platform
  nodeProcess.arch = process.arch
  const webContents = new EventEmitter()

  const runtime = {
    fetch: fetchImpl,
    storage: {
      get: key => store.get(key),
      set: (key, value) => store.set(key, value)
    },
    app,
    nodeProcess,
    webContents,
    appVersion: '1.2.3',
    electronVersion: '31.0.0',
    autoLifecycle: true,
    autoCrash: true,
    ...overrides
  }

  return {
    runtime,
    fetches,
    store,
    app,
    nodeProcess,
    webContents,
    emitApp: (event, ...args) => app.emit(event, ...args),
    emitProcess: (event, ...args) => nodeProcess.emit(event, ...args),
    emitWebContents: (event, ...args) => webContents.emit(event, ...args)
  }
}
