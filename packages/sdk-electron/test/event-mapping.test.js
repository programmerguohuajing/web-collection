import test from 'node:test'
import assert from 'node:assert/strict'
import { createElectronEysWithCore } from '../src/factory.js'
import { makeCore } from './helpers/fake-core.js'
import { createFakeRuntime } from './helpers/fake-runtime.js'

/**
 * 事件类型红线（对齐后端采集 type 白名单 ['track','perf','behavior','error',...]）：
 * 本包所有自动采集产出的 (type, name/metric, props.crash_source) 必须落在下表内，
 * 不新增任何事件 type —— Electron 场景语义全部表达在 name / metric / props 上。
 */
const MAPPING_TABLE = Object.freeze([
  { trigger: "app 'ready'", type: 'behavior', name: 'app_start' },
  { trigger: "app 'ready'", type: 'perf', metric: 'app_ready' },
  { trigger: "app 'browser-window-focus'", type: 'behavior', name: 'app_foreground' },
  { trigger: "app 'browser-window-blur'", type: 'behavior', name: 'app_background' },
  { trigger: "process 'uncaughtException'", type: 'error', crashSource: 'main_uncaughtException' },
  { trigger: "process 'unhandledRejection'", type: 'error', crashSource: 'main_unhandledRejection' },
  { trigger: "webContents 'render-process-gone'", type: 'error', crashSource: 'renderer_gone' },
  { trigger: "webContents 'preload-error'", type: 'error', crashSource: 'preload_error' }
])

const ALLOWED_BEHAVIOR_NAMES = new Set(MAPPING_TABLE.filter(r => r.type === 'behavior').map(r => r.name))
const ALLOWED_METRICS = new Set(MAPPING_TABLE.filter(r => r.type === 'perf').map(r => r.metric))
const ALLOWED_CRASH_SOURCES = new Set(MAPPING_TABLE.filter(r => r.type === 'error').map(r => r.crashSource))

test('映射表自检：每行 type 均在后端白名单内', () => {
  const WHITELIST = new Set(['track', 'perf', 'performance', 'behavior', 'error', 'replay', 'log', 'trace'])
  for (const row of MAPPING_TABLE) {
    assert.ok(WHITELIST.has(row.type), `映射表行 type 越界：${JSON.stringify(row)}`)
    assert.ok(String(row.name || row.metric || row.crashSource || '').length <= 48, 'name/metric/crash_source 过长')
  }
})

test('全触发面扫描：自动采集产出的行为/指标/崩溃值全部落在映射表内', () => {
  const fake = createFakeRuntime({ processUptimeMs: () => 100 })
  const core = makeCore()
  createElectronEysWithCore({}, fake.runtime, core)
  fake.emitApp('ready')
  fake.emitApp('browser-window-focus')
  fake.emitApp('browser-window-blur')
  fake.emitProcess('uncaughtException', new Error('a'))
  fake.emitProcess('unhandledRejection', new Error('b'))
  fake.emitWebContents('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
  fake.emitWebContents('preload-error', {}, '/p.js', new Error('c'))

  for (const b of core.__client.calls.behavior) {
    assert.ok(ALLOWED_BEHAVIOR_NAMES.has(b.name), `未登记的 behavior name：${b.name}`)
  }
  for (const m of core.__client.calls.metric) {
    assert.ok(ALLOWED_METRICS.has(m.name), `未登记的 metric：${m.name}`)
    assert.equal(typeof m.value, 'number')
  }
  for (const e of core.__client.calls.error) {
    assert.ok(ALLOWED_CRASH_SOURCES.has(e.extra?.crashSource ?? e.extra?.crash_source), `未登记的 crash_source：${JSON.stringify(e.extra)}`)
  }
})
