import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { ensureSchema, run } from '../apps/api/src/db.js'
import { deleteDashboard, deleteInsight, listDashboards, listEventProperties, listInsights, queryEventInsight, queryPaths, saveDashboard, saveInsight } from '../apps/api/src/services/analytics-service.js'

test('Analytics V2 queries PostgreSQL and keeps dashboard references consistent', async () => {
  await ensureSchema()
  const suffix = randomUUID()
  const appId = `analytics-${suffix}`
  const now = Date.now()
  const events = [
    ['u1', 'd1', 's1', 'checkout_submit', '/home', { plan: 'pro' }, now],
    ['u1', 'd1', 's1', 'checkout_submit', '/pay', { plan: 'pro' }, now + 1],
    ['', 'd2', 's2', 'checkout_submit', '/home', { plan: 'free' }, now + 2]
  ]
  for (const [userId, deviceId, sessionId, name, path, props, ts] of events) {
    await run(`insert into events(id,ts,type,app_id,release_name,user_id,device_id,session_id,name,path,browser,device,props_json)
      values(?::uuid,?,'track',?,'test',?,?,?,?,?,'Chrome','Desktop',?::jsonb)`, [randomUUID(), ts, appId, userId, deviceId, sessionId, name, path, JSON.stringify(props)])
  }
  for (const [sessionId, userId, deviceId, path, ts] of [['p1', 'u1', 'd1', '/home', now], ['p1', 'u1', 'd1', '/pay', now + 1]]) {
    await run(`insert into events(id,ts,type,app_id,release_name,user_id,device_id,session_id,name,path,props_json)
      values(?::uuid,?,'behavior',?,'test',?,?,?, 'pv',?,'{}'::jsonb)`, [randomUUID(), ts, appId, userId, deviceId, sessionId, path])
  }

  let insightId
  let dashboardId
  try {
    const result = await queryEventInsight({ appId, eventName: 'checkout_submit', measure: 'users', interval: 'hour', breakdown: 'props.plan' })
    assert.deepEqual(Object.fromEntries(result.series.map(item => [item.name, item.points[0].value])), { pro: 1, free: 1 })
    const filtered = await queryEventInsight({ appId, eventName: 'checkout_submit', measure: 'sessions', filters: [{ field: 'props.plan', operator: 'in', value: ['pro'] }] })
    assert.equal(filtered.table[0].value, 1)
    assert.ok((await listEventProperties({ appId, eventName: 'checkout_submit' })).some(item => item.name === 'plan'))

    const path = await queryPaths({ appId, startPath: '/home', maxDepth: 3 })
    assert.equal(path.edges[0].users, 1)

    insightId = (await saveInsight({ name: `订单趋势-${suffix}`, kind: 'eventTrend', definition: { appId, eventName: 'checkout_submit' } })).id
    assert.ok((await listInsights()).some(item => item.id === insightId))
    dashboardId = (await saveDashboard({ name: `分析看板-${suffix}`, widgets: ['live', { type: 'insight', id: insightId }] })).id
    assert.ok((await listDashboards()).find(item => Number(item.id) === dashboardId).widgets_json.some(item => item.type === 'insight'))

    await deleteInsight(insightId)
    insightId = null
    assert.deepEqual((await listDashboards()).find(item => Number(item.id) === dashboardId).widgets_json, ['live'])
  } finally {
    if (insightId) await deleteInsight(insightId)
    if (dashboardId) await deleteDashboard(dashboardId)
    await run('delete from events where app_id=?', [appId])
  }
})
