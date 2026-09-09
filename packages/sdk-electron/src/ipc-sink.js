/**
 * @file 渲染进程事件 IPC 桥（主进程侧 sink）：接收 preload 转发的事件载荷并代理上报
 *
 * 职责：主进程作为**网络代理**——渲染进程（web SDK 或平台内核 + IPC 适配器）把
 * `{ events: [...] }` 批量载荷经 IPC 发到主进程，由主进程用 Node fetch 直发服务端。
 * 动机：① 渲染进程加载 file:// 时没有可用的同源上报端点；② 绕开渲染侧 CORS；
 *      ③ collectKey 等凭据只留在主进程，不下发渲染进程。
 *
 * 语义：优先 ipcMain.handle / ipcRenderer.invoke（带 ack，发送失败内核会重试）；
 *      老版本 Electron 退化为 ipcMain.on / ipcRenderer.send（fire-and-forget，响应 202）。
 * 红线：sink 内部异常只记诊断，绝不让 IPC 回调向上抛（未捕获异常会打崩主进程）。
 */
import { DEFAULT_IPC_CHANNEL, DIAGNOSTIC } from './constants.js'
import { guard } from './guard.js'

/**
 * 挂载 IPC 事件代理 sink
 * @param {object} options
 * @param {object} options.ipcMain    Electron ipcMain 对象（依赖注入）
 * @param {string} [options.channel]  IPC 通道名（默认 'eys:events'，须与 preload 侧一致）
 * @param {string} options.endpoint   采集端点（如 https://host/api/collect）
 * @param {string} [options.collectKey] 应用采集密钥（经 x-app-key 头下发服务端）
 * @param {Function} [options.fetch]  注入的 fetch（缺省回落 globalThis.fetch）
 * @param {{ emit?: Function }} [options.diagnostics] 诊断出口
 * @returns {{ dispose: () => void, readonly mode: 'handle' | 'on' | 'off' }}
 */
export function attachIpcSink(options = {}) {
  const ipcMain = options.ipcMain
  const channel = options.channel || DEFAULT_IPC_CHANNEL
  const endpoint = options.endpoint
  const collectKey = options.collectKey || ''
  const fetchImpl = options.fetch || globalThis.fetch
  const diagnostics = options.diagnostics || null
  const state = { mode: 'off', disposed: false }

  if (!ipcMain || !endpoint || typeof fetchImpl !== 'function') {
    try { diagnostics?.emit?.(DIAGNOSTIC.SDK_INTERNAL_ERROR, { module: 'ipc-sink', reason: 'config_missing' }) } catch { /* 静默 */ }
    return { dispose: () => {}, get mode() { return 'off' } }
  }

  const handleRequest = guard(async (payload) => {
    if (state.disposed) return { ok: false, status: 503 }
    if (!isValidPayload(payload)) {
      try { diagnostics?.emit?.(DIAGNOSTIC.IPC_PAYLOAD_INVALID, { channel }) } catch { /* 静默 */ }
      return { ok: false, status: 400 }
    }
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(collectKey ? { 'x-app-key': collectKey } : {}) },
        body: JSON.stringify(payload)
      })
      const status = Number(response?.status ?? response?.statusCode ?? 200)
      return { ok: status >= 200 && status < 300, status }
    } catch (error) {
      try { diagnostics?.emit?.(DIAGNOSTIC.IPC_PROXY_FAILED, { reason: error instanceof Error ? error.name : 'Error' }) } catch { /* 静默 */ }
      return { ok: false, status: 502 }
    }
  }, 'ipc-sink.request', diagnostics)

  if (typeof ipcMain.handle === 'function') {
    try {
      ipcMain.handle(channel, (_event, payload) => handleRequest(payload))
      state.mode = 'handle'
    } catch (error) {
      try { diagnostics?.emit?.(DIAGNOSTIC.SDK_INTERNAL_ERROR, { module: 'ipc-sink', reason: error?.name || 'Error' }) } catch { /* 静默 */ }
    }
  } else if (typeof ipcMain.on === 'function') {
    const listener = guard((_event, payload) => { void handleRequest(payload) }, 'ipc-sink.on', diagnostics)
    try {
      ipcMain.on(channel, listener)
      state.mode = 'on'
    } catch { /* 静默 */ }
    return {
      dispose() {
        state.disposed = true
        try { ipcMain.removeListener(channel, listener) } catch { /* 静默 */ }
      },
      get mode() { return state.mode }
    }
  }

  return {
    dispose() {
      state.disposed = true
      try { ipcMain.removeHandler?.(channel) } catch { /* 静默 */ }
    },
    get mode() { return state.mode }
  }
}

/**
 * 载荷校验：仅放行采集契约形态（{events:[...]} / 数组 / 单条含 type 的事件对象）。
 * replay 载荷（{type:'replay', events: rrweb 数据}）同样命中 {events:[...]} 分支，天然放行。
 */
function isValidPayload(payload) {
  if (!payload || typeof payload !== 'object') return false
  if (Array.isArray(payload)) return payload.length > 0 && payload.every(item => item && typeof item === 'object')
  if (Array.isArray(payload.events)) return payload.events.length > 0
  return typeof payload.type === 'string'
}
