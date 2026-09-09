import test from 'node:test'
import assert from 'node:assert/strict'
import { createElectronEysWithCore } from '../src/factory.js'
import { makeCore } from './helpers/fake-core.js'
import { createFakeRuntime } from './helpers/fake-runtime.js'

test('内核缺失 → 降级 noop（degraded 标记 + API 面齐全，不抛错）', () => {
  const client = createElectronEysWithCore({ endpoint: '/api/collect' }, {}, null)
  assert.equal(client.__eysElectron?.degraded, true)
  assert.doesNotThrow(() => client.track('x'))
  assert.doesNotThrow(() => client.error(new Error('x')))
  assert.doesNotThrow(() => client.flush(true))
  assert.doesNotThrow(() => client.dispose())
  assert.equal(client.getAnonymousId(), '')
})

test('fetch 缺失分支在独立进程测试（见 fetch-missing.test.js）——此处仅验证 fetch 正常回落', () => {
  const fake = createFakeRuntime({ fetch: undefined })
  const core = makeCore()
  const client = createElectronEysWithCore({}, fake.runtime, core)
  // Node ≥ 18 全局存在 fetch → 回落 globalThis.fetch → 正常装配（非 noop）
  assert.equal(client.__eysElectron?.degraded, undefined)
  assert.ok(core.__client, '应回退到 globalThis.fetch 正常装配')
})

test('完整装配 → 内核 client 创建，adapter 名为 electron，设备上下文注入', () => {
  const fake = createFakeRuntime()
  const core = makeCore()
  const client = createElectronEysWithCore({ endpoint: '/api/collect', appId: 'app-1' }, fake.runtime, core)
  assert.equal(client.__eysElectron?.degraded, undefined)
  assert.ok(core.__client, '内核 client 应已创建')
  assert.equal(core.__client.calls.adapter?.name, 'electron')
  assert.equal(core.__client.calls.config.appId, 'app-1')
  const ctx = core.__client.calls.setContext[0]
  assert.equal(ctx.appVersion, '1.2.3')
  assert.equal(ctx.electronVersion, '31.0.0')
  assert.equal(ctx.platform, process.platform)
})

test('内核 API 透传：track/error/metric 经由真实内核 client 记录', () => {
  const fake = createFakeRuntime()
  const core = makeCore()
  const client = createElectronEysWithCore({}, fake.runtime, core)
  client.track('btn_click', { id: 1 })
  client.error(new Error('boom'), { crash_source: 'main_uncaughtException' })
  client.metric('app_ready', 1250)
  client.behavior('app_foreground')
  assert.equal(core.__client.calls.track[0].name, 'btn_click')
  assert.equal(core.__client.calls.error[0].extra.crash_source, 'main_uncaughtException')
  assert.equal(core.__client.calls.metric[0].name, 'app_ready')
  assert.equal(core.__client.calls.behavior[0].name, 'app_foreground')
})

test('autoLifecycle/autoCrash 默认自动挂载：app ready 即上报 app_start + app_ready', () => {
  const fake = createFakeRuntime({ processUptimeMs: () => 1250 })
  const core = makeCore()
  createElectronEysWithCore({}, fake.runtime, core)
  fake.emitApp('ready')
  const behaviors = core.__client.calls.behavior
  const metrics = core.__client.calls.metric
  assert.equal(behaviors[0].name, 'app_start')
  assert.equal(behaviors[0].props.appVersion, '1.2.3')
  assert.equal(metrics[0].name, 'app_ready')
  assert.equal(metrics[0].value, 1250)
})

test('auto 开关全关 → 不挂载；start() 手动挂载后 ready 才上报', () => {
  const fake = createFakeRuntime({ autoLifecycle: false, autoCrash: false })
  const core = makeCore()
  const client = createElectronEysWithCore({}, fake.runtime, core)
  fake.emitApp('ready')
  fake.emitProcess('uncaughtException', new Error('early'))
  assert.equal(core.__client.calls.behavior.length, 0)
  assert.equal(core.__client.calls.error.length, 0)
  client.start()
  fake.emitApp('ready')
  fake.emitProcess('uncaughtException', new Error('late'))
  assert.equal(core.__client.calls.behavior[0].name, 'app_start')
  assert.equal(core.__client.calls.error[0].extra.crash_source, 'main_uncaughtException')
})

test('dispose 卸载插桩并销毁内核 client（幂等）', () => {
  const fake = createFakeRuntime()
  const core = makeCore()
  const client = createElectronEysWithCore({}, fake.runtime, core)
  client.dispose()
  client.dispose()
  assert.equal(core.__client.calls.destroyCount, 1)
  fake.emitApp('ready')
  fake.emitProcess('uncaughtException', new Error('after dispose'))
  assert.equal(core.__client.calls.behavior.length, 0)
  assert.equal(core.__client.calls.error.length, 0)
})
