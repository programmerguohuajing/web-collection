/**
 * @file AI 诊断 Cloudflare Worker 入口
 *
 * 独立 Worker（web-collection-ai），绑定同一 D1 + Vectorize(ai-kb) + Workers AI。
 * 路由：
 *   POST /api/ai/diagnose           统一入口 {type,traceId|issueId|errorText,appId?,preferOverseas?}
 *   POST /api/ai/diagnose/trace     便捷
 *   POST /api/ai/diagnose/error     便捷
 *   POST /api/ai/feedback           反馈 {diagnosisId,rating,correction?}
 *   POST /api/ai/kb/ingest          触发 RAG 摄取（需 x-ai-key）
 *   GET  /api/ai/kb/search          调试检索（需 x-ai-key）
 *   GET  /health
 * 控制台同域免 key；开放调用需 x-ai-key == env.AI_API_KEY。
 */
import { json, cors } from '../packages/ai/http.js'
import { createD1Adapter, hash } from '../packages/ai/db-adapter.js'
import { createVectorizeStore } from '../packages/ai/vector-store.js'
import { createEmbedder } from '../packages/ai/embed.js'
import { createKb } from '../packages/ai/kb.js'
import { createModelGateway } from '../packages/ai/model-gateway.js'
import { createDiagnoser } from '../packages/ai/diagnoser.js'
import { runScan, createFindingsRepo } from '../packages/ai/findings.js'
import { createConversationStore } from '../packages/ai/conversation.js'
import { loadPushChannels, deliverFinding } from '../packages/ai/notify.js'
import { ingestResolvedIssues } from '../packages/ai/ingest.js'
import { createRateLimiter } from '../packages/ai/rate-limit.js'
import { sedimentFeedback } from '../packages/ai/feedback.js'
import { normalizeAiSettings, aiSettingsToEnv, maskKey } from '../packages/ai/runtime-config.js'
import { encryptSecrets, decryptSecrets } from '../packages/alerting.js'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), request)
    try {
      const path = url.pathname
      if (path === '/health') return cors(json({ ok: true, runtime: 'cloudflare-ai-worker' }), request)
      if (path.startsWith('/api/ai/')) {
        // settings 三端点是管理面：仅同源可访问，x-ai-key 开放 API key 无权读写配置
        const settingsAdmin = path === '/api/ai/settings' || path === '/api/ai/settings/test' || path === '/api/ai/settings/models'
        if (settingsAdmin) {
          const origin = request.headers.get('origin')
          let crossOrigin = false
          if (origin) { try { crossOrigin = new URL(origin).origin !== url.origin } catch { crossOrigin = true } }
          if (crossOrigin) return cors(json({ error: 'forbidden' }, 403), request)
        } else {
          // §8.3 兜底方案落地：KB 路由不再恒要求 x-ai-key。
          // 同源（控制台）请求一律放行；仅当配置了 AI_API_KEY 且为跨源开放调用时才校验。
          // 这样知识库页面不依赖部署期配置主/ai 双 worker 同值 AI_API_KEY。
          const requireKey = env.AI_API_KEY && !sameOrigin(request, url)
          if (requireKey && request.headers.get('x-ai-key') !== env.AI_API_KEY) {
            return cors(json({ error: 'unauthorized' }, 401), request)
          }
        }
        return cors(await route(request, env, url, path), request)
      }
      return cors(json({ error: 'not found' }, 404), request)
    } catch (error) {
      const status = Number(error?.status) || 500
      // 5xx 落日志：否则 CF 控制台/wrangler tail 看不到根因（如 subrequest 超限、绑定缺失）
      console.error(`[ai] ${request.method} ${url.pathname} failed (${status}):`, error?.stack || error?.message || error)
      return cors(json({ error: status >= 500 ? 'internal error' : (error?.message || 'error') }, status), request)
    }
  },

  /** Cron Trigger：定时主动扫描并写入洞察流（P1）。异常不抛出以免中断 cron。 */
  async scheduled(event, env) {
    try {
      const { DB } = env
      const db = createD1Adapter({ DB })
      const result = await runScan(db, { sinceHours: 24 })
      console.log(`[ai:scheduled] scan done: inserted=${result.inserted.length} skipped=${result.skipped}`)
    } catch (error) {
      console.error('[ai:scheduled] scan failed:', String(error?.message || error))
    }
  }
}

