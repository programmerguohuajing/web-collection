import assert from 'node:assert/strict'
import { createPlatformEys } from '../src/platform/core.js'

const reports = []
const requests = []
const storage = new Map()
const adapter = {
  name: 'test',
  request: async options => { requests.push(options); reports.push(...options.data.events); return { statusCode: 200 } },
  getStorage: key => storage.get(key),
  setStorage: (key, value) => storage.set(key, value),
  getContext: () => ({ path: '/home', userAgent: 'test/1' })
}

const eys = createPlatformEys({ endpoint: 'https://collector.test/api/collect', collectKey: 'eys_test', batchSize: 10, flushInterval: 60_000 }, adapter)
eys.setUser({ id: 'u1', name: '测试用户' })
eys.track('pay', { amount: 10 })
eys.pageView('/home')
eys.markPageReady()
await eys.flush()

assert.equal(reports.length, 3)
assert.equal(reports[0].userId, 'u1')
assert.equal(reports[0].sdkVersion, '0.1.7')
assert.equal(reports[0].source, 'manual')
assert.equal(reports[0].props.amount, 10)
assert.equal(reports[1].name, 'pv')
assert.equal(reports[2].metric, 'data_ready')
assert.equal(requests[0].headers['x-app-key'], 'eys_test')
const denied = createPlatformEys({ endpoint: 'https://collector.test/api/collect', consent: 'denied', flushInterval: 60_000 }, adapter)
denied.setContext({ module: 'orders', token: 'hidden' })
denied.track('blocked')
await denied.flush()
assert.equal(reports.some(item => item.name === 'blocked'), false)
denied.setConsent('granted')
denied.track('allowed', { token: 'secret' })
const transaction = denied.startTransaction('checkout', { page: 'order' })
transaction.setData({ step: 'pay' })
transaction.finish({ status: 'success' })
await denied.flush()
const allowed = reports.find(item => item.name === 'allowed')
assert.equal(allowed.context.module, 'orders')
assert.equal(allowed.props.token, '[REDACTED]')
assert.equal(reports.some(item => item.metric === 'transaction'), true)
assert.equal(reports.find(item => item.metric === 'transaction').source, 'platform')
denied.track('will-be-cleared')
denied.setConsent('denied')
await denied.flush()
assert.equal(reports.some(item => item.name === 'will-be-cleared'), false)
denied.destroy()
eys.destroy()
