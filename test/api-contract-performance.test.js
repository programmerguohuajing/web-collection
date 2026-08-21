import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { all, run } from '../apps/api/src/db.js'
import { listApplications, listAlerts, listReleases, updateAlertStatus } from '../apps/api/src/governance.js'
import { buildDistributedTrace, getDistributedTrace, getSessions, getTrace, recordSpans, whereFor } from '../apps/api/src/services/analytics-service.js'
import { initDatabase } from '../apps/api/src/store.js'
import { countReplaySessions, listReplayEventRows, listReplaySessions } from '../apps/api/src/repositories/replays-repo.js'

await initDatabase()

test('invalid pagination falls back to bounded values across governance APIs', async () => {
  const applications = await listApplications({ page: 'not-a-number', pageSize: '999999' })
  assert.equal(applications.page, 1)
  assert.equal(applications.pageSize, 100)
  assert.ok(applications.items.length <= applications.pageSize)

  const releases = await listReleases('missing-app', { page: 'Infinity', pageSize: 'NaN' })
  assert.equal(releases.page, 1)
  assert.equal(releases.pageSize, 10)
  assert.deepEqual(releases.items, [])
})

test('invalid time filters never generate NaN SQL parameters', () => {
  const result = whereFor({ startTime: 'invalid', endTime: 'Infinity', appId: 'app' })
  assert.deepEqual(result.params, ['app'])
  assert.doesNotMatch(result.where, /NaN|Infinity/)
})

test('numeric backend span status codes are exposed as errors', () => {
  const tree = buildDistributedTrace([], [{ id: 'status-check', trace_id: 'trace-status', span_id: 'status-span', start_ts: 1, duration: 5, status_code: '503', attributes_json: {} }])
  assert.deepEqual(tree.errorSpans, ['status-span'])
  assert.equal(tree.nodes[0].hasError, true)
})

test('trace detail and distributed tree honor application/release filters', async () => {
  const suffix = randomUUID().replaceAll('-', '')
  const appId = `contract-${suffix}`
  const traceId = `trace-${suffix}`
  const spanSuffix = suffix.slice(0, 10)
  const ids = [randomUUID(), randomUUID()]
  try {
    await run(`insert into events (id, ts, type, app_id, release_name, trace_id, span_id, name, props_json)
      values (?, ?, 'perf', ?, '1.0.0', ?, ?, 'fetch', '{}'::jsonb),
             (?, ?, 'perf', ?, '2.0.0', ?, ?, 'fetch', '{}'::jsonb)`,
      [ids[0], 100, appId, traceId, `span-${spanSuffix}-a`, ids[1], 200, appId, traceId, `span-${spanSuffix}-b`])

    const detail = await getTrace(traceId, { appId, release: '1.0.0', page: 1, pageSize: 10 })
    assert.equal(detail.total, 1)
    assert.equal(detail.items.length, 1)
    assert.equal(detail.items[0].spanId, `span-${spanSuffix}-a`)

    const tree = await getDistributedTrace(traceId, { appId, release: '1.0.0' })
    assert.equal(tree.nodes.length, 1)
    assert.equal(tree.nodes[0].id, `span-${spanSuffix}-a`)
    assert.equal(tree.truncated, false)
  } finally {
    await run('delete from events where id = any(?::uuid[])', [ids])
  }
})

test('replay list groups segments and preserves latest non-empty metadata', async () => {
  const suffix = randomUUID().replaceAll('-', '')
  const appId = `replay-${suffix}`
  const sessionId = `session-${suffix}`
  const first = Date.now() - 1000
  try {
    await run(`insert into replay_events (app_id, session_id, user_id, user_name, created_at, url, release, end_reason, events_json)
      values (?, ?, 'user-old', 'Old Name', ?, 'https://old.example', '1.0.0', 'route', ?::jsonb),
             (?, ?, 'user-new', 'New Name', ?, 'https://new.example', '1.0.1', 'normal', ?::jsonb)`, [
      appId, sessionId, first, JSON.stringify([{ type: '2' }]),
      appId, sessionId, first + 1000, JSON.stringify([{ type: '2' }])
    ])
    const rows = await listReplaySessions(10, { appId })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].count, 2)
    assert.equal(rows[0].userId, 'user-new')
    assert.equal(rows[0].release, '1.0.1')
    assert.equal(rows[0].url, 'https://new.example')
    assert.equal(Number(rows[0].firstSeen), first)
    assert.equal(Number(rows[0].lastSeen), first + 1000)
    assert.equal(await countReplaySessions({ appId }), 1)
  } finally {
    await run('delete from replay_events where app_id=?', [appId])
  }
})