function sameOrigin(request, url) {
  const origin = request.headers.get('origin')
  if (!origin) return false
  try { return new URL(origin).origin === url.origin } catch { return false }
}

// 限流器模块级单例：Workers 全局作用域存活期间复用令牌桶。
// （此前在 buildDeps 内新建，每请求重置，限流形同虚设）
let sharedLimiter = null
function getRateLimiter(env) {
  if (!sharedLimiter) {
    sharedLimiter = createRateLimiter({
      capacity: Number(env.AI_RATE_CAPACITY) > 0 ? Number(env.AI_RATE_CAPACITY) : 60,
      refillPerSec: Number(env.AI_RATE_REFILL) > 0 ? Number(env.AI_RATE_REFILL) : 10
    })
  }
  return sharedLimiter
}

async function buildDeps(env) {
  // DB(ai) > env > 默认：读库异常内部已吞掉（回落纯 env），诊断不中断
  const { source } = await readAiSettingsRaw(env)
  const effectiveEnv = { ...env, ...aiSettingsToEnv(source) }
  const db = createD1Adapter({ DB: env.DB })
  const embedder = env.AI ? createEmbedder({ backend: 'cloudflare', ai: env.AI }) : null
  const kb = createKb({ db, vectorStore: createVectorizeStore(env.AI_KB), embedder })
  const gateway = createModelGateway(effectiveEnv)
  const diagnoser = createDiagnoser({ db, gateway, kb, embedder })
  return { db, kb, gateway, diagnoser, embedder, vectorStore: createVectorizeStore(env.AI_KB), limiter: getRateLimiter(env) }
}

