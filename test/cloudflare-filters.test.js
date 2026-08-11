import assert from 'node:assert/strict'
import worker, { alertMessage, buildDistributedTrace, filters, issueFilters, issueKey, replayFilters } from '../cloudflare/worker.js'

const result = filters(new URL('https://example.com/api/events?type=error&path=%2Flogin%2Flogin'))

assert.equal(result.where, 'where type=? and (path like ? or url like ?)')
assert.deepEqual(result.values, ['error', '%/login/login%', '%/login/login%'])

const behavior = filters(new URL('https://example.com/api/events?type=behavior,track'))
assert.equal(behavior.where, 'where type in (?,?)')
assert.deepEqual(behavior.values, ['behavior', 'track'])

const logs = filters(new URL('https://example.com/api/logs?name=warn'), 'log')
assert.equal(logs.where, 'where type=? and name=?')
assert.deepEqual(logs.values, ['log', 'warn'])

const traceFilters = filters(new URL('https://example.com/api/traces?traceId=abc&release=1.2.3&path=%2Fcheckout&startTime=10&endTime=20'), null, ["trace_id<>''"])
assert.equal(traceFilters.where, "where trace_id<>'' and release_name=? and trace_id like ? and (path like ? or url like ?) and ts>=? and ts<=?")
assert.deepEqual(traceFilters.values, ['1.2.3', '%abc%', '%/checkout%', '%/checkout%', 10, 20])

const replays = replayFilters(new URL('https://example.com/api/replays?appId=web&release=1.2.3&path=%2Fcheckout&startTime=10&endTime=20'))
assert.equal(replays.where, 'where app_id=? and release_name=? and url like ? and created_at>=? and created_at<=?')
assert.deepEqual(replays.values, ['web', '1.2.3', '%/checkout%', 10, 20])

const issueScope = issueFilters(new URL('https://example.com/api/issues?appId=web&release=1.2.3&startTime=10&endTime=20'))
assert.equal(issueScope.where, 'where app_id=? and release_name=? and last_seen>=? and last_seen<=?')
assert.deepEqual(issueScope.values, ['web', '1.2.3', 10, 20])

assert.equal(alertMessage({ type: 'perf', appId: 'web', value: 4200, path: '/home' }, 'lcp', 4000), '[Web Collection] web LCP 4200ms，超过阈值 4000ms，页面 /home')
assert.equal(alertMessage({ type: 'error', appId: 'web', name: 'TypeError', message: 'boom', path: '/home', release: '1.0.0', traceId: 'trace-1' }, 'error'), '[Web Collection] web TypeError: boom，页面 /home，版本 1.0.0，Trace trace-1')
assert.equal(issueKey({ appId: 'web', name: 'SseError', stack: 'sdk line', props: { source: 'https://example.com/events' } }), 'web|SseError|https://example.com/events')

const capabilityResponse = await worker.fetch(new Request('https://example.com/api/capabilities'), {})
assert.deepEqual(await capabilityResponse.json(), { productAnalyticsV2: false })

let writes = 0
let pending
const statement = { bind() { return this }, first: async () => ({ enabled: 1, sample_rate: 1, replay_sample_rate: 1, rules_json: '{"allowedOrigins":["*"]}' }), run: async () => { await new Promise(resolve => setTimeout(resolve, 20)); writes++; return { meta: {} } } }
const response = await worker.fetch(new Request('https://example.com/api/collect', { method: 'POST', body: JSON.stringify({ type: 'behavior', name: 'pv' }) }), { DB: { prepare: sql => ({ ...statement, bind(...values) { assert.equal((sql.match(/\?/g) || []).length, values.length); return this } }) } }, { waitUntil: promise => { pending = promise } })
assert.equal(response.status, 200)
assert.equal(writes, 0)
await pending
assert.equal(writes, 3)

