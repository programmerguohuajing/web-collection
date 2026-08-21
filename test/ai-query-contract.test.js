import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDistributedTrace as workerBuild } from '../cloudflare/worker.js'
import { buildDistributedTrace as aiBuild, mapEvent as aiMapEvent, mapIssue as aiMapIssue } from '../packages/ai/queries.js'
import { mapEvent as workerMapEvent } from '../cloudflare/worker.js'

// 双后端共享的 AI 查询实现（packages/ai/queries.js）必须与 worker.js 主实现输出一致，
// 防止「仅 Cloudflare」「双后端」两处逻辑漂移（设计 §13.4）。

function sampleEvents() {
  return [
    { id: 'e1', ts: 1000, type: 'perf', app_id: 'a', span_id: 's1', parent_span_id: '', props_json: '{}', metric: 'lcp', value: 2500 },
    { id: 'e2', ts: 1200, type: 'error', app_id: 'a', span_id: 's2', parent_span_id: 's1', props_json: '{"__parentSpanId":"s1"}', name: 'TypeError', message: 'x is undefined', stack: 'line',
      metric: '', value: null },
    { id: 'e3', ts: 1300, type: 'behavior', app_id: 'a', span_id: 's3', parent_span_id: 's2', props_json: '{"status":500}', name: 'click', metric: '', value: null }
  ]
}

test('buildDistributedTrace 与 worker 主实现输出一致', async () => {
  const events = sampleEvents()
  const a = aiBuild(events)
  const w = workerBuild(events)
  assert.deepEqual(a, w)
  assert.ok(a.errorSpans.length > 0, '应包含错误 span')
})

test('mapEvent 与 worker mapEvent 输出一致', () => {
  const row = {
    id: 'e1', ts: 1000, type: 'error', app_id: 'a', release_name: '1.0',
    user_id: 'u1', user_name: 'bob', user_phone: '13812345678', session_id: 's',
    device_id: 'd', trace_id: 't', span_id: 'sp', sdk_version: '0.2', environment: 'prod',
    source: 'js', context_json: '{}', url: 'u', path: 'p', title: 't', referrer: 'r',
    user_agent: 'ua', name: 'TypeError', metric: '', value: null, message: 'm', stack: 'st',
    props_json: '{}', breadcrumbs_json: '[]', app_version: '1.0', product_id: null,
    event_id: 'e1', request_id: null, occurred_at: 1000, received_at: 1000,
    schema_version: '1', batch_id: null, retry_count: 0, contract_status: 'accepted',
    contract_errors_json: null
  }
  assert.deepEqual(aiMapEvent(row), workerMapEvent(row))
})

test('mapIssue 映射字段完整（含 resolutionNotes 新增字段）', () => {
  const out = aiMapIssue({ fingerprint: 'fp', status: 'resolved', app_id: 'a', release_name: '1.0',
    name: 'TypeError', message: 'm', stack: 's', url: 'u', props_json: '{}', breadcrumbs_json: '[]',
    original_json: '{}', count: 3, first_seen: 1, last_seen: 2, resolved_at: 3, affected_users: 2,
    resolution_notes: '修复说明' })
  assert.equal(out.fingerprint, 'fp')
  assert.equal(out.release, '1.0')
  assert.equal(out.resolutionNotes, '修复说明')
  assert.equal(out.affectedUsers, 2)
  // PG 版 issues 表用 release 列名，worker 用 release_name —— 兼容两种
  const pg = aiMapIssue({ fingerprint: 'fp', status: 'resolved', app_id: 'a', release: '2.0', name: 'n', first_seen: 1, last_seen: 2 })
  assert.equal(pg.release, '2.0')
})
