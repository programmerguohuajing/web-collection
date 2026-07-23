import assert from 'node:assert/strict'
import worker, { alertMessage, filters, issueKey } from '../cloudflare/worker.js'

const result = filters(new URL('https://example.com/api/events?type=error&path=%2Flogin%2Flogin'))

assert.equal(result.where, 'where type=? and (path like ? or url like ?)')
assert.deepEqual(result.values, ['error', '%/login/login%', '%/login/login%'])

const behavior = filters(new URL('https://example.com/api/events?type=behavior,track'))
assert.equal(behavior.where, 'where type in (?,?)')
assert.deepEqual(behavior.values, ['behavior', 'track'])

const logs = filters(new URL('https://example.com/api/logs?name=warn'), 'log')
assert.equal(logs.where, 'where type=? and name=?')
assert.deepEqual(logs.values, ['log', 'warn'])

assert.equal(alertMessage({ type: 'perf', appId: 'web', value: 4200, path: '/home' }, 'lcp', 4000), '[Web Collection] web LCP 4200ms，超过阈值 4000ms，页面 /home')
assert.equal(alertMessage({ type: 'error', appId: 'web', name: 'TypeError', message: 'boom', path: '/home', release: '1.0.0', traceId: 'trace-1' }, 'error'), '[Web Collection] web TypeError: boom，页面 /home，版本 1.0.0，Trace trace-1')
assert.equal(issueKey({ appId: 'web', name: 'SseError', stack: 'sdk line', props: { source: 'https://example.com/events' } }), 'web|SseError|https://example.com/events')

let writes = 0
let pending
const statement = { bind() { return this }, first: async () => ({ enabled: 1, sample_rate: 1, replay_sample_rate: 1, rules_json: '{"allowedOrigins":["*"]}' }), run: async () => { await new Promise(resolve => setTimeout(resolve, 20)); writes++; return { meta: {} } } }
const response = await worker.fetch(new Request('https://example.com/api/collect', { method: 'POST', body: JSON.stringify({ type: 'behavior', name: 'pv' }) }), { DB: { prepare: () => ({ ...statement }) } }, { waitUntil: promise => { pending = promise } })
assert.equal(response.status, 200)
assert.equal(writes, 0)
await pending
assert.equal(writes, 3)

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

console.log('cloudflare filters tests passed')
