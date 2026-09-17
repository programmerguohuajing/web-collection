import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from '../apps/web/node_modules/pinia/dist/pinia.mjs'
import { applyRoutePrefill, downloadReport, eventPager, filters, getReplay, loadGovernance, rankBehavior, resetPageFilters, resetPages } from '../apps/web/src/dashboard.js'
import { RANGE_PRESETS, rangeFromPreset, useFilterStore } from '../apps/web/src/stores/filters.js'

assert.deepEqual(rankBehavior({ route: 2, pushState: 3, popstate: 4, click: 1 }), [['路由切换', 9], ['点击', 1]])

resetPageFilters()
applyRoutePrefill({ appId: 'ts-app-uni', status: 'open' })
// appId 属于顶部全局筛选，不应被页面级深链写入 dashboard.filters。
assert.equal('appId' in filters.value, false)
assert.equal(filters.value.status, 'open')

// 路由预填只负责页面级字段；切页时由 resetPageFilters 显式清理，避免条件串页。
resetPageFilters()
applyRoutePrefill({ keyword: 'trace-1' })
assert.equal(filters.value.keyword, 'trace-1')
assert.equal(filters.value.status, '')

setActivePinia(createPinia())
const filterStore = useFilterStore()

// 校验时间预设中包含「今日」与「最近12小时」，且位于「最近1小时」与「最近24小时」之间
const labels = RANGE_PRESETS.map(p => p.label)
assert.deepEqual(labels.slice(0, 4), ['最近1小时', '今日', '最近12小时', '最近24小时'])
assert.deepEqual(RANGE_PRESETS.map(p => p.value).slice(0, 4), ['1', 'today', '12', '24'])

const testNow = new Date('2026-09-17T12:00:00.000Z').getTime()
const todayRange = rangeFromPreset('today', testNow)
const expectedStart = new Date(testNow)
expectedStart.setHours(0, 0, 0, 0)
assert.equal(todayRange[0], expectedStart.getTime())
assert.equal(todayRange[1], testNow)

const twelveRange = rangeFromPreset('12', testNow)
assert.deepEqual(twelveRange, [testNow - 12 * 3600000, testNow])
assert.equal(rangeFromPreset('custom'), null)
assert.deepEqual(rangeFromPreset(''), [])

filterStore.rangePreset = 'today'
assert.equal(filterStore.rangeLabel, '今日')
filterStore.rangePreset = '12'
assert.equal(filterStore.rangeLabel, '最近12小时')

eventPager.value.page = 3
resetPages()
assert.equal(eventPager.value.page, 1)

const requests = []
const jsonResponse = data => ({ ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => data })
globalThis.fetch = async url => {
  requests.push(url)
  return jsonResponse(url.startsWith('/api/alerts') ? { items: [], total: 0, page: 2, pageSize: 20 } : url.startsWith('/api/applications?') ? { items: [], total: 0, page: 3, pageSize: 50 } : [])
}
await loadGovernance({ alertPage: 2, alertPageSize: 20, appPage: 3, appPageSize: 50 })
assert.ok(requests.includes('/api/applications?page=3&pageSize=50'))
assert.ok(requests.includes('/api/applications'))
assert.ok(requests.includes('/api/settings'))

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
