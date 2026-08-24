/**
 * @file AI 诊断 Express Router（Node + PostgreSQL 后端）
 *
 * 复用 packages/ai/* 同一套逻辑（queries/kb/gateway/diagnoser），仅存储后端不同：
 *   - db：createPgAdapter(包装 db.js 的 all/run)
 *   - 向量：pgvector（apps/api/src/vector-store.js）
 *   - embedding：本地 OpenAI 兼容端点 EMBEDDING_BASE_URL（未配置则无向量，RAG 降级关键词）
 *
 * 挂载：apps/api/index.js 中 `app.use(createAiRouter())`，自动挂到 /api/ai/*。
 */
import { Router } from 'express'
import { createPgAdapter, hash } from '../../../packages/ai/db-adapter.js'
import { createEmbedder } from '../../../packages/ai/embed.js'
import { createKb } from '../../../packages/ai/kb.js'
import { createModelGateway } from '../../../packages/ai/model-gateway.js'
import { createDiagnoser } from '../../../packages/ai/diagnoser.js'
import { ingestResolvedIssues } from '../../../packages/ai/ingest.js'
import { createRateLimiter } from '../../../packages/ai/rate-limit.js'
import { sedimentFeedback } from '../../../packages/ai/feedback.js'
import { all, run } from './db.js'
import { vectorStore } from './vector-store.js'

let nodeEmbedder = null
async function getEmbedder() {
  const base = process.env.EMBEDDING_BASE_URL
  if (!base) return null
  if (nodeEmbedder) return nodeEmbedder
  const model = process.env.EMBEDDING_MODEL || 'bge-large-en-v1.5'
  const apiKey = process.env.EMBEDDING_API_KEY || ''
  nodeEmbedder = createEmbedder({
    backend: 'node',
    async embed(text) {
      const res = await fetch(`${base.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model, input: String(text) })
      })
      if (!res.ok) throw new Error(`embedding http ${res.status}`)
      const data = await res.json()
      const vec = data?.data?.[0]?.embedding || data?.embedding
      if (!Array.isArray(vec)) throw new Error('embedding 响应无向量')
      return vec
    }
  })
  return nodeEmbedder
}

export function createAiRouter(opts = {}) {
  const router = Router()
  const db = createPgAdapter({ all, run })
  const gateway = createModelGateway(process.env, { fetchFn: globalThis.fetch })
  const limiter = createRateLimiter({
    capacity: Number(process.env.AI_RATE_CAPACITY) > 0 ? Number(process.env.AI_RATE_CAPACITY) : 60,
    refillPerSec: Number(process.env.AI_RATE_REFILL) > 0 ? Number(process.env.AI_RATE_REFILL) : 10
  })

  async function buildDiagnoser() {
    const vectorReady = await vectorStore.ready()
    const embedder = await getEmbedder()
    const kb = createKb({ db, vectorStore: vectorReady ? vectorStore : null, embedder })
    return createDiagnoser({ db, gateway, kb, embedder })
  }

  const wrap = fn => async (req, res, next) => { try { res.json(await fn(req)) } catch (err) { next(err) } }

  router.get('/health', (req, res) => res.json({ ok: true, runtime: 'node-ai-service' }))

  // 开放 API 鉴权（§8）：配置 AI_API_KEY 时强制校验 x-ai-key；控制台同域调用免 key
  const apiKey = process.env.AI_API_KEY
  const sameOrigin = req => {
    const origin = req.headers.origin
    if (!origin) return false
    try { return new URL(origin).host === String(req.headers.host || '') } catch { return false }
  }
  // 限流（按 key 令牌桶，防滥用/控成本）
  const limit = (req, res, next) => {
    const key = req.headers['x-ai-key'] || req.headers['x-app-key'] || (sameOrigin(req) ? 'console' : (req.ip || 'anonymous'))
    const { ok, retryAfterMs } = limiter.consume(key)
    if (!ok) { res.set('retry-after', String(Math.ceil(retryAfterMs / 1000))); return res.status(429).json({ error: 'rate limited', retryAfterMs }) }
    return next()
  }
  router.use((req, res, next) => {
    if (req.path === '/health') return next()
    if (apiKey && !sameOrigin(req) && req.headers['x-ai-key'] !== apiKey) {
      return res.status(401).json({ error: 'unauthorized' })
    }
    return limit(req, res, next)
  })

  router.post('/diagnose', wrap(async req => {
    const { type, traceId, issueId, errorText, appId, preferOverseas } = req.body || {}
    const d = await buildDiagnoser()
    if (type === 'trace' || traceId) return d.trace({ traceId, appId, preferOverseas })
    if (type === 'error' || issueId || errorText) return d.error({ issueId, errorText, appId, preferOverseas })
    const err = new Error('type/traceId/issueId/errorText 至少提供一项'); err.statusCode = 400; throw err
  }))

  router.post('/diagnose/trace', wrap(async req => {
    const d = await buildDiagnoser(); return d.trace(req.body || {})
  }))

  router.post('/diagnose/error', wrap(async req => {
    const d = await buildDiagnoser(); return d.error(req.body || {})
  }))

  router.post('/feedback', wrap(async req => {
    const { diagnosisId, rating, correction, appId } = req.body || {}
    if (!diagnosisId || !['up', 'down'].includes(rating)) { const err = new Error('diagnosisId 与 rating(up|down) 必填'); err.statusCode = 400; throw err }
    const id = hash(diagnosisId)
    await run('insert into ai_feedback (id,diagnosis_id,rating,correction,created_at) values (?,?,?,?,?)',
      [id, diagnosisId, rating, correction || null, Date.now()])
    // M5：反馈→KB 自动沉淀（down + correction 时写为知识库 chunk）
    let sedimented = null
    try {
      const vectorReady = await vectorStore.ready()
      const kb = createKb({ db, vectorStore: vectorReady ? vectorStore : null, embedder: await getEmbedder() })
      sedimented = await sedimentFeedback({ db, kb, diagnosisId, rating, correction, appId })
    } catch (err) { sedimented = { error: String(err?.message || err) } }
    return { ok: true, id, sedimented }
  }))

  router.post('/kb/ingest', wrap(async req => {
    const vectorReady = await vectorStore.ready()
    const kb = createKb({ db, vectorStore: vectorReady ? vectorStore : null, embedder: await getEmbedder() })
    return ingestResolvedIssues({ db, kb, force: !!(req.body && req.body.force) })
  }))

  router.get('/kb/search', wrap(async req => {
    const vectorReady = await vectorStore.ready()
    const kb = createKb({ db, vectorStore: vectorReady ? vectorStore : null, embedder: await getEmbedder() })
    return { results: await kb.search(String(req.query.q || ''), { appId: String(req.query.appId || ''), topK: 8 }) }
  }))

  router.delete('/kb/source', wrap(async req => {
    const type = String(req.query.type || '')
    const id = String(req.query.id || '')
    if (!type || !id) { const err = new Error('type 与 id 必填'); err.statusCode = 400; throw err }
    const vectorReady = await vectorStore.ready()
    const kb = createKb({ db, vectorStore: vectorReady ? vectorStore : null, embedder: await getEmbedder() })
    await kb.removeBySource(type, id)
    return { ok: true }
  }))

  router.get('/kb/meta', wrap(async req => {
    const rows = (await all('select source_type,source_id,content_hash,version,updated_at from ai_kb_meta order by updated_at desc limit 200')) || []
    return { items: rows }
  }))

  return router
}
