/**
 * Phase 0 · P0-5 事件信封扩展（版本拆分 + 新字段）契约测试。
 *
 * 覆盖：
 *  1. Node mapEvent 正确映射新信封字段；旧事件（无新列）返回 null 不抛错。
 *  2. Cloudflare Worker mapEvent 与 Node mapEvent 字段口径一致（契约对齐）。
 *  3. buildEventInsert 写入 43 列，占位符/参数与列数一致；receivedAt=Date.now()、
 *     appVersion/eventId 回退 release/id、schemaVersion 默认 '1'。
 *
 * 设计依据：tracking-platform-comparison-and-evolution-plan.md §6.2 / P0-5。
 * 不依赖真实数据库（buildEventInsert 为纯函数）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { mapEvent as nodeMapEvent } from '../apps/api/src/mappers/event-mapper.js'
import { mapEvent as workerMapEvent } from '../cloudflare/worker.js'
import { buildEventInsert } from '../apps/api/src/repositories/events-repo.js'

/** 构造一条"全字段"事件行（模拟 DB 查询结果）。 */
function fullRow(overrides = {}) {
  return {
    id: 'e1',
    ts: 1000,
    type: 'track',
    app_id: 'app-a',
    release_name: '1.0.0',
    user_id: 'u1',
    user_name: 'n',
    user_phone: '13800138000',
    session_id: 's1',
    device_id: 'd1',
    trace_id: 't1',
    span_id: 'sp1',
    parent_span_id: 'psp1',
    url: 'https://example.com/p',
    path: '/p',
    title: 'T',
    referrer: 'r',
    user_agent: 'ua',
    sdk_version: '1.2.3',
    environment: 'production',
    source: 'web',
    context_json: '{}',
    browser: 'Chrome',
    os: 'Windows',
    device: 'desktop',
    name: 'click',
    metric: 'lcp',
    value: 123.45,
    message: 'm',
    stack: 'st',
    props_json: '{"k":"v"}',
    breadcrumbs_json: '[]',
    // ---- P0-5 信封新字段 ----
    app_version: '1.0.0',
    product_id: 'prod-1',
    event_id: 'evt-9',
    request_id: 'req-9',
    occurred_at: 900,
    received_at: 1100,
    schema_version: '2',
    batch_id: 'batch-1',
    retry_count: 2,
    contract_status: 'accepted',
    contract_errors_json: null,
    ...overrides
  }
}

test('Node mapEvent 正确映射 P0-5 信封新字段', () => {
  const out = nodeMapEvent(fullRow())
  assert.equal(out.appVersion, '1.0.0')
  assert.equal(out.productId, 'prod-1')
  assert.equal(out.eventId, 'evt-9')
  assert.equal(out.requestId, 'req-9')
  assert.equal(out.occurredAt, 900)
  assert.equal(out.receivedAt, 1100)
  assert.equal(out.schemaVersion, '2')
  assert.equal(out.batchId, 'batch-1')
  assert.equal(out.retryCount, 2)
  assert.equal(out.contractStatus, 'accepted')
  assert.equal(out.contractErrors, null)
  // 既有字段不受影响
  assert.equal(out.release, '1.0.0')
  assert.equal(out.sdkVersion, '1.2.3')
  assert.deepEqual(out.props, { k: 'v' })
})

test('Node mapEvent 对旧事件（无信封列）返回 null 且不抛错', () => {
  const legacy = {
    id: 'e-legacy',
    ts: 500,
    type: 'track',
    app_id: 'app-a',
    release_name: '0.9.0',
    user_id: null,
    user_name: null,
    user_phone: null,
    session_id: null,
    device_id: null,
    trace_id: null,
    span_id: null,
    url: null,
    path: null,
    title: null,
    referrer: null,
    user_agent: null,
    sdk_version: null,
    environment: null,
    source: null,
    context_json: null,
    browser: null,
    os: null,
    device: null,
    name: 'pv',
    metric: null,
    value: null,
    message: null,
    stack: null,
    props_json: null,
    breadcrumbs_json: null
  }
  assert.doesNotThrow(() => nodeMapEvent(legacy))
  const out = nodeMapEvent(legacy)
  assert.equal(out.appVersion, null)
  assert.equal(out.productId, null)
  assert.equal(out.eventId, null)
  assert.equal(out.requestId, null)
  assert.equal(out.occurredAt, null)
  assert.equal(out.receivedAt, null)
  assert.equal(out.schemaVersion, null)
  assert.equal(out.batchId, null)
  assert.equal(out.retryCount, null)
  assert.equal(out.contractStatus, null)
  assert.equal(out.contractErrors, null)
})

