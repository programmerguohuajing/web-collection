import assert from 'node:assert/strict'
import { createPlatformEys } from '../src/platform/core.js'

const reports = []
const storage = new Map()
const adapter = {
  name: 'test',
  request: async options => { reports.push(...options.data.events); return { statusCode: 200 } },
  getStorage: key => storage.get(key),
  setStorage: (key, value) => storage.set(key, value),
  getContext: () => ({ path: '/home', userAgent: 'test/1' })
}

const eys = createPlatformEys({ endpoint: 'https://collector.test/api/collect', batchSize: 10, flushInterval: 60_000 }, adapter)
eys.setUser({ id: 'u1', name: '测试用户' })
eys.track('pay', { amount: 10 })
eys.pageView('/home')
await eys.flush()

assert.equal(reports.length, 2)
assert.equal(reports[0].userId, 'u1')
assert.equal(reports[0].props.amount, 10)
assert.equal(reports[1].name, 'pv')
eys.destroy()
