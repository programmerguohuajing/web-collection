import assert from 'node:assert/strict'
import test from 'node:test'
import aiWorker from '../cloudflare/ai-worker.js'

const ORIGIN = 'https://ai.example.com'

/** 通用 D1 stub：settings 表持久化；其余查询返回空 */
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

const originalFetch = globalThis.fetch
test.afterEach(() => { globalThis.fetch = originalFetch })

function jsonResponse(value, status = 200) {
  const body = JSON.stringify(value)
  return { ok: status >= 200 && status < 300, status, text: async () => body, json: async () => value }
}

test('buildDeps：DB 配置 modelOrder=domestic 覆盖 env 的 local-only', async t => {
  let hitUrl = ''
  globalThis.fetch = async (url, init = {}) => {
    hitUrl = String(url)
    return jsonResponse({ choices: [{ message: { content: '{"summary":"ok","rootCause":"x","suggestions":["y"]}' } }] })
  }
  // env 只配了 local 通道（无 baseUrl，实际不可用）；DB 配置指向 domestic
  const env = d1Stub(JSON.stringify({
    retention: {},
    alerts: {},
    ai: { modelOrder: 'domestic', modelFallback: false, timeoutMs: 30000, providers: { domestic: { baseUrl: 'https://api.deepseek.com/v1', modelName: 'deepseek-chat', apiFormat: 'openai-chat' } }, workersAiModel: '' }
  }))
  env.MODEL_ORDER = 'local'
  delete env.AI

  const res = await aiWorker.fetch(new Request(`${ORIGIN}/api/ai/diagnose/error`, {
    method: 'POST',
    body: JSON.stringify({ type: 'error', errorText: 'TypeError: boom at app.js:1' })
  }), env, { waitUntil: async () => {} })
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.provider, 'domestic', '应按 DB 配置走 domestic')
  assert.equal(hitUrl, 'https://api.deepseek.com/v1/chat/completions')

  // 二次请求命中缓存也不影响断言（refId 相同）——换文本避免缓存
  const res2 = await aiWorker.fetch(new Request(`${ORIGIN}/api/ai/diagnose/error`, {
    method: 'POST',
    body: JSON.stringify({ type: 'error', errorText: 'Another error ' + Math.random() })
  }), env, { waitUntil: async () => {} })
  const data2 = await res2.json()
  assert.equal(data2.provider, 'domestic')
})

const CHAT_OK = '{"summary":"fb","rootCause":"c","suggestions":[]}'
// Workers AI 绑定 stub：embedding 调用({text})与 chat 调用({messages})按参数形状分发
const AI_BINDING_STUB = {
  async run(model, input) {
    if (input && 'text' in input) return { data: [Array(8).fill(0.1)] }
    if (String(model).includes('baai')) return { data: [Array(8).fill(0.1)] }
    return { choices: [{ message: { content: CHAT_OK } }] }
  }
}

const KB_INDEX_STUB = {
  query: async () => ({ matches: [] }),
  upsert: async () => {},
  deleteByIds: async () => {}
}

test('buildDeps：settings 内容损坏时回落纯 env，诊断不中断（workers-ai 兜底）', async t => {
  // settings 行存在但 config_json 非法：读配置失败必须吞掉，不能影响诊断
  const state = { configJson: 'not-valid-json{{{' }
  const env = {
    DB: {
      prepare(sql) {
        return {
          values: [],
          bind() { return this },
          async first() { return /select config_json from settings/.test(sql) ? { config_json: state.configJson } : null },
          async run() { return { meta: {} } },
          async all() { return { results: [] } }
        }
      }
    },
    AI: AI_BINDING_STUB,
    AI_KB: KB_INDEX_STUB,
    MODEL_ORDER: 'workers-ai',
    MODEL_FALLBACK: 'off'
  }
  const res = await aiWorker.fetch(new Request(`${ORIGIN}/api/ai/diagnose/error`, {
    method: 'POST',
    body: JSON.stringify({ type: 'error', errorText: 'TypeError: boom2 at app.js:2' })
  }), env, { waitUntil: async () => {} })
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.provider, 'workers-ai')
})

test('buildDeps：密文损坏（masterKey 不匹配）时同样回落 env 而非报错', async t => {
  const goodStub = d1Stub(JSON.stringify({ retention: {}, alerts: {}, ai_keys: 'AAAA.BBBB' }))
  const env = {
    DB: goodStub.DB,
    AI: AI_BINDING_STUB,
    AI_KB: KB_INDEX_STUB,
    MODEL_ORDER: 'workers-ai',
    MODEL_FALLBACK: 'off'
  }
  const res = await aiWorker.fetch(new Request(`${ORIGIN}/api/ai/diagnose/error`, {
    method: 'POST',
    body: JSON.stringify({ type: 'error', errorText: 'TypeError: boom3 at app.js:3' })
  }), env, { waitUntil: async () => {} })
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.provider, 'workers-ai')
})
