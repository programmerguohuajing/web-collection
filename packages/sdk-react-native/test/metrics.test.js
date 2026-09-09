/**
 * @file 采集模块测试（冷启动 / 帧率 / 网络）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createColdStartCollector } from '../src/metrics/cold-start.js'
import { createFrameStatsCollector } from '../src/metrics/frame-stats.js'
import { createNetworkInstrumentor } from '../src/metrics/network.js'

test('冷启动：markAppReady → app-ready，仅一次', () => {
  const metrics = []
  const c = createColdStartCollector({ metric: (n, v, p) => metrics.push({ n, v, p }), moduleInitTs: 1000, now: () => 2000 })
  assert.equal(c.markAppReady(), true)
  assert.equal(c.markAppReady(), false)
  assert.equal(metrics.length, 1)
  assert.equal(metrics[0].p.markSource, 'app-ready')
  assert.equal(metrics[0].v, 1000)
})

test('冷启动：首帧终点 → first-frame', () => {
  const metrics = []
  const c = createColdStartCollector({ metric: (n, v, p) => metrics.push({ n, v, p }), moduleInitTs: 0, now: () => 500 })
  let cb = null
  c.start((callback) => {
    cb = callback
    return () => {}
  })
  assert.ok(cb)
  cb(500)
  assert.equal(metrics[0].p.markSource, 'first-frame')
})

test('冷启动：phase 首次 cold，后续 warm', async () => {
  // 模块级 startedOnce 为全局状态，用缓存破坏获取全新模块实例以隔离。
  const mod = await import(`../src/metrics/cold-start.js?phase=${Date.now()}`)
  const a = mod.createColdStartCollector({ metric: () => {} })
  assert.equal(a.phase, 'cold')
  const b = mod.createColdStartCollector({ metric: () => {} })
  assert.equal(b.phase, 'warm')
})

test('帧率：60 帧/秒 → fps=60，droppedFrames=0；10s 节流只出 1 条', () => {
  const metrics = []
  const c = createFrameStatsCollector({
    metric: (n, v, p) => metrics.push({ n, v, p }),
    sampleWindowMs: 1000,
    reportIntervalMs: 10000,
    fpsTarget: 60
  })
  let cb = null
  c.start((callback) => {
    cb = callback
    return () => {}
  })
  assert.ok(cb)
  // 驱动 120 帧（≈2000ms），确保至少一个采样窗口（≥1000ms）完成；节流使其仅出 1 条。
  let t = 0
  for (let i = 0; i < 120; i++) {
    t += 1000 / 60
    cb(t)
  }
  assert.equal(metrics.length, 1, '节流应使 10s 内仅 1 条')
  assert.equal(metrics[0].v, 60, 'fps 应为 60')
  assert.equal(metrics[0].p.droppedFrames, 0)
})

test('网络：wrapFetch 复用内核且错误 rethrow', async () => {
  const kernel = {
    wrapFetch: (impl) => async (...args) => {
      try {
        return await impl(...args)
      } catch (e) {
        throw e
      }
    }
  }
  const n = createNetworkInstrumentor({ wrapFetch: kernel.wrapFetch })
  const w = n.wrap(async () => {
    throw new Error('x')
  })
  await assert.rejects(() => w(), /x/)
})
