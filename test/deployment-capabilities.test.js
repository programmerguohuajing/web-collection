import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CAPABILITY_KEYS,
  NODE_CAPABILITIES,
  WORKER_CAPABILITIES,
  buildCapabilities
} from '../packages/deployment-capabilities.js'

const nodeSource = readFileSync(new URL('../apps/api/src/index.js', import.meta.url), 'utf8')
const workerSource = readFileSync(new URL('../cloudflare/worker.js', import.meta.url), 'utf8')

test('Node 与 Worker 能力键集合与 CAPABILITY_KEYS 完全一致（schema parity）', () => {
  const nodeKeys = Object.keys(buildCapabilities(NODE_CAPABILITIES)).filter(k => k !== 'productAnalyticsV2').sort()
  const workerKeys = Object.keys(buildCapabilities(WORKER_CAPABILITIES)).filter(k => k !== 'productAnalyticsV2').sort()
  assert.deepEqual(nodeKeys, [...CAPABILITY_KEYS].sort())
  assert.deepEqual(workerKeys, [...CAPABILITY_KEYS].sort())
  assert.deepEqual(nodeKeys, workerKeys)
})

test('Worker 不是“整体未实现”：仅 insights 一项差异', () => {
  const node = buildCapabilities(NODE_CAPABILITIES)
  const worker = buildCapabilities(WORKER_CAPABILITIES)
  // 除 insights 外，其余已实现的路径/实时/版本/漏斗/仪表盘必须一致为真。
  for (const key of ['funnels', 'dashboards', 'paths', 'live', 'releases']) {
    assert.equal(worker[key], true, `Worker 应支持 ${key}`)
    assert.equal(node[key], worker[key], `${key} 在两端应一致`)
  }
  assert.equal(node.insights, true)
  assert.equal(worker.insights, false)
})

test('buildCapabilities 写入向后兼容别名 productAnalyticsV2', () => {
  assert.equal(buildCapabilities(NODE_CAPABILITIES).productAnalyticsV2, true)
  assert.equal(buildCapabilities(WORKER_CAPABILITIES).productAnalyticsV2, false)
})

test('Node 与 Worker 都从单一真相源导入 buildCapabilities（代码级契约）', () => {
  assert.match(nodeSource, /deployment-capabilities/)
  assert.match(nodeSource, /buildCapabilities\(\s*NODE_CAPABILITIES\s*\)/)
  assert.match(workerSource, /deployment-capabilities/)
  assert.match(workerSource, /buildCapabilities\(\s*WORKER_CAPABILITIES\s*\)/)
})
