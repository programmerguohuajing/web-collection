import assert from 'node:assert/strict'
import test from 'node:test'
import { behaviorDetailLabel } from '../src/utils/format.js'

test('formats behavior event details without repeating the type', () => {
  assert.equal(behaviorDetailLabel({ type: 'behavior', name: 'click', props: { elementLabel: '换一换' } }), '换一换')
  assert.equal(behaviorDetailLabel({ type: 'track', name: 'checkout_submit' }), 'checkout_submit')
  assert.equal(behaviorDetailLabel({ type: 'behavior', name: 'page_leave', props: { stayTime: 3200 } }), '停留 3.2s')
  assert.equal(behaviorDetailLabel({ type: 'behavior', name: 'scroll', props: { depth: 42, maxDepth: 80 } }), '当前 42% · 最深 80%')
  assert.equal(behaviorDetailLabel({ type: 'behavior', name: 'exposure', props: { label: '推荐商品' } }), '推荐商品')
  assert.equal(behaviorDetailLabel({ type: 'behavior', name: 'pushState', props: { from: '/list', to: '/detail' } }), '/list → /detail')
  assert.equal(behaviorDetailLabel({ type: 'behavior', name: 'pv' }), '-')
  assert.equal(behaviorDetailLabel({ type: 'behavior', name: 'click' }), '-')
})