test('Worker mapEvent 与 Node mapEvent 信封字段口径一致', () => {
  const nodeOut = nodeMapEvent(fullRow())
  const workerOut = workerMapEvent(fullRow())
  for (const key of ['appVersion', 'productId', 'eventId', 'requestId', 'occurredAt', 'receivedAt', 'schemaVersion', 'batchId', 'retryCount', 'contractStatus', 'contractErrors']) {
    assert.equal(workerOut[key], nodeOut[key], `字段 ${key} 在 Node/Worker 间不一致`)
  }
  // 既有字段也应一致（防回归）
  assert.equal(workerOut.release, nodeOut.release)
  assert.equal(workerOut.sdkVersion, nodeOut.sdkVersion)
})

test('buildEventInsert 写入 43 列且占位符/参数与列数一致', () => {
  const { sql, params } = buildEventInsert({ id: 'e1', ts: 1000, type: 'track', appId: 'app-a', release: '1.0.0' })

  const columns = sql.match(/insert into events \(([^)]+)\)/)[1]
    .split(',').map((s) => s.trim())
  const placeholders = (sql.match(/\?/g) || []).length
  assert.equal(columns.length, 43, `列数应为 43，实际 ${columns.length}`)
  assert.equal(placeholders, 43, `占位符数应为 43，实际 ${placeholders}`)
  assert.equal(params.length, 43, `参数数应为 43，实际 ${params.length}`)

  const idx = (name) => columns.indexOf(name)
  // appVersion 回退 release；eventId 回退 id；schemaVersion 默认 '1'
  assert.equal(params[idx('app_version')], '1.0.0', 'app_version 应回退 release')
  assert.equal(params[idx('event_id')], 'e1', 'event_id 应回退 id')
  assert.equal(params[idx('schema_version')], '1', 'schema_version 默认 1')
  assert.equal(params[idx('contract_status')], 'accepted')
  // received_at 为服务端写入时间（number，约等于 now）
  const receivedAt = params[idx('received_at')]
  assert.ok(typeof receivedAt === 'number' && receivedAt >= 1000, 'received_at 应为服务端时间戳')
  assert.ok(Math.abs(receivedAt - Date.now()) < 5000, 'received_at 应约等于写入时刻')
  // occurred_at 回退 ts
  assert.equal(params[idx('occurred_at')], 1000)
})

test('buildEventInsert 优先使用事件自带 envelope 字段', () => {
  const { sql, params } = buildEventInsert({
    id: 'e2',
    ts: 2000,
    type: 'track',
    appId: 'app-a',
    release: '1.0.0',
    appVersion: '2.3.4',
    eventId: 'evt-custom',
    schemaVersion: '3',
    occurredAt: 1900,
    requestId: 'req-x',
    productId: 'prod-x',
    batchId: 'batch-x',
    retryCount: 5
  })

  const columns = sql.match(/insert into events \(([^)]+)\)/)[1]
    .split(',').map((s) => s.trim())
  const idx = (name) => columns.indexOf(name)
  assert.equal(params[idx('app_version')], '2.3.4')
  assert.equal(params[idx('event_id')], 'evt-custom')
  assert.equal(params[idx('schema_version')], '3')
  assert.equal(params[idx('occurred_at')], 1900)
  assert.equal(params[idx('request_id')], 'req-x')
  assert.equal(params[idx('product_id')], 'prod-x')
  assert.equal(params[idx('batch_id')], 'batch-x')
  assert.equal(params[idx('retry_count')], 5)
})
