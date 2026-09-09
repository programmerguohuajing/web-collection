import test from 'node:test'
import assert from 'node:assert/strict'
import { createElectronEysWithCore } from '../src/factory.js'
import { attachRendererWatchdog } from '../src/crash.js'
import { makeCore, createFakePlatformClient } from './helpers/fake-core.js'
import { createFakeRuntime } from './helpers/fake-runtime.js'

test('主进程 uncaughtException → error(crash_source=main_uncaughtException)', () => {
  const fake = createFakeRuntime()
  const core = makeCore()
  createElectronEysWithCore({}, fake.runtime, core)
  const err = new Error('boom main')
  fake.emitProcess('uncaughtException', err)
  assert.equal(core.__client.calls.error.length, 1)
  assert.equal(core.__client.calls.error[0].extra.crash_source, 'main_uncaughtException')
  assert.equal(core.__client.calls.error[0].reason, err)
})

test('主进程 unhandledRejection → error(crash_source=main_unhandledRejection)', () => {
  const fake = createFakeRuntime()
  const core = makeCore()
  createElectronEysWithCore({}, fake.runtime, core)
  fake.emitProcess('unhandledRejection', 'raw string reason')
  assert.equal(core.__client.calls.error[0].extra.crash_source, 'main_unhandledRejection')
  assert.equal(core.__client.calls.error[0].reason.message, 'raw string reason')
})

test('render-process-gone → error(crash_source=renderer_gone, reason/exitCode)', () => {
  const fake = createFakeRuntime()
  const core = makeCore()
  createElectronEysWithCore({}, fake.runtime, core)
  fake.emitWebContents('render-process-gone', {}, { reason: 'oom', exitCode: 137 })
  const record = core.__client.calls.error[0]
  assert.equal(record.extra.crash_source, 'renderer_gone')
  assert.equal(record.extra.reason, 'oom')
  assert.equal(record.extra.exitCode, 137)
  assert.equal(record.reason.message, 'renderer process gone: oom')
})

test('preload-error → error(crash_source=preload_error, file)', () => {
  const fake = createFakeRuntime()
  const core = makeCore()
  createElectronEysWithCore({}, fake.runtime, core)
  fake.emitWebContents('preload-error', {}, '/app/preload.js', new Error('cannot find module'))
  const record = core.__client.calls.error[0]
  assert.equal(record.extra.crash_source, 'preload_error')
  assert.equal(record.extra.file, '/app/preload.js')
})

test('dispose 后崩溃不再上报；attachRendererWatchdog 返回的卸载函数生效', () => {
  const fake = createFakeRuntime()
  const core = makeCore()
  const client = createElectronEysWithCore({}, fake.runtime, core)
  client.dispose()
  fake.emitProcess('uncaughtException', new Error('after dispose'))
  fake.emitWebContents('render-process-gone', {}, { reason: 'crashed' })
  assert.equal(core.__client.calls.error.length, 0)

  const client2 = createFakePlatformClient({}, {})
  const detach = attachRendererWatchdog(fake.webContents, client2)
  fake.emitWebContents('render-process-gone', {}, { reason: 'crashed' })
  assert.equal(client2.calls.error.length, 1)
  detach()
  fake.emitWebContents('render-process-gone', {}, { reason: 'crashed' })
  assert.equal(client2.calls.error.length, 1)
})

test('getAllWebContents 快照形态注入：每个 webContents 均被看护', () => {
  const wcA = { on() {}, removeListener() {} }
  const wcB = { on() {}, removeListener() {} }
  const fake = createFakeRuntime({ webContents: undefined, getAllWebContents: () => [wcA, wcB] })
  const core = makeCore()
  createElectronEysWithCore({}, fake.runtime, core)
  fake.emitProcess('uncaughtException', new Error('main'))
  assert.equal(core.__client.calls.error.length, 1)
})

test('uncaughtException 处理器内部抛错不影响进程（guard 兜底，不向上抛）', () => {
  const fake = createFakeRuntime()
  const core = makeCore()
  createElectronEysWithCore({}, fake.runtime, core)
  // 让内核 client.error 抛错 → crash 监听经 guard 包装必须吞掉
  core.__client.error = () => { throw new Error('client broken') }
  assert.doesNotThrow(() => fake.emitProcess('uncaughtException', new Error('x')))
})
