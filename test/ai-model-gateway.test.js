import assert from 'node:assert/strict'
import test from 'node:test'
import { maskPII } from '../packages/ai/pii.js'
import { createModelGateway, parseJsonOutput, TIMEOUT_MS } from '../packages/ai/model-gateway.js'

test('maskPII 掩码手机号/邮箱/身份证/URL token/密钥/user_id', () => {
  assert.equal(maskPII('联系 13812345678 同志'), '联系 [MASKED_PHONE] 同志')
  assert.equal(maskPII('mail alice@example.com now'), 'mail [MASKED_EMAIL] now')
  assert.equal(maskPII('id 11010519491231002X'), 'id [MASKED_ID]')
  assert.equal(maskPII('?token=abc123&x=1'), '?token=[MASKED]&x=1')
  assert.equal(maskPII('"user_id"="u-42"'), '"user_id"="[MASKED_USER]"')
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.some-signature-value-abcdefghijklmnop'
  assert.ok(!maskPII(jwt).includes('eyJhbGci'), '长 token 应被掩码')
})

test('maskPII 不误伤普通错误文本', () => {
  const t = maskPII('TypeError: Cannot read properties of undefined at app.js:42')
  assert.ok(t.includes('TypeError'))
  assert.ok(t.includes('undefined'))
})

function openaiFetchMock(routes) {
  return async (url, init = {}) => {
    const hit = routes[url] || routes['*']
    if (!hit) return { ok: false, status: 404, text: async () => 'no route', json: async () => ({}) }
    return hit(init)
  }
}

function okJson(content) {
  return { ok: true, status: 200, text: async () => {}, json: async () => ({ choices: [{ message: { content } }] }) }
}

test('MODEL_ORDER 本地不可达自动回退到国内', async () => {
  let domesticCalled = 0
  const env = {
    LOCAL_MODEL_BASE_URL: 'http://localhost:11434/v1',
    DOMESTIC_API_KEY: 'd-key',
    MODEL_ORDER: 'local,domestic,overseas'
  }
  const fetchFn = openaiFetchMock({
    'http://localhost:11434/v1/chat/completions': async () => { throw new Error('ECONNREFUSED') },
    'https://api.deepseek.com/v1/chat/completions': (init) => { domesticCalled++; return okJson('{"summary":"x"}') }
  })
  const gw = createModelGateway(env, { fetchFn })
  const r = await gw.route('sys', 'user')
  assert.equal(r.model, 'domestic:deepseek-chat')
  assert.equal(domesticCalled, 1)
})

test('preferOverseas 直达海外，且海外前 maskPII 脱敏', async () => {
  let seenBody = null
  const env = { OVERSEAS_API_KEY: 'o-key', LOCAL_MODEL_BASE_URL: 'http://localhost:11434/v1' }
  const fetchFn = openaiFetchMock({
    'https://api.openai.com/v1/chat/completions': (init) => { seenBody = JSON.parse(init.body); return okJson('{"summary":"x"}') }
  })
  const gw = createModelGateway(env, { fetchFn })
  const r = await gw.route('sys', '联系 13812345678', { preferOverseas: true })
  assert.equal(r.model, 'overseas:gpt-4o-mini')
  // 海外应强脱敏（user prompt 里的手机号被掩码）
  const sent = seenBody.messages.map(m => m.content).join(' ')
  assert.ok(!sent.includes('13812345678'))
})

test('本地未配置 LOCAL_MODEL_BASE_URL 时被跳过', async () => {
  let domesticCalled = 0
  const env = { DOMESTIC_API_KEY: 'd' } // 无 local base url
  const fetchFn = openaiFetchMock({ 'https://api.deepseek.com/v1/chat/completions': () => { domesticCalled++; return okJson('{"summary":"x"}') } })
  const gw = createModelGateway(env, { fetchFn })
  const r = await gw.route('sys', 'u')
  assert.equal(r.model, 'domestic:deepseek-chat')
  assert.equal(domesticCalled, 1)
})

test('所有 provider 不可达则抛错（调用方转降级响应）', async () => {
  const env = { DOMESTIC_API_KEY: 'd' }
  const fetchFn = openaiFetchMock({ '*': async () => { throw new Error('down') } })
  const gw = createModelGateway(env, { fetchFn })
  await assert.rejects(() => gw.route('sys', 'u'))
})

test('parseJsonOutput 防御性解析（文本包裹 JSON）', () => {
  assert.deepEqual(parseJsonOutput('{"summary":"a"}'), { summary: 'a' })
  assert.deepEqual(parseJsonOutput('好的，结果是 {"summary":"a"} 这样'), { summary: 'a' })
  assert.throws(() => parseJsonOutput('not json'))
})

test('超时最终以错误形式抛出（可被调用方降级）', async () => {
  const env = { DOMESTIC_API_KEY: 'd', MODEL_ORDER: 'domestic', AI_TIMEOUT_MS: 80 } // 仅 domestic + 短超时加速
  const fetchFn = async (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  })
  const gw = createModelGateway(env, { fetchFn })
  const start = Date.now()
  await assert.rejects(() => gw.route('sys', 'u'))
  const elapsed = Date.now() - start
  assert.ok(elapsed >= 70 && elapsed < 500, `应在 80ms 超时窗口抛错，实际 ${elapsed}ms`)
})
