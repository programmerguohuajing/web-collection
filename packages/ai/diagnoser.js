/**
 * @file AI 诊断编排器（双后端共享）
 *
 * 组装：context（queries）+ rag（kb.search）+ model-gateway.route + 落库 ai_diagnoses + 缓存。
 * db 由 db-adapter 构造；kb 由 packages/ai/kb.js createKb 构造；gateway 由 model-gateway 构造。
 * 缓存策略：同 ref_id 10 分钟内复用，省成本。
 *
 * P0 产品化：解耦「错误前提」——trace 诊断不再因无错误而整体降级；新增统一入口
 * `diagnose({scope,ref,...})`，scope ∈ {trace, perf, session, release}（ask 留待 P2）。
 */
import { getDistributedTrace, getErrorEvents, getIssue, getSimilarIssues, getTrace, getSessionEvents, getReleaseStats, getPreviousRelease, getErrorClusters, getPerfWindow, getVolumeWindow } from './queries.js'
import { SYSTEM_PROMPT, ASK_SYSTEM_PROMPT, buildUserPrompt } from './prompt.js'
import { parseJsonOutput } from './model-gateway.js'
import { createConversationStore } from './conversation.js'

const HOUR = 3600 * 1000

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

  /** 统一入口：按 scope 路由（P0 产品化） */
  async function diagnose({ scope, ref, appId, preferOverseas, conversationId, finding }) {
    const s = String(scope || 'trace').toLowerCase()
    if (s === 'finding') return deepDiagnoseFinding(finding || ref, { appId, preferOverseas, conversationId })
    if (!ref?.trim()) throw Object.assign(new Error('ref 必填（traceId / sessionId / release 名称 / 问题文本）'), { status: 400 })
    if (s === 'trace' || s === 'perf') return trace({ traceId: ref, appId, preferOverseas, perfOnly: s === 'perf' })
    if (s === 'session') return session({ sessionId: ref, appId, preferOverseas })
    if (s === 'release') return release({ releaseName: ref, appId, preferOverseas })
    if (s === 'ask') return ask({ question: ref, appId, preferOverseas, conversationId })
    throw Object.assign(new Error(`不支持的 scope: ${scope}`), { status: 400 })
  }

  /**
   * 洞察深诊断：把 P1 主动扫描产出的洞察（四类 scope）映射到 P0 引擎。
   * - release-regression → release（对比上一版）
   * - error-cluster      → error（按错误名做相似 issue 检索）
   * - perf-regression / metric-drop → ask（无专属引擎，注入洞察结论+证据做根因分析）
   */
  async function deepDiagnoseFinding(finding, { appId, preferOverseas, conversationId }) {
    if (!finding || !finding.scope) throw Object.assign(new Error('finding 必填（含 scope / object / summary / evidence）'), { status: 400 })
    const sc = String(finding.scope).toLowerCase()
    if (sc === 'release-regression') {
      if (!finding.object?.trim()) throw Object.assign(new Error('该洞察缺少发布版本对象'), { status: 400 })
      return release({ releaseName: finding.object, appId, preferOverseas })
    }
    if (sc === 'error-cluster') {
      if (!finding.object?.trim()) throw Object.assign(new Error('该洞察缺少错误对象'), { status: 400 })
      return error({ errorText: finding.object, appId, preferOverseas })
    }
    if (sc === 'perf-regression' || sc === 'metric-drop') {
      const question = buildFindingQuestion(finding)
      const a = await ask({ question, appId, preferOverseas, conversationId })
      // 归一化为诊断渲染结构（answer 同时保留，供助手页引用）
      return { ...a, summary: a.answer, hypotheses: [], suggestions: [] }
    }
    throw Object.assign(new Error(`不支持的洞察类型: ${finding.scope}`), { status: 400 })
  }

  /** 把洞察结论+证据拼成自然语言问题，供 ask 做根因分析 */
  function buildFindingQuestion(finding) {
    const ev = Array.isArray(finding.evidence) && finding.evidence.length
      ? finding.evidence.map(e => `- ${e}`).join('\n')
      : '（无结构化证据）'
    const scopeLabel = {
      'perf-regression': '性能退化',
      'metric-drop': '关键指标骤降'
    }[finding.scope] || finding.scope
    return `这是一条系统主动发现的「${scopeLabel}」洞察。\n\n结论：${finding.summary || ''}\n\n证据：\n${ev}\n\n请基于现有遥测数据，给出最可能的根因假设（按置信度排序）与可执行的排查/修复建议；若数据不足以定位，请明确说明缺什么证据。`
  }

  /** trace 诊断（解耦错误前提） */
  async function trace({ traceId, appId, preferOverseas, perfOnly }) {
    if (!traceId?.trim()) throw Object.assign(new Error('traceId 必填'), { status: 400 })
    const refType = perfOnly ? 'perf' : 'trace'
    const cachedResult = await cached(refType, traceId)
    if (cachedResult) return cachedResult
    const trace = await getDistributedTrace(db, traceId)
    // P0 解耦：曾在此硬门槛无错误即整体降级；现改为「无节点才降级，有节点即分析」。
    if (!trace.nodes?.length) {
      return { degraded: true, summary: '未找到该 trace 或其包含的事件', context: { trace } }
    }
    const hasErrors = !!trace.errorSpans?.length
    const errorEvents = hasErrors ? await getErrorEvents(db, { traceId }) : []
    const perfContext = buildPerfContext(trace)
    const scope = perfOnly ? 'perf' : 'trace'
    const query = buildQuery({ scope, trace, errorEvents })
    const kbResults = embedder ? await kb.search(query, { appId, topK: 8 }) : []
    const userPrompt = buildUserPrompt({ scope, trace, perfContext, errorEvents, kbResults })
    const { content, model, provider } = await gateway.route(SYSTEM_PROMPT, userPrompt, { preferOverseas })
    const parsed = parseModelOutput(content)
    const confidence = parsed.degraded ? null : avgConfidence(parsed.response)
    const kbHits = mapKbHits(kbResults)
    await store(refType, traceId, appId, { traceId, scope }, { ...asResult(parsed.response), kbHits, model, provider, confidence, degraded: parsed.degraded })
    return { ...asResult(parsed.response), kbHits, model, provider, confidence, refId: traceId, degraded: parsed.degraded }
  }

  /** session 诊断（单会话聚合分析） */
  async function session({ sessionId, appId, preferOverseas }) {
    if (!sessionId?.trim()) throw Object.assign(new Error('sessionId 必填'), { status: 400 })
    const cachedResult = await cached('session', sessionId)
    if (cachedResult) return cachedResult
    const events = await getSessionEvents(db, sessionId, appId)
    if (!events?.length) return { degraded: true, summary: '该会话无事件数据', context: { sessionId } }
    const sessionContext = buildSessionContext(events)
    const query = buildQuery({ scope: 'session', sessionContext })
    const kbResults = embedder ? await kb.search(query, { appId, topK: 8 }) : []
    const userPrompt = buildUserPrompt({ scope: 'session', sessionContext, kbResults })
    const { content, model, provider } = await gateway.route(SYSTEM_PROMPT, userPrompt, { preferOverseas })
    const parsed = parseModelOutput(content)
    const confidence = parsed.degraded ? null : avgConfidence(parsed.response)
    const kbHits = mapKbHits(kbResults)
    await store('session', sessionId, appId, { sessionId }, { ...asResult(parsed.response), kbHits, model, provider, confidence, degraded: parsed.degraded })
    return { ...asResult(parsed.response), kbHits, model, provider, confidence, refId: sessionId, degraded: parsed.degraded }
  }

  /** release 诊断（版本对比分析） */
  async function release({ releaseName, appId, preferOverseas }) {
    if (!releaseName?.trim()) throw Object.assign(new Error('release 必填'), { status: 400 })
    const cachedResult = await cached('release', releaseName)
    if (cachedResult) return cachedResult
    const stats = await getReleaseStats(db, releaseName, appId)
    if (!stats || !stats.total) return { degraded: true, summary: '该版本无事件数据', context: { releaseName } }
    const prev = await getPreviousRelease(db, releaseName, appId)
    const prevStats = prev ? await getReleaseStats(db, prev.release_name, appId) : null
    const releaseContext = buildReleaseContext(stats, prevStats, prev)
    const query = buildQuery({ scope: 'release', releaseContext })
    const kbResults = embedder ? await kb.search(query, { appId, topK: 8 }) : []
    const userPrompt = buildUserPrompt({ scope: 'release', releaseContext, kbResults })
    const { content, model, provider } = await gateway.route(SYSTEM_PROMPT, userPrompt, { preferOverseas })
    const parsed = parseModelOutput(content)
    const confidence = parsed.degraded ? null : avgConfidence(parsed.response)
    const kbHits = mapKbHits(kbResults)
    await store('release', releaseName, appId, { releaseName }, { ...asResult(parsed.response), kbHits, model, provider, confidence, degraded: parsed.degraded })
    return { ...asResult(parsed.response), kbHits, model, provider, confidence, refId: releaseName, degraded: parsed.degraded }
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
    const userPrompt = buildUserPrompt({ scope: 'error', issue: issue || { name: guessName(errorText), message: errorText, stack: '' }, similarIssues, kbResults })
    const { content, model, provider } = await gateway.route(SYSTEM_PROMPT, userPrompt, { preferOverseas })
    const parsed = parseModelOutput(content)
    const confidence = parsed.degraded ? null : avgConfidence(parsed.response)
    const kbHits = mapKbHits(kbResults)
    await store('error', String(refId), appId, { issueId, errorText: errorText?.slice(0, 500) }, { ...asResult(parsed.response), kbHits, model, provider, confidence, degraded: parsed.degraded })
    const out = { ...asResult(parsed.response), kbHits, model, provider, confidence, refId: String(refId), degraded: parsed.degraded }
    if (issue) out.issue = issue.fingerprint
    return out
  }

  /** ask 诊断（P2 对话式助手：自然语言问答 + 轻量聚合工具 + 多轮记忆） */
  async function ask({ question, appId, preferOverseas, conversationId }) {
    if (!question?.trim()) throw Object.assign(new Error('question 必填'), { status: 400 })
    const store = createConversationStore(db)
    const conv = conversationId?.trim() ? await store.get(conversationId.trim()) : null
    const history = conv?.messages || []
    const contextText = await retrieveContext(question, appId)
    const kbResults = embedder ? await kb.search(question, { appId, topK: 6 }) : []
    const kbBlock = kbResults.length
      ? '## 知识库片段\n' + kbResults.map(k => `- [${k.metadata?.title || k.source_id}](${k.score != null ? k.score.toFixed(2) : ''}) ${String(k.text || '').slice(0, 400)}`).join('\n')
      : ''
    const historyBlock = history.length ? '## 对话历史\n' + history.map(m => `${m.role}: ${m.content}`).join('\n') : ''
    const userPrompt = `用户问题：${question}\n\n## 可观测上下文（自动聚合）\n${contextText}\n\n${kbBlock}\n\n${historyBlock}\n\n请基于以上给出简洁、有证据支撑的回答；若数据不足请明确说明。`
    const { content, model, provider } = await gateway.route(ASK_SYSTEM_PROMPT, userPrompt, { preferOverseas, jsonMode: false })
    let cid = conv?.id
    if (cid) {
      await store.append(cid, { role: 'user', content: question })
      await store.append(cid, { role: 'assistant', content })
    } else {
      cid = await store.create({ appId, title: question.slice(0, 40), messages: [{ role: 'user', content: question }, { role: 'assistant', content }] })
    }
    return {
      conversationId: cid,
      answer: content,
      model,
      messages: [...history, { role: 'user', content: question }, { role: 'assistant', content }]
    }
  }

  /** 轻量工具调用：从问题中解析时间窗并聚合关键指标，注入 prompt（不调用 LLM） */
  async function retrieveContext(question, appId) {
    const sinceTs = Date.now() - 24 * HOUR
    const [clusters, perf, vol] = await Promise.all([
      getErrorClusters(db, { appId, sinceTs, limit: 3 }),
      getPerfWindow(db, { appId, fromTs: sinceTs }),
      getVolumeWindow(db, { appId, fromTs: sinceTs })
    ])
    const parts = [`近 24h 事件量(非错误): ${vol}`]
    if (perf.count) parts.push(`近 24h 性能均值: ${perf.avg?.toFixed(1)}ms（样本 ${perf.count}）`)
    if (clusters.length) parts.push('近 24h 错误簇: ' + clusters.map(c => `${c.name}（${c.count} 次 / 影响 ${c.affected} 人）`).join('；'))
    return parts.join('\n')
  }

  return { trace, error, diagnose, ask, cached, store }
}

