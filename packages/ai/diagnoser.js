/**
 * @file AI 诊断编排器（双后端共享）
 *
 * 组装：context（queries）+ rag（kb.search）+ model-gateway.route + 落库 ai_diagnoses + 缓存。
 * db 由 db-adapter 构造；kb 由 packages/ai/kb.js createKb 构造；gateway 由 model-gateway 构造。
 * 缓存策略：同 ref_id 10 分钟内复用，省成本。
 */
import { getDistributedTrace, getErrorEvents, getIssue, getSimilarIssues, getTrace } from './queries.js'
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt.js'
import { parseJsonOutput } from './model-gateway.js'

const CACHE_MS = 10 * 60 * 1000

export function createDiagnoser({ db, gateway, kb, embedder }) {
  async function cached(refType, refId) {
    const row = await db.prepare('select * from ai_diagnoses where ref_type=? and ref_id=? order by created_at desc limit 1')
      .bind(refType, refId).first()
    if (!row) return null
    const created = Number(row.created_at || 0)
    if (Date.now() - created > CACHE_MS) return null
    if (row.degraded) return { degraded: true, ...safeParse(row.response_json, {}), model: row.model, refId: refId }
    return { ...safeParse(row.response_json, {}), model: row.model, refId: refId }
  }

  async function store(refType, refId, appId, requestSummary, result) {
    const now = Date.now()
    await db.prepare(
      `insert into ai_diagnoses (id,ref_type,ref_id,app_id,request_summary,response_json,model,confidence,degraded,created_at)
       values (?,?,?,?,?,?,?,?,?,?)`
    ).bind(`${refType}:${refId}:${now}`, refType, refId, appId || null,
      JSON.stringify(requestSummary || null), JSON.stringify(result.response || {}),
      result.model || null, result.confidence ?? null, result.degraded ? 1 : 0, now).run()
  }

  /** trace 诊断 */
  async function trace({ traceId, appId, preferOverseas }) {
    if (!traceId?.trim()) throw Object.assign(new Error('traceId 必填'), { status: 400 })
    const cachedResult = await cached('trace', traceId)
    if (cachedResult) return cachedResult
    const trace = await getDistributedTrace(db, traceId)
    if (!trace.errorSpans?.length && !(trace.nodes?.length)) {
      return { degraded: true, summary: '未找到该 trace 或其包含的错误事件', context: { trace } }
    }
    const errorEvents = await getErrorEvents(db, { traceId })
    const query = buildQuery({ trace, errorEvents })
    const kbResults = embedder ? await kb.search(query, { appId, topK: 8 }) : []
    const userPrompt = buildUserPrompt({ kind: 'trace', trace, errorEvents, kbResults })
    const { content, model, provider } = await gateway.route(SYSTEM_PROMPT, userPrompt, { preferOverseas })
    const parsed = parseModelOutput(content)
    const confidence = parsed.degraded ? null : avgConfidence(parsed.response)
    const kbHits = mapKbHits(kbResults)
    await store('trace', traceId, appId, { traceId }, { ...asResult(parsed.response), kbHits, model, provider, confidence, degraded: parsed.degraded })
    return { ...asResult(parsed.response), kbHits, model, provider, confidence, refId: traceId, degraded: parsed.degraded }
  }

  /** error 诊断（按 issue 指纹 / 错误文本） */
  async function error({ issueId, errorText, appId, preferOverseas }) {
    if (!issueId?.trim() && !errorText?.trim()) {
      throw Object.assign(new Error('issueId 或 errorText 必填'), { status: 400 })
    }
    const refId = issueId?.trim() || hashRef(String(errorText).trim())
    const cachedResult = await cached('error', String(refId))
    if (cachedResult) return cachedResult
    const issue = issueId ? await getIssue(db, issueId) : null
    const similarIssues = await getSimilarIssues(db, {
      name: issue?.name || guessName(errorText),
      message: issue?.message || errorText,
      appId,
      limit: 5
    })
    const kbResults = embedder ? await kb.search(issue?.message || errorText || ''.slice(0, 1000), { appId, topK: 8 }) : []
    const userPrompt = buildUserPrompt({ kind: 'error', issue: issue || { name: guessName(errorText), message: errorText, stack: '' }, similarIssues, kbResults })
    const { content, model, provider } = await gateway.route(SYSTEM_PROMPT, userPrompt, { preferOverseas })
    const parsed = parseModelOutput(content)
    const confidence = parsed.degraded ? null : avgConfidence(parsed.response)
    const kbHits = mapKbHits(kbResults)
    await store('error', String(refId), appId, { issueId, errorText: errorText?.slice(0, 500) }, { ...asResult(parsed.response), kbHits, model, provider, confidence, degraded: parsed.degraded })
    const out = { ...asResult(parsed.response), kbHits, model, provider, confidence, refId: String(refId), degraded: parsed.degraded }
    if (issue) out.issue = issue.fingerprint
    return out
  }

  return { trace, error, cached, store }
}

function buildQuery({ trace, errorEvents }) {
  const parts = []
  for (const e of (errorEvents || []).slice(0, 5)) parts.push(`${e.name || ''} ${e.message || ''}`)
  for (const n of (trace?.nodes || [])) if (n.hasError) parts.push(n.name)
  return parts.filter(Boolean).join(' ') || 'frontend error'
}

function guessName(text) {
  const m = String(text || '').match(/([A-Za-z]+(?:Error|Exception))/)
  return m ? m[1] : 'Error'
}

function hashRef(text) { return sha256(String(text || '')) }
function sha256(v) {
  // 无 node:crypto 依赖的轻量确定性 hash（仅用于缓存键）
  let h = 0
  const s = String(v)
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0 }
  return 'h' + (h >>> 0).toString(36)
}

function mapKbHits(kbResults) {
  return (kbResults || []).map(k => ({
    id: k.id,
    sourceType: k.source_type || '',
    sourceId: k.source_id || '',
    title: k.metadata?.title || k.source_id || k.id,
    score: Number(k.score ?? 0) || null
  }))
}

function avgConfidence(response) {
  const hs = response?.hypotheses || []
  if (!hs.length) return null
  const nums = hs.map(h => Number(h.confidence)).filter(Number.isFinite)
  return nums.length ? Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(3)) : null
}

function asResult(response) {
  return {
    summary: response.summary || '',
    hypotheses: response.hypotheses || [],
    suggestions: response.suggestions || [],
    relatedKb: response.relatedKb || [],
    ...(response.rawOutput ? { rawOutput: response.rawOutput } : {})
  }
}

function safeParse(v, fallback) { try { return typeof v === 'string' ? JSON.parse(v) : v ?? fallback } catch { return fallback } }

/** 模型输出解析失败时降级而非抛错（推理模型偶发输出非 JSON），保证诊断链路不中断 */
function parseModelOutput(content) {
  try {
    return { response: parseJsonOutput(content), degraded: false }
  } catch {
    return {
      degraded: true,
      response: {
        summary: '模型输出不可解析（已降级展示原始片段）',
        rawOutput: String(content || '').slice(0, 500),
        hypotheses: [],
        suggestions: [],
        relatedKb: []
      }
    }
  }
}
