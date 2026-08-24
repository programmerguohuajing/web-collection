/**
 * @file AI 设置 ↔ gateway env 映射（Web 配置持久化到 D1 后的运行时合成）
 *
 * DB(ai) > env > 代码默认：normalizeAiSettings 归一库中配置，
 * aiSettingsToEnv 把配置翻译成 model-gateway 认识的 env 键，由调用方覆盖合并。
 */

export const VALID_PROVIDERS = ['local', 'domestic', 'overseas']
export const VALID_ORDER = [...VALID_PROVIDERS, 'workers-ai']
export const API_FORMATS = ['openai-chat', 'anthropic-messages', 'openai-responses', 'gemini-generatecontent']

export const DEFAULT_AI_SETTINGS = {
  modelOrder: 'local,domestic,overseas',
  modelFallback: true,
  timeoutMs: 30000,
  providers: { local: {}, domestic: {}, overseas: {} },
  workersAiModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
}

export const PROVIDER_ENV_MAP = {
  'local.baseUrl': 'LOCAL_MODEL_BASE_URL',
  'local.modelName': 'LOCAL_MODEL_NAME',
  'local.apiKey': 'LOCAL_MODEL_API_KEY',
  'local.apiFormat': 'LOCAL_API_FORMAT',
  'domestic.baseUrl': 'DOMESTIC_BASE_URL',
  'domestic.modelName': 'DOMESTIC_MODEL_NAME',
  'domestic.apiKey': 'DOMESTIC_API_KEY',
  'domestic.apiFormat': 'DOMESTIC_API_FORMAT',
  'overseas.baseUrl': 'OVERSEAS_BASE_URL',
  'overseas.modelName': 'OVERSEAS_MODEL_NAME',
  'overseas.apiKey': 'OVERSEAS_API_KEY',
  'overseas.apiFormat': 'OVERSEAS_API_FORMAT',
  workersAiModel: 'WORKERS_AI_MODEL'
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 深合并默认值 + trim + clamp timeout[5000,120000] + 丢弃非法键 */
export function normalizeAiSettings(input = {}) {
  const raw = input && typeof input === 'object' ? input : {}
  const order = cleanString(raw.modelOrder).split(',').map(s => s.trim()).filter(p => VALID_ORDER.includes(p))
  const timeoutRaw = Number(raw.timeoutMs)
  const timeout = Number.isFinite(timeoutRaw) && timeoutRaw > 0
    ? Math.min(120000, Math.max(5000, Math.round(timeoutRaw)))
    : DEFAULT_AI_SETTINGS.timeoutMs
  const providers = {}
  for (const name of VALID_PROVIDERS) {
    const p = raw.providers?.[name]
    providers[name] = p && typeof p === 'object'
      ? {
          baseUrl: cleanString(p.baseUrl).slice(0, 500),
          modelName: cleanString(p.modelName).slice(0, 128),
          apiFormat: API_FORMATS.includes(p.apiFormat) ? p.apiFormat : 'openai-chat'
        }
      : { baseUrl: '', modelName: '', apiFormat: 'openai-chat' }
  }
  return {
    modelOrder: order.length ? order.join(',') : DEFAULT_AI_SETTINGS.modelOrder,
    modelFallback: typeof raw.modelFallback === 'boolean' ? raw.modelFallback : true,
    timeoutMs: timeout,
    providers,
    workersAiModel: (cleanString(raw.workersAiModel) || DEFAULT_AI_SETTINGS.workersAiModel).slice(0, 128)
  }
}

/** 配置 → env 键值；仅显式非空配置才产键（不覆盖 env 与代码默认）；modelFallback=false → MODEL_FALLBACK='off' */
export function aiSettingsToEnv(settings) {
  const out = {}
  const raw = settings && typeof settings === 'object' ? settings : {}
  for (const [path, envKey] of Object.entries(PROVIDER_ENV_MAP)) {
    const dot = path.indexOf('.')
    let value
    if (dot < 0) value = raw[path]
    else {
      const [provider, field] = [path.slice(0, dot), path.slice(dot + 1)]
      value = raw.providers?.[provider]?.[field]
    }
    if (typeof value !== 'string' || !value.trim()) continue
    if (path.endsWith('.apiFormat') && !API_FORMATS.includes(value)) continue
    out[envKey] = value.trim()
  }
  if (typeof raw.modelOrder === 'string') {
    const order = raw.modelOrder.split(',').map(s => s.trim()).filter(p => VALID_ORDER.includes(p))
    if (order.length) out.MODEL_ORDER = order.join(',')
  }
  const timeoutRaw = Number(raw.timeoutMs)
  if (Number.isFinite(timeoutRaw) && timeoutRaw > 0) out.AI_TIMEOUT_MS = String(Math.round(timeoutRaw))
  if (raw.modelFallback === false) out.MODEL_FALLBACK = 'off'
  return out
}

export function maskKey(key) {
  const text = String(key || '')
  if (!text) return ''
  return text.length >= 8 ? `••••${text.slice(-4)}` : '••••'
}
