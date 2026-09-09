/**
 * @file 事件映射表测试（类型白名单 / clip 长度 / 分类）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAPPING_TABLE, EVENT_TYPES, assertWhitelisted, categoryOf } from '../src/events.js'

test('映射表全部 11 行：type 在白名单内、metric/name 不超长', () => {
  assert.equal(MAPPING_TABLE.length, 11)
  for (const row of MAPPING_TABLE) {
    const ev = row.build()
    assert.ok(EVENT_TYPES.includes(ev.type), `${row.id} type=${ev.type} 不在白名单`)
    assert.ok(assertWhitelisted(ev), `${row.id} 未通过 assertWhitelisted`)
    if (ev.metric) assert.ok(ev.metric.length <= 32, `${row.id} metric 超长`)
    if (ev.name) assert.ok(ev.name.length <= 160, `${row.id} name 超长`)
    assert.equal(categoryOf(ev), row.category, `${row.id} 分类不符`)
  }
})

test('移动端不新增 type（全部来自封闭白名单）', () => {
  for (const row of MAPPING_TABLE) {
    const ev = row.build()
    assert.ok(EVENT_TYPES.includes(ev.type))
  }
})