async function route(request, env, url, path) {
  const { db, kb, diagnoser, embedder, vectorStore, limiter } = await buildDeps(env)

  // 限流（§8 按 key 令牌桶，防滥用/控成本）：key = 开放 API 的 x-ai-key，否则按调用来源
  const rateKey = request.headers.get('x-ai-key') || request.headers.get('x-app-key') || 'anonymous'
  if (path.startsWith('/api/ai/')) {
    const { ok, retryAfterMs } = limiter.consume(rateKey)
    if (!ok) return json({ error: 'rate limited', retryAfterMs }, 429, { 'retry-after': String(Math.ceil(retryAfterMs / 1000)) })
  }

  if (path === '/api/ai/diagnose' && request.method === 'POST') {
    return json(await diagnoseMap(diagnoser, await request.json()))
  }
  if (path === '/api/ai/diagnose/trace' && request.method === 'POST') {
    return json(await diagnoser.trace(await request.json()))
  }
  if (path === '/api/ai/diagnose/error' && request.method === 'POST') {
    return json(await diagnoser.error(await request.json()))
  }
  if (path === '/api/ai/feedback' && request.method === 'POST') {
    return json(await saveFeedback(db, kb, await request.json()))
  }
  if (path === '/api/ai/kb/ingest' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}))
    return json(await ingestResolvedIssues({ db, kb, embedder, vectorStore, force: !!body.force }))
  }
  if (path === '/api/ai/kb/search' && request.method === 'GET') {
    const q = url.searchParams.get('q') || ''
    const appId = url.searchParams.get('appId') || ''
    return json({ results: await kb.search(q, { appId, topK: 8 }) })
  }
  if (path === '/api/ai/kb/source' && request.method === 'DELETE') {
    const type = url.searchParams.get('type') || ''
    const id = url.searchParams.get('id') || ''
    if (!type || !id) throw Object.assign(new Error('type 与 id 必填'), { status: 400 })
    await kb.removeBySource(type, id)
    return json({ ok: true })
  }
  if (path === '/api/ai/settings' && request.method === 'GET') {
    return json(await readAiSettings(env))
  }
  if (path === '/api/ai/settings' && request.method === 'PUT') {
    return json(await saveAiSettings(env, await request.json()))
  }
  if (path === '/api/ai/settings/test' && request.method === 'POST') {
    return json(await testAiSettings(env, await request.json().catch(() => ({}))))
  }
  if (path === '/api/ai/settings/models' && request.method === 'POST') {
    return json(await listProviderModels(env, await request.json().catch(() => ({}))))
  }
  if (path === '/api/ai/kb/meta' && request.method === 'GET') {
    const list = await kb.listMeta({
      page: url.searchParams.get('page') || 1,
      pageSize: url.searchParams.get('pageSize') || 50,
      type: url.searchParams.get('type') || '',
      appId: url.searchParams.get('appId') || ''
    })
    return json(list)
  }
  if (path === '/api/ai/kb/stats' && request.method === 'GET') {
    return json(await kb.stats())
  }
  if ((path.startsWith('/api/ai/kb/chunk/') || path.startsWith('/api/ai/kb/chunk%2F')) && request.method === 'GET') {
    const id = decodeURIComponent(path.slice('/api/ai/kb/chunk/'.length))
    const row = await kb.getChunk(id)
    if (!row) throw Object.assign(new Error('chunk 不存在'), { status: 404 })
    let metadata = null
    try { metadata = row.metadata_json ? JSON.parse(row.metadata_json) : null } catch { metadata = null }
    return json({ ...row, metadata })
  }
  // 按 source 维度确定性定位原文 chunk（不依赖向量检索）
  if (path === '/api/ai/kb/locate' && request.method === 'GET') {
    const type = url.searchParams.get('type') || ''
    const id = url.searchParams.get('id') || ''
    if (!type || !id) throw Object.assign(new Error('type 与 id 必填'), { status: 400 })
    const row = await kb.getFirstChunkBySource(type, id)
    if (!row) throw Object.assign(new Error('chunk 不存在'), { status: 404 })
    let metadata = null
    try { metadata = row.metadata_json ? JSON.parse(row.metadata_json) : null } catch { metadata = null }
    return json({ ...row, metadata })
  }
  if (path === '/api/ai/kb/runbook' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}))
    const title = String(body?.title || '').trim()
    // 手动摄取仅开放 runbook / doc 两类；issue 由重建索引沉淀、feedback 由诊断修正闭环产生
    const sourceType = ['runbook', 'doc'].includes(String(body?.sourceType)) ? String(body.sourceType) : 'runbook'
    // url 模式：服务端抓取在线页面；否则要求 text 正文
    if (body?.url) {
      return json(await kb.ingestRunbookFromUrl({ url: String(body.url), title, appId: String(body?.appId || ''), sourceType }))
    }
    const text = String(body?.text || '').trim()
    if (!title || !text) throw Object.assign(new Error('title 与 text（或 url）必填'), { status: 400 })
    return json(await kb.ingestRunbook({ title, text, appId: String(body?.appId || ''), sourceType }))
  }

  // ---- P1 主动诊断 · 洞察流 ----
  if (path === '/api/ai/scan' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}))
    return json(await runScan(db, { appId: body.appId || undefined, sinceHours: Number(body.sinceHours) || 24 }))
  }
  if (path === '/api/ai/findings' && request.method === 'GET') {
    const repo = createFindingsRepo(db)
    const list = await repo.list({
      appId: url.searchParams.get('appId') || undefined,
      scope: url.searchParams.get('scope') || undefined,
      status: url.searchParams.get('status') || undefined,
      limit: Number(url.searchParams.get('limit')) || 50
    })
    return json({ items: list, total: list.length })
  }
  const findingStatus = path.match(/^\/api\/ai\/findings\/([^/]+)\/status$/)
  if (findingStatus && request.method === 'POST') {
    const repo = createFindingsRepo(db)
    const { status } = await request.json().catch(() => ({}))
    if (!['open', 'ack', 'resolved', 'ignored'].includes(status)) throw Object.assign(new Error('非法 status'), { status: 400 })
    return json(await repo.updateStatus(findingStatus[1], status))
  }
  const findingNotify = path.match(/^\/api\/ai\/findings\/([^/]+)\/notify$/)
  if (findingNotify && request.method === 'POST') {
    const repo = createFindingsRepo(db)
    const finding = await repo.get(findingNotify[1])
    if (!finding) throw Object.assign(new Error('finding 不存在'), { status: 404 })
    const channels = await loadPushChannels(db)
    const results = await deliverFinding(finding, { channels })
    return json({ ok: results.every(r => r.ok), results })
  }

  // ---- P2 对话式助手 ----
  if (path === '/api/ai/conversations' && request.method === 'GET') {
    const store = createConversationStore(db)
    return json({ items: await store.list({ appId: url.searchParams.get('appId') || undefined, limit: Number(url.searchParams.get('limit')) || 30 }) })
  }
  if (path === '/api/ai/ask' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}))
    return json(await diagnoser.ask({ question: body.question, appId: body.appId, preferOverseas: body.preferOverseas, conversationId: body.conversationId }))
  }

  return json({ error: 'not found' }, 404)
}

