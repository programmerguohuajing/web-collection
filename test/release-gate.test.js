import assert from 'node:assert/strict'
import test from 'node:test'
import worker, { buildDistributedTrace } from '../cloudflare/worker.js'
import { mapEvent } from '../apps/api/src/mappers/event-mapper.js'
import { mapIssue } from '../apps/api/src/mappers/issue-mapper.js'
import { mapReplay } from '../apps/api/src/mappers/replay-mapper.js'
import { setupInputMonitor } from '../packages/sdk/src/behavior/input.js'
import { elementInfo } from '../packages/sdk/src/utils/dom.js'
import {
  API_SLOW_THRESHOLD_MS,
  API_TIMEOUT_MS,
  activeRequestCount,
  api,
  getReplay,
  loadGovernance,
  loadReleases,
  normalizePageResponse,
  slowRequest,
  toList
} from '../apps/web/src/dashboard.js'

const originalFetch = globalThis.fetch

test.afterEach(() => {
  globalThis.fetch = originalFetch
  slowRequest.value = false
  assert.equal(activeRequestCount.value, 0)
})

function jsonResponse(value, status = 200) {
  const body = JSON.stringify(value)
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => value
  }
}

function assertPageEnvelope(payload, { page, pageSize } = {}) {
  assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload), '列表接口必须返回对象 envelope')
  assert.ok(Array.isArray(payload.items), '列表 envelope.items 必须是数组')
  assert.ok(Number.isInteger(Number(payload.page)) && Number(payload.page) >= 1, '列表 envelope.page 必须是正整数')
  assert.ok(Number.isInteger(Number(payload.pageSize)) && Number(payload.pageSize) >= 1 && Number(payload.pageSize) <= 100, '列表 envelope.pageSize 必须在 1..100')
  assert.ok(Number.isInteger(Number(payload.total)) && Number(payload.total) >= 0, '列表 envelope.total 必须是非负整数')
  assert.ok(Number(payload.total) >= payload.items.length, 'total 不能小于当前页条数')
  if (page != null) assert.equal(Number(payload.page), page)
  if (pageSize != null) assert.equal(Number(payload.pageSize), pageSize)
  return payload.items
}

function pick(row, ...keys) {
  const key = keys.find(name => row?.[name] !== undefined && row?.[name] !== null)
  assert.ok(key, `字段缺失：${keys.join(' / ')}`)
  return row[key]
}

function database({ all = [], first = { count: 0 }, onPrepare } = {}) {
  const calls = []
  const env = {
    DB: {
      prepare(sql) {
        const call = { sql, values: [] }
        calls.push(call)
        const result = {
          bind(...values) {
            call.values = values
            return result
          },
          async all() {
            if (typeof onPrepare === 'function') return { results: await onPrepare(call, 'all') }
            return { results: typeof all === 'function' ? await all(call) : all }
          },
          async first() {
            if (typeof onPrepare === 'function') return await onPrepare(call, 'first')
            return typeof first === 'function' ? await first(call) : first
          },
          async run() { return { meta: { changes: 1, last_row_id: 1 } } }
        }
        return result
      }
    }
  }
  return { env, calls }
}

async function workerJson(path, env) {
  const response = await worker.fetch(new Request(`https://gate.test${path}`), env)
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  return { response, body, text }
}

test('页面 ViewModel 字段契约：手机号脱敏、Span 标识保留、DOM 不采集 value', () => {
  const event = mapEvent({
    id: 'event-1', ts: 1, type: 'perf', app_id: 'gate-app', release_name: '1.2.0',
    user_id: 'user-1', user_name: '测试用户', user_phone: '13800138000',
    trace_id: 'trace-1', span_id: 'span-1', parent_span_id: 'root',
    props_json: JSON.stringify({ status: 503, method: 'GET', url: 'https://api.test/orders' })
  })
  assert.equal(event.userPhone, '138****8000')
  assert.notEqual(event.userPhone, '13800138000')
  assert.equal(event.traceId, 'trace-1')
  assert.equal(event.spanId, 'span-1')
  assert.equal(event.parentSpanId, 'root')
  assert.equal(event.props.status, 503)

  const issue = mapIssue({
    fingerprint: 'issue-1', status: 'open', app_id: 'gate-app', release: '1.2.0',
    name: 'TypeError', message: 'boom', count: 2, affected_users: 1,
    first_seen: 1, last_seen: 2, users_json: '[]'
  })
  assert.equal(issue.fingerprint, 'issue-1')
  assert.equal(issue.count, 2)
  assert.equal(issue.affectedUsers, 1)

  const replay = mapReplay({ id: 7, session_id: 'session-1', user_phone: '13912345678', count: 1, first_seen: 1, last_seen: 2 })
  assert.equal(replay.replayId, 7)
  assert.equal(replay.sessionId, 'session-1')
  assert.equal(replay.userPhone, '139****5678')

  const attributes = [{ name: 'value', value: 'sensitive-input' }, { name: 'placeholder', value: '请输入手机号' }]
  const info = elementInfo({
    tagName: 'INPUT', id: 'phone', className: 'field', value: '13800138000', attributes,
    innerText: '', textContent: '', closest: () => null,
    getAttribute: name => attributes.find(item => item.name === name)?.value || ''
  })
  assert.equal('value' in info, false)
  assert.equal(info.label, '请输入手机号')
})

