import assert from 'node:assert/strict'
import test from 'node:test'
import { eventCategory, eventSource, sanitizeEvent } from '../src/core/event.js'

test('event envelope helpers classify and redact data', () => {
  assert.equal(eventSource({ type: 'track' }), 'manual')
  assert.equal(eventSource({ type: 'behavior' }), 'auto')
  assert.equal(eventCategory({ type: 'perf', metric: 'fetch' }), 'requests')
  assert.deepEqual(sanitizeEvent({ props: { token: 'secret', amount: 2 }, context: { module: 'order' } }), { props: { token: '[REDACTED]', amount: 2 }, context: { module: 'order' } })
})
