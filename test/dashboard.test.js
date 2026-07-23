import assert from 'node:assert/strict'
import { downloadReport, eventPager, filters, getReplay, loadGovernance, rankBehavior, resetPages, setFiltersFromRoute } from '../apps/web/src/dashboard.js'

assert.deepEqual(rankBehavior({ route: 2, pushState: 3, popstate: 4, click: 1 }), [['路由切换', 9], ['点击', 1]])

setFiltersFromRoute({ appId: 'ts-app-uni', status: 'open' })
setFiltersFromRoute({ keyword: 'trace-1' }, true)
assert.equal(filters.value.appId, 'ts-app-uni')
assert.equal(filters.value.keyword, 'trace-1')
assert.equal(filters.value.status, '')

eventPager.value.page = 3
resetPages()
assert.equal(eventPager.value.page, 1)

const requests = []
globalThis.fetch = async url => {
  requests.push(url)
  return { ok: true, json: async () => url.startsWith('/api/alerts') ? { items: [], total: 0, page: 2, pageSize: 20 } : url.startsWith('/api/applications?') ? { items: [], total: 0, page: 3, pageSize: 50 } : [] }
}
await loadGovernance({ alertPage: 2, alertPageSize: 20, appPage: 3, appPageSize: 50 })
assert.ok(requests.includes('/api/alerts?page=2&pageSize=20'))
assert.ok(requests.includes('/api/applications?page=3&pageSize=50'))

await Promise.all([getReplay('session-1'), getReplay('session-1')])
assert.equal(requests.filter(url => url === '/api/replays/session-1').length, 1)

let clicked = false
let revoked = ''
globalThis.document = {
  body: { append() {} },
  createElement: () => ({ click() { clicked = true }, remove() {} })
}
URL.createObjectURL = () => 'blob:report'
URL.revokeObjectURL = value => { revoked = value }
globalThis.fetch = async () => ({ ok: true, blob: async () => new Blob(['report']) })
await downloadReport('events')
await new Promise(resolve => setTimeout(resolve, 0))
assert.equal(clicked, true)
assert.equal(revoked, 'blob:report')

console.log('dashboard tests passed')