test('输入行为采集只记录元数据和值长度，销毁监听器必须幂等', () => {
  const originalAdd = globalThis.addEventListener
  const originalRemove = globalThis.removeEventListener
  const listeners = new Map()
  const events = []
  globalThis.addEventListener = (name, handler) => listeners.set(name, handler)
  globalThis.removeEventListener = name => listeners.delete(name)
  const attributes = [{ name: 'placeholder', value: '请输入手机号' }]
  const target = {
    nodeType: 1, tagName: 'INPUT', id: 'phone', className: '', value: '13800138000', attributes,
    innerText: '', textContent: '', closest: () => null,
    getAttribute: name => attributes.find(item => item.name === name)?.value || ''
  }
  try {
    const stop = setupInputMonitor({ push: event => events.push(event) })
    listeners.get('focusin')({ target })
    listeners.get('input')({ target })
    listeners.get('focusout')({ target })
    assert.deepEqual(events.map(event => event.name), ['input_focus', 'input_change', 'input_blur'])
    assert.ok(events.every(event => !('value' in event.props)))
    assert.equal(events.at(-1).props.valueLength, 11)
    assert.equal(events.at(1).props.changeCount, 1)
    assert.doesNotThrow(stop)
    assert.equal(listeners.size, 0)
  } finally {
    globalThis.addEventListener = originalAdd
    globalThis.removeEventListener = originalRemove
  }
})

test('分页响应 envelope 稳定，允许合法空页但不把错误对象当作列表', () => {
  assert.deepEqual(normalizePageResponse({ items: [{ id: 1 }], total: 1, page: 1, pageSize: 10 }), { items: [{ id: 1 }], total: 1, page: 1, pageSize: 10 })
  assert.deepEqual(normalizePageResponse({ rows: [{ id: 2 }], count: 2, page: 2, pageSize: 1 }), { items: [{ id: 2 }], total: 2, page: 2, pageSize: 1 })
  assert.deepEqual(normalizePageResponse({ data: { results: [{ id: 3 }], total: 1, page: 1, pageSize: 10 } }), { items: [{ id: 3 }], total: 1, page: 1, pageSize: 10 })
  assert.deepEqual(normalizePageResponse({ items: [], total: 0, page: 1, pageSize: 10 }), { items: [], total: 0, page: 1, pageSize: 10 })
  assert.deepEqual(toList([{ id: 4 }]), [{ id: 4 }])
  assert.throws(() => toList({ error: 'database unavailable' }), /列表|格式|items/i)
  assert.throws(() => assertPageEnvelope({ error: 'database unavailable' }), /envelope/)
})