async function diagnoseMap(diagnoser, body) {
  const { type, scope, ref, traceId, sessionId, release, issueId, errorText, appId, preferOverseas } = body || {}
  // P0 产品化：统一入口 scope + ref（ref 缺省时从各 legacy 字段回退解析）
  if (scope) {
    const resolvedRef = ref || traceId || sessionId || release || issueId || errorText
    return diagnoser.diagnose({ scope, ref: resolvedRef, appId, preferOverseas })
  }
  // 旧兼容：type / traceId / issueId / errorText
  if (type === 'trace' || traceId) return diagnoser.trace({ traceId, appId, preferOverseas })
  if (type === 'error' || issueId || errorText) return diagnoser.error({ issueId, errorText, appId, preferOverseas })
  throw Object.assign(new Error('scope/type/traceId/issueId/errorText 至少提供一项'), { status: 400 })
}

async function saveFeedback(db, kb, body) {
  const { diagnosisId, rating, correction, appId } = body || {}
  if (!diagnosisId || !['up', 'down'].includes(rating)) throw Object.assign(new Error('diagnosisId 与 rating(up|down) 必填'), { status: 400 })
  const now = Date.now()
  const id = hash(`${diagnosisId}:${now}`)
  await db.prepare('insert into ai_feedback (id,diagnosis_id,rating,correction,created_at) values (?,?,?,?,?)')
    .bind(id, diagnosisId, rating, correction || null, now).run()
  // M5：反馈→KB 自动沉淀（down + correction 时写为知识库 chunk）
  let sedimented = null
  try {
    sedimented = await sedimentFeedback({ db, kb, diagnosisId, rating, correction, appId })
  } catch (error) {
    // 沉淀失败不阻塞反馈落库
    sedimented = { error: String(error?.message || error) }
  }
  return { ok: true, id, sedimented }
}

// ---- AI 设置（D1 持久化，DB > env > 默认）----

function aiMasterKey(env) {
  // R1：主 worker 的 ALERT_SECRET_MASTER_KEY 原值可能拿不到，ai-worker 支持独立 AI_SECRET_MASTER_KEY；
  // 若两 worker 同值则回落兼容 ALERT_SECRET_MASTER_KEY
  return env.AI_SECRET_MASTER_KEY || env.ALERT_SECRET_MASTER_KEY || ''
}

