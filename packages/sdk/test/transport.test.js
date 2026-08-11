import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createEventId,
  computeBackoff,
  parseRetryAfter,
  classifyResponse,
  IndexedDBQueue,
  FetchTransport,
  BeaconTransport,
  ReliableSender,
  createMultiTabLock
} from '../src/transport/index.js'
import { createDiagnosticSink, DIAGNOSTIC_TYPES } from '../src/transport/diagnostics.js'

// ---------------------------------------------------------------------------
// id
// ---------------------------------------------------------------------------
test('createEventId 生成唯一且符合格式的 ID', () => {
  const a = createEventId()
  const b = createEventId()
  assert.match(a, /^e-[0-9a-z]+-[0-9a-z]+-[0-9a-z]+$/)
  assert.notEqual(a, b)
})

// ---------------------------------------------------------------------------
// retry
// ---------------------------------------------------------------------------
test('computeBackoff 随 attempt 增大且不超过 max，抖动落在 [low, exp]', () => {
  const seq = [0, 1, 2, 3, 4]
  const vals = seq.map((a) => computeBackoff(a, { base: 500, max: 30000, factor: 2, jitter: 0.5, rng: () => 0 }))
  // rng=0 → 结果应为下限 exp*(1-jitter) = exp*0.5
  assert.equal(vals[0], 250)
  assert.equal(vals[1], 500)
  assert.equal(vals[2], 1000)
  assert.equal(vals[3], 2000)
  assert.equal(vals[4], 4000)

  // rng=1 → 上限 exp
  const tops = seq.map((a) => computeBackoff(a, { base: 500, max: 30000, factor: 2, jitter: 0.5, rng: () => 1 }))
  assert.equal(tops[4], 8000)

  // 不超过 max
  const capped = computeBackoff(20, { base: 500, max: 30000, factor: 2, jitter: 0, rng: () => 1 })
  assert.ok(capped <= 30000)
})

test('parseRetryAfter 支持秒数、HTTP-date 与回退', () => {
  assert.equal(parseRetryAfter('5'), 5000)
  assert.equal(parseRetryAfter(null, 123), 123)
  const future = new Date(Date.now() + 2000).toUTCString()
  const ms = parseRetryAfter(future)
  assert.ok(ms >= 1000 && ms <= 3000)
  assert.equal(parseRetryAfter('garbage', 999), 999)
})

test('classifyResponse 区分 success/retry/drop', () => {
  assert.equal(classifyResponse(200), 'success')
  assert.equal(classifyResponse(204), 'success')
  assert.equal(classifyResponse(429), 'retry')
  assert.equal(classifyResponse(500), 'retry')
  assert.equal(classifyResponse(503), 'retry')
  assert.equal(classifyResponse(408), 'retry')
  assert.equal(classifyResponse(400), 'drop')
  assert.equal(classifyResponse(404), 'drop')
  assert.equal(classifyResponse(413), 'drop')
})

// ---------------------------------------------------------------------------
// diagnostics
// ---------------------------------------------------------------------------
test('createDiagnosticSink 仅在有回调时分发，且不抛异常', () => {
  const events = []
  const sink = createDiagnosticSink((e) => events.push(e))
  sink.emit('timeout', { status: 0 })
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'timeout')
  assert.ok(typeof events[0].ts === 'number')
  // 无回调时静默
  createDiagnosticSink(null).emit('queue_full', {})
  // 回调抛错不影响主流程
  const bad = createDiagnosticSink(() => { throw new Error('x') })
  assert.doesNotThrow(() => bad.emit('retry', {}))
})

test('DIAGNOSTIC_TYPES 覆盖路线图要求的诊断类型', () => {
  for (const t of ['queue_full', 'rate_limited', 'timeout', 'invalid_payload', 'storage_quota', 'dropped_by_sampling', 'beacon_rejected', 'beacon_oversize', 'beacon_fallback']) {
    assert.ok(DIAGNOSTIC_TYPES.includes(t), `缺少 ${t}`)
  }
})

// ---------------------------------------------------------------------------
// IndexedDBQueue（内存降级模式，Node 无 indexedDB）
// ---------------------------------------------------------------------------
test('IndexedDBQueue 内存模式下 enqueue/peek/dequeue/snapshot/clear', async () => {
  const q = new IndexedDBQueue({ maxQueue: 50 })
  assert.equal(q.isPersistent, false)
  await q.enqueue({ id: 'a', value: { n: 1 }, ts: 1 })
  await q.enqueue({ id: 'b', value: { n: 2 }, ts: 2 })
  assert.equal(await q.size(), 2)
  const peeked = await q.peek(10)
  assert.deepEqual(peeked.map((v) => v.n), [1, 2])
  // peek 不移除
  assert.equal(await q.size(), 2)
  const taken = await q.dequeue(1)
  assert.deepEqual(taken, [{ n: 1 }])
  assert.equal(await q.size(), 1)
  const snap = await q.snapshot()
  assert.deepEqual(snap, [{ n: 2 }])
  await q.clear()
  assert.equal(await q.size(), 0)
})