test('治理与发布接口保留 snake_case ViewModel 字段并映射非空数据', async () => {
  const requests = []
  const application = { app_id: 'gate-app', name: 'Gate App', platform: 'web', owner: 'QA', enabled: true, sample_rate: 0.5, replay_sample_rate: 0.25, release_count: 2, rules_json: {} }
  const release = { app_id: 'gate-app', release_name: '1.2.0', status: 'active', created_at: 1700000000000 }
  globalThis.fetch = async url => {
    requests.push(String(url))
    if (String(url).startsWith('/api/applications?page=')) return jsonResponse({ items: [application], total: 1, page: 1, pageSize: 10 })
    if (String(url) === '/api/applications') return jsonResponse([application])
    if (String(url).includes('/releases?')) return jsonResponse({ items: [release], total: 1, page: 1, pageSize: 10 })
    if (String(url) === '/api/settings') return jsonResponse({ retention: { eventsDays: 30 }, alerts: { enabled: true } })
    throw new Error(`unexpected request: ${url}`)
  }

  const governance = await loadGovernance({ appPage: 1, appPageSize: 10 })
  const applications = assertPageEnvelope(governance.applications, { page: 1, pageSize: 10 })
  assert.equal(pick(applications[0], 'app_id', 'appId'), 'gate-app')
  assert.equal(pick(applications[0], 'release_count', 'releaseCount'), 2)
  assert.equal(pick(applications[0], 'sample_rate', 'sampleRate'), 0.5)
  assert.equal(pick(applications[0], 'replay_sample_rate', 'replaySampleRate'), 0.25)
  assert.equal(governance.applicationOptions.length, 1)

  const releases = assertPageEnvelope(await loadReleases('gate-app', 1, 10), { page: 1, pageSize: 10 })
  assert.equal(pick(releases[0], 'release_name', 'releaseName', 'release'), '1.2.0')
  assert.equal(pick(releases[0], 'status'), 'active')
  assert.ok(requests.includes('/api/applications?page=1&pageSize=10'))
  assert.ok(requests.includes('/api/applications/gate-app/releases?page=1&pageSize=10'))
})

test('API 非 2xx 不伪装为空列表，并提供可观测的超时错误', async () => {
  globalThis.fetch = async () => jsonResponse({ error: 'database unavailable' }, 503)
  await assert.rejects(
    api('/api/events?page=1&pageSize=10', { timeout: 200 }),
    error => error.code === 'HTTP_ERR' && error.status === 503 && /database unavailable/.test(error.message)
  )

  let signal
  globalThis.fetch = async (_url, options = {}) => {
    signal = options.signal
    return new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    })
  }
  const started = performance.now()
  await assert.rejects(api('/api/events?page=1&pageSize=10', { timeout: 30 }), error => error.code === 'TIMEOUT_ERR')
  assert.ok(performance.now() - started < 500, '超时请求必须在预算内结束')
  assert.equal(signal.aborted, true)
})

test('慢请求有提示，requestKey 取消旧请求且 getReplay 失败后不污染缓存', async () => {
  let sawSlow = false
  globalThis.fetch = async (_url, options = {}) => {
    await new Promise(resolve => setTimeout(resolve, 35))
    sawSlow ||= slowRequest.value
    options.signal?.throwIfAborted?.()
    return jsonResponse({ items: [], total: 0, page: 1, pageSize: 10 })
  }
  await api('/api/events?page=1&pageSize=10', { timeout: 200, slowThreshold: 10 })
  assert.equal(sawSlow, true)
  assert.equal(slowRequest.value, false)

  let calls = 0
  let firstSignal
  globalThis.fetch = async (_url, options = {}) => {
    calls++
    if (calls === 1) {
      firstSignal = options.signal
      return new Promise((resolve, reject) => options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))
    }
    return jsonResponse({ ok: true })
  }
  const first = api('/api/events', { requestKey: 'gate-events' })
  await new Promise(resolve => setTimeout(resolve, 5))
  const second = api('/api/events', { requestKey: 'gate-events', timeout: 200 })
  await assert.rejects(first, error => error.code === 'ABORT_ERR')
  assert.deepEqual(await second, { ok: true })
  assert.equal(firstSignal.aborted, true)

  let replayCalls = 0
  globalThis.fetch = async () => {
    replayCalls++
    if (replayCalls === 1) return jsonResponse({ error: 'temporary' }, 500)
    return jsonResponse([{ type: 2, data: {} }])
  }
  await assert.rejects(getReplay('gate-replay'))
  assert.deepEqual(await getReplay('gate-replay'), [{ type: 2, data: {} }])
  assert.equal(replayCalls, 2)
})

test('Worker 列表接口强制分页上限、筛选参数并返回非空 ViewModel', async () => {
  const eventRow = {
    id: 'event-1', ts: 1700000000000, type: 'perf', app_id: 'gate-app', release_name: '1.2.0',
    user_id: 'user-1', user_name: 'QA', user_phone: '13800138000', trace_id: 'trace-1', span_id: 'span-1',
    metric: 'fetch', value: 42, props_json: JSON.stringify({ status: 200, method: 'GET', url: 'https://api.test/orders' })
  }
  const { env, calls } = database({
    all: call => call.sql.includes('count(*)') ? [] : [eventRow],
    first: { count: 1 }
  })
  const { response, body } = await workerJson('/api/events?appId=gate-app&type=perf&page=3&pageSize=9999', env)
  assert.equal(response.status, 200)
  const items = assertPageEnvelope(body, { page: 3, pageSize: 100 })
  assert.equal(pick(items[0], 'traceId', 'trace_id'), 'trace-1')
  assert.equal(pick(items[0], 'spanId', 'span_id'), 'span-1')
  assert.equal(pick(items[0], 'userPhone'), '138****8000')
  assert.ok(calls.some(call => call.sql.includes('app_id=?') && call.values.includes('gate-app')))
  assert.ok(calls.some(call => call.values.at(-2) === 100 && call.values.at(-1) === 200))
})

