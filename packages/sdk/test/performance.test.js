import assert from 'node:assert/strict'
import { setupPerformanceMonitor } from '../src/performance/index.js'

const originalDocument = globalThis.document
const originalPerformanceObserver = globalThis.PerformanceObserver
const originalAddEventListener = globalThis.addEventListener
const observers = new Map()
const listeners = new Map()
globalThis.document = { readyState: 'complete' }
globalThis.PerformanceObserver = class {
  constructor(callback) { this.callback = callback }
  observe({ type }) { observers.set(type, this.callback) }
}
globalThis.addEventListener = (type, listener) => listeners.set(type, listener)

const metrics = []
const finalize = setupPerformanceMonitor({
  metric: (name, value) => metrics.push([name, value]),
  error() {},
  endpoint: '/collect',
  originalFetch: fetch,
  requests: false,
  tracing: false,
  traceOrigins: [],
  pageTraceId: 'trace'
})
const emit = (type, entries) => observers.get(type)?.({ getEntries: () => entries })
emit('largest-contentful-paint', [{ startTime: 100 }, { startTime: 200 }])
emit('event', [{ interactionId: 1, duration: 40 }, { interactionId: 2, duration: 80 }])
emit('layout-shift', [{ value: 0.1, startTime: 10, hadRecentInput: false }])
emit('resource', [{ name: '/cached.js', transferSize: 0, decodedBodySize: 10, duration: 5, responseStart: 1 }, { name: '/app.js', transferSize: 10, decodedBodySize: 10, duration: 6, responseStart: 1 }])
listeners.get('error')({ target: { src: '/missing.js' } })
finalize()

assert.deepEqual(metrics.filter(([name]) => ['lcp', 'inp', 'cls'].includes(name)), [['lcp', 200], ['inp', 80], ['cls', 0.1]])
assert.deepEqual(metrics.filter(([name]) => name === 'cache_hit_rate').map(([, value]) => value), [100, 0])
assert.deepEqual(metrics.filter(([name]) => name === 'resource_failure_rate').map(([, value]) => value), [0, 0, 100])

globalThis.document = originalDocument
globalThis.PerformanceObserver = originalPerformanceObserver
globalThis.addEventListener = originalAddEventListener

console.log('performance monitor tests passed')
