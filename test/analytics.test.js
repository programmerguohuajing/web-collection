import assert from 'node:assert/strict'
import test from 'node:test'
import { computeFunnel } from '../apps/api/src/services/analytics-service.js'

test('funnel counts ordered conversion, dropoff, errors and replay correlation', () => {
  const base = { release_name: '1.0', browser: 'Chrome', device: 'Desktop' }
  const rows = [
    { ...base, actor: 'u1', session_id: 's1', name: 'view', type: 'track', ts: 1 },
    { ...base, actor: 'u1', session_id: 's1', name: 'pay', type: 'track', ts: 2 },
    { ...base, actor: 'u2', session_id: 's2', name: 'view', type: 'track', ts: 3 },
    { ...base, actor: 'u2', session_id: 's2', name: 'Error', type: 'error', ts: 4 }
  ]
  const result = computeFunnel(rows, ['view', 'pay'], [{ session_id: 's2_replay' }])
  assert.deepEqual(result.steps.map(item => [item.count, item.lost]), [[2, 0], [1, 1]])
  assert.equal(result.lostSessions[0].errors, 1)
  assert.equal(result.lostSessions[0].replaySessionId, 's2_replay')
})