test('Worker 合法空态有明确结构，数据库异常返回 500 而不是空列表', async () => {
  const emptyDb = database({ all: [], first: { count: 0 } }).env
  const emptyList = await workerJson('/api/traces/?page=2&pageSize=25', emptyDb)
  assert.equal(emptyList.response.status, 200)
  assertPageEnvelope(emptyList.body, { page: 2, pageSize: 25 })
  assert.deepEqual(emptyList.body.items, [])
  assert.equal(emptyList.body.total, 0)

  const distributed = await workerJson('/api/traces/empty/distributed', emptyDb)
  assert.equal(distributed.response.status, 200)
  assert.deepEqual(distributed.body, { root: null, nodes: [], edges: [], criticalPath: [], errorSpans: [] })

  const failingEnv = {
    DB: {
      prepare() {
        return {
          bind() { return this },
          async all() { throw new Error('database unavailable') },
          async first() { throw new Error('database unavailable') }
        }
      }
    }
  }
  const failed = await workerJson('/api/events?page=1&pageSize=10', failingEnv)
  assert.equal(failed.response.status, 500)
  assert.match(failed.text, /database unavailable/)
  assert.notDeepEqual(failed.body, [])
  assert.notDeepEqual(failed.body, { items: [], total: 0, page: 1, pageSize: 10 })
})

test('分布式链路 ViewModel 保留 ID、状态和父子边，避免顶部统计下无拓扑', () => {
  const trace = buildDistributedTrace([
    { id: 'root-event', trace_id: 'trace-1', span_id: 'root', type: 'perf', metric: 'page_load', ts: 100, value: 10, props_json: '{}' },
    { id: 'child-event', trace_id: 'trace-1', span_id: 'child', parent_span_id: 'root', type: 'perf', metric: 'fetch', ts: 110, value: 20, props_json: '{"status":503}' },
    { id: 'error-event', trace_id: 'trace-1', span_id: 'error', parent_span_id: 'child', type: 'error', name: 'ResourceError', ts: 120, props_json: '{}' }
  ])
  assert.equal(trace.nodes.length, 3)
  assert.ok(trace.nodes.every(node => node.spanId || node.id))
  assert.ok(trace.nodes.some(node => node.id === 'child' && pick(node, 'status', 'statusCode') === 'ERROR'))
  assert.deepEqual(trace.edges, [{ source: 'root', target: 'child' }, { source: 'child', target: 'error' }])
  assert.deepEqual(trace.criticalPath, ['root', 'child', 'error'])
})

test('结构性热请求预算：健康数据与分页模拟响应分别小于 250ms / 2s', async () => {
  const quickEnv = database({ all: [], first: { count: 0 } }).env
  const healthStarted = performance.now()
  const health = await workerJson('/health', quickEnv)
  const healthElapsed = performance.now() - healthStarted
  assert.equal(health.response.status, 200)
  assert.deepEqual(health.body, { ok: true, runtime: 'cloudflare-workers' })
  assert.ok(healthElapsed < 250, `health 结构性预算超时：${healthElapsed.toFixed(1)}ms`)

  const listStarted = performance.now()
  const list = await workerJson('/api/events?page=1&pageSize=10', quickEnv)
  const listElapsed = performance.now() - listStarted
  assert.equal(list.response.status, 200)
  assertPageEnvelope(list.body, { page: 1, pageSize: 10 })
  assert.ok(listElapsed < 2000, `列表结构性预算超时：${listElapsed.toFixed(1)}ms`)
  assert.ok(API_SLOW_THRESHOLD_MS > 0 && API_SLOW_THRESHOLD_MS <= 2000, '慢请求提示阈值应处于可观测预算内')
  assert.ok(API_TIMEOUT_MS > API_SLOW_THRESHOLD_MS, '硬超时必须晚于慢请求提示')
})
