/**
 * @file RAG 知识库：摄取 upsert + 检索 search（双后端）
 *
 * - 向量索引统一抽象为 `vectorStore`：
 *   - Cloudflare：包装 env.AI_KB（Vectorize）
 *   - Node/PG：pgvector 实现（apps/api 侧基于 pool 注入，见 apps/api/src/vector-store.js）
 *   vectorStore 接口：{ query(vec,{topK,filter}) -> [{id,score}], upsert([{id,values,metadata}]),
 *                       deleteByIds(ids) }
 * - 原文：始终存 DB 表 `ai_kb_chunks`（D1 / PG 都是该表），便于回取与展示来源。
 * - 增量：`ai_kb_meta.content_hash` 比对，变化才重嵌重写。
 *
 * 用法（由 diagnoser / rag-ingest.mjs 调用）：
 *   const kb = createKb({ db, vectorStore, embedder })
 *   await kb.search(query, { appId, topK })
 *   await kb.upsertDoc({ sourceType, sourceId, appId, text, metadata })
 */
export const KB_TABLE = 'ai_kb_chunks'
export const META_TABLE = 'ai_kb_meta'
export const KB_ELEMS = { table: KB_TABLE }

import { hash } from './db-adapter.js'

export function createKb({ db, vectorStore, embedder }) {
  async function search(query, { appId, topK = 8, limit = 5 } = {}) {
    if (!vectorStore) return []
    const vec = await embedder.embedText(query)
    const filter = appId ? { app_id: appId } : null
    const matches = await vectorStore.query(Array.isArray(vec) ? vec : vec.data, { topK, filter })
    if (!matches || !matches.length) return []
    const ids = matches.map(m => m.id).filter(Boolean)
    if (!ids.length) return []
    const placeholders = ids.map(() => '?').join(',')
    const rows = await db.prepare(`select * from ${KB_TABLE} where id in (${placeholders})`).bind(...ids).all()
    const byId = new Map(rows.map(r => [r.id, r]))
    return matches
      .map(m => byId.get(m.id) ? { ...byId.get(m.id), score: m.score } : null)
      .filter(Boolean)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit)
  }

  /** 写入一个 chunk：原文落 DB，向量入向量索引（经 vectorStore 双后端统一） */
  async function upsertChunk(c) {
    const now = Date.now()
    const metadataJson = JSON.stringify(c.metadata || null)
    await db.prepare(
      `insert into ${KB_TABLE} (id,source_type,source_id,app_id,chunk_idx,text,metadata_json,updated_at)
       values (?,?,?,?,?,?,?,?)
       on conflict(id) do update set text=excluded.text,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`
    ).bind(c.id, c.sourceType, c.sourceId, c.appId || null, c.chunkIdx, c.text, metadataJson, now).run()
    if (vectorStore) {
      const vec = await embedder.embedText(c.text)
      await vectorStore.upsert([{ id: c.id, values: vec, metadata: { app_id: c.appId || '', source_type: c.sourceType } }])
    }
  }

  async function removeBySource(sourceType, sourceId) {
    const rows = await db.prepare(`select id from ${KB_TABLE} where source_type=? and source_id=?`).bind(sourceType, sourceId).all()
    const ids = rows.map(r => r.id)
    await db.prepare(`delete from ${KB_TABLE} where source_type=? and source_id=?`).bind(sourceType, sourceId).run()
    // 同步清理 meta，避免列表出现「幽灵条目」（chunks 已删但 meta 残留）
    await db.prepare(`delete from ${META_TABLE} where source_type=? and source_id=?`).bind(sourceType, sourceId).run()
    if (vectorStore && ids.length) await vectorStore.deleteByIds(ids)
  }

  /** 单条 chunk 详情（原文 + metadata），供 /kb/chunk/:id */
  async function getChunk(id) {
    return db.prepare(`select * from ${KB_TABLE} where id=?`).bind(id).first()
  }

  /**
   * 全量摄取元数据列表（升级版）：join chunks 带出 title/excerpt/app_id，
   * 支持分页（page/pageSize）与 type/appId 过滤。供知识库列表页与统计概览。
   */
  async function listMeta({ page = 1, pageSize = 50, type = '', appId = '' } = {}) {
    const where = []
    const params = []
    if (type) { where.push('m.source_type=?'); params.push(type) }
    if (appId) { where.push('c.app_id=?'); params.push(appId) }
    const clause = where.length ? ` where ${where.join(' and ')}` : ''
    const totalRow = await db.prepare(
      `select count(distinct m.id) as n from ${META_TABLE} m left join ${KB_TABLE} c on c.source_type=m.source_type and c.source_id=m.source_id${clause}`
    ).bind(...params).first()
    const size = Math.max(1, Math.min(Number(pageSize) || 50, 200))
    const offset = (Math.max(1, Number(page) || 1) - 1) * size
    const rows = (await db.prepare(
      `select m.source_type, m.source_id, m.content_hash, m.version, m.updated_at,
              max(c.app_id) as app_id,
              max(coalesce(json_extract(c.metadata_json, '$.title'), null)) as title,
              max(substr(c.text, 1, 120)) as excerpt
         from ${META_TABLE} m left join ${KB_TABLE} c on c.source_type=m.source_type and c.source_id=m.source_id${clause}
        group by m.id, m.source_type, m.source_id, m.content_hash, m.version, m.updated_at
        order by m.updated_at desc limit ? offset ?`
    ).bind(...params, size, offset).all()) || []
    return { items: rows, total: Number(totalRow?.n ?? rows.length), page: Number(page) || 1, pageSize: size }
  }

  /** 统计概览：总数 + 按 source_type 计数 + 最近更新时间 */
  async function stats() {
    const rows = (await db.prepare(`select source_type, count(*) as n from ${META_TABLE} group by source_type`).all()) || []
    const byType = {}
    let total = 0
    for (const r of rows) { byType[r.source_type] = Number(r.n); total += Number(r.n) }
    const latest = await db.prepare(`select max(updated_at) as latest from ${META_TABLE}`).first()
    return { total, byType, latestUpdated: Number(latest?.latest ?? 0) || null }
  }

  /**
   * runbook 摄取：按 Markdown 标题切分入库（source_type='runbook'）。
   * 幂等：同 source 先删后写；返回 { ingested }。
   */
  async function ingestRunbook({ title, text, appId }) {
    const sourceId = `runbook:${hash(String(title || '')).slice(0, 12)}`
    await removeBySource('runbook', sourceId)
    const chunks = splitMarkdown(String(text || ''))
    if (!chunks.length) chunks.push({ title: title || '', text: String(text || '').trim() })
    for (let i = 0; i < chunks.length; i++) {
      const chunkTitle = chunks[i].title || title || ''
      const chunkText = `# ${chunkTitle}\n\n${chunks[i].text}`
      await upsertChunk({
        id: `${sourceId}:${hash(chunkText).slice(0, 12)}:${i}`,
        sourceType: 'runbook', sourceId, appId: appId || 'global', chunkIdx: i,
        text: chunkText, metadata: { title: chunkTitle, file: title || '' }
      })
    }
    await upsertMeta({ sourceType: 'runbook', sourceId, contentHash: hash(`${title}|${text}`), version: '1' })
    return { ok: true, sourceId, ingested: chunks.length }
  }

  /** 简易 Markdown 切分：按 1-4 级标题分块 */
  function splitMarkdown(raw) {
    const lines = String(raw).split('\n')
    const chunks = []
    let current = [], currentTitle = ''
    const push = () => {
      if (!current.length) return
      const t = current.join('\n').trim()
      if (t) chunks.push({ title: currentTitle, text: t })
      current = []
    }
    for (const line of lines) {
      const h = /^(#{1,4})\s+(.*)$/.exec(line)
      if (h) { push(); currentTitle = h[2].trim(); current.push(line); continue }
      current.push(line)
    }
    push()
    return chunks
  }

  /**
   * runbook 在线链接摄取：服务端抓取页面 → HTML 转纯文本 → 复用 ingestRunbook 切分入库。
   * 安全：仅允许 http(s)；拒绝内网/回环地址；30s 超时、1MB 大小上限；瞬时失败自动重试一次。
   */
  async function ingestRunbookFromUrl({ url, title, appId }) {
    let parsed
    try { parsed = new URL(String(url || '')) } catch { throw kbErr(400, 'URL 格式无效') }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw kbErr(400, '仅支持 http(s) 链接')
    }
    assertPublicHost(parsed.hostname)

    const text = await fetchPageTextWithRetry(parsed.href)
    const finalTitle = String(title || '').trim() || parsed.hostname
    return ingestRunbook({ title: finalTitle, text: text.trim(), appId })
  }

  function kbErr(status, message) { return Object.assign(new Error(message), { status }) }

  /** SSRF 防护：拒绝内网/回环/链路本地地址 */
  function assertPublicHost(hostname) {
    const host = String(hostname || '').toLowerCase()
    const blocked = host === 'localhost' || host === '0.0.0.0' || host.endsWith('.local')
      || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
      || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
      || host === '[::1]' || host.startsWith('fd') || host.startsWith('fe80')
    if (blocked) throw kbErr(400, '不允许抓取内网地址')
  }

  const PAGE_FETCH_TIMEOUT_MS = 30000

  /**
   * 单次抓取：携带浏览器特征头降低被站点 WAF 拦截概率；
   * 响应头与 body 读取共用同一个 30s 超时窗口（避免慢速滴流 body 挂死请求）。
   */
  async function fetchPageText(href) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), PAGE_FETCH_TIMEOUT_MS)
    let res
    try {
      res = await fetch(href, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          'accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
        }
      })
    } catch (e) {
      clearTimeout(timer)
      if (e?.name === 'AbortError') throw kbErr(504, `抓取超时(${PAGE_FETCH_TIMEOUT_MS / 1000}s)：页面响应过慢或被站点拦截`)
      throw kbErr(502, `抓取失败：${String(e?.message || e).slice(0, 80)}`)
    }
    if (!res.ok) { clearTimeout(timer); throw kbErr(502, `抓取失败：HTTP ${res.status}`) }

    const len = Number(res.headers.get('content-length') || 0)
    if (len > 1024 * 1024) { clearTimeout(timer); throw kbErr(413, '页面超过 1MB 上限') }
    let raw
    try {
      raw = await res.text()
    } catch (e) {
      clearTimeout(timer)
      if (e?.name === 'AbortError') throw kbErr(504, `读取页面内容超时(${PAGE_FETCH_TIMEOUT_MS / 1000}s)`)
      throw kbErr(502, `读取页面失败：${String(e?.message || e).slice(0, 80)}`)
    }
    clearTimeout(timer)
    if (raw.length > 1024 * 1024 * 1.2) throw kbErr(413, '页面超过 1MB 上限')

    const contentType = res.headers.get('content-type') || ''
    return /html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(raw) ? htmlToText(raw) : raw
  }

  /** 瞬时失败（超时/网络错误/远端 5xx）自动重试一次；URL 参数问题与远端 4xx 不重试 */
  async function fetchPageTextWithRetry(href) {
    let lastErr
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await fetchPageText(href)
      } catch (e) {
        lastErr = e
        const status = e?.status
        const retriable = status === 504 || status === 502 && !/^抓取失败：HTTP 4/.test(String(e?.message))
        if (!retriable || attempt === 2) throw e
        await new Promise(r => setTimeout(r, 800))
      }
    }
    throw lastErr
  }

  /** 极简 HTML → 纯文本：去 script/style、块级标签换行、解实体、压空白 */
  function htmlToText(html) {
    let s = String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)\b[^>]*>/gi, '\n')
      .replace(/<h([1-4])\b[^>]*>/gi, '\n## ')
      .replace(/<[^>]+>/g, ' ')
    s = s.replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    return s.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n')
  }

  async function getMeta(sourceType, sourceId) {
    return db.prepare(`select * from ${META_TABLE} where source_type=? and source_id=?`).bind(sourceType, sourceId).first()
  }

  async function upsertMeta({ sourceType, sourceId, contentHash, version }) {
    const now = Date.now()
    await db.prepare(
      `insert into ${META_TABLE} (id,source_type,source_id,content_hash,version,updated_at)
       values (?,?,?,?,?,?)
       on conflict(id) do update set content_hash=excluded.content_hash,version=excluded.version,updated_at=excluded.updated_at`
    ).bind(`${sourceType}:${sourceId}`, sourceType, sourceId, contentHash, version || null, now).run()
  }

  return { search, upsertChunk, removeBySource, getMeta, upsertMeta, getChunk, listMeta, stats, ingestRunbook, ingestRunbookFromUrl }
}
