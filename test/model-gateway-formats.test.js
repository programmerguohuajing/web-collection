import assert from 'node:assert/strict'
import test from 'node:test'
import { createModelGateway } from '../packages/ai/model-gateway.js'

/** 捕获一次请求并返回指定 JSON 响应 */
function captureFetch(responseBody, status = 200) {
  const calls = []
  const fn = async (url, init = {}) => {
    calls.push({ url, headers: init.headers || {}, body: typeof init.body === 'string' ? JSON.parse(init.body) : null })
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(responseBody), json: async () => responseBody }
  }
  fn.calls = calls
  return fn
}

test('anthropic-messages：URL/鉴权头/system 提升/messages 转换/content 提取', async () => {
  const fetchFn = captureFetch({ content: [{ type: 'text', text: '{"summary":"ok"}' }] })
  const gw = createModelGateway({
    OVERSEAS_BASE_URL: 'https://api.anthropic.com',
    OVERSEAS_MODEL_NAME: 'claude-sonnet-4-5',
    OVERSEAS_API_KEY: 'ak-test',
    OVERSEAS_API_FORMAT: 'anthropic-messages',
    MODEL_ORDER: 'overseas',
    MODEL_FALLBACK: 'off'
  }, { fetchFn })
  const r = await gw.route('你是诊断助手', '分析这个错误')
  assert.equal(r.provider, 'overseas')
  const call = fetchFn.calls[0]
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages')
  assert.equal(call.headers['x-api-key'], 'ak-test')
  assert.equal(call.headers['anthropic-version'], '2023-06-01')
  assert.equal(call.body.system, '你是诊断助手')
  assert.deepEqual(call.body.messages, [{ role: 'user', content: '分析这个错误' }])
  assert.equal(call.body.model, 'claude-sonnet-4-5')
  assert.ok(!JSON.stringify(call.body).includes('"role":"system"'))
  assert.equal(r.content, '{"summary":"ok"}')
})

test('openai-responses：URL/output_text 提取', async () => {
  const fetchFn = captureFetch({ output_text: '{"summary":"resp"}', output: [] })
  const gw = createModelGateway({
    DOMESTIC_BASE_URL: 'https://api.example.com/v1',
    DOMESTIC_MODEL_NAME: 'gpt-5.1-mini',
    DOMESTIC_API_KEY: 'sk-r',
    DOMESTIC_API_FORMAT: 'openai-responses',
    MODEL_ORDER: 'domestic',
    MODEL_FALLBACK: 'off'
  }, { fetchFn })
  const r = await gw.route('sys', 'user msg')
  const call = fetchFn.calls[0]
  assert.equal(call.url, 'https://api.example.com/v1/responses')
  assert.equal(call.headers.authorization, 'Bearer sk-r')
  assert.deepEqual(call.body.input, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'user msg' }])
  assert.equal(call.body.max_output_tokens, 2048)
  assert.equal(r.content, '{"summary":"resp"}')
})

test('openai-responses：无 output_text 时遍历 output[].content[].text 拼接', async () => {
  const fetchFn = captureFetch({
    output: [
      { content: [{ type: 'output_text', text: '{"a"' }, { type: 'output_text', text: ':1}' }] },
      { content: [] }
    ]
  })
  const gw = createModelGateway({
    DOMESTIC_BASE_URL: 'https://api.example.com/v1',
    DOMESTIC_API_FORMAT: 'openai-responses',
    MODEL_ORDER: 'domestic',
    MODEL_FALLBACK: 'off'
  }, { fetchFn })
  const r = await gw.route('s', 'u')
  assert.equal(r.content, '{"a":1}')
})

test('gemini-generatecontent：URL?key=/contents/systemInstruction/candidates 提取', async () => {
  const fetchFn = captureFetch({ candidates: [{ content: { parts: [{ text: '{"g"' }, { text: ':2}'}] } }] })
  const gw = createModelGateway({
    OVERSEAS_BASE_URL: 'https://generativelanguage.googleapis.com',
    OVERSEAS_MODEL_NAME: 'gemini-2.5-flash',
    OVERSEAS_API_KEY: 'gm-key',
    OVERSEAS_API_FORMAT: 'gemini-generatecontent',
    MODEL_ORDER: 'overseas',
    MODEL_FALLBACK: 'off'
  }, { fetchFn })
  const r = await gw.route('系统提示', '用户问题')
  const call = fetchFn.calls[0]
  assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=gm-key')
  assert.deepEqual(call.body.contents, [{ role: 'user', parts: [{ text: '用户问题' }] }])
  assert.deepEqual(call.body.systemInstruction, { parts: [{ text: '系统提示' }] })
  assert.equal(r.content, '{"g":2}')
})

test('未设 API_FORMAT 时保持 openai-chat 兼容（现有行为不变）', async () => {
  const fetchFn = captureFetch({ choices: [{ message: { content: '{"summary":"x"}' } }] })
  const gw = createModelGateway({
    DOMESTIC_BASE_URL: 'https://api.deepseek.com/v1',
    DOMESTIC_API_KEY: 'd',
    MODEL_ORDER: 'domestic',
    MODEL_FALLBACK: 'off'
  }, { fetchFn })
  const r = await gw.route('s', 'u')
  const call = fetchFn.calls[0]
  assert.equal(call.url, 'https://api.deepseek.com/v1/chat/completions')
  assert.equal(call.body.response_format.type, 'json_object')
  assert.equal(r.content, '{"summary":"x"}')
})

test('非法 API_FORMAT 回落 openai-chat', async () => {
  const fetchFn = captureFetch({ choices: [{ message: { content: 'ok' } }] })
  const gw = createModelGateway({
    DOMESTIC_BASE_URL: 'https://x/v1',
    DOMESTIC_API_FORMAT: 'ftp',
    MODEL_ORDER: 'domestic',
    MODEL_FALLBACK: 'off'
  }, { fetchFn })
  await gw.route('s', 'u')
  assert.ok(fetchFn.calls[0].url.endsWith('/chat/completions'))
})

test('上游非 200 时抛错并可回退下一个 provider', async () => {
  let fallbackHit = false
  const failingFetch = async () => ({ ok: false, status: 401, text: async () => 'unauthorized', json: async () => ({}) })
  const gw = createModelGateway({
    OVERSEAS_BASE_URL: 'https://api.anthropic.com',
    OVERSEAS_API_KEY: 'bad',
    OVERSEAS_API_FORMAT: 'anthropic-messages',
    DOMESTIC_BASE_URL: 'https://api.deepseek.com/v1',
    MODEL_ORDER: 'overseas,domestic',
    MODEL_FALLBACK: 'off'
  }, {
    fetchFn: async (url, init) => (String(url).includes('anthropic') ? failingFetch(url, init) : (fallbackHit = true, captureFetch({ choices: [{ message: { content: 'fb' } }] })(url, init)))
  })
  const r = await gw.route('s', 'u')
  assert.ok(fallbackHit)
  assert.equal(r.provider, 'domestic')
})
