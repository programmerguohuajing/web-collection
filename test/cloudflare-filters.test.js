import assert from 'node:assert/strict'
import { alertMessage, filters } from '../cloudflare/worker.js'

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

console.log('cloudflare filters tests passed')