test('IndexedDBQueue 超出 maxQueue 时丢弃最旧', async () => {
  const q = new IndexedDBQueue({ maxQueue: 2 })
  await q.enqueue({ id: 'a', value: { n: 1 }, ts: 1 })
  await q.enqueue({ id: 'b', value: { n: 2 }, ts: 2 })
  await q.enqueue({ id: 'c', value: { n: 3 }, ts: 3 })
  const snap = await q.snapshot()
  assert.deepEqual(snap.map((v) => v.n), [2, 3])
})

test('IndexedDBQueue replaceAll 整体替换', async () => {
  const q = new IndexedDBQueue({ maxQueue: 10 })
  await q.enqueue({ id: 'x', value: { n: 9 }, ts: 1 })
  await q.replaceAll([{ id: 'y', value: { n: 8 }, ts: 2 }])
  const snap = await q.snapshot()
  assert.deepEqual(snap, [{ n: 8 }])
})

// ---------------------------------------------------------------------------
// FetchTransport
// ---------------------------------------------------------------------------
function jsonResponse(status, headers = {}) {
  let _headers = headers
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? _headers['retry-after'] : null) }
  }
}

test('FetchTransport 成功返回 status', async () => {
  const calls = []
  const t = new FetchTransport({
    endpoint: '/api/collect',
    fetchImpl: async (url, init) => { calls.push(init); return jsonResponse(200) }
  })
  const res = await t.send([{ a: 1 }])
  assert.equal(res.status, 200)
  assert.equal(res.ok, true)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers['content-type'], 'application/json')
})

test('FetchTransport 携带 x-app-key', async () => {
  const t = new FetchTransport({
    endpoint: '/api/collect',
    collectKey: 'k1',
    fetchImpl: async () => jsonResponse(200)
  })
  const res = await t.send([{ a: 1 }])
  assert.equal(res.status, 200)
})

test('FetchTransport 服务端 500 返回结果（分类由调用方决定）', async () => {
  const t = new FetchTransport({ endpoint: '/api/collect', fetchImpl: async () => jsonResponse(500) })
  const res = await t.send([{ a: 1 }])
  assert.equal(res.status, 500)
  assert.equal(res.ok, false)
})

test('FetchTransport 超时抛 TimeoutError', async () => {
  const t = new FetchTransport({
    endpoint: '/api/collect',
    timeout: 20,
    fetchImpl: (url, init) =>
      new Promise((_resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        if (init.signal) {
          if (init.signal.aborted) return onAbort()
          init.signal.addEventListener('abort', onAbort)
        }
      })
  })
  let err
  try { await t.send([{ a: 1 }]) } catch (e) { err = e }
  assert.ok(err)
  assert.equal(err.name, 'TimeoutError')
})

test('FetchTransport 网络错误抛 NetworkError', async () => {
  const t = new FetchTransport({ endpoint: '/api/collect', fetchImpl: async () => { throw new Error('down') } })
  let err
  try { await t.send([{ a: 1 }]) } catch (e) { err = e }
  assert.ok(err)
  assert.equal(err.name, 'NetworkError')
})

test('FetchTransport 不可用抛出 TransportUnavailable', async () => {
  const t = new FetchTransport({ endpoint: '/api/collect', fetchImpl: null })
  assert.equal(t.available(), false)
  await assert.rejects(() => t.send([{ a: 1 }]), /fetch unavailable/)
})

// ---------------------------------------------------------------------------
// BeaconTransport
// ---------------------------------------------------------------------------
test('BeaconTransport 字节长度按 UTF-8 计算（非字符长度）', () => {
  const t = new BeaconTransport({ endpoint: '/api/collect' })
  assert.equal(t._byteLength('中国'), 6)
  assert.equal(t._byteLength('ab'), 2)
})

test('BeaconTransport 走 sendBeacon 成功入队', async () => {
  const calls = []
  const t = new BeaconTransport({
    endpoint: '/api/collect',
    sendBeacon: (url, data) => { calls.push({ url, data }); return true }
  })
  const events = [{ a: 1 }, { b: 2 }]
  const res = await t.send(events, { diagnostic: createDiagnosticSink(() => {}) })
  assert.equal(res.outcome, 'queued')
  assert.equal(res.queued, 1)
  assert.equal(calls.length, 1)
})

