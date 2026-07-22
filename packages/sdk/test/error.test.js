import assert from 'node:assert/strict'
import { setupErrorMonitor } from '../src/error/index.js'

const listeners = {}
globalThis.addEventListener = (type, callback) => { listeners[type] = callback }

let reported
setupErrorMonitor({ error: (error, extra) => { reported = { error, extra } } })
listeners.error({ target: { src: 'https://img.example.com/broken.png', tagName: 'IMG', outerHTML: '<img src="https://img.example.com/broken.png">' } })

assert.equal(reported.error.message, 'https://img.example.com/broken.png')
assert.equal(reported.extra.name, 'ResourceError')
assert.equal(reported.extra.tag, 'IMG')

console.log('error monitor tests passed')
