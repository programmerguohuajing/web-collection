/**
 * @file AI 设置读写/探活/模型列表（Node + PostgreSQL 后端）
 *
 * 与 cloudflare/ai-worker.js 的 settings 四端点行为对齐：
 *   GET  /api/ai/settings        归一化 + 脱敏 + effectiveSource 来源标注
 *   PUT  /api/ai/settings        校验 → key 三分支 → AES-GCM 加密 → 读-合-写
 *   POST /api/ai/settings/test   用「待保存配置」并行探活各 provider
 *   POST /api/ai/settings/models 拉取单 provider 模型列表
 *
 * 存储复用 platform_settings(id=1, config_json jsonb)；加密与 CF 共用
 * ALERT_SECRET_MASTER_KEY + packages/alerting.js（WebCrypto AES-GCM，双后端兼容）。
 */
import { Router } from 'express'
import { encryptSecrets, decryptSecrets } from '../../../packages/alerting.js'
import { normalizeAiSettings, aiSettingsToEnv, maskKey } from '../../../packages/ai/runtime-config.js'
import { createModelGateway } from '../../../packages/ai/model-gateway.js'
import { sameProviderOrigin, validateProviderBaseUrl } from '../../../packages/ai/provider-security.js'
import { first, run } from './db.js'

const PROVIDER_NAMES = ['local', 'domestic', 'overseas']
const MODEL_LIST_FORMATS = ['openai-chat', 'openai-responses', 'anthropic-messages', 'gemini-generatecontent']
const SOURCE_FIELDS = [
  ['modelOrder', 'MODEL_ORDER'],
  ['timeoutMs', 'AI_TIMEOUT_MS'],
  ['workersAiModel', 'WORKERS_AI_MODEL']
]

const masterKey = () => process.env.ALERT_SECRET_MASTER_KEY || ''
const invalid = message => { throw Object.assign(new Error(message), { status: 400 }) }

function parseConfig(configJson) {
  if (configJson && typeof configJson === 'object') return configJson
  try { return JSON.parse(String(configJson || '{}')) } catch { return {} }
}

async function readAiSettingsRaw() {
  try {
    const row = await first(`select config_json from platform_settings where id=1`)
    const config = parseConfig(row?.config_json)
    let keys = {}
    let keysError = ''
    try { keys = await decryptSecrets(config.ai_keys, masterKey()) } catch (error) { keysError = String(error?.message || error) }
    return {
      source: config.ai && typeof config.ai === 'object' ? config.ai : {},
      keys: keys && typeof keys === 'object' ? keys : {},
      keysError
    }
  } catch (error) {
    console.error('readAiSettingsRaw failed:', String(error?.message || error))
    return { source: {}, keys: {}, keysError: '' }
  }
}

/** GET：归一化 + 脱敏 + effectiveSource（逐字段标注 db/env/default 来源） */
export async function readAiSettings() {
  const env = process.env
  const { source, keys } = await readAiSettingsRaw()
  const normalized = normalizeAiSettings(source)
  const dbEnvKeys = new Set(Object.keys(aiSettingsToEnv(source)))
  const effectiveSource = {}

  const sourceOf = envKey => dbEnvKeys.has(envKey) ? 'db' : (env[envKey] ? 'env' : 'default')
  for (const [field, envKey] of SOURCE_FIELDS) effectiveSource[field] = sourceOf(envKey)
  effectiveSource.modelFallback = normalized.modelFallback === false
    ? 'db'
    : String(env.MODEL_FALLBACK ?? '').toLowerCase() === 'off' ? 'env' : 'default'

  const providers = {}
  for (const name of PROVIDER_NAMES) {
    const p = normalized.providers[name]
    const prefix = name === 'local' ? 'LOCAL_MODEL' : name.toUpperCase()
    providers[name] = {
      baseUrl: p.baseUrl,
      modelName: p.modelName,
      apiFormat: p.apiFormat,
      hasKey: Boolean(keys[name]),
      keyMask: maskKey(keys[name])
    }
    effectiveSource[`providers.${name}.baseUrl`] = dbEnvKeys.has(`${prefix}_BASE_URL`) ? 'db' : (env[`${prefix}_BASE_URL`] ? 'env' : 'default')
    effectiveSource[`providers.${name}.modelName`] = dbEnvKeys.has(`${prefix}_MODEL_NAME`) ? 'db' : (env[`${prefix}_MODEL_NAME`] ? 'env' : 'default')
    effectiveSource[`providers.${name}.apiKey`] = keys[name] ? 'db' : (env[`${prefix}_API_KEY`] ? 'env' : 'none')
    effectiveSource[`providers.${name}.apiFormat`] = dbEnvKeys.has(`${prefix}_API_FORMAT`) ? 'db' : (env[`${prefix}_API_FORMAT`] ? 'env' : 'default')
  }

  return {
    modelOrder: normalized.modelOrder,
    modelFallback: normalized.modelFallback,
    timeoutMs: normalized.timeoutMs,
    workersAiModel: normalized.workersAiModel,
    providers,
    effectiveSource
  }
}

