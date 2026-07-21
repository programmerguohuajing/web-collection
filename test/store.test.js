import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyIssue, percentile } from '../apps/api/src/store.js'

test('resolved issue becomes regression on a later release', () => {
  assert.equal(classifyIssue({ status: 'resolved', release: '1.0.0' }, { release: '1.0.1' }), 'regression')
})

test('percentile uses the nearest rank value', () => {
  assert.equal(percentile([1, 2, 100, 101], 75), 100)
})
