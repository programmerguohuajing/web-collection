import assert from 'node:assert/strict'
import { formatDuration, formatErrorLocation, readableText, scoreWebVitals } from '../apps/web/src/utils/format.js'

assert.equal(formatDuration(999), '999ms')
assert.equal(formatDuration(1250), '1.3s')
assert.equal(formatDuration(1227572), '20分27秒')
assert.equal(readableText('[object Object]', 'UnhandledRejection'), 'UnhandledRejection')
assert.equal(readableText({ message: '请求失败' }), '请求失败')
assert.equal(readableText({ code: 500 }), '{"code":500}')
assert.equal(formatErrorLocation({ props: { source: '/app.js', line: 12, column: 8 } }), '/app.js:12:8')
assert.equal(formatErrorLocation({ stack: 'Error\n at fn (https://example.com/app.js:20:4)' }), 'https://example.com/app.js:20:4')
assert.deepEqual(scoreWebVitals({ fcp: 1000, lcp: 2000, inp: 100, cls: 0.05, ttfb: 500 }), { score: 100, grade: 'A', measured: 5 })
assert.equal(scoreWebVitals({}), null)
