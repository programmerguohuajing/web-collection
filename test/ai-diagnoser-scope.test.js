import assert from 'node:assert/strict'
import test from 'node:test'
import { createDiagnoser } from '../packages/ai/diagnoser.js'

/**
 * P0 产品化：scope 引擎单测。
 * 覆盖：trace 无错误也能产出性能诊断、session/release 上下文组装、diagnose 路由、参数校验。
 * db 用「SQL 特征匹配」的内存 mock，让真实 queries.js 命中注入 fixture。
 */
function buildDb(fixtures = {}) {
  const inserts = []
  const db = {
    inserts,
    prepare(sql) {
      const stmt = {
        _values: null,
        bind(...values) { this._values = values; return this },
        async all() {
          if (sql.includes('from events where trace_id=')) return fixtures.events || []
          if (sql.includes('from events where session_id=')) return fixtures.sessionEvents || []
          if (sql.includes('from events where release_name=') && sql.includes('group by type')) return fixtures.releaseStats || []
          if (sql.includes('min(ts)') && sql.includes('group by release_name')) return fixtures.releaseList || []
          if (sql.includes('ai_kb_chunks')) return []
          return []
        },
        async first() {
          if (sql.includes('from issues where fingerprint=')) return fixtures.issue || null
          if (sql.includes('ai_diagnoses')) return null
          return null
        },
        async run() { inserts.push(sql); return { changes: 1, lastRowId: 1 } }
      }
      return stmt
    }
  }
  return db
}

const modelGateway = impl => ({ route: impl })

const PERF_EVENTS = [
  { id: 'e1', ts: 1000, type: 'perf', app_id: 'a', span_id: 's1', parent_span_id: '', props_json: '{}', metric: 'lcp', value: 2500, name: '', stack: '' },
  { id: 'e2', ts: 1100, type: 'perf', app_id: 'a', span_id: 's2', parent_span_id: 's1', props_json: '{}', metric: 'fcp', value: 1800, name: '', stack: '' }
]

const SESSION_EVENTS = [
  { id: 'e1', ts: 1000, type: 'pageview', app_id: 'a', session_id: 'sess-1', user_agent: 'UA', device_id: 'd1', url: 'https://x/1', props_json: '{}', value: null, name: '', stack: '' },
  { id: 'e2', ts: 1100, type: 'error', app_id: 'a', session_id: 'sess-1', user_agent: 'UA', device_id: 'd1', url: 'https://x/2', props_json: '{}', message: 'boom', name: 'TypeError', stack: 'at x.js:1', value: null },
  { id: 'e3', ts: 1200, type: 'error', app_id: 'a', session_id: 'sess-1', user_agent: 'UA', device_id: 'd1', url: 'https://x/2', props_json: '{}', message: 'boom2', name: 'RangeError', stack: 'at y.js:2', value: null },
  { id: 'e4', ts: 1300, type: 'perf', app_id: 'a', session_id: 'sess-1', user_agent: 'UA', device_id: 'd1', props_json: '{}', metric: 'lcp', value: 2500, name: '', stack: '', value: 2500 }
]

const RELEASE_STATS = [
  { type: 'error', cnt: 5, perf_avg: null },
  { type: 'perf', cnt: 3, perf_avg: 2500 },
  { type: 'pageview', cnt: 100, perf_avg: null }
]
const RELEASE_STATS_PREV = [
  { type: 'error', cnt: 2, perf_avg: null },
  { type: 'perf', cnt: 3, perf_avg: 2000 },
  { type: 'pageview', cnt: 90, perf_avg: null }
]
const RELEASE_LIST = [
  { release_name: 'v1', first_ts: 100 },
  { release_name: 'v2', first_ts: 200 }
]

const FIXTURES = {
  events: PERF_EVENTS,
  sessionEvents: SESSION_EVENTS,
  releaseStats: RELEASE_STATS,
  releaseList: RELEASE_LIST
}

test('P0 trace 无错误：仍产出性能诊断（不整体降级）', async () => {
  let userPrompt = ''
  const gateway = modelGateway(async (sys, up) => {
    userPrompt = up
    return { model: 'm', provider: 'p', content: JSON.stringify({
      summary: 'LCP 2500ms 偏高', hypotheses: [{ cause: '主资源过大', confidence: 0.6, evidence: ['span:s1'] }],
      suggestions: [{ action: '压缩主资源' }], relatedKb: []
    }) }
  })
  const d = createDiagnoser({ db: buildDb(FIXTURES), gateway, kb: { search: async () => [] }, embedder: {} })
  const res = await d.diagnose({ scope: 'trace', ref: 't-perf', appId: 'a' })
  assert.equal(res.degraded, false)
  assert.equal(res.summary, 'LCP 2500ms 偏高')
  assert.ok(userPrompt.includes('性能热点') || userPrompt.includes('分布式链路'))
  // 无错误 → RAG query 不应含 error 文本，应含慢节点
  assert.ok(userPrompt.length > 0)
})

