import assert from 'node:assert/strict'
import { setupErrorMonitor } from '../src/error/index.js'
import { setupSseMonitor } from '../src/performance/sse.js'

const listeners = {}
globalThis.addEventListener = (type, callback) => { listeners[type] = callback }

let reported
setupErrorMonitor({ error: (error, extra) => { reported = { error, extra } } })
listeners.error({ target: { src: 'https://img.example.com/broken.png', tagName: 'IMG', outerHTML: '<img src="https://img.example.com/broken.png">' } })

assert.equal(reported.error.message, 'https://img.example.com/broken.png')
assert.equal(reported.extra.name, 'ResourceError')
assert.equal(reported.extra.tag, 'IMG')

class EventSourceMock {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  constructor() { this.listeners = {}; EventSourceMock.last = this }
  addEventListener(type, callback) { this.listeners[type] = callback }
  close() {}
}

globalThis.window = { EventSource: EventSourceMock }
globalThis.performance = { now: () => 1 }
setupSseMonitor({ metric() {}, error: (error, extra) => { reported = { error, extra } } })
function openFromApp() { return new window.EventSource('https://example.com/events') }
openFromApp()
EventSourceMock.last.listeners.error({ type: 'error' })

assert.equal(reported.extra.name, 'SseError')
assert.equal(reported.extra.source, 'https://example.com/events')
assert.match(reported.error.stack, /openFromApp/)
assert.doesNotMatch(reported.error.stack, /setupSseMonitor/)

console.log('error monitor tests passed')
