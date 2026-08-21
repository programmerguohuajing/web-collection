/**
 * @file 混合 Model Gateway（ADR-004）
 *
 * provider 可插拔：本地 Ollama（OpenAI 兼容端点）/ 国内 / 海外。
 * 路由顺序由 env.MODEL_ORDER 配置（默认 local,domestic,overseas）：
 *   本地不可达（ECONNREFUSED/超时）自动回退国内/海外；海外前强脱敏 maskPII。
 * 显式 preferOverseas 可直达海外。统一 messages → JSON 输出。
 */
import { maskPII } from './pii.js'

const DEFAULT_ORDER = ['local', 'domestic', 'overseas']
export const TIMEOUT_MS = 8000
export const MAX_TOKENS = 2048

/** 统一 OpenAI 兼容 chat/completions 调用（local/Ollama 与 domestic/overseas 兼容 hub 均适用） */
async function callOpenAICompat(fetchFn, baseURL, model, apiKey, messages, { signal, jsonMode = true } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  const body = { model, messages, max_tokens: MAX_TOKENS, temperature: 0.2, stream: false }
  if (jsonMode) body.response_format = { type: 'json_object' }
  const res = await fetchFn(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', headers, body: JSON.stringify(body), signal
  })
  if (!res.ok) throw new Error(`llm http ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new Error('llm 响应无 content')
  return content
}

/** 构造 gateway。env 需含 provider 配置；fetchFn 便于单测注入。 */
export function createModelGateway(env = {}, { fetchFn = fetch } = {}) {
  const rawFetch = fetchFn
  const providers = {
    local: async (messages, signal) => {
      const baseURL = env.LOCAL_MODEL_BASE_URL
      if (!baseURL) throw new Error('local provider 未配置 LOCAL_MODEL_BASE_URL')
      return callOpenAICompat(rawFetch, baseURL, env.LOCAL_MODEL_NAME || 'deepseek-v3', env.LOCAL_MODEL_API_KEY || '', messages, { signal })
    },
    domestic: async (messages, signal) => {
      return callOpenAICompat(rawFetch, env.DOMESTIC_BASE_URL || 'https://api.deepseek.com/v1', env.DOMESTIC_MODEL_NAME || 'deepseek-chat', env.DOMESTIC_API_KEY, messages, { signal })
    },
    overseas: async (messages, signal) => {
      return callOpenAICompat(rawFetch, env.OVERSEAS_BASE_URL || 'https://api.openai.com/v1', env.OVERSEAS_MODEL_NAME || 'gpt-4o-mini', env.OVERSEAS_API_KEY, messages, { signal })
    }
  }

  function orderOf(preferOverseas) {
    const configured = (env.MODEL_ORDER || DEFAULT_ORDER.join(',')).split(',').map(s => s.trim()).filter(Boolean)
    if (preferOverseas) return ['overseas', ...configured.filter(p => p !== 'overseas')]
    return configured.length ? configured : DEFAULT_ORDER
  }

  async function route(systemPrompt, userPrompt, { preferOverseas = false, jsonMode = true } = {}) {
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
    const order = orderOf(preferOverseas).filter(name => providers[name])
    const timeoutMs = Number(env.AI_TIMEOUT_MS) > 0 ? Number(env.AI_TIMEOUT_MS) : TIMEOUT_MS
    let lastErr
    for (const name of order) {
      const provider = providers[name]
      // 海外通道强脱敏（PII 出境守卫）；本地/国内按原样（本地数据不出内网）
      const safeMessages = name === 'overseas'
        ? messages.map(m => ({ ...m, content: maskPII(m.content) }))
        : messages
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      try {
        const content = await provider(safeMessages, ctrl.signal)
        clearTimeout(timer)
        return { model: `${name}:${providerModelName(env, name)}`, content, provider: name }
      } catch (e) {
        clearTimeout(timer)
        const aborted = e?.name === 'AbortError'
        lastErr = aborted ? new Error(`provider ${name} 超时（${timeoutMs}ms）`) : e
        continue // 不可达 → 回退下一个
      }
    }
    throw lastErr || new Error('无可用模型 provider')
  }

  return { route, providers, orderOf }
}

function providerModelName(env, name) {
  if (name === 'local') return env.LOCAL_MODEL_NAME || 'deepseek-v3'
  if (name === 'domestic') return env.DOMESTIC_MODEL_NAME || 'deepseek-chat'
  if (name === 'overseas') return env.OVERSEAS_MODEL_NAME || 'gpt-4o-mini'
  return name
}

/** 防御性 JSON 解析：优先 response_format，失败则从文本截取首个 {...} 块 */
export function parseJsonOutput(content) {
  if (!content) throw new Error('模型输出为空')
  const text = String(content)
  try { return JSON.parse(text) } catch {}
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)) } catch {}
  }
  throw new Error('模型未返回可解析 JSON')
}
