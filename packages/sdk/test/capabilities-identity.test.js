/**
 * P1-4 能力位 + 静默降级 · P2-5 双 ID + 启动排队 验证
 * 覆盖平台层（createPlatformEys）与 Web 层（createEys）两条入口。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPlatformEys } from '../src/platform/core.js'
import { createEys } from '../src/index.js'

test('platform: getCapabilities 返回适配器声明的能力位', () => {
  const adapter = {
    name: 'test',
    capabilities: { networkStatus: true, storage: true },
    request: async () => ({ statusCode: 200 }),
    getStorage: () => null,
    setStorage: () => {},
    getContext: () => ({ path: '/', userAgent: 't' })
  }
  const eys = createPlatformEys({ endpoint: '/api/collect' }, adapter)
  assert.deepEqual(eys.getCapabilities(), { networkStatus: true, storage: true })
  eys.destroy() // 释放定时上报 interval，避免 Node 事件循环被悬挂句柄阻塞
})

test('platform: 双 ID —— getAnonymousId 稳定，identify 回填 userId', async () => {
  const reports = []
  const adapter = {
    name: 'test',
    request: async o => { reports.push(...o.data.events); return { statusCode: 200 } },
    getStorage: () => null,
    setStorage: () => {},
    getContext: () => ({ path: '/', userAgent: 't' })
  }
  const eys = createPlatformEys({ endpoint: '/api/collect', batchSize: 10 }, adapter)
  const anon = eys.getAnonymousId()
  assert.ok(typeof anon === 'string' && anon.length > 0)

  eys.identify('u-web')        // 设置 appUserId
  eys.track('pay', { amount: 1 })
  await eys.flush()

  const pay = reports.find(r => r.name === 'pay')
  assert.ok(pay, 'pay 事件应已上报')
  assert.equal(pay.userId, 'u-web')   // identify 后入队事件带 userId
  assert.equal(pay.deviceId, anon)    // 匿名设备 ID 始终随行（双 ID）
  eys.destroy() // 释放定时上报 interval
})

test('platform: 启动前事件缓冲并在 ready 后回放（P2-5 启动排队）', async () => {
  const reports = []
  let resolveStorage
  const storagePromise = new Promise(r => { resolveStorage = r })
  const adapter = {
    name: 'test',
    request: async o => { reports.push(...o.data.events); return { statusCode: 200 } },
    // getStorage 返回未决 promise，模拟异步初始化（hydrate 暂挂起）
    getStorage: () => storagePromise,
    setStorage: () => {},
    getContext: () => ({ path: '/', userAgent: 't' })
  }
  const eys = createPlatformEys({ endpoint: '/api/collect', batchSize: 10 }, adapter)

  eys.track('early', {})          // ready 未 resolve → 进入 pendingTracks，未发送
  assert.equal(reports.length, 0) // 尚未回放

  resolveStorage(null)            // hydrate 完成 → 触发回放
  await eys.flush()
  assert.equal(reports.length, 1) // 回放后入队并被发送
  assert.equal(reports[0].name, 'early')
  eys.destroy() // 释放定时上报 interval
})

test('web: getCapabilities / identify / getAnonymousId（最小 DOM 桩）', async () => {
  const saved = {}
  const props = {
    window: globalThis,
    location: { href: 'https://example.com/', pathname: '/', referrer: '' },
    document: { title: '', hidden: false, visibilityState: 'visible', querySelector: () => null, addEventListener() {}, removeEventListener() {} },
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0)
  }
  for (const k of Object.keys(props)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k)
    Object.defineProperty(globalThis, k, { value: props[k], configurable: true, writable: true })
  }
  const collected = []
  const fetchMock = async () => ({ ok: true, status: 200, json: async () => ({}) })
  globalThis.fetch = fetchMock
  try {
    const eys = createEys({
      appId: 't', endpoint: '/api/collect', replay: false, exposure: false, batchSize: 10,
      beforeSend: (item) => { collected.push(item); return item }
    })
    const caps = eys.getCapabilities()
    assert.ok('dom' in caps && 'exposure' in caps && 'beacon' in caps)
    assert.equal(caps.exposure, false) // Node 环境无 IntersectionObserver

    const anon = eys.getAnonymousId()
    assert.ok(typeof anon === 'string' && anon.length > 0)

    eys.identify('web-u')
    eys.track('click', { x: 1 })
    await eys.flush()

    const click = collected.find(c => c.name === 'click')
    assert.ok(click, 'click 事件应已采集')
    assert.equal(click.userId, 'web-u')  // identify 回填
    assert.equal(click.deviceId, anon)   // 匿名 ID 随行

    // 释放 SDK 内部定时器（flush 轮询 / 跨标签页 BroadcastChannel 等），避免 Node 事件循环被悬挂句柄阻塞。
    // fetch 已 mock，destroy 的退出刷新走 transport（sendExitBatch）而非 imageReport 的 <img>，可正常 resolve。
    await eys.destroy()
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k]) Object.defineProperty(globalThis, k, saved[k])
      else delete globalThis[k]
    }
    delete globalThis.fetch
  }
})
