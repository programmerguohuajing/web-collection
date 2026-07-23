import assert from 'node:assert/strict'
import { navigationMetrics } from '../packages/sdk/src/performance/index.js'
import { onReady } from '../packages/sdk/src/utils/performance.js'

const metrics = navigationMetrics({
  domainLookupStart: 10,
  domainLookupEnd: 20,
  connectStart: 20,
  connectEnd: 50,
  secureConnectionStart: 30,
  requestStart: 55,
  responseStart: 100,
  responseEnd: 140,
  domContentLoadedEventEnd: 200,
  loadEventEnd: 300,
  redirectStart: 1,
  redirectEnd: 6,
  redirectCount: 2
})

assert.deepEqual(metrics, {
  dns: 10,
  tcp: 30,
  tls: 20,
  request: 45,
  download: 40,
  ttfb: 100,
  dom_ready: 200,
  page_load: 300,
  redirect: 5,
  redirect_count: 2
})

const originalDocument = globalThis.document
const originalAddEventListener = globalThis.addEventListener
let loadHandler
let readyCalled = false
globalThis.document = { readyState: 'loading' }
globalThis.addEventListener = (type, handler) => { if (type === 'load') loadHandler = handler }
onReady(() => { readyCalled = true })
loadHandler()
assert.equal(readyCalled, false)
await new Promise(resolve => setTimeout(resolve))
assert.equal(readyCalled, true)
globalThis.document = originalDocument
globalThis.addEventListener = originalAddEventListener

console.log('navigation metrics tests passed')
