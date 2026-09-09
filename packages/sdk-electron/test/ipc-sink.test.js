import test from 'node:test'
import assert from 'node:assert/strict'
import { attachIpcSink } from '../src/ipc-sink.js'
import { createElectronIpcAdapter, exposeEysBridge } from '../src/preload.js'
import { EventEmitter } from 'node:events'

function fakeIpcMain() {
  const handlers = new Map()
  return {
    handlers,
    handle(channel, fn) { handlers.set(channel, fn) },
    removeHandler(channel) { handlers.delete(channel) },
    async invoke(channel, payload) { return handlers.has(channel) ? handlers.get(channel)({}, payload) : undefined }
  }
}

test('handle 模式：合法载荷经 fetch 代理上报（端点 + x-app-key）', async () => {
  const fetches = []
  const ipcMain = fakeIpcMain()
  const sink = attachIpcSink({
    ipcMain,
    channel: 'eys:events',
    endpoint: 'https://host.example/api/collect',
    collectKey: 'ck_123',
    fetch: async (url, init) => { fetches.push({ url, init }); return { status: 200 } }
  })
  assert.equal(sink.mode, 'handle')
  const ack = await ipcMain.invoke('eys:events', { events: [{ type: 'track', name: 'x' }] })
  assert.deepEqual(ack, { ok: true, status: 200 })
  assert.equal(fetches[0].url, 'https://host.example/api/collect')
  assert.equal(fetches[0].init.headers['x-app-key'], 'ck_123')
  assert.equal(fetches[0].init.body, JSON.stringify({ events: [{ type: 'track', name: 'x' }] }))
})

test('非法载荷 → 400 + ipc_payload_invalid 诊断，不触发 fetch', async () => {
  const diags = []
  const ipcMain = fakeIpcMain()
  attachIpcSink({
    ipcMain, endpoint: 'https://host/api/collect',
    fetch: async () => { throw new Error('should not fetch') },
    diagnostics: { emit: (name, detail) => diags.push({ name, detail }) }
  })
  const ack = await ipcMain.invoke('eys:events', { hello: 'world' })
  assert.equal(ack.status, 400)
  assert.ok(diags.some(d => d.name === 'ipc_payload_invalid'))
})

test('fetch 失败 → 502（内核据此重试）+ ipc_proxy_failed 诊断', async () => {
  const diags = []
  const ipcMain = fakeIpcMain()
  attachIpcSink({
    ipcMain, endpoint: 'https://host/api/collect',
    fetch: async () => { throw new Error('network down') },
    diagnostics: { emit: (name) => diags.push(name) }
  })
  const ack = await ipcMain.invoke('eys:events', { events: [{ type: 'track' }] })
  assert.equal(ack.status, 502)
  assert.ok(diags.includes('ipc_proxy_failed'))
})

test('replay 载荷（type=replay + events=rrweb 数据）天然放行', async () => {
  const ipcMain = fakeIpcMain()
  attachIpcSink({ ipcMain, endpoint: 'https://host/api/collect', fetch: async () => ({ status: 200 }) })
  const ack = await ipcMain.invoke('eys:events', { type: 'replay', events: [1, 2, 3] })
  assert.equal(ack.ok, true)
})

test('dispose 移除 handle 注册（真 Electron 中此后 invoke 会拒绝，内核走重试）', async () => {
  const ipcMain = fakeIpcMain()
  const sink = attachIpcSink({ ipcMain, endpoint: 'https://host/api/collect', fetch: async () => ({ status: 200 }) })
  assert.equal(sink.mode, 'handle')
  sink.dispose()
  assert.equal(ipcMain.handlers.size, 0)
  // 假件无 handler 时返回 undefined（对应真 Electron 的 invoke rejection 路径）
  const ack = await ipcMain.invoke('eys:events', { events: [{}] })
  assert.equal(ack, undefined)
})

test('老版本 ipcMain（无 handle）退化为 on 模式', () => {
  const listeners = new Map()
  const ipcMain = {
    on: (channel, fn) => listeners.set(channel, fn),
    removeListener: (channel) => listeners.delete(channel)
  }
  const sink = attachIpcSink({ ipcMain, endpoint: 'https://host/api/collect', fetch: async () => ({ status: 200 }) })
  assert.equal(sink.mode, 'on')
  sink.dispose()
  assert.equal(listeners.size, 0)
})

test('preload 适配器：invoke 路径把 ack.status 映射为 response.status；契约字段齐备', async () => {
  const ipcMain = fakeIpcMain()
  attachIpcSink({ ipcMain, endpoint: 'https://host/api/collect', fetch: async () => ({ status: 200 }) })
  const ipcRenderer = {
    send: () => {},
    invoke: (channel, payload) => ipcMain.invoke(channel, payload)
  }
  const adapter = createElectronIpcAdapter({ ipcRenderer, channel: 'eys:events' })
  assert.equal(adapter.name, 'electron-renderer')
  const response = await adapter.request({ url: 'ignored', method: 'POST', headers: {}, data: { events: [{ type: 'track' }] } })
  assert.equal(response.status, 200)
  // 渲染端上下文：node:test 无 window → 安全回落空字符串
  const ctx = adapter.getContext()
  assert.equal(ctx.path, '')
  assert.equal(typeof ctx.userAgent, 'string')
})

test('exposeEysBridge：window.__EYS_IPC__ 最小 send 能力（send 异常静默不抛）', () => {
  const sent = []
  const ipcRenderer = {
    send: (channel, payload) => sent.push({ channel, payload })
  }
  exposeEysBridge(ipcRenderer, 'eys:events')
  assert.equal(globalThis.__EYS_IPC__.channel, 'eys:events')
  globalThis.__EYS_IPC__.send({ events: [{ type: 'track' }] })
  assert.equal(sent[0].channel, 'eys:events')
  delete globalThis.__EYS_IPC__
  // 坏 ipcRenderer：不抛错、不写入全局
  assert.doesNotThrow(() => exposeEysBridge(null))
  assert.equal(globalThis.__EYS_IPC__, undefined)
})
