import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CANONICAL_EVENTS, EVENT_ALIASES, resolveEventName, isCanonical, CANONICAL_EVENT_NAMES } from '../packages/events-schema.js'

test('EVENT_ALIASES 覆盖文档 §6.1 全部旧名', () => {
  for (const old of ['pv', 'page_leave', 'app_start', 'click', 'exposure', 'form_start', 'form_submit']) {
    assert.ok(EVENT_ALIASES[old], `缺少别名映射: ${old}`)
  }
})

test('resolveEventName 将旧名归一为标准名', () => {
  assert.equal(resolveEventName('pv'), 'page_viewed')
  assert.equal(resolveEventName('click'), 'element_clicked')
  assert.equal(resolveEventName('app_start'), 'session_started')
  assert.equal(resolveEventName('exposure'), 'element_exposed')
  assert.equal(resolveEventName('page_leave'), 'page_left')
})

test('resolveEventName 保留已是标准名的事件', () => {
  assert.equal(resolveEventName('page_viewed'), 'page_viewed')
  assert.equal(resolveEventName('element_clicked'), 'element_clicked')
})

test('resolveEventName 对未知事件原样返回，不静默丢弃', () => {
  assert.equal(resolveEventName('custom_business_event'), 'custom_business_event')
  assert.equal(resolveEventName(''), '')
})

test('resolveEventName 大小写与空白不敏感', () => {
  assert.equal(resolveEventName('  PV '), 'page_viewed')
  assert.equal(resolveEventName('Click'), 'element_clicked')
})

test('isCanonical 正确判断兼容等价', () => {
  assert.equal(isCanonical('pv', 'page_viewed'), true)
  assert.equal(isCanonical('page_viewed', 'page_viewed'), true)
  assert.equal(isCanonical('click', 'page_viewed'), false)
})

test('CANONICAL_EVENT_NAMES 与 CANONICAL_EVENTS 键一致', () => {
  assert.deepEqual(CANONICAL_EVENT_NAMES.sort(), Object.keys(CANONICAL_EVENTS).sort())
})