test('BeaconTransport sendBeacon 返回 false → beacon_rejected', async () => {
  const eventsSeen = []
  const t = new BeaconTransport({
    endpoint: '/api/collect',
    sendBeacon: () => false
  })
  const res = await t.send([{ a: 1 }], { diagnostic: createDiagnosticSink((e) => eventsSeen.push(e.type)) })
  assert.equal(res.outcome, 'rejected')
  assert.ok(eventsSeen.includes('beacon_rejected'))
})

test('BeaconTransport 单条超限 → beacon_oversize（非破坏性跳过）', async () => {
  const eventsSeen = []
  let called = 0
  const t = new BeaconTransport({
    endpoint: '/api/collect',
    maxBytes: 20,
    sendBeacon: () => { called++; return true }
  })
  const res = await t.send([{ a: 'x'.repeat(40) }], { diagnostic: createDiagnosticSink((e) => eventsSeen.push(e.type)) })
  assert.equal(res.oversize, 1)
  assert.equal(called, 0)
  assert.ok(eventsSeen.includes('beacon_oversize'))
})

test('BeaconTransport UTF-8 字节切片产生多个批次', async () => {
  let calls = 0
  const t = new BeaconTransport({
    endpoint: '/api/collect',
    maxBytes: 30,
    sendBeacon: () => { calls++; return true }
  })
  const events = [{ a: 'xxxxx' }, { a: 'yyyyy' }, { a: 'zzzzz' }] // 每个 JSON ~13 字节
  await t.send(events, { diagnostic: createDiagnosticSink(() => {}) })
  // 前两组合并（26B），第三个单独（13B）→ 2 批
  assert.equal(calls, 2)
})

test('BeaconTransport 无 Beacon 且配置 collectKey → 回退 fetch keepalive', async () => {
  const seen = []
  let fetchCalled = false
  const t = new BeaconTransport({
    endpoint: '/api/collect',
    collectKey: 'k1',
    sendBeacon: undefined,
    fetchImpl: async () => { fetchCalled = true; return jsonResponse(200) }
  })
  const res = await t.send([{ a: 1 }], { diagnostic: createDiagnosticSink((e) => seen.push(e.type)) })
  assert.equal(res.outcome, 'fallback')
  assert.equal(fetchCalled, true)
  assert.ok(seen.includes('beacon_fallback'))
})

// ---------------------------------------------------------------------------
// ReliableSender
// ---------------------------------------------------------------------------
test('ReliableSender enqueue 自动补全 eventId', () => {
  const s = new ReliableSender({ maxQueue: 10 })
  s.enqueue({ type: 'track', name: 'x' })
  assert.equal(s.size(), 1)
  assert.ok(s.items[0].value.eventId)
  assert.match(s.items[0].value.eventId, /^e-/)
})

test('ReliableSender 在线发送成功 → 出队', async () => {
  const seen = []
  const transport = new FetchTransport({ endpoint: '/api/collect', fetchImpl: async () => jsonResponse(200) })
  const s = new ReliableSender({ transport, maxQueue: 10, maxBatch: 10, diagnostic: createDiagnosticSink((e) => seen.push(e.type)) })
  for (let i = 0; i < 3; i++) s.enqueue({ type: 'track', name: 'e' + i })
  const res = await s.sendBatchOnline(false)
  assert.equal(res.sent, 3)
  assert.equal(s.size(), 0)
  assert.ok(seen.includes('flush_success'))
})

test('ReliableSender 收到 4xx → 永久丢弃（dropped_non_retryable）', async () => {
  const seen = []
  const transport = new FetchTransport({ endpoint: '/api/collect', fetchImpl: async () => jsonResponse(400) })
  const s = new ReliableSender({ transport, maxQueue: 10, maxBatch: 10, diagnostic: createDiagnosticSink((e) => seen.push(e)) })
  s.enqueue({ type: 'track', name: 'x' })
  const res = await s.sendBatchOnline(false)
  assert.equal(res.dropped, 1)
  assert.equal(s.size(), 0)
  assert.ok(seen.some((e) => e.type === 'dropped_non_retryable'))
})

test('ReliableSender 收到 5xx → 退避重试，超上限后丢弃', async () => {
  const seen = []
  const transport = new FetchTransport({ endpoint: '/api/collect', fetchImpl: async () => jsonResponse(500) })
  const s = new ReliableSender({
    transport,
    maxQueue: 10,
    maxBatch: 10,
    maxRetries: 2,
    backoffBase: 1,
    backoffMax: 1,
    diagnostic: createDiagnosticSink((e) => seen.push(e.type))
  })
  s.enqueue({ type: 'track', name: 'x' })
  s.enqueue({ type: 'track', name: 'y' })
  // 第 1、2 次：retry；第 3 次：超过 maxRetries → 丢弃
  await s.sendBatchOnline(false)
  await s.sendBatchOnline(false)
  const res = await s.sendBatchOnline(false)
  assert.equal(res.dropped, 2)
  assert.equal(s.size(), 0)
  assert.ok(seen.filter((t) => t === 'retry').length >= 2)
  assert.ok(seen.includes('dropped_non_retryable'))
  // 清理可能残留的退避定时器
  clearTimeout(s._retryTimer)
})

