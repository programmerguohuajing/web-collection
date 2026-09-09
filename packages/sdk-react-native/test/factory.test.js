/**
 * @file 装配层测试（createReactNativeEysWithCore + 生命周期 / 崩溃 / 冷启动）
 *
 * 注意：node --test 默认并发执行同文件子测试，因此每个测试使用独立的 core 包装，
 * 把自己的内核客户端捕获在闭包内，避免共享模块级 recorded.client 被并发覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createReactNativeEysWithCore } from '../src/factory.js'
import { createPlatformEys, createReactNativeAdapter } from './helpers/fake-core.js'
import { createFakeRuntime } from './helpers/fake-runtime.js'

/** 每个测试独立捕获自己创建的内核客户端。 */
function makeCore() {
  const captured = { client: null }
  return {
    captured,
    createPlatformEys: (cfg, adapter) => {
      const client = createPlatformEys(cfg, adapter)
      captured.client = client
      return client
    },
    createReactNativeAdapter
  }
}

test('core 缺失 → noop 客户端且不抛', () => {
  const core = makeCore()
  const eys = createReactNativeEysWithCore({ appId: 'x' }, {}, null)
  assert.equal(typeof eys.track, 'function')
  assert.doesNotThrow(() => eys.track('a', {}))
  assert.equal(eys.markAppReady(), false)
  assert.doesNotThrow(() => eys.start())
  assert.doesNotThrow(() => eys.destroy())
})

test('start 发射 app_start 且生命周期订阅 appState', () => {
  const core = makeCore()
  const rt = createFakeRuntime()
  const eys = createReactNativeEysWithCore({ appId: 'x' }, rt, core)
  eys.start()
  assert.ok(core.captured.client.__calls.behavior.some((b) => b.name === 'app_start'))
})

test('切后台 → app_background + flush；回前台超阈值 → 旋转会话', () => {
  const core = makeCore()
  const rt = createFakeRuntime()
  const eys = createReactNativeEysWithCore({ appId: 'x', sessionTimeoutMs: 0 }, rt, core)
  eys.start()
  rt.emitAppState('background')
  rt.emitAppState('active')
  const c = core.captured.client.__calls
  const starts = c.behavior.filter((b) => b.name === 'app_start')
  const fg = c.behavior.find((b) => b.name === 'app_foreground')
  assert.ok(starts.length >= 2, '应有初始 + 旋转两次 app_start')
  assert.ok(fg, '应有 app_foreground')
  assert.equal(fg.props.newSession, true)
  assert.ok(c.behavior.some((b) => b.name === 'app_background'))
  assert.ok(c.flush >= 1, '切后台应触发 flush')
})

test('崩溃采集链式调用原 ErrorUtils handler', () => {
  const core = makeCore()
  const rt = createFakeRuntime()
  const eys = createReactNativeEysWithCore({ appId: 'x' }, rt, core)
  eys.start()
  assert.equal(typeof rt.errorUtils._handler, 'function', '应安装全局 handler')
  rt.errorUtils.getGlobalHandler() // 原 handler 为 null 时不应抛
  rt.errorUtils._handler(new Error('boom'), true)
  assert.ok(core.captured.client.__calls.error.length >= 1, '应记录一次 error')
})

test('markAppReady → 冷启动 metric 且 markSource=app-ready', () => {
  const core = makeCore()
  const rt = createFakeRuntime()
  const eys = createReactNativeEysWithCore({ appId: 'x' }, rt, core)
  eys.start()
  eys.markAppReady()
  const cs = core.captured.client.__calls.metric.find((m) => m.name === 'app_cold_start')
  assert.ok(cs, '应有 app_cold_start')
  assert.equal(cs.props.markSource, 'app-ready')
})

test('wrapFetch 委托给内核 wrapFetch', () => {
  const core = makeCore()
  const rt = createFakeRuntime()
  const eys = createReactNativeEysWithCore({ appId: 'x' }, rt, core)
  const w = eys.wrapFetch(() => 1)
  assert.equal(core.captured.client.__calls.wrapFetch, 1)
  assert.equal(typeof w, 'function')
})

test('destroy 后内核被销毁且不抛', () => {
  const core = makeCore()
  const rt = createFakeRuntime()
  const eys = createReactNativeEysWithCore({ appId: 'x' }, rt, core)
  eys.start()
  assert.doesNotThrow(() => eys.destroy())
  assert.equal(core.captured.client.__calls.destroy, 1)
})
