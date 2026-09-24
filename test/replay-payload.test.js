import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeReplayPayload } from '../apps/web/src/utils/replay-payload.js'

test('normalizeReplayPayload 统一裸数组/events/data 信封并按时间排序', () => {
  const variants = [
    [{ type: 3, ts: 20 }, { type: 2, timestamp: 0 }],
    { events: [{ type: 3, ts: 20 }, { type: 2, timestamp: 0 }] },
    { data: [{ type: 3, ts: 20 }, { type: 2, timestamp: 0 }] }
  ]
  for (const payload of variants) {
    const result = normalizeReplayPayload(payload)
    assert.equal(result.rawEventCount, 2)
    assert.deepEqual(result.events.map(item => item.timestamp), [0, 20])
  }
})

test('normalizeReplayPayload 保留截断元数据并剔除非法时间事件', () => {
  const result = normalizeReplayPayload({
    events: [{ type: 2, timestamp: 10 }, { type: 3, timestamp: 'bad' }],
    truncated: true,
    originalSpanMs: 3600000,
    spanMs: 1800000
  })
  assert.equal(result.rawEventCount, 2)
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0].timestamp, 10)
  assert.equal(result.truncated, true)
  assert.equal(result.originalSpanMs, 3600000)
  assert.equal(result.spanMs, 1800000)
})

test('normalizeReplayPayload 空/异常响应稳定返回空契约', () => {
  for (const payload of [null, undefined, {}, 'bad']) {
    assert.deepEqual(normalizeReplayPayload(payload).events, [])
    assert.equal(normalizeReplayPayload(payload).rawEventCount, 0)
  }
})
