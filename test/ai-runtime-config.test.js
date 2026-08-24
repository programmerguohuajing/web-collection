import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_AI_SETTINGS, normalizeAiSettings, aiSettingsToEnv, maskKey, PROVIDER_ENV_MAP } from '../packages/ai/runtime-config.js'

test('normalize 空对象 → 全默认值', () => {
  const s = normalizeAiSettings({})
  assert.equal(s.modelOrder, 'local,domestic,overseas')
  assert.equal(s.modelFallback, true)
  assert.equal(s.timeoutMs, 30000)
  assert.deepEqual(Object.keys(s.providers).sort(), ['domestic', 'local', 'overseas'])
  for (const p of Object.values(s.providers)) {
    assert.equal(p.baseUrl, '')
    assert.equal(p.modelName, '')
    assert.equal(p.apiFormat, 'openai-chat')
  }
  assert.equal(s.workersAiModel, '@cf/meta/llama-3.3-70b-instruct-fp8-fast')
})

test('normalize 非法 provider 键被剔除；非法 modelOrder 值被过滤', () => {
  const s = normalizeAiSettings({
    modelOrder: 'local,bogus,overseas,workers-ai',
    providers: { local: { baseUrl: ' http://x ', modelName: 'm1' }, evil: { baseUrl: 'http://y' }, domestic: 'not-an-object' }
  })
  assert.ok(!('evil' in s.providers))
  assert.equal(s.providers.local.baseUrl, 'http://x')
  assert.equal(s.modelOrder, 'local,overseas,workers-ai')
  // 全非法 → 默认顺序
  const fallback = normalizeAiSettings({ modelOrder: 'a,b,c' })
  assert.equal(fallback.modelOrder, DEFAULT_AI_SETTINGS.modelOrder)
})

test('timeoutMs clamp 边界：4000→5000、150000→120000；非数字→默认', () => {
  assert.equal(normalizeAiSettings({ timeoutMs: 4000 }).timeoutMs, 5000)
  assert.equal(normalizeAiSettings({ timeoutMs: 150000 }).timeoutMs, 120000)
  assert.equal(normalizeAiSettings({ timeoutMs: 45000 }).timeoutMs, 45000)
  assert.equal(normalizeAiSettings({ timeoutMs: 'abc' }).timeoutMs, 30000)
  assert.equal(normalizeAiSettings({ timeoutMs: null }).timeoutMs, 30000)
})

test('toEnv 映射正确性（A1 表全字段）', () => {
  const env = aiSettingsToEnv({
    modelOrder: 'workers-ai,domestic',
    timeoutMs: 45000,
    workersAiModel: '@cf/qwen/qwen2.5-coder-32b-instruct',
    providers: {
      local: { baseUrl: 'http://192.168.1.5:11434/v1', modelName: 'deepseek-r1:8b', apiFormat: 'openai-chat' },
      domestic: { baseUrl: 'https://api.deepseek.com/v1', modelName: 'deepseek-chat', apiKey: 'sk-d', apiFormat: 'anthropic-messages' },
      overseas: { baseUrl: 'https://api.anthropic.com', modelName: 'claude-sonnet-4-5', apiFormat: 'anthropic-messages' }
    }
  })
  assert.deepEqual(env, {
    MODEL_ORDER: 'workers-ai,domestic',
    AI_TIMEOUT_MS: '45000',
    WORKERS_AI_MODEL: '@cf/qwen/qwen2.5-coder-32b-instruct',
    LOCAL_MODEL_BASE_URL: 'http://192.168.1.5:11434/v1',
    LOCAL_MODEL_NAME: 'deepseek-r1:8b',
    LOCAL_API_FORMAT: 'openai-chat',
    DOMESTIC_BASE_URL: 'https://api.deepseek.com/v1',
    DOMESTIC_MODEL_NAME: 'deepseek-chat',
    DOMESTIC_API_KEY: 'sk-d',
    DOMESTIC_API_FORMAT: 'anthropic-messages',
    OVERSEAS_BASE_URL: 'https://api.anthropic.com',
    OVERSEAS_MODEL_NAME: 'claude-sonnet-4-5',
    OVERSEAS_API_FORMAT: 'anthropic-messages'
  })
})

test('toEnv 空/未配置字段不产键（不覆盖 env）', () => {
  const env = aiSettingsToEnv({
    providers: {
      local: { baseUrl: '', modelName: '', apiFormat: '' },
      domestic: {},
      overseas: { apiKey: '' }
    }
  })
  assert.deepEqual(env, {})
  // 非法 apiFormat 不产键
  const bad = aiSettingsToEnv({ providers: { overseas: { apiFormat: 'ftp' } } })
  assert.deepEqual(bad, {})
})

test('toEnv modelFallback:false → MODEL_FALLBACK=off；true/缺省不产键', () => {
  assert.deepEqual(aiSettingsToEnv({ modelFallback: false }), { MODEL_FALLBACK: 'off' })
  assert.deepEqual(aiSettingsToEnv({ modelFallback: true }), {})
  assert.deepEqual(aiSettingsToEnv({}), {})
})

test('maskKey 三分支', () => {
  assert.equal(maskKey(''), '')
  assert.equal(maskKey(null), '')
  assert.equal(maskKey('short'), '••••')
  assert.equal(maskKey('12345678'), '••••5678')
  assert.equal(maskKey('sk-abcdef123456'), '••••3456')
})

test('PROVIDER_ENV_MAP 覆盖 A1 全部映射且无重复 env 键', () => {
  const values = Object.values(PROVIDER_ENV_MAP)
  assert.equal(new Set(values).size, values.length)
  for (const key of ['LOCAL_MODEL_BASE_URL', 'LOCAL_MODEL_API_KEY', 'DOMESTIC_BASE_URL', 'DOMESTIC_API_KEY', 'OVERSEAS_BASE_URL', 'OVERSEAS_API_KEY', 'WORKERS_AI_MODEL', 'LOCAL_API_FORMAT', 'DOMESTIC_API_FORMAT', 'OVERSEAS_API_FORMAT']) {
    assert.ok(values.includes(key), `缺少 ${key}`)
  }
})
