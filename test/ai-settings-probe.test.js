import assert from 'node:assert/strict'
import test from 'node:test'
import aiWorker from '../cloudflare/ai-worker.js'

const ORIGIN = 'https://ai.example.com'
const MASTER_KEY = 'unit-test-master-key'

function d1Stub(configJson = null) {
  const state = { configJson }
  return {
    DB: {
      prepare(sql) {
        const statement = {
          values: [],
          bind(...values) { this.values = values; return this },
          async first() {
            if (/select config_json from settings/.test(sql)) return state.configJson == null ? null : { config_json: state.configJson }
            return null
          },
          async run() {
            if (/insert into settings/.test(sql)) state.configJson = statement.values[0]
            return { meta: {} }
          },
          async all() { return { results: [] } }
        }
        return statement
      }
    },
    _state: state
  }
}

function post(path, body) {
  return new Request(`${ORIGIN}${path}`, { method: 'POST', body: JSON.stringify(body) })
}

const originalFetch = globalThis.fetch

test.afterEach(() => {
  globalThis.fetch = originalFetch
})

function jsonResponse(value, status = 200) {
  const body = JSON.stringify(value)
  return { ok: status >= 200 && status < 300, status, text: async () => body, json: async () => value }
}

test('POST /settings/test：local 不可达 fail、workers-ai 兜底 ok、结果并行返回', async t => {
  t.plan ? null : null
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, signal: init.signal })
    throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
  }
  const env = d1Stub()
  env.MODEL_FALLBACK = 'off'
  env.AI = { run: async () => ({ choices: [{ message: { content: 'ok' } }] }) }
  const res = await aiWorker.fetch(post('/api/ai/settings/test', {
    modelOrder: 'local,domestic',
    providers: { domestic: { baseUrl: 'https://api.deepseek.com/v1' } }
  }), env)
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.results.local.ok, false)
  assert.ok(data.results.local.error.length <= 80)
  assert.equal(typeof data.results.local.latencyMs, 'number')
  assert.equal(data.results.domestic.ok, false, 'domestic 也走被劫持的 fetch → fail')
  assert.equal(data.results['workers-ai'].ok, true, 'workers-ai 用 AI 绑定不受 fetch 劫持影响')
})

test('POST /settings/test：表单新 key 优先生效（发给上游的是新 key）', async t => {
  let seenAuth = ''
  globalThis.fetch = async (url, init = {}) => {
    seenAuth = init.headers?.authorization || ''
    return jsonResponse({ choices: [{ message: { content: 'ok' } }] })
  }
  const res = await aiWorker.fetch(post('/api/ai/settings/test', {
    modelOrder: 'domestic',
    modelFallback: false,
    providers: { domestic: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-brand-new' } }
  }), d1Stub())
  const data = await res.json()
  assert.equal(data.results.domestic.ok, true)
  assert.equal(seenAuth, 'Bearer sk-brand-new')
})

test('POST /settings/models：openai 格式取 data[].id 并排序', async t => {
  let calledUrl = '', auth = ''
  globalThis.fetch = async (url, init = {}) => {
    calledUrl = url
    auth = init.headers?.authorization || ''
    return jsonResponse({ data: [{ id: 'zeta' }, { id: 'alpha' }] })
  }
  const res = await aiWorker.fetch(post('/api/ai/settings/models', {
    provider: 'domestic',
    baseUrl: 'https://api.deepseek.com/v1/',
    apiFormat: 'openai-chat'
  }), d1Stub())
  const data = await res.json()
  assert.deepEqual(data, { ok: true, models: ['alpha', 'zeta'] })
  assert.equal(calledUrl, 'https://api.deepseek.com/v1/models')
  assert.equal(auth, '')
})

test('POST /settings/models：anthropic 头 + gemini 前缀剥离', async t => {
  const seen = []
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url, headers: init.headers || {} })
    if (String(url).includes('anthropic')) return jsonResponse({ data: [{ id: 'claude-x' }] })
    return jsonResponse({ models: [{ name: 'models/gemini-a' }, { name: 'models/gemini-b' }] })
  }
  const r1 = await aiWorker.fetch(post('/api/ai/settings/models', {
    provider: 'overseas', baseUrl: 'https://api.anthropic.com', apiFormat: 'anthropic-messages'
  }), d1Stub())
  const d1 = await r1.json()
  assert.deepEqual(d1.models, ['claude-x'])
  assert.equal(seen[0].headers['anthropic-version'], '2023-06-01')

  const r2 = await aiWorker.fetch(post('/api/ai/settings/models', {
    provider: 'overseas', baseUrl: 'https://generativelanguage.googleapis.com', apiFormat: 'gemini-generatecontent', apiKey: 'gm'
  }), d1Stub())
  const d2 = await r2.json()
  assert.deepEqual(d2.models, ['gemini-a', 'gemini-b'])
  assert.ok(seen[1].url.endsWith('?key=gm'))
})

test('POST /settings/models：apiKey 为空时回落库中已存密钥；失败返回 ok:false 不抛 5xx', async t => {
  // 先存一个 key
  const putEnv = d1Stub()
  putEnv.AI_SECRET_MASTER_KEY = MASTER_KEY
  await aiWorker.fetch(new Request(`${ORIGIN}/api/ai/settings`, {
    method: 'PUT', body: JSON.stringify({ providers: { domestic: { apiKey: 'sk-stored-key' } } })
  }), putEnv)

  let auth = ''
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('fail-host')) return jsonResponse({ error: 'nope' }, 401)
    auth = init.headers?.authorization || ''
    return jsonResponse({ data: [] })
  }
  const r1 = await aiWorker.fetch(post('/api/ai/settings/models', { provider: 'domestic', baseUrl: 'https://api.deepseek.com/v1' }), putEnv)
  const d1 = await r1.json()
  assert.equal(d1.ok, true)
  assert.equal(auth, 'Bearer sk-stored-key')

  const r2 = await aiWorker.fetch(post('/api/ai/settings/models', { provider: 'domestic', baseUrl: 'https://fail-host.example/v1' }), putEnv)
  assert.equal(r2.status, 200)
  const d2 = await r2.json()
  assert.equal(d2.ok, false)
  assert.match(d2.error, /401/)
})

test('POST /settings/models：provider 非法 → 400；workers-ai 明确不支持', async t => {
  const res = await aiWorker.fetch(post('/api/ai/settings/models', { provider: 'workers-ai' }), d1Stub())
  assert.equal(res.status, 400)
})
