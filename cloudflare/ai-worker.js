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
import { ingestResolvedIssues } from '../packages/ai/ingest.js'
import { createRateLimiter } from '../packages/ai/rate-limit.js'
import { sedimentFeedback } from '../packages/ai/feedback.js'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), request)
    try {
      const path = url.pathname
      if (path === '/health') return cors(json({ ok: true, runtime: 'cloudflare-ai-worker' }), request)
      if (path.startsWith('/api/ai/')) {
        const adminOnly = path === '/api/ai/kb/ingest' || path === '/api/ai/kb/search' || path === '/api/ai/kb/source' || path === '/api/ai/kb/meta'
        const requireKey = adminOnly || (env.AI_API_KEY && !sameOrigin(request, url))
        if (requireKey && request.headers.get('x-ai-key') !== env.AI_API_KEY) {
          return cors(json({ error: 'unauthorized' }, 401), request)
        }
        return cors(await route(request, env, url, path), request)
      }
      return cors(json({ error: 'not found' }, 404), request)
    } catch (error) {
      const status = Number(error?.status) || 500
      return cors(json({ error: status >= 500 ? 'internal error' : (error?.message || 'error') }, status), request)
    }
  }
}

function sameOrigin(request, url) {
  const origin = request.headers.get('origin')
  if (!origin) return false
  try { return new URL(origin).origin === url.origin } catch { return false }
}

function buildDeps(env) {
  const db = createD1Adapter({ DB: env.DB })
  const embedder = env.AI ? createEmbedder({ backend: 'cloudflare', ai: env.AI }) : null
  const kb = createKb({ db, vectorStore: createVectorizeStore(env.AI_KB), embedder })
  const gateway = createModelGateway(env)
  const diagnoser = createDiagnoser({ db, gateway, kb, embedder })
  const limiter = createRateLimiter({
    capacity: Number(env.AI_RATE_CAPACITY) > 0 ? Number(env.AI_RATE_CAPACITY) : 60,
    refillPerSec: Number(env.AI_RATE_REFILL) > 0 ? Number(env.AI_RATE_REFILL) : 10
  })
  return { db, kb, gateway, diagnoser, limiter }
}

async function route(request, env, url, path) {
  const { db, kb, diagnoser, limiter } = buildDeps(env)

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
    return json(await ingestResolvedIssues({ db, kb, force: !!body.force }))
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
  if (path === '/api/ai/kb/meta' && request.method === 'GET') {
    const rows = (await db.prepare('select source_type,source_id,content_hash,version,updated_at from ai_kb_meta order by updated_at desc limit 200').all()) || []
    return json({ items: rows })
  }
  return json({ error: 'not found' }, 404)
}

async function diagnoseMap(diagnoser, body) {
  const { type, traceId, issueId, errorText, appId, preferOverseas } = body || {}
  if (type === 'trace' || traceId) return diagnoser.trace({ traceId, appId, preferOverseas })
  if (type === 'error' || issueId || errorText) return diagnoser.error({ issueId, errorText, appId, preferOverseas })
  throw Object.assign(new Error('type/traceId/issueId/errorText 至少提供一项'), { status: 400 })
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
