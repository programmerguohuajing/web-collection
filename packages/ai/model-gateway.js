/**
 * @file 混合 Model Gateway（ADR-004）
 *
 * provider 可插拔：本地 Ollama（OpenAI 兼容端点）/ 国内 / 海外。
 * 路由顺序由 env.MODEL_ORDER 配置（默认 local,domestic,overseas）：
 *   本地不可达（ECONNREFUSED/超时）自动回退国内/海外；海外前强脱敏 maskPII。
 * 显式 preferOverseas 可直达海外。统一 messages → JSON 输出。
 * 每 provider 可经 {PREFIX}_API_FORMAT 选择上游协议：
 *   openai-chat | anthropic-messages | openai-responses | gemini-generatecontent
 */
import { maskPII } from './pii.js'

const DEFAULT_ORDER = ['local', 'domestic', 'overseas']
export const DEFAULT_FALLBACK_ORDER = ['workers-ai']
export const TIMEOUT_MS = 8000
export const MAX_TOKENS = 2048
export const WORKERS_AI_MODEL = env => env.WORKERS_AI_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast'

const ANTHROPIC_VERSION = '2023-06-01'

/** OpenAI Chat Completions：POST {base}/chat/completions */
async function callOpenAIChat(fetchFn, { baseURL, model, apiKey }, messages, { signal, jsonMode = true } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  const body = { model, messages, max_tokens: MAX_TOKENS, temperature: 0.2, stream: false }
  if (jsonMode) body.response_format = { type: 'json_object' }
  const res = await fetchFn(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', headers, body: JSON.stringify(body), signal
  })
  if (!res.ok) throw new Error(`llm http ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  const message = data?.choices?.[0]?.message
  // 推理模型（deepseek-r1/qwen3 等）经 Ollama OpenAI 兼容层可能把内容放在 reasoning、content 为空
  const content = typeof message?.content === 'string' && message.content.trim()
    ? message.content
    : (typeof message?.reasoning === 'string' ? message.reasoning : '')
  if (!content.trim()) throw new Error('llm 响应无 content')
  return content
}

/** Anthropic Messages 原生：POST {base}/v1/messages，system 提升到顶层 */
async function callAnthropicMessages(fetchFn, { baseURL, model, apiKey }, messages, { signal } = {}) {
  if (!baseURL) throw new Error('anthropic provider 未配置 baseUrl')
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n')
  const headers = { 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION }
  if (apiKey) headers['x-api-key'] = apiKey
  const body = {
    model,
    max_tokens: MAX_TOKENS,
    temperature: 0.2,
    messages: messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }))
  }
  if (system) body.system = system
  const res = await fetchFn(`${baseURL.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST', headers, body: JSON.stringify(body), signal
  })
  if (!res.ok) throw new Error(`llm http ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  const text = Array.isArray(data?.content)
    ? data.content.map(block => (typeof block?.text === 'string' ? block.text : '')).join('')
    : ''
  if (!text.trim()) throw new Error('anthropic 响应无 text')
  return text
}

/** OpenAI Responses API：POST {base}/responses */
async function callOpenAIResponses(fetchFn, { baseURL, model, apiKey }, messages, { signal } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  const body = { model, input: messages, max_output_tokens: MAX_TOKENS, stream: false }
  const res = await fetchFn(`${baseURL.replace(/\/$/, '')}/responses`, {
    method: 'POST', headers, body: JSON.stringify(body), signal
  })
  if (!res.ok) throw new Error(`llm http ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  let content = typeof data?.output_text === 'string' ? data.output_text : ''
  if (!content && Array.isArray(data?.output)) {
    content = data.output.flatMap(item => Array.isArray(item?.content) ? item.content : [])
      .map(part => (typeof part?.text === 'string' ? part.text : '')).join('')
  }
  if (!content.trim()) throw new Error('responses API 响应无 output_text')
  return content
}