let recoveryPending
let eventAttempts = 0
const recoveryQueries = []
const recoveryResponse = await worker.fetch(new Request('https://example.com/api/collect', { method: 'POST', body: JSON.stringify({ type: 'behavior', name: 'recovery' }) }), {
  DB: {
    prepare(sql) {
      recoveryQueries.push(sql)
      return {
        bind(...values) { assert.equal((sql.match(/\?/g) || []).length, values.length); return this },
        async first() { return { enabled: 1, sample_rate: 1, replay_sample_rate: 1, rules_json: '{"allowedOrigins":["*"]}' } },
        async run() {
          if (sql.startsWith('insert into events') && eventAttempts++ === 0) throw new Error('Exceeded maximum DB size')
          return { meta: { changes: sql.startsWith('delete from replays') ? 100 : 1 } }
        }
      }
    }
  }
}, { waitUntil: promise => { recoveryPending = promise } })
assert.equal(recoveryResponse.status, 200)
await recoveryPending
assert.equal(eventAttempts, 2)
assert.equal(recoveryQueries.filter(sql => sql.startsWith('delete from replays')).length, 1)

let eventNamesSql = ''
let eventNamesValues = []
const eventNamesResponse = await worker.fetch(new Request('https://example.com/api/analytics/event-names?appId=web&type=error'), {
  DB: {
    prepare(sql) {
      eventNamesSql = sql
      return {
        bind(...values) { eventNamesValues = values; return this },
        async all() { return { results: [{ name: 'click', count: 12 }] } }
      }
    }
  }
})
assert.match(eventNamesSql, /type in \('behavior','track'\)/)
assert.doesNotMatch(eventNamesSql, /type=\?/)
assert.deepEqual(eventNamesValues, ['web'])
assert.deepEqual(await eventNamesResponse.json(), [{ name: 'click', count: 12 }])

const issueQueries = []
const summaryResponse = await worker.fetch(new Request('https://example.com/api/summary?appId=web'), {
  DB: {
    prepare(sql) {
      let values = []
      return {
        bind(...bound) { values = bound; return this },
        async all() {
          if (sql.includes('from issues')) issueQueries.push([sql, values])
          return { results: [] }
        },
        async first() {
          issueQueries.push([sql, values])
          return { issue_count: 2, regression_count: 1 }
        }
      }
    }
  }
})
assert.equal((await summaryResponse.json()).issueCount, 2)
assert.equal(issueQueries.length, 2)
assert.ok(issueQueries.every(([sql, values]) => sql.includes('where app_id=?') && values[0] === 'web'))

const traceQueries = []
const tracesResponse = await worker.fetch(new Request('https://example.com/api/traces?page=2&pageSize=25'), {
  DB: {
    prepare(sql) {
      let values = []
      return {
        bind(...bound) { values = bound; return this },
        async all() { traceQueries.push([sql, values]); return { results: [] } },
        async first() { traceQueries.push([sql, values]); return { count: 51 } }
      }
    }
  }
})
assert.deepEqual(await tracesResponse.json(), { items: [], total: 51, page: 2, pageSize: 25 })
assert.ok(traceQueries.some(([sql]) => /trace_id<>''/.test(sql)))
assert.ok(traceQueries.some(([sql, values]) => /limit \? offset \?/.test(sql) && values.at(-2) === 25 && values.at(-1) === 25))

let releasesSql = ''
let releasesValues = []
const releasesResponse = await worker.fetch(new Request('https://example.com/api/analytics/releases?appId=web&release=1.2.3&startTime=10&endTime=20'), {
  DB: {
    prepare(sql) {
      releasesSql = sql
      return {
        bind(...values) { releasesValues = values; return this },
        async all() { return { results: [{ app_id: 'web', release: '1.2.3', events: 12, errors: 1, users: 3 }] } }
      }
    }
  }
})
assert.deepEqual(await releasesResponse.json(), [{ app_id: 'web', release: '1.2.3', events: 12, errors: 1, users: 3 }])
assert.match(releasesSql, /from releases r left join events e/)
assert.match(releasesSql, /where r\.app_id=\? and r\.release_name=\?/)
assert.deepEqual(releasesValues, [10, 20, 'web', '1.2.3'])

const workerTree = buildDistributedTrace([
  { id: 'child-event', span_id: 'child', props_json: '{"__parentSpanId":"root","status":200}', type: 'perf', metric: 'fetch', ts: 20, value: 10 },
  { id: 'root-event', span_id: 'root', props_json: '{}', type: 'perf', metric: 'page_load', ts: 10, value: 5 },
  { id: 'legacy-event', span_id: null, props_json: '{}', type: 'behavior', name: 'pv', ts: 5 }
])
assert.deepEqual(workerTree.edges, [{ source: 'root', target: 'child' }])
assert.ok(workerTree.nodes.some(node => node.id === 'event-legacy-event'))

