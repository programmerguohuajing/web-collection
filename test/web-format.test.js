import assert from 'node:assert/strict'
import { formatDuration, formatErrorLocation, formatSpanId, formatSpanStatus, readableText, scoreWebVitals, spanStatusType } from '../apps/web/src/utils/format.js'
import { buildSummary } from '../apps/api/src/services/summary-service.js'

assert.equal(formatDuration(999), '999ms')
assert.equal(formatDuration(1250), '1.3s')
assert.equal(formatDuration(1227572), '20分27秒')
assert.equal(readableText('[object Object]', 'UnhandledRejection'), 'UnhandledRejection')
assert.equal(readableText({ message: '请求失败' }), '请求失败')
assert.equal(readableText({ code: 500 }), '{"code":500}')
assert.equal(formatErrorLocation({ props: { source: '/app.js', line: 12, column: 8 } }), '/app.js:12:8')
assert.equal(formatErrorLocation({ stack: 'Error\n at fn (https://example.com/app.js:20:4)' }), 'https://example.com/app.js:20:4')
assert.equal(formatErrorLocation({ stack: 'Error\n at sdk (https://collector.test/sdk/web-collection-sdk.iife.js:1:2)\n at app (https://example.com/app.js:20:4)' }), 'https://example.com/app.js:20:4')
assert.deepEqual(scoreWebVitals({ fcp: 1000, lcp: 2000, inp: 100, cls: 0.05, ttfb: 500 }), { score: 100, grade: 'A', measured: 5 })
assert.equal(scoreWebVitals({}), null)
assert.equal(formatSpanId({ spanId: 'camel-span' }), 'camel-span')
assert.equal(formatSpanId({ span_id: 'legacy-span' }), 'legacy-span')
assert.equal(formatSpanId({}), '-')
assert.equal(formatSpanStatus({ type: 'perf', props: {} }), 'OK')
assert.equal(formatSpanStatus({ type: 'perf', props: { status: 204 } }), '204')
assert.equal(formatSpanStatus({ type: 'perf', props: { status: 503 } }), '503')
assert.equal(formatSpanStatus({ type: 'error', props: {} }), 'ERROR')
assert.equal(formatSpanStatus({ type: 'perf', props: { failed: 'true', status: 0 } }), 'ERROR')
assert.equal(spanStatusType({ type: 'perf', props: { status: 302 } }), 'warning')
assert.equal(spanStatusType({ type: 'perf', props: { status: 503 } }), 'danger')
assert.equal(spanStatusType({ type: 'perf', props: {} }), 'success')

const summary = buildSummary([], {}, [], [
  { type: 'perf', metric: 'lcp', value: 100 },
  { type: 'perf', metric: 'lcp', value: 300 },
  { type: 'perf', metric: 'lcp', value: 200 },
  { type: 'perf', metric: 'blank_screen_rate', value: 0 },
  { type: 'perf', metric: 'blank_screen_rate', value: 100 },
  { type: 'perf', metric: 'page_load', value: 0 }
])
assert.equal(summary.perf.lcp, 300)
assert.equal(summary.perf.blank_screen_rate, 50)
assert.equal(summary.perf.page_load, undefined)
assert.deepEqual(summary.perfCounts, { lcp: 3, blank_screen_rate: 2 })
