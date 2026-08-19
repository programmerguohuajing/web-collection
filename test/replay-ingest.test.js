import test from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { decompressReplayEvents, reassembleReplayEvents } from '../apps/api/src/replay-ingest.js'

/** 构造一条 gzip base64 压缩的 replay 记录（对齐 SDK 默认 compression:'gzip'）。 */
function gzippedEvent(events) {
  const b64 = gzipSync(Buffer.from(JSON.stringify(events)), { level: 9 }).toString('base64')
  return { compression: 'gzip', events: b64 }
}

test('decompressReplayEvents 还原 gzip base64 事件数组（SDK 默认路径）', () => {
  const events = [
    { type: 2, timestamp: 100, data: { width: 800, height: 600 } },
    { type: 3, timestamp: 150, data: {} }
  ]
  const out = decompressReplayEvents(gzippedEvent(events))
  assert.deepEqual(out, events)
})

test('decompressReplayEvents 兼容未压缩数组直传', () => {
  const events = [{ type: 3, timestamp: 1 }]
  assert.deepEqual(decompressReplayEvents({ compression: 'none', events }), events)
  // 无 compression 字段但 events 为数组也应直传
  assert.deepEqual(decompressReplayEvents({ events }), events)
})

/** 构造一条 compression:'none' 且 events 为 base64(JSON) 的 fallback 记录（无 CompressionStream 环境）。 */
function noneBase64Event(events) {
  return { compression: 'none', events: Buffer.from(JSON.stringify(events)).toString('base64') }
}

test('decompressReplayEvents 兼容 compression:none + base64 编码数组（SDK fallback 路径）', () => {
  const events = [
    { type: 2, timestamp: 100, data: { width: 800, height: 600 } },
    { type: 3, timestamp: 150, data: {} }
  ]
  const out = decompressReplayEvents(noneBase64Event(events))
  assert.deepEqual(out, events)
})

test('decompressReplayEvents 畸形 gzip / 非字符串 安全降级为空', () => {
  assert.deepEqual(decompressReplayEvents({ compression: 'gzip', events: '!!!not-gzip!!!' }), [])
  assert.deepEqual(decompressReplayEvents({ compression: 'gzip', events: 123 }), [])
  assert.deepEqual(decompressReplayEvents(null), [])
  assert.deepEqual(decompressReplayEvents({}), [])
})

test('reassembleReplayEvents 跨分页按事件时间重组（收包乱序也能还原）', () => {
  // 三条分页记录，按入库顺序为 page3、page1、page2（模拟乱序到达）。
  const rows = [
    { events_json: [{ type: 3, timestamp: 300 }, { type: 3, timestamp: 350 }] }, // page3
    { events_json: [{ type: 2, timestamp: 100 }, { type: 3, timestamp: 120 }] }, // page1（含全量快照）
    { events_json: [{ type: 3, timestamp: 200 }, { type: 3, timestamp: 250 }] }  // page2
  ]
  const out = reassembleReplayEvents(rows)
  // 应从首个 type:2 快照开始，并按时间戳升序
  assert.deepEqual(out.map(e => e.timestamp), [100, 120, 200, 250, 300, 350])
  assert.equal(out[0].type, 2)
})

test('reassembleReplayEvents 无快照时也返回全部事件（不裁剪）', () => {
  const rows = [{ events_json: [{ type: 3, timestamp: 50 }, { type: 3, timestamp: 60 }] }]
  const out = reassembleReplayEvents(rows)
  assert.deepEqual(out.map(e => e.timestamp), [50, 60])
})

test('reassembleReplayEvents 容忍非数组 / 空行', () => {
  assert.deepEqual(reassembleReplayEvents([]), [])
  assert.deepEqual(reassembleReplayEvents([{ events_json: null }, { events_json: 'bad' }]), [])
})

test('端到端：gzip 分页上报 → 服务端重组得到完整有序回放', () => {
  // 模拟 SDK flushReplay 把 5 个事件按 page/pageCount 拆成 2 页，均为 gzip。
  const all = [
    { type: 2, timestamp: 10 },
    { type: 3, timestamp: 20 },
    { type: 3, timestamp: 30 },
    { type: 3, timestamp: 40 },
    { type: 3, timestamp: 50 }
  ]
  const page1 = all.slice(0, 3)
  const page2 = all.slice(3)
  // 到达顺序故意颠倒：先 page2 后 page1。
  const rows = [
    { events_json: decompressReplayEvents(gzippedEvent(page2)) },
    { events_json: decompressReplayEvents(gzippedEvent(page1)) }
  ]
  const out = reassembleReplayEvents(rows)
  assert.deepEqual(out, all)
})
