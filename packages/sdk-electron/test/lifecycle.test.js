import test from 'node:test'
import assert from 'node:assert/strict'
import { createElectronEysWithCore } from '../src/factory.js'
import { makeCore } from './helpers/fake-core.js'
import { createFakeRuntime } from './helpers/fake-runtime.js'

test('ready 只报一次 app_start（幂等），app_ready 为冷启动毫秒', () => {
  const fake = createFakeRuntime({ processUptimeMs: () => 800 })
  const core = makeCore()
  createElectronEysWithCore({}, fake.runtime, core)
  fake.emitApp('ready')
  fake.emitApp('ready')
  fake.emitApp('ready')
  const starts = core.__client.calls.behavior.filter(b => b.name === 'app_start')
  assert.equal(starts.length, 1)
  const ready = core.__client.calls.metric.filter(m => m.name === 'app_ready')
  assert.equal(ready.length, 1)
  assert.equal(ready[0].value, 800)
})

test('focus/blur 去抖：连续同态只报一次，状态真实切换才上报', () => {
  const fake = createFakeRuntime()
  const core = makeCore()
  createElectronEysWithCore({}, fake.runtime, core)
  fake.emitApp('browser-window-focus')
  fake.emitApp('browser-window-focus')
  fake.emitApp('browser-window-focus')
  assert.equal(core.__client.calls.behavior.filter(b => b.name === 'app_foreground').length, 1)
  fake.emitApp('browser-window-blur')
  fake.emitApp('browser-window-blur')
  assert.equal(core.__client.calls.behavior.filter(b => b.name === 'app_background').length, 1)
  fake.emitApp('browser-window-focus')
  assert.equal(core.__client.calls.behavior.filter(b => b.name === 'app_foreground').length, 2)
})

test('window-all-closed / before-quit → flush(true) 强制冲刷', () => {
  const fake = createFakeRuntime()
  const core = makeCore()
  createElectronEysWithCore({}, fake.runtime, core)
  fake.emitApp('window-all-closed')
  fake.emitApp('before-quit')
  assert.deepEqual(core.__client.calls.flush, [{ force: true }, { force: true }])
})

test('未 ready 前 focus/blur 不产生 app_start（仅前台后台行为）', () => {
  const fake = createFakeRuntime()
  const core = makeCore()
  createElectronEysWithCore({}, fake.runtime, core)
  fake.emitApp('browser-window-focus')
  assert.equal(core.__client.calls.behavior.filter(b => b.name === 'app_start').length, 0)
  assert.equal(core.__client.calls.behavior.filter(b => b.name === 'app_foreground').length, 1)
})
