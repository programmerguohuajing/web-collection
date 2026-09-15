import test from 'node:test'
import assert from 'node:assert/strict'
import { getOverviewTrend } from '../apps/api/src/services/overview-trend-service.js'

test('getOverviewTrend returns 24 bucket trend objects', async () => {
  const buckets = await getOverviewTrend()
  assert.equal(Array.isArray(buckets), true)
  assert.equal(buckets.length, 24)
  for (const b of buckets) {
    assert.ok(typeof b.ts === 'number')
    assert.ok(typeof b.label === 'string')
    assert.ok(typeof b.errors === 'number')
    assert.ok(typeof b.requests === 'number')
    assert.ok(typeof b.users === 'number')
  }
})

test('getOverviewTrend supports filter parameters', async () => {
  const now = Date.now()
  const buckets = await getOverviewTrend({
    appId: 'test-app',
    release: '1.0.0',
    startTime: now - 24 * 3600000,
    endTime: now
  })
  assert.equal(buckets.length, 24)
})