let distributedTraceId = ''
const distributedResponse = await worker.fetch(new Request('https://example.com/api/traces/trace-1/distributed'), {
  DB: {
    prepare(sql) {
      assert.match(sql, /where trace_id=\? order by ts/)
      return {
        bind(value) { distributedTraceId = value; return this },
        async all() { return { results: [{ id: 'event-1', trace_id: 'trace-1', span_id: 'span-1', type: 'perf', metric: 'fetch', ts: 1, value: 12, props_json: '{}' }] } }
      }
    }
  }
})
assert.equal(distributedTraceId, 'trace-1')
assert.equal((await distributedResponse.json()).nodes.length, 1)

const emptyTraceResponse = await worker.fetch(new Request('https://example.com/api/traces/'), {
  DB: { prepare() { throw new Error('空 Trace ID 不应查询数据库') } }
})
assert.deepEqual(await emptyTraceResponse.json(), { items: [], total: 0, page: 1, pageSize: 10 })

const sessionQueries = []
const sessionsResponse = await worker.fetch(new Request('https://example.com/api/analytics/sessions?page=3&pageSize=5'), {
  DB: {
    prepare(sql) {
      let values = []
      return {
        bind(...bound) { values = bound; return this },
        async all() { sessionQueries.push([sql, values]); return { results: [] } },
        async first() { sessionQueries.push([sql, values]); return { count: 12 } }
      }
    }
  }
})
assert.deepEqual(await sessionsResponse.json(), { items: [], total: 12, page: 3, pageSize: 5 })
assert.ok(sessionQueries.some(([sql]) => /session_id<>''/.test(sql)))
assert.ok(sessionQueries.some(([sql, values]) => /group by session_id order by ended_at desc limit \? offset \?/.test(sql) && values.at(-2) === 5 && values.at(-1) === 10))

const funnelsResponse = await worker.fetch(new Request('https://example.com/api/funnels?page=2&pageSize=10'), {
  DB: {
    prepare(sql) {
      return {
        bind() { return this },
        async all() { return { results: [{ id: 1, steps_json: '["view","pay"]' }] } },
        async first() { return { count: 11 } }
      }
    }
  }
})
assert.deepEqual(await funnelsResponse.json(), { items: [{ id: 1, steps_json: ['view', 'pay'] }], total: 11, page: 2, pageSize: 10 })

let deletedId
const deleteResponse = await worker.fetch(new Request('https://example.com/api/funnels/7', { method: 'DELETE' }), {
  DB: {
    prepare() {
      return {
        bind(id) { deletedId = id; return this },
        async run() { return { meta: { changes: 1 } } }
      }
    }
  }
})
assert.equal(deleteResponse.status, 200)
assert.equal(deletedId, 7)
assert.match(deleteResponse.headers.get('access-control-allow-methods'), /DELETE/)

const applicationDeletes = []
const deleteApplicationResponse = await worker.fetch(new Request('https://example.com/api/applications/test-app', { method: 'DELETE' }), {
  DB: {
    prepare(sql) {
      let values
      return {
        bind(...bound) { values = bound; return this },
        async run() { applicationDeletes.push([sql, values]); return { meta: { changes: 1 } } }
      }
    }
  }
})
assert.equal(deleteApplicationResponse.status, 200)
assert.deepEqual(applicationDeletes, [
  ['delete from releases where app_id=?', ['test-app']],
  ['delete from applications where app_id=?', ['test-app']]
])

const exportQueries = []
for (const kind of ['events', 'issues', 'replays']) {
  const response = await worker.fetch(new Request(`https://example.com/api/export/${kind}.csv?appId=web`), {
    DB: {
      prepare(sql) {
        let values
        return {
          bind(...bound) { values = bound; return this },
          async all() { exportQueries.push([kind, sql, values]); return { results: [] } }
        }
      }
    }
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-disposition'), `attachment; filename="web-collection-${kind}.csv"`)
}
assert.ok(exportQueries.every(([, sql, values]) => sql.includes('where app_id=?') && values[0] === 'web'))
assert.doesNotMatch(exportQueries.find(([kind]) => kind === 'replays')[1], /events_json/)

console.log('cloudflare filters tests passed')