// ---------------- 上下文构建 ----------------

/** 性能链路上下文：慢节点（按耗时降序）+ 关键路径 */
function buildPerfContext(trace) {
  const slowNodes = [...(trace.nodes || [])]
    .filter(n => Number(n.duration) > 0)
    .sort((a, b) => Number(b.duration) - Number(a.duration))
    .slice(0, 10)
    .map(n => ({ id: n.id, name: n.name, service: n.service, duration: n.duration, status: n.status }))
  return { slowNodes, criticalPath: trace.criticalPath || [], hasErrors: !!trace.errorSpans?.length }
}

/** 会话聚合上下文：按类型计数、错误/性能指标、关键错误样本 */
function buildSessionContext(events) {
  const byType = {}
  let errorCount = 0, perfCount = 0, perfSum = 0
  const userAgent = events[0]?.userAgent || ''
  const deviceId = events[0]?.deviceId || ''
  const urls = []
  for (const e of events) {
    byType[e.type] = (byType[e.type] || 0) + 1
    if (e.type === 'error') errorCount++
    if (e.type === 'perf') { perfCount++; if (Number(e.value) > 0) perfSum += Number(e.value) }
    if (e.url && !urls.includes(e.url)) urls.push(e.url)
  }
  const perfAvg = perfCount ? Number((perfSum / perfCount).toFixed(2)) : null
  const tsList = events.map(e => Number(e.ts)).filter(Number.isFinite)
  const durationMs = tsList.length ? Number(Math.max(...tsList) - Math.min(...tsList)) : 0
  return {
    eventCount: events.length,
    byType,
    errorCount,
    perfCount,
    perfAvg,
    userAgent,
    deviceId,
    durationMs,
    urls: urls.slice(0, 10),
    errors: events.filter(e => e.type === 'error').slice(0, 5).map(e => ({ id: e.id, name: e.name, message: String(e.message || '').slice(0, 200), url: e.url }))
  }
}