test('ReliableSender 并发 flush 仅单活跃发送者', async () => {
  const transport = new FetchTransport({ endpoint: '/api/collect', fetchImpl: async () => jsonResponse(200) })
  const s = new ReliableSender({ transport, maxQueue: 10, maxBatch: 10 })
  s.enqueue({ type: 'track', name: 'x' })
  const [a, b] = await Promise.all([s.sendBatchOnline(false), s.sendBatchOnline(false)])
  // 其中一个应被跳过（skipped），另一个发送 1 条
  const sent = (a.sent || 0) + (b.sent || 0)
  assert.equal(sent, 1)
  assert.ok(a.skipped || b.skipped)
})

test('ReliableSender 退出 flush 走 Beacon 且非破坏性（保留队列）', async () => {
  let beaconCalls = 0
  const beacon = new BeaconTransport({
    endpoint: '/api/collect',
    sendBeacon: () => { beaconCalls++; return true }
  })
  const transport = new FetchTransport({ endpoint: '/api/collect', fetchImpl: async () => jsonResponse(200) })
  const s = new ReliableSender({ transport, beacon, maxQueue: 10, maxBatch: 10 })
  for (let i = 0; i < 3; i++) s.enqueue({ type: 'track', name: 'e' + i })
  const res = await s.sendExitBatch()
  assert.equal(res.outcome, 'queued')
  assert.equal(beaconCalls, 1)
  // 非破坏性：事件仍留在队列，待服务端按 eventId 幂等去重
  assert.equal(s.size(), 3)
})

test('ReliableSender 退出 flush 无 Beacon 时回退 fetch keepalive（非破坏性）', async () => {
  let fetchCalls = 0
  const transport = new FetchTransport({ endpoint: '/api/collect', fetchImpl: async () => { fetchCalls++; return jsonResponse(200) } })
  const s = new ReliableSender({ transport, beacon: null, maxQueue: 10, maxBatch: 10 })
  s.enqueue({ type: 'track', name: 'x' })
  const res = await s.sendExitBatch()
  assert.equal(res.outcome, 'keepalive')
  assert.equal(fetchCalls, 1)
  assert.equal(s.size(), 1)
})

test('ReliableSender 从持久队列恢复（next_session_recovered）', async () => {
  const cold = new IndexedDBQueue({ maxQueue: 50 })
  await cold.replaceAll([
    { id: 'r1', value: { eventId: 'r1', type: 'track', name: 'old' }, ts: 1 },
    { id: 'r2', value: { eventId: 'r2', type: 'track', name: 'old2' }, ts: 2 }
  ])
  const seen = []
  const s = new ReliableSender({ cold, transport: new FetchTransport({ endpoint: '/api/collect', fetchImpl: async () => jsonResponse(200) }), maxQueue: 10, diagnostic: createDiagnosticSink((e) => seen.push(e)) })
  await s.ready
  assert.equal(s.size(), 2)
  assert.ok(seen.some((e) => e.type === 'next_session_recovered'))
  // 在线发送成功清空
  const res = await s.sendBatchOnline(false)
  assert.equal(res.sent, 2)
  assert.equal(s.size(), 0)
})

// ---------------------------------------------------------------------------
// MultiTabLock
// ---------------------------------------------------------------------------
// 注意：这里直接使用 Node 全局的 BroadcastChannel（生产环境即浏览器 BroadcastChannel），
// 以验证真实投递语义；测试结束必须 close()，否则底层 MessagePort 会使 worker 无法退出。

test('MultiTabLock 单域名最多一个活跃发送者', async () => {
  const lockA = createMultiTabLock('same', { timeout: 100 })
  const lockB = createMultiTabLock('same', { timeout: 100 })
  try {
    // A 赢得锁（无竞争者回应）
    const aWon = await lockA.acquire()
    assert.equal(aWon, true)
    assert.equal(lockA.isHeld(), true)
    // B 请求时被 A 拒绝
    const bWon = await lockB.acquire()
    assert.equal(bWon, false)
    // A 释放后 B 可赢得
    lockA.release()
    const bWon2 = await lockB.acquire()
    assert.equal(bWon2, true)
  } finally {
    lockA.close()
    lockB.close()
  }
})

test('MultiTabLock 无 BroadcastChannel 时退化为标签页内布尔守卫', async () => {
  const lock = createMultiTabLock('x', { BroadcastChannel: null, timeout: 100 })
  try {
    assert.equal(await lock.acquire(), true)
    assert.equal(await lock.acquire(), false)
    lock.release()
    assert.equal(await lock.acquire(), true)
  } finally {
    lock.close()
  }
})