/** 读库原始配置：{source(明文 ai 对象), keys(已解密), keysError}；任何异常吞掉返回空 */
async function readAiSettingsRaw(env) {
  try {
    const row = await env.DB.prepare('select config_json from settings where id=1').first()
    const config = row?.config_json ? JSON.parse(row.config_json) : {}
    let keys = {}
    let keysError = ''
    try {
      keys = await decryptSecrets(config.ai_keys, aiMasterKey(env))
    } catch (error) {
      keysError = String(error?.message || error)
    }
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

const SOURCE_FIELDS = [
  ['modelOrder', 'MODEL_ORDER'],
  ['timeoutMs', 'AI_TIMEOUT_MS'],
  ['workersAiModel', 'WORKERS_AI_MODEL']
]

/** GET：归一化 + 脱敏 + effectiveSource（逐字段标注 db/env/default 来源） */
async function readAiSettings(env) {
  const { source, keys } = await readAiSettingsRaw(env)
  const normalized = normalizeAiSettings(source)
  const dbEnvKeys = new Set(Object.keys(aiSettingsToEnv(source)))
  const effectiveSource = {}

  const sourceOf = envKey => dbEnvKeys.has(envKey) ? 'db' : (env[envKey] ? 'env' : 'default')
  for (const [field, envKey] of SOURCE_FIELDS) effectiveSource[field] = sourceOf(envKey)
  effectiveSource.modelFallback = normalized.modelFallback === false
    ? 'db'
    : String(env.MODEL_FALLBACK ?? '').toLowerCase() === 'off' ? 'env' : 'default'

  const providers = {}
  for (const name of ['local', 'domestic', 'overseas']) {
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

function invalid(message) {
  throw Object.assign(new Error(message), { status: 400 })
}

/** PUT：校验 → key 三分支处理 → AES-GCM 加密 → 读-合-写 upsert → 返回脱敏结果 */
async function saveAiSettings(env, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('请求体必须是对象')

  // modelOrder 严格校验：出现即必须全为合法值且至少一项
  if (input.modelOrder !== undefined) {
    const tokens = String(input.modelOrder).split(',').map(s => s.trim()).filter(Boolean)
    if (!tokens.length || !tokens.every(t => ['local', 'domestic', 'overseas', 'workers-ai'].includes(t))) {
      invalid('modelOrder 只能包含 local/domestic/overseas/workers-ai 且至少一项')
    }
  }
  // baseUrl 格式校验（normalize 会截断长度，这里校验协议头）
  for (const name of ['local', 'domestic', 'overseas']) {
    const url = input.providers?.[name]?.baseUrl
    if (typeof url === 'string' && url.trim() && !/^https?:\/\//i.test(url.trim())) {
      invalid(`${name}.baseUrl 必须 http(s):// 开头`)
    }
  }

  const masterKey = aiMasterKey(env)
  const { source, keys: existingKeys } = await readAiSettingsRaw(env)

  // apiKey 三分支：undefined/null/'' 或 •••• 前缀 → 保留库中现有值；其他非空 → 新 key
  const mergedKeys = { ...existingKeys }
  let hasNewKey = false
  for (const name of ['local', 'domestic', 'overseas']) {
    const incoming = input.providers?.[name]?.apiKey
    if (typeof incoming === 'string' && incoming.trim() && !incoming.startsWith('••••')) {
      mergedKeys[name] = incoming.trim()
      hasNewKey = true
    }
  }
  if (hasNewKey && !masterKey) {
    throw Object.assign(new Error('ALERT_SECRET_MASTER_KEY 未配置，无法保存密钥'), { status: 503 })
  }

  const normalized = normalizeAiSettings(input)
  try {
    const row = await env.DB.prepare('select config_json from settings where id=1').first()
    let config = {}
    if (row?.config_json) { try { config = JSON.parse(row.config_json) } catch {} }
    config.ai = normalized
    config.ai_keys_v = 1
    if (Object.keys(mergedKeys).length) {
      config.ai_keys = await encryptSecrets(mergedKeys, masterKey)
    } else {
      delete config.ai_keys
    }
    const now = Date.now()
    await env.DB.prepare('insert into settings(id,config_json,updated_at) values(1,?,?) on conflict(id) do update set config_json=excluded.config_json,updated_at=excluded.updated_at')
      .bind(JSON.stringify(config), now).run()
  } catch (error) {
    if (error?.status) throw error
    console.error('saveAiSettings failed:', String(error?.stack || error?.message || error))
    throw Object.assign(new Error('保存 AI 设置失败'), { status: 500 })
  }
  return readAiSettings(env)
}

/** test/models 专用小桶限流（防 SSRF 滥用/扫端口） */
function consumeSettingsBucket(env, bucket) {
  const { ok } = getRateLimiter(env).consume(bucket)
  return ok
}

/** POST /settings/test：用「待保存配置」对 order 内每个 provider + workers-ai 并行发最小请求 */
async function testAiSettings(env, input) {
  if (!consumeSettingsBucket(env, 'settings-test')) {
    throw Object.assign(new Error('请求过于频繁，稍后再试'), { status: 429 })
  }
  const normalized = normalizeAiSettings(input)
  const { keys } = await readAiSettingsRaw(env)
  // 合成待测 env：表单值 > 库中已存 key > worker env
  const merged = {
    ...normalized,
    providers: Object.fromEntries(['local', 'domestic', 'overseas'].map(name => [
      name,
      { ...normalized.providers[name], apiKey: input.providers?.[name]?.apiKey?.trim() || keys[name] || '' }
    ]))
  }
  const effectiveEnv = { ...env, ...aiSettingsToEnv(merged), AI: env.AI }
  const gateway = createModelGateway(effectiveEnv)

  const names = [...normalized.modelOrder.split(',').map(s => s.trim()).filter(Boolean)]
  if (normalized.modelFallback !== false && !names.includes('workers-ai')) names.push('workers-ai')

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

const MODEL_LIST_FORMATS = ['openai-chat', 'openai-responses', 'anthropic-messages', 'gemini-generatecontent']

/** POST /settings/models：拉取单个 provider 的模型列表（apiKey 空时回落库中密钥） */
async function listProviderModels(env, input) {
  if (!consumeSettingsBucket(env, 'settings-models')) {
    throw Object.assign(new Error('请求过于频繁，稍后再试'), { status: 429 })
  }
  const name = String(input.provider || '')
  if (!['local', 'domestic', 'overseas'].includes(name)) {
    throw Object.assign(new Error('provider 必须是 local/domestic/overseas（workers-ai 不支持列表）'), { status: 400 })
  }
  const prefix = name === 'local' ? 'LOCAL_MODEL' : name.toUpperCase()
  const baseURL = (typeof input.baseUrl === 'string' && input.baseUrl.trim())
    || env[`${prefix}_BASE_URL`] || ''
  if (!baseURL) return { ok: false, error: 'baseUrl 未配置' }

  const apiFormat = MODEL_LIST_FORMATS.includes(input.apiFormat) ? input.apiFormat : 'openai-chat'
  const { keys } = await readAiSettingsRaw(env)
  let apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() && !input.apiKey.startsWith('••••')
    ? input.apiKey.trim()
    : (keys[name] || env[`${prefix}_API_KEY`] || '')

  const base = baseURL.replace(/\/$/, '')
  const headers = {}
  let url
  let pick = data => data

  if (apiFormat === 'anthropic-messages') {
    url = `${base}/v1/models`
    headers['anthropic-version'] = '2023-06-01'
    if (apiKey) headers['x-api-key'] = apiKey
    pick = data => (Array.isArray(data?.data) ? data.data.map(m => m?.id).filter(Boolean) : [])
  } else if (apiFormat === 'gemini-generatecontent') {
    url = `${base}/v1beta/models${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}`
    pick = data => (Array.isArray(data?.models) ? data.models.map(m => String(m?.name || '').replace(/^models\//, '')).filter(Boolean) : [])
  } else {
    url = `${base}/models`
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    pick = data => (Array.isArray(data?.data) ? data.data.map(m => m?.id).filter(Boolean) : [])
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: ctrl.signal })
    if (!res.ok) {
      return { ok: false, error: `${res.status} ${(await res.text()).slice(0, 80)}`.trim().slice(0, 120) }
    }
    const models = pick(await res.json()).sort()
    return { ok: true, models }
  } catch (error) {
    const message = error?.name === 'AbortError' ? '超时(8s)' : String(error?.message || error)
    return { ok: false, error: message.slice(0, 120) }
  } finally {
    clearTimeout(timer)
  }
}