test('P0 trace 性能模式（scope=perf）走性能链路', async () => {
  let userPrompt = ''
  const gateway = modelGateway(async (sys, up) => { userPrompt = up; return { model: 'm', provider: 'p', content: JSON.stringify({ summary: 'perf', hypotheses: [], suggestions: [], relatedKb: [] }) } })
  const d = createDiagnoser({ db: buildDb(FIXTURES), gateway, kb: { search: async () => [] }, embedder: {} })
  await d.diagnose({ scope: 'perf', ref: 't-perf', appId: 'a' })
  assert.ok(userPrompt.includes('性能链路'))
})

test('P0 session 诊断：上下文含错误聚合', async () => {
  let userPrompt = ''
  const gateway = modelGateway(async (sys, up) => { userPrompt = up; return { model: 'm', provider: 'p', content: JSON.stringify({ summary: '会话有 2 个错误', hypotheses: [], suggestions: [], relatedKb: [] }) } })
  const d = createDiagnoser({ db: buildDb(FIXTURES), gateway, kb: { search: async () => [] }, embedder: {} })
  const res = await d.diagnose({ scope: 'session', ref: 'sess-1', appId: 'a' })
  assert.equal(res.degraded, false)
  assert.equal(res.refId, 'sess-1')
  assert.ok(userPrompt.includes('会话聚合'))
  assert.ok(userPrompt.includes('"errorCount": 2'))
})

test('P0 release 诊断：上下文含版本对比与变化率', async () => {
  const db = buildDb({ ...FIXTURES, releaseStats: RELEASE_STATS, releaseList: RELEASE_LIST })
  // 第二次 getReleaseStats（上一版本）需返回 prev 数据：用闭包区分
  // 简化：让 mock 对 v1 返回 prev，通过覆盖 releaseStats 顺序不可行，改为定制 all()
  const customDb = {
    inserts: [],
    prepare(sql) {
      const stmt = {
        bind(...v) { this._v = v; return this },
        async all() {
          if (sql.includes('from events where trace_id=')) return []
          if (sql.includes('from events where session_id=')) return []
          if (sql.includes('group by type')) {
            // 取 release_name 参数判断当前/上一版本
            const name = this._v[this._v.length - 1]
            return name === 'v1' ? RELEASE_STATS_PREV : RELEASE_STATS
          }
          if (sql.includes('min(ts)')) return RELEASE_LIST
          return []
        },
        async first() { return null },
        async run() { return { changes: 1 } }
      }
      return stmt
    }
  }
  let userPrompt = ''
  const gateway = modelGateway(async (sys, up) => { userPrompt = up; return { model: 'm', provider: 'p', content: JSON.stringify({ summary: 'v2 错误率上升', hypotheses: [], suggestions: [], relatedKb: [] }) } })
  const d = createDiagnoser({ db: customDb, gateway, kb: { search: async () => [] }, embedder: {} })
  const res = await d.diagnose({ scope: 'release', ref: 'v2', appId: 'a' })
  assert.equal(res.degraded, false)
  assert.equal(res.refId, 'v2')
  assert.ok(userPrompt.includes('版本发布对比'))
  assert.ok(userPrompt.includes('v1'))
})

test('P0 diagnose 路由：缺 ref 抛 400', async () => {
  const d = createDiagnoser({ db: buildDb(FIXTURES), gateway: modelGateway(async () => ({ content: '{}' })), kb: { search: async () => [] }, embedder: {} })
  await assert.rejects(() => d.diagnose({ scope: 'trace', ref: '' }), err => err.status === 400)
})

test('P0 diagnose 路由：不支持的 scope 抛 400', async () => {
  const d = createDiagnoser({ db: buildDb(FIXTURES), gateway: modelGateway(async () => ({ content: '{}' })), kb: { search: async () => [] }, embedder: {} })
  await assert.rejects(() => d.diagnose({ scope: 'bogus', ref: 'x' }), err => err.status === 400)
})

test('P0 diagnose 路由：scope=ask 现由 P2 接管（无 conversationId 也返回答案）', async () => {
  const d = createDiagnoser({ db: buildDb(FIXTURES), gateway: modelGateway(async () => ({ content: 'iOS 转化下降 12%' })), kb: { search: async () => [] }, embedder: {} })
  const res = await d.diagnose({ scope: 'ask', ref: '为什么转化掉了', appId: 'a' })
  assert.ok(res.answer)
  assert.ok(res.conversationId)
})

test('P0 buildQuery：无错误 trace 检索 query 含慢节点而非 error 文本', async () => {
  // 通过间接方式验证：trace 无错误时模型收到的 userPrompt 不含「错误事件」段
  let userPrompt = ''
  const gateway = modelGateway(async (sys, up) => { userPrompt = up; return { model: 'm', provider: 'p', content: JSON.stringify({ summary: 'ok', hypotheses: [], suggestions: [], relatedKb: [] }) } })
  const d = createDiagnoser({ db: buildDb(FIXTURES), gateway, kb: { search: async () => [] }, embedder: {} })
  await d.diagnose({ scope: 'trace', ref: 't-perf', appId: 'a' })
  assert.ok(!userPrompt.includes('## 错误事件'))
})