/** PUT：校验 → key 三分支处理 → AES-GCM 加密 → 读-合-写 upsert → 返回脱敏结果 */
export async function saveAiSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('请求体必须是对象')

  // modelOrder 严格校验：出现即必须全为合法值且至少一项
  if (input.modelOrder !== undefined) {
    const tokens = String(input.modelOrder).split(',').map(s => s.trim()).filter(Boolean)
    if (!tokens.length || !tokens.every(t => ['local', 'domestic', 'overseas', 'workers-ai'].includes(t))) {
      invalid('modelOrder 只能包含 local/domestic/overseas/workers-ai 且至少一项')
    }
  }
  for (const name of PROVIDER_NAMES) {
    const url = input.providers?.[name]?.baseUrl
    if (typeof url === 'string' && url.trim()) {
      try { validateProviderBaseUrl(url, { allowPrivate: name === 'local' }) } catch (error) { invalid(`${name}.baseUrl: ${error.message}`) }
    }
  }

  const { source, keys: existingKeys } = await readAiSettingsRaw()

  // apiKey 三分支：undefined/null/'' 或 •••• 前缀 → 保留库中现有值；其他非空 → 新 key
  const mergedKeys = { ...existingKeys }
  let hasNewKey = false
  for (const name of PROVIDER_NAMES) {
    const incoming = input.providers?.[name]?.apiKey
    const incomingUrl = input.providers?.[name]?.baseUrl?.trim() || ''
    const previousUrl = source?.providers?.[name]?.baseUrl || ''
    const hasExplicitKey = typeof incoming === 'string' && incoming.trim() && !incoming.startsWith('••••')
    if (hasExplicitKey) {
      mergedKeys[name] = incoming.trim()
      hasNewKey = true
    } else if (incomingUrl && (!previousUrl || !sameProviderOrigin(incomingUrl, previousUrl))) {
      // Provider 域名变化时清除旧密钥，禁止旧凭据自动跟随到新主机。
      delete mergedKeys[name]
    }
  }
  if (hasNewKey && !masterKey()) {
    throw Object.assign(new Error('ALERT_SECRET_MASTER_KEY 未配置，无法保存密钥'), { status: 503 })
  }

  const normalized = normalizeAiSettings(input)
  try {
    const config = parseConfig((await first(`select config_json from platform_settings where id=1`))?.config_json)
    config.ai = normalized
    config.ai_keys_v = 1
    if (Object.keys(mergedKeys).length) {
      if (masterKey()) {
        config.ai_keys = await encryptSecrets(mergedKeys, masterKey())
      }
    } else {
      delete config.ai_keys
    }
    const now = Date.now()
    await run(
      `insert into platform_settings(id,config_json,updated_at) values(1,?::jsonb,?)
       on conflict(id) do update set config_json=excluded.config_json,updated_at=excluded.updated_at`,
      [JSON.stringify(config), now]
    )
  } catch (error) {
    if (error?.status) throw error
    console.error('saveAiSettings failed:', String(error?.stack || error?.message || error))
    throw Object.assign(new Error(`保存 AI 设置失败: ${error?.message || error}`), { status: 500 })
  }
  return readAiSettings()
}

/** POST /settings/test：用「待保存配置」对 order 内每个 provider + workers-ai 并行发最小请求 */
export async function testAiSettings(input) {
  const env = process.env
  const normalized = normalizeAiSettings(input)
  const { source, keys } = await readAiSettingsRaw()
  // 合成待测配置：显式表单 key 优先；Base URL 换域名时绝不自动复用已保存 key。
  const merged = {
    ...normalized,
    providers: Object.fromEntries(PROVIDER_NAMES.map(name => {
      const rawKey = input.providers?.[name]?.apiKey?.trim() || ''
      const incomingKey = rawKey && !rawKey.startsWith('••••') ? rawKey : ''
      const incomingUrl = input.providers?.[name]?.baseUrl?.trim() || ''
      if (incomingUrl) validateProviderBaseUrl(incomingUrl, { allowPrivate: name === 'local' })
      const savedUrl = source?.providers?.[name]?.baseUrl || ''
      const canReuse = !incomingUrl || (savedUrl && sameProviderOrigin(incomingUrl, savedUrl))
      return [name, { ...normalized.providers[name], apiKey: incomingKey || (canReuse ? keys[name] || '' : '') }]
    }))
  }
  const effectiveEnv = { ...env, ...aiSettingsToEnv(merged) }
  const gateway = createModelGateway(effectiveEnv)

  let names = [...normalized.modelOrder.split(',').map(s => s.trim()).filter(Boolean)]
  const targetProvider = String(input.targetProvider || '').trim()
  if (targetProvider) {
    names = [targetProvider]
  } else if (normalized.modelFallback !== false && !names.includes('workers-ai')) {
    names.push('workers-ai')
  }

  const probes = names.map(async name => {
    const start = Date.now()
    try {
      const provider = gateway.providers[name]
      if (!provider) return [name, { ok: false, error: '未知 provider' }]
      const ctrl = new AbortController()
      // 推理模型（r1/qwen3）首 token 前思考链较长，10s 常误报超时；放宽到 20s
      const timer = setTimeout(() => ctrl.abort(), 20000)
      try {
        await provider([{ role: 'user', content: '回复ok' }], ctrl.signal)
        clearTimeout(timer)
        return [name, { ok: true, latencyMs: Date.now() - start }]
      } catch (error) {
        clearTimeout(timer)
        const message = error?.name === 'AbortError' ? '超时(20s)' : String(error?.message || error)
        return [name, { ok: false, error: message.slice(0, 80), latencyMs: Date.now() - start }]
      }
    } catch (error) {
      return [name, { ok: false, error: String(error?.message || error).slice(0, 80), latencyMs: Date.now() - start }]
    }
  })
  const results = Object.fromEntries(await Promise.all(probes))

  return { results }
}

