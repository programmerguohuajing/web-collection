import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyIssue, fingerprint, percentile } from '../apps/api/src/store.js'

test('resolved issue becomes regression on a later release', () => {
  assert.equal(classifyIssue({ status: 'resolved', release: '1.0.0' }, { release: '1.0.1' }), 'regression')
})

test('percentile uses the nearest rank value', () => {
  assert.equal(percentile([1, 2, 100, 101], 75), 100)
})

test('SSE errors from the same endpoint share a fingerprint', () => {
  const base = { appId: 'web', name: 'Error', message: 'SseError', props: { name: 'SseError', source: 'https://example.com/events' } }
  assert.equal(fingerprint({ ...base, stack: 'at sdk-v1.js:1:1' }), fingerprint({ ...base, name: 'SseError', stack: 'at sdk-v2.js:2:2' }))
  assert.notEqual(fingerprint(base), fingerprint({ ...base, props: { ...base.props, source: 'https://example.com/other' } }))
})
