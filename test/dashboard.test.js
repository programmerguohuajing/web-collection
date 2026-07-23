import assert from 'node:assert/strict'
import { getReplay, loadGovernance, rankBehavior } from '../apps/web/src/dashboard.js'

assert.deepEqual(rankBehavior({ route: 2, pushState: 3, popstate: 4, click: 1 }), [['路由切换', 9], ['点击', 1]])

const requests = []
globalThis.fetch = async url => {
  requests.push(url)
  return { ok: true, json: async () => url.startsWith('/api/alerts') ? { items: [], total: 0, page: 2, pageSize: 20 } : [] }
}
await loadGovernance(2, 20)
assert.ok(requests.includes('/api/alerts?page=2&pageSize=20'))

await Promise.all([getReplay('session-1'), getReplay('session-1')])
assert.equal(requests.filter(url => url === '/api/replays/session-1').length, 1)

console.log('dashboard tests passed')