/** Gemini generateContent：POST {base}/v1beta/models/{model}:generateContent?key= */
async function callGeminiGenerateContent(fetchFn, { baseURL, model, apiKey }, messages, { signal } = {}) {
  if (!baseURL) throw new Error('gemini provider 未配置 baseUrl')
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n')
  const headers = { 'content-type': 'application/json' }
  const body = {
    contents: messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    })),
    generationConfig: { maxOutputTokens: MAX_TOKENS, temperature: 0.2 }
  }
  if (system) body.systemInstruction = { parts: [{ text: system }] }
  const keyParam = apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''
  const res = await fetchFn(`${baseURL.replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(model)}:generateContent${keyParam}`, {
    method: 'POST', headers, body: JSON.stringify(body), signal
  })
  if (!res.ok) throw new Error(`llm http ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  const parts = data?.candidates?.[0]?.content?.parts
  const text = Array.isArray(parts) ? parts.map(p => (typeof p?.text === 'string' ? p.text : '')).join('') : ''
  if (!text.trim()) throw new Error('gemini 响应无 text')
  return text
}

const CALLERS = {
  'openai-chat': callOpenAIChat,
  'anthropic-messages': callAnthropicMessages,
  'openai-responses': callOpenAIResponses,
  'gemini-generatecontent': callGeminiGenerateContent
}

const PROVIDER_ENV_PREFIX = {
  local: 'LOCAL',
  domestic: 'DOMESTIC',
  overseas: 'OVERSEAS'
}

function providerConfig(env, name) {
  const prefix = PROVIDER_ENV_PREFIX[name]
  const apiFormat = CALLERS[env[`${prefix}_API_FORMAT`]] ? env[`${prefix}_API_FORMAT`] : 'openai-chat'
  const cfg = name === 'local'
    ? { baseURL: env.LOCAL_MODEL_BASE_URL, model: env.LOCAL_MODEL_NAME || 'deepseek-v3', apiKey: env.LOCAL_MODEL_API_KEY || '' }
    : {
        baseURL: name === 'domestic' ? env.DOMESTIC_BASE_URL || 'https://api.deepseek.com/v1' : env.OVERSEAS_BASE_URL || 'https://api.openai.com/v1',
        model: name === 'domestic' ? env.DOMESTIC_MODEL_NAME || 'deepseek-chat' : env.OVERSEAS_MODEL_NAME || 'gpt-4o-mini',
        apiKey: name === 'domestic' ? env.DOMESTIC_API_KEY : env.OVERSEAS_API_KEY
      }
  return { ...cfg, apiFormat }
}

/** 构造 gateway。env 需含 provider 配置；fetchFn 便于单测注入。 */
export function createModelGateway(env = {}, { fetchFn = fetch } = {}) {
  const rawFetch = fetchFn
  const providers = {
    local: async (messages, signal, { jsonMode } = {}) => {
      const cfg = providerConfig(env, 'local')
      if (!cfg.baseURL) throw new Error('local provider 未配置 LOCAL_MODEL_BASE_URL')
      return CALLERS[cfg.apiFormat](rawFetch, cfg, messages, { signal, jsonMode })
    },
    domestic: async (messages, signal, { jsonMode } = {}) => {
      return CALLERS[providerConfig(env, 'domestic').apiFormat](rawFetch, providerConfig(env, 'domestic'), messages, { signal, jsonMode })
    },
    overseas: async (messages, signal, { jsonMode } = {}) => {
      return CALLERS[providerConfig(env, 'overseas').apiFormat](rawFetch, providerConfig(env, 'overseas'), messages, { signal, jsonMode })
    },
    // Cloudflare Workers AI 兜底：ai-worker 自带 AI 绑定，无需 key/隧道，
    // local/domestic/overseas 全部不可达时仍可产出诊断（质量较低但可用）。
    'workers-ai': async (messages) => {
      if (!env.AI?.run) throw new Error('workers-ai provider 未绑定 AI')
      const result = await env.AI.run(WORKERS_AI_MODEL(env), {
        messages,
        max_tokens: MAX_TOKENS,
        temperature: 0.2
      })
      // 兼容多种返回形态：优先 OpenAI 风格 choices，其次 {response} 字符串
      let content = result?.choices?.[0]?.message?.content
      if (typeof content !== 'string' && typeof result?.response === 'string') {
        content = result.response
      }
      if (!content && result && typeof result.getReader === 'function') {
        content = await new Response(result).text()
      }
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error(`workers-ai 响应无 content: ${JSON.stringify(result).slice(0, 200)}`)
      }
      return content
    }
  }

  function orderOf(preferOverseas) {
    const configured = (env.MODEL_ORDER || DEFAULT_ORDER.join(',')).split(',').map(s => s.trim()).filter(Boolean)
    if (preferOverseas) return ['overseas', ...configured.filter(p => p !== 'overseas')]
    // 配置的顺序跑完后追加兜底 provider（除非显式配置了 workers-ai 位置或禁用）
    const fallback = String(env.MODEL_FALLBACK ?? '').toLowerCase() === 'off' ? [] : DEFAULT_FALLBACK_ORDER.filter(p => !configured.includes(p))
    return [...configured.length ? configured : DEFAULT_ORDER, ...fallback]
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
        const content = await provider(safeMessages, ctrl.signal, { jsonMode })
        clearTimeout(timer)
        return { model: `${name}:${providerModelName(env, name)}`, content, provider: name }
      } catch (e) {
        clearTimeout(timer)
        const aborted = e?.name === 'AbortError'
        lastErr = aborted ? new Error(`provider ${name} 超时（${timeoutMs}ms）`) : e
        // 可观测性：回退时记录失败原因（仅 provider 名与错误消息，不含配置与 key）
        console.error(`gateway provider ${name} failed: ${String(e?.message || e).slice(0, 200)}`)
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
  if (name === 'workers-ai') return WORKERS_AI_MODEL(env)
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
