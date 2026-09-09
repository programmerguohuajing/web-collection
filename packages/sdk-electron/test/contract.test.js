import test from 'node:test'

/**
 * 真内核冒烟测试：验证 @web-collection/sdk/platform 的 createPlatformEys
 * 能与本包 adapter 直接装配（契约对齐）。内核 bundle 未构建时跳过（沙箱常态）。
 */
test('契约冒烟：真实内核 + electron adapter 装配', async (t) => {
  let core = null
  try {
    core = await import('@web-collection/sdk/platform')
  } catch {
    return t.skip('@web-collection/sdk/platform bundle 未构建（packages/sdk/dist），跳过契约冒烟')
  }
  const assert = (await import('node:assert/strict')).default
  const { createElectronAdapter } = await import('../src/adapter.js')
  const { createMemoryStorage } = await import('../src/storage.js')

  assert.equal(typeof core.createPlatformEys, 'function')
  const adapter = createElectronAdapter({
    fetch: async () => ({ status: 200, ok: true }),
    storage: createMemoryStorage(),
    getContext: () => ({ path: '', url: '', title: '', referrer: '', userAgent: 'Electron/test' })
  })
  const client = core.createPlatformEys({ endpoint: 'https://host.example/api/collect', appId: 'smoke', flushInterval: 3600000, minFlushInterval: 0 }, adapter)
  assert.equal(typeof client.track, 'function')
  assert.equal(typeof client.error, 'function')
  assert.equal(typeof client.flush, 'function')
  assert.equal(client.getCapabilities().dom, false)
  assert.doesNotThrow(() => client.track('smoke_event', { source: 'contract-test' }))
  assert.doesNotThrow(() => client.error(new Error('smoke'), { crash_source: 'main_uncaughtException' }))
  await assert.doesNotReject(() => client.flush(true))
  client.destroy()
})
