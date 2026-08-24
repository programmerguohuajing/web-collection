import assert from 'node:assert/strict'
import test from 'node:test'
import aiWorker from '../cloudflare/ai-worker.js'
import mainWorker from '../cloudflare/worker.js'

const AI_ORIGIN = 'https://ai.example.com'
const MAIN_ORIGIN = 'https://main.example.com'
const MASTER_KEY = 'unit-test-master-key'

/** 最小 D1 stub：只支持 settings 表的 select/insert(on conflict) 语义 */
function d1Stub() {
  const state = { configJson: null, updatedAt: null }
  const env = {
    DB: {
      prepare(sql) {
        const statement = {
          values: [],
          bind(...values) { this.values = values; return this },
          async first() {
            if (/select config_json from settings/.test(sql)) {
              return state.configJson == null ? null : { config_json: state.configJson }
            }
            return null
          },
          async run() {
            if (/insert into settings/.test(sql)) {
              state.configJson = statement.values[0]
              state.updatedAt = statement.values[1]
            }
            return { meta: {} }
          },
          async all() { return { results: [] } }
        }
        return statement
      }
    },
    _state: state
  }
  return env
}

function req(path, { method = 'GET', body, origin, headers = {} } = {}) {
  const h = { ...headers }
  if (origin) h.origin = origin
  return new Request(`${AI_ORIGIN}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
}

async function readBody(res) {
  const text = await res.text()
  try { return JSON.parse(text) } catch { return text }
}

test('GET /api/ai/settings：无配置时返回默认值且 effectiveSource=default', async () => {
  const res = await aiWorker.fetch(req('/api/ai/settings'), { DB: d1Stub().DB })
  assert.equal(res.status, 200)
  const data = await readBody(res)
  assert.equal(data.modelOrder, 'local,domestic,overseas')
  assert.equal(data.modelFallback, true)
  assert.equal(data.timeoutMs, 30000)
  assert.equal(data.effectiveSource.timeoutMs, 'default')
  assert.equal(data.effectiveSource['providers.domestic.apiKey'], 'none')
  for (const p of Object.values(data.providers)) {
    assert.equal(p.hasKey, false)
    assert.ok(!('apiKey' in p), '响应不得包含明文 apiKey 字段')
  }
})

test('PUT 保存 apiKey → GET 脱敏回显 hasKey/keyMask，密文落库不含明文', async () => {
  const env = d1Stub()
  env.AI_SECRET_MASTER_KEY = MASTER_KEY
  const put = await aiWorker.fetch(req('/api/ai/settings', {
    method: 'PUT',
    body: { providers: { domestic: { baseUrl: 'https://api.deepseek.com/v1', modelName: 'deepseek-chat', apiKey: 'sk-secret-9999' } }, timeoutMs: 45000 }
  }), env)
  assert.equal(put.status, 200)
  const saved = await readBody(put)
  assert.equal(saved.providers.domestic.hasKey, true)
  assert.equal(saved.providers.domestic.keyMask, '••••9999')
  assert.equal(saved.timeoutMs, 45000)
  assert.equal(saved.effectiveSource.timeoutMs, 'db')

  const stored = JSON.parse(env._state.configJson)
  assert.ok(stored.ai_keys, 'ai_keys 密文必须存在')
  assert.ok(!stored.ai_keys.includes('sk-secret-9999'), '库中不得有明文 key')
  assert.equal(stored.ai_keys_v, 1)
  assert.deepEqual(Object.keys(stored.ai.providers.domestic).sort(), ['apiFormat', 'baseUrl', 'modelName'])

  const get = await aiWorker.fetch(req('/api/ai/settings'), env)
  const data = await readBody(get)
  assert.equal(data.providers.domestic.keyMask, '••••9999')
  assert.equal(data.effectiveSource['providers.domestic.baseUrl'], 'db')
})

test('PUT 回显 mask（•••• 前缀）与空值均视为未修改，保留旧 key', async () => {
  const env = d1Stub()
  env.AI_SECRET_MASTER_KEY = MASTER_KEY
  await aiWorker.fetch(req('/api/ai/settings', {
    method: 'PUT',
    body: { providers: { overseas: { apiKey: 'sk-original-4321' } } }
  }), env)

  const put2 = await aiWorker.fetch(req('/api/ai/settings', {
    method: 'PUT',
    body: { providers: { overseas: { apiKey: '••••4321' } } }
  }), env)
  assert.equal(put2.status, 200)
  const data = await readBody(put2)
  assert.equal(data.providers.overseas.keyMask, '••••4321', '旧 key 应保留（mask 未变成新 key）')

  // 空字符串也不清掉
  await aiWorker.fetch(req('/api/ai/settings', { method: 'PUT', body: { providers: { overseas: { apiKey: '' } } } }), env)
  const get = await aiWorker.fetch(req('/api/ai/settings'), env)
  assert.equal((await readBody(get)).providers.overseas.hasKey, true)
})

test('PUT 校验失败：modelOrder 非法 → 400；baseUrl 协议头错 → 400', async () => {
  const env = d1Stub()
  const r1 = await aiWorker.fetch(req('/api/ai/settings', { method: 'PUT', body: { modelOrder: 'bogus' } }), env)
  assert.equal(r1.status, 400)
  const r2 = await aiWorker.fetch(req('/api/ai/settings', {
    method: 'PUT',
    body: { providers: { local: { baseUrl: 'ftp://x' } } }
  }), env)
  assert.equal(r2.status, 400)
})

test('masterKey 未配置时 PUT 带 新 apiKey → 503；不带 key 可正常保存', async () => {
  const env = d1Stub()
  const r1 = await aiWorker.fetch(req('/api/ai/settings', {
    method: 'PUT',
    body: { providers: { domestic: { apiKey: 'sk-new' } } }
  }), env)
  assert.equal(r1.status, 503)

  const r2 = await aiWorker.fetch(req('/api/ai/settings', { method: 'PUT', body: { timeoutMs: 60000 } }), env)
  assert.equal(r2.status, 200)
})

test('settings 端点跨源拒绝：Origin 不同源 → 403，x-ai-key 也无效', async () => {
  const env = d1Stub()
  const res = await aiWorker.fetch(req('/api/ai/settings', { origin: 'https://evil.example' }), env)
  assert.equal(res.status, 403)
  const res2 = await aiWorker.fetch(req('/api/ai/settings', {
    method: 'PUT',
    origin: 'https://evil.example',
    body: {},
    headers: { 'x-ai-key': 'leaked-key' }
  }), env)
  assert.equal(res2.status, 403)
})

test('读库异常时 GET 不中断（返回默认配置）', async () => {
  const brokenDb = { prepare() { throw new Error('D1 down') } }
  const res = await aiWorker.fetch(req('/api/ai/settings'), { DB: brokenDb })
  assert.equal(res.status, 200)
  const data = await readBody(res)
  assert.equal(data.timeoutMs, 30000)
})

test('回归：主 worker saveSettings 覆写后 config_json.ai / ai_keys 必须保留', async () => {
  const aiEnv = d1Stub()
  aiEnv.AI_SECRET_MASTER_KEY = MASTER_KEY
  await aiWorker.fetch(req('/api/ai/settings', {
    method: 'PUT',
    body: { timeoutMs: 45000, providers: { domestic: { apiKey: 'sk-preserve' } } }
  }), aiEnv)
  const afterAi = JSON.parse(aiEnv._state.configJson)
  assert.ok(afterAi.ai && afterAi.ai_keys, '前置：AI 配置已写入')

  // 同一份 D1，走主 worker 的 PUT /api/settings 只改 retention
  const mainEnv = { DB: aiEnv.DB }
  const mainRes = await mainWorker.fetch(new Request(`${MAIN_ORIGIN}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ retention: { eventsDays: 7 }, alerts: { enabled: true } })
  }), mainEnv, { waitUntil: async () => {} })
  assert.equal(mainRes.status, 200)

  const preserved = JSON.parse(aiEnv._state.configJson)
  assert.equal(preserved.retention.eventsDays, 7, 'retention 已更新')
  assert.equal(preserved.ai?.timeoutMs, 45000, 'config_json.ai 必须保留')
  assert.ok(preserved.ai_keys, 'config_json.ai_keys 必须保留')

  // 主 worker GET settings 也应正常返回（不吐 ai 内部结构）
  const getRes = await mainWorker.fetch(new Request(`${MAIN_ORIGIN}/api/settings`), mainEnv, { waitUntil: async () => {} })
  const data = await readBody(getRes)
  assert.equal(data.retention.eventsDays, 7)
})
