import assert from 'node:assert/strict'
import { setupConsoleMonitor } from '../src/behavior/console.js'

const calls = []
const breadcrumbs = []
const target = { warn: (...args) => calls.push(args), error: () => {} }
const originalWarn = target.warn
const restore = setupConsoleMonitor({ remember: item => breadcrumbs.push(item), target })

target.warn('request failed', { status: 503 })
assert.equal(breadcrumbs[0].message, 'request failed {"status":503}')
assert.deepEqual(calls[0], ['request failed', { status: 503 }])
restore()
assert.equal(target.warn, originalWarn)
