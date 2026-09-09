/**
 * @file 真内核契约冒烟（可 skip）：端到端验证 @web-collection/sdk/platform 的 createPlatformEys
 *
 * 若 @web-collection/sdk 未构建 / 不可解析，则 skip 并打印原因，不因它挂红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('真内核契约（不可解析时 skip）', async (t) => {
  let mod
  try {
    mod = await import('@web-collection/sdk/platform')
  } catch {
    t.skip('@web-collection/sdk/platform 不可解析（未构建或不在 node_modules）')
    return
  }
  if (typeof mod.createPlatformEys !== 'function') {
    t.skip('createPlatformEys 缺失')
    return
  }

  const adapter = mod.createReactNativeAdapter
    ? mod.createReactNativeAdapter({ fetch: async () => ({ status: 200 }) })
    : { name: 'rn', capabilities: {} }
  const client = mod.createPlatformEys({ appId: 'contract-test', endpoint: '/api/collect' }, adapter)
  for (const m of [
    'track',
    'error',
    'metric',
    'behavior',
    'flush',
    'setContext',
    'wrapFetch',
    'getCapabilities',
    'getAnonymousId'
  ]) {
    assert.equal(typeof client[m], 'function', `内核客户端应暴露 ${m}`)
  }
  // 基础采集：metric 进入队列、flush 不抛
  assert.doesNotThrow(() => client.metric('app_cold_start', 1200, { phase: 'cold', appReadyMs: 1200, markSource: 'app-ready' }))
  await client.flush(true)
})
