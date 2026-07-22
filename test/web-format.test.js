import assert from 'node:assert/strict'
import { formatDuration, readableText, scoreWebVitals } from '../apps/web/src/utils/format.js'

assert.equal(formatDuration(999), '999ms')
assert.equal(formatDuration(1250), '1.3s')
assert.equal(formatDuration(1227572), '20分27秒')
assert.equal(readableText('[object Object]', 'UnhandledRejection'), 'UnhandledRejection')
assert.equal(readableText({ message: '请求失败' }), '请求失败')
assert.equal(readableText({ code: 500 }), '{"code":500}')
assert.deepEqual(scoreWebVitals({ fcp: 1000, lcp: 2000, inp: 100, cls: 0.05, ttfb: 500 }), { score: 100, grade: 'A', measured: 5 })
assert.equal(scoreWebVitals({}), null)