/** POST /settings/models：拉取单个 provider 的模型列表（apiKey 空时回落库中密钥） */
export async function listProviderModels(input) {
  const env = process.env
  const name = String(input.provider || '')
  if (!['local', 'domestic', 'overseas'].includes(name)) {
    throw Object.assign(new Error('provider 必须是 local/domestic/overseas（workers-ai 不支持列表）'), { status: 400 })
  }
  const prefix = name === 'local' ? 'LOCAL_MODEL' : name.toUpperCase()
  const requestedBaseURL = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : ''
  const baseURL = requestedBaseURL || env[`${prefix}_BASE_URL`] || ''
  if (!baseURL) return { ok: false, error: 'baseUrl 未配置' }
  try { validateProviderBaseUrl(baseURL, { allowPrivate: name === 'local' }) } catch (error) { return { ok: false, error: error.message } }

  const apiFormat = MODEL_LIST_FORMATS.includes(input.apiFormat) ? input.apiFormat : 'openai-chat'
  const { source, keys } = await readAiSettingsRaw()
  const explicitKey = typeof input.apiKey === 'string' && input.apiKey.trim() && !input.apiKey.startsWith('••••') ? input.apiKey.trim() : ''
  const trustedBaseURL = source?.providers?.[name]?.baseUrl || env[`${prefix}_BASE_URL`] || ''
  const canReuseStoredKey = !requestedBaseURL || (trustedBaseURL && sameProviderOrigin(requestedBaseURL, trustedBaseURL))
  let apiKey = explicitKey || (canReuseStoredKey ? (keys[name] || env[`${prefix}_API_KEY`] || '') : '')

  const base = baseURL.replace(/\/$/, '')
  const headers = {}
  let url

  if (apiFormat === 'anthropic-messages') {
    url = `${base}/v1/models`
    headers['anthropic-version'] = '2023-06-01'
    if (apiKey) headers['x-api-key'] = apiKey
  } else if (apiFormat === 'gemini-generatecontent') {
    url = `${base}/v1beta/models${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}`
  } else {
    url = `${base}/models`
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: ctrl.signal })
    if (!res.ok) {
      return { ok: false, error: `${res.status} ${(await res.text()).slice(0, 80)}`.trim().slice(0, 120) }
    }
    const data = await res.json()
    let models = []
    if (apiFormat === 'anthropic-messages') models = Array.isArray(data?.data) ? data.data.map(m => m?.id).filter(Boolean) : []
    else if (apiFormat === 'gemini-generatecontent') models = Array.isArray(data?.models) ? data.models.map(m => String(m?.name || '').replace(/^models\//, '')).filter(Boolean) : []
    else models = Array.isArray(data?.data) ? data.data.map(m => m?.id).filter(Boolean) : []
    return { ok: true, models: models.sort() }
  } catch (error) {
    const message = error?.name === 'AbortError' ? '超时(8s)' : String(error?.message || error)
    return { ok: false, error: message.slice(0, 120) }
  } finally {
    clearTimeout(timer)
  }
}

/** 挂载到 /api/ai 下（settings 管理面三端点沿用外层鉴权中间件） */
export function settingsRouter() {
  const router = Router()
  router.use((req, res, next) => {
    const auth = req.auth
    const allowed = auth?.via === 'api_key' || (auth?.via === 'session' && ['owner', 'admin'].includes(auth.role) && auth.level === 'L4')
    if (!allowed) return res.status(auth ? 403 : 401).json({ error: 'AI 设置仅限管理员访问' })
    next()
  })
  const handle = fn => async (req, res) => {
    try {
      res.json(await fn(req, res))
    } catch (err) {
      const status = Number(err?.status || err?.statusCode) || 500
      res.status(status).json({ message: err?.message || '服务器内部错误', error: err?.message || 'error' })
    }
  }
  router.get('/settings', handle(req => readAiSettings()))
  router.put('/settings', handle(req => saveAiSettings(req.body)))
  router.post('/settings/test', handle(req => testAiSettings(req.body)))
  router.post('/settings/models', handle(req => listProviderModels(req.body)))
  return router
}