test('numeric replay id loads the base session snapshot across segments', async () => {
  const suffix = randomUUID().replaceAll('-', '')
  const appId = `replay-detail-${suffix}`
  const baseSessionId = `base-${suffix}`
  const firstSessionId = `segment-1-${suffix}`
  const secondSessionId = `segment-2-${suffix}`
  const first = Date.now() - 1000
  let latestId
  try {
    await run(`insert into replay_events (app_id, session_id, base_session_id, created_at, events_json)
      values (?, ?, ?, ?, ?::jsonb)`, [
      appId,
      firstSessionId,
      baseSessionId,
      first,
      JSON.stringify([{ type: 2, timestamp: first, data: { width: 800, height: 600 } }])
    ])
    const inserted = await run(`insert into replay_events (app_id, session_id, base_session_id, created_at, events_json)
      values (?, ?, ?, ?, ?::jsonb) returning id`, [
      appId,
      secondSessionId,
      baseSessionId,
      first + 1000,
      JSON.stringify([{ type: 3, timestamp: first + 1000, data: { source: 2 } }])
    ])
    latestId = Number(inserted.rows[0].id)

    const rows = await listReplayEventRows(String(latestId))
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.flatMap(row => row.events_json).map(event => event.type), [2, 3])
  } finally {
    await run('delete from replay_events where app_id=?', [appId])
  }
})

test('session replay correlation is scoped by application and release', async () => {
  const suffix = randomUUID().replaceAll('-', '')
  const appId = `session-${suffix}`
  const otherAppId = `other-${suffix}`
  const sessionId = `session-${suffix}`
  const eventId = randomUUID()
  try {
    await run(`insert into events (id, ts, type, app_id, release_name, session_id, name, props_json)
      values (?, ?, 'behavior', ?, '2.0.0', ?, 'pv', '{}'::jsonb)`, [eventId, Date.now(), appId, sessionId])
    await run(`insert into replay_events (app_id, session_id, base_session_id, created_at, release, events_json)
      values (?, ?, ?, ?, '2.0.0', ?::jsonb), (?, ?, ?, ?, '2.0.0', ?::jsonb)`, [
      otherAppId, `${sessionId}-wrong`, sessionId, Date.now(), JSON.stringify([]),
      appId, `${sessionId}-right`, sessionId, Date.now() + 1, JSON.stringify([])
    ])
    const sessions = await getSessions({ appId, release: '2.0.0', page: 1, pageSize: 10 })
    assert.equal(sessions.items.length, 1)
    assert.equal(sessions.items[0].replaySessionId, `${sessionId}-right`)
  } finally {
    await run('delete from events where id=?', [eventId])
    await run('delete from replay_events where app_id in (?, ?)', [appId, otherAppId])
  }
})

test('span ingestion batches writes, rejects missing trace IDs and keeps contract counters', async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const traceId = `batch-trace-${suffix}`
  const spans = Array.from({ length: 120 }, (_, index) => ({
    id: `batch-${suffix}-${index}`,
    traceId,
    spanId: `span-${suffix}-${index}`,
    serviceName: 'orders',
    operationName: 'GET /orders',
    startTime: 1000 + index,
    duration: index,
    status: { code: index === 119 ? 'ERROR' : 'OK' },
    attributes: { index }
  }))
  spans.push({ id: `missing-${suffix}`, spanId: 'orphan' })
  try {
    const result = await recordSpans(spans)
    assert.deepEqual(result, { ok: true, count: 120, received: 121, rejected: 1 })
    const rows = await all('select count(*)::integer count from spans where trace_id=?', [traceId])
    assert.equal(Number(rows[0].count), 120)
  } finally {
    await run('delete from spans where trace_id=?', [traceId])
  }
})

test('alert status endpoint supports filters and rejects invalid or missing records', async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const appId = `alert-${suffix}`
  let alertId
  try {
    const inserted = await run(`insert into alert_history (app_id, metric, fingerprint, level, value, message, context_json, created_at)
      values (?, 'error', ?, 'error', 2, 'test alert', ?::jsonb, ?) returning id`, [
      appId, `fp-${suffix}`, JSON.stringify({ traceId: `trace-${suffix}`, threshold: 1 }), Date.now()
    ])
    alertId = Number(inserted.rows[0].id)
    const pending = await listAlerts({ appId, metric: 'error', status: 'pending', page: 1, pageSize: 10 })
    assert.equal(pending.total, 1)
    assert.equal(pending.items[0].status, 'pending')
    assert.equal(pending.items[0].trace_id, `trace-${suffix}`)
    assert.equal(Number(pending.items[0].threshold), 1)

    const updated = await updateAlertStatus(alertId, 'acknowledged')
    assert.equal(updated.status, 'acknowledged')
    assert.equal((await listAlerts({ appId, status: 'pending' })).total, 0)
    assert.equal((await listAlerts({ appId, status: 'acknowledged' })).total, 1)

    await assert.rejects(() => updateAlertStatus(alertId, 'unknown'), error => error.statusCode === 400)
    await assert.rejects(() => updateAlertStatus(999999999, 'resolved'), error => error.statusCode === 404)
  } finally {
    if (alertId) await run('delete from alert_history where id=?', [alertId])
  }
})
