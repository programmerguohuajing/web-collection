import test from 'node:test'
import assert from 'node:assert/strict'
import { createElectronEysWithCore } from '../src/factory.js'
import { makeCore } from './helpers/fake-core.js'
import { createFakeRuntime } from './helpers/fake-runtime.js'

/**
 * fetch 缺失降级分支（Electron < 22 主进程无全局 fetch）。
 * 独立成文件：测试进程内临时摘除 globalThis.fetch——node --test 的并发以「文件」为进程边界，
 * 单文件内不与其他装配用例并发，避免全局摘除造成交叉污染。
 */
test('runtime.fetch 与全局 fetch 均缺失 → noop + fetch_missing 诊断', () => {
  const original = globalThis.fetch
  globalThis.fetch = undefined
  try {
    const diags = []
    const fake = createFakeRuntime({ fetch: undefined })
    const client = createElectronEysWithCore(
      { endpoint: '/api/collect', onDiagnostic: d => diags.push(d) },
      fake.runtime,
      makeCore()
    )
    assert.equal(client.__eysElectron?.degraded, true)
    assert.ok(diags.some(d => d.name === 'fetch_missing'))
    assert.doesNotThrow(() => client.track('x'))
    assert.doesNotThrow(() => client.dispose())
  } finally {
    globalThis.fetch = original
  }
})
