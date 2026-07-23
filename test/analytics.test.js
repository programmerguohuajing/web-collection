import assert from 'node:assert/strict'
import test from 'node:test'
import { computeFunnel, computePaths, normalizeFunnelSteps, normalizeInsightQuery, whereFor } from '../apps/api/src/services/analytics-service.js'

test('trace filters support id, time, release and page', () => {
  const result = whereFor({ traceId: 'abc', release: '1.2.3', path: '/checkout', startTime: 10, endTime: 20 }, ["trace_id<>''"])
  assert.equal(result.where, "where trace_id<>'' and release_name=? and trace_id ilike ? and (path ilike ? or url ilike ?) and ts>=? and ts<=?")
  assert.deepEqual(result.params, ['1.2.3', '%abc%', '%/checkout%', '%/checkout%', 10, 20])
})

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

test('analytics query validates fields and normalizes user-selected filters', () => {
  const query = normalizeInsightQuery({
    eventName: 'checkout_submit',
    measure: 'users',
    interval: 'day',
    breakdown: 'props.plan',
    filters: [{ field: 'release', operator: 'in', value: ['1.0', '2.0'] }, { field: 'props.source', operator: 'exists' }]
  })
  assert.equal(query.measure, 'users')
  assert.equal(query.breakdown, 'props.plan')
  assert.deepEqual(query.filters[0].value, ['1.0', '2.0'])
  assert.throws(() => normalizeInsightQuery({ eventName: 'x', breakdown: "props.x' or true--" }), /拆分维度无效/)
  assert.throws(() => normalizeInsightQuery({ eventName: 'x', filters: [{ field: 'path', operator: 'contains', value: '/shop' }] }), /操作符无效/)
})

test('funnel keeps legacy steps and applies property filters within one session', () => {
  assert.deepEqual(normalizeFunnelSteps(['view', 'pay']).map(item => item.eventName), ['view', 'pay'])
  const steps = [{ eventName: 'view', filters: [{ field: 'props.plan', operator: 'eq', value: 'pro' }] }, { eventName: 'pay', filters: [] }]
  const rows = [
    { actor: 'u1', session_id: 's1', name: 'view', type: 'track', ts: 1, props_json: { plan: 'pro' } },
    { actor: 'u1', session_id: 's1', name: 'pay', type: 'track', ts: 2, props_json: {} },
    { actor: 'u1', session_id: 's2', name: 'view', type: 'track', ts: 3, props_json: { plan: 'free' } },
    { actor: 'u2', session_id: 's3', name: 'view', type: 'track', ts: 4, props_json: { plan: 'pro' } },
    { actor: 'u2', session_id: 's4', name: 'pay', type: 'track', ts: 5, props_json: {} }
  ]
  assert.deepEqual(computeFunnel(rows, steps).steps.map(item => item.count), [2, 1])
})

test('path analysis creates layered nodes, transitions and user counts', () => {
  const rows = [
    { session_id: 's1', user_id: 'u1', device_id: 'd1', path: '/home', ts: 1 },
    { session_id: 's1', user_id: 'u1', device_id: 'd1', path: '/list', ts: 2 },
    { session_id: 's1', user_id: 'u1', device_id: 'd1', path: '/detail', ts: 3 },
    { session_id: 's2', user_id: '', device_id: 'd2', path: '/home', ts: 1 },
    { session_id: 's2', user_id: '', device_id: 'd2', path: '/list', ts: 2 }
  ]
  const result = computePaths(rows, { startPath: '/home', maxDepth: 3, minUsers: 1 })
  assert.equal(result.nodes.find(item => item.id === '0:/home').users, 2)
  assert.equal(result.edges.find(item => item.source === '0:/home' && item.target === '1:/list').users, 2)
  assert.equal(result.dropoffs.find(item => item.step === 1).users, 1)
})
