/**
 * @file React Native 会话回放双模式单元测试（手势轨迹 + 画面快照）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeOptions } from '../src/config.js'
import { recordPointerEvent, recordSnapshotEvent } from '../src/replay.js'

test('normalizeOptions 包含默认 replay 配置（方案二手势开启，方案一快照关闭）', () => {
  const options = normalizeOptions({})
  assert.equal(options.replay.enablePointerReplay, true)
  assert.equal(options.replay.enableSnapshotReplay, false)
  assert.equal(options.replay.snapshotIntervalMs, 2000)
  assert.equal(options.replay.snapshotQuality, 0.5)
})

test('normalizeOptions 自定义与钳位 replay 配置', () => {
  const options = normalizeOptions({
    replay: {
      enablePointerReplay: false,
      enableSnapshotReplay: true,
      snapshotIntervalMs: 100 // 小于下限 500ms
    }
  })
  assert.equal(options.replay.enablePointerReplay, false)
  assert.equal(options.replay.enableSnapshotReplay, true)
  assert.equal(options.replay.snapshotIntervalMs, 500)
})

test('recordPointerEvent 上报格式符合播放器约定的 pointer_event 结构', () => {
  const recorded = []
  const fakeClient = {
    recordReplay(name, props) {
      recorded.push({ name, props })
    }
  }

  const result = recordPointerEvent(fakeClient, {
    kind: 'down',
    x: 120.456,
    y: 340.789,
    pointerId: 2
  })

  assert.equal(result, true)
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].name, 'pointer_event')
  assert.equal(recorded[0].props.kind, 'down')
  assert.equal(recorded[0].props.x, 120.5)
  assert.equal(recorded[0].props.y, 340.8)
  assert.equal(recorded[0].props.pointer_id, 2)
  assert.equal(recorded[0].props.platform, 'react-native')
})

test('recordSnapshotEvent 上报格式符合播放器约定的 canvas_snapshot 结构', () => {
  const recorded = []
  const fakeClient = {
    recordReplay(name, props) {
      recorded.push({ name, props })
    }
  }

  const result = recordSnapshotEvent(fakeClient, {
    imageData: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    width: 390,
    height: 844
  })

  assert.equal(result, true)
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].name, 'canvas_snapshot')
  assert.equal(recorded[0].props.snapshot_type, 'image_png')
  assert.equal(recorded[0].props.width, 390)
  assert.equal(recorded[0].props.height, 844)
  assert.equal(recorded[0].props.platform, 'react-native')
  assert.ok(recorded[0].props.image_data)
})

test('客户端缺失或输入无效时静默降级不抛异常', () => {
  assert.equal(recordPointerEvent(null), false)
  assert.equal(recordSnapshotEvent(null), false)
  assert.equal(recordSnapshotEvent({ recordReplay: () => {} }, { imageData: '' }), false)
})