/** 版本对比上下文：当前 vs 上一版本，含变化率 */
function buildReleaseContext(stats, prevStats, prev) {
  const delta = {}
  if (prevStats) {
    delta.total = diffPct(stats.total, prevStats.total)
    delta.errors = diffPct(stats.errors, prevStats.errors)
    delta.perf = (prevStats.perfAvg != null && stats.perfAvg != null) ? diffPct(stats.perfAvg, prevStats.perfAvg) : null
  }
  return { current: stats, previous: prevStats, previousName: prev?.release_name || null, delta }
}

function diffPct(cur, prev) {
  if (prev == null || prev === 0) return null
  return Number((((cur - prev) / prev) * 100).toFixed(1))
}

// ---------------- RAG 检索 query（scope 感知） ----------------

function buildQuery({ scope, trace, errorEvents, sessionContext, releaseContext }) {
  const parts = []
  if (scope === 'trace' || scope === 'perf') {
    if ((errorEvents || []).length) {
      for (const e of errorEvents.slice(0, 5)) parts.push(`${e.name || ''} ${e.message || ''}`)
    } else if (trace?.nodes?.length) {
      const slow = [...trace.nodes].filter(n => Number(n.duration) > 0).sort((a, b) => Number(b.duration) - Number(a.duration)).slice(0, 5)
      for (const n of slow) parts.push(`${n.name} ${n.duration}ms`)
      for (const n of (trace.nodes || [])) if (n.hasError) parts.push(n.name)
    }
  } else if (scope === 'session') {
    if (sessionContext?.errors) for (const e of sessionContext.errors.slice(0, 5)) parts.push(`${e.name || ''} ${e.message || ''}`)
    parts.push(`session events=${sessionContext?.eventCount || 0} errors=${sessionContext?.errorCount || 0}`)
  } else if (scope === 'release') {
    parts.push(`release ${releaseContext?.current?.release || ''} errors=${releaseContext?.current?.errors || 0}`)
    if (releaseContext?.previousName) parts.push(`previous ${releaseContext.previousName}`)
  }
  return parts.filter(Boolean).join(' ') || 'frontend telemetry'
}

// ---------------- 工具函数 ----------------

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
