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
export const ARTICLE_TABLE = 'ai_kb_articles'
export const QUALITY_TABLE = 'ai_kb_quality'
export const HISTORY_TABLE = 'ai_kb_history'
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

  /** 按 source 维度取第一条 chunk（确定性定位，不依赖向量检索），供 /kb/locate */
  async function getFirstChunkBySource(sourceType, sourceId) {
    return db.prepare(
      `select * from ${KB_TABLE} where source_type=? and source_id=? order by chunk_idx asc limit 1`
    ).bind(String(sourceType || ''), String(sourceId || '')).first() || null
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
    // json 提取方言：PG 的 metadata_json 为 jsonb（->> 操作符），D1/SQLite 用 json_extract
    const titleExpr = db.dialect === 'postgres'
      ? `max(c.metadata_json ->> 'title') as title`
      : `max(coalesce(json_extract(c.metadata_json, '$.title'), null)) as title`
    const rows = (await db.prepare(
      `select m.source_type, m.source_id, m.content_hash, m.version, m.updated_at,
              max(c.app_id) as app_id,
              ${titleExpr},
              max(substr(c.text, 1, 120)) as excerpt
         from ${META_TABLE} m left join ${KB_TABLE} c on c.source_type=m.source_type and c.source_id=m.source_id${clause}
        group by m.id, m.source_type, m.source_id, m.content_hash, m.version, m.updated_at
        order by m.updated_at desc limit ? offset ?`
    ).bind(...params, size, offset).all()) || []
    return { items: rows, total: Number(totalRow?.n ?? rows.length), page: Number(page) || 1, pageSize: size }
  }

  /**
   * 知识摄取：按 Markdown 标题切分入库，默认 source_type='runbook'，可传 'doc' 等。
   * 幂等：同 source 先删后写；返回 { ingested, indexed }。
   * sourceId 可选：URL 模式传入基于 URL 的固定 id，避免同域不同文章互相覆盖。
   *
   * 性能（CF Worker subrequest 限额关键）：原文 D1 batch 一次写入，
   * 向量「单次批量嵌入 + 单次 upsert」——远程调用次数与 chunk 数解耦。
   */
  async function ingestRunbook({ title, text, appId, sourceId, sourceType = 'runbook' }) {
    const st = String(sourceType || 'runbook')
    const sid = sourceId || `${st}:${hash(String(title || '')).slice(0, 12)}`
    await removeBySource(st, sid)
    const chunks = splitMarkdown(String(text || ''))
    if (!chunks.length) chunks.push({ title: title || '', text: String(text || '').trim() })

    const items = chunks.map((c, i) => {
      const chunkTitle = c.title || title || ''
      const chunkText = `# ${chunkTitle}\n\n${c.text}`
      return {
        id: `${sid}:${hash(chunkText).slice(0, 12)}:${i}`,
        sourceType: st, sourceId: sid, appId: appId || 'global', chunkIdx: i,
        text: chunkText, metadata: { title: chunkTitle, file: title || '' }
      }
    })
    await putChunks(items)
    const indexed = await indexChunkVectors(items)
    await upsertMeta({ sourceType: st, sourceId: sid, contentHash: hash(`${title}|${text}`), version: '1' })
    return { ok: true, sourceId: sid, ingested: items.length, indexed }
  }

  /**
   * 批量向量写入：单次批量嵌入 + 单次 upsert。
   * 失败静默降级（返回 0）：原文已落库可正常浏览/删除，仅语义检索暂时不可用。
   */
  async function indexChunkVectors(items) {
    if (!vectorStore || !embedder || !items.length) return 0
    let vecs
    try {
      vecs = await embedder.embedBatch(items.map(it => it.text))
      if (!Array.isArray(vecs) || vecs.length !== items.length) return 0
      await vectorStore.upsert(items.map((it, i) => ({
        id: it.id, values: vecs[i], metadata: { app_id: it.appId || '', source_type: it.sourceType }
      })))
      return items.length
    } catch { return 0 }
  }

  /**
   * 批量落库：优先 db.batch（D1 多语句一次往返、subrequest 计 1），
   * 无 batch 能力的注入实现退化为单条并发写。
   */
  async function putChunks(items) {
    if (!items.length) return
    const now = Date.now()
    const sql = `insert into ${KB_TABLE} (id,source_type,source_id,app_id,chunk_idx,text,metadata_json,updated_at)
         values (?,?,?,?,?,?,?,?)
         on conflict(id) do update set text=excluded.text,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`
    if (typeof db.batch === 'function') {
      await db.batch(items.map(c => ({
        sql,
        values: [c.id, c.sourceType, c.sourceId, c.appId || null, c.chunkIdx, c.text, JSON.stringify(c.metadata || null), now]
      })))
      return
    }
    await Promise.all(items.map(c => upsertChunk(c)))
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
   * sourceId 固定取 URL 哈希：同域不同文章互不覆盖；同一链接重复抓取为幂等更新。
   */
  async function ingestRunbookFromUrl({ url, title, appId, sourceType = 'runbook' }) {
    let parsed
    try { parsed = new URL(String(url || '')) } catch { throw kbErr(400, 'URL 格式无效') }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw kbErr(400, '仅支持 http(s) 链接')
    }
    assertPublicHost(parsed.hostname)

    const { text, docTitle } = await fetchPageTextWithRetry(parsed.href)
    // 标题优先级：手填 > 页面 <title> > host+path（hostname 会令同域文章互相覆盖，仅作最后兜底）
    const pathFallback = `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`.replace(/\/+$/, '')
    const finalTitle = String(title || '').trim() || docTitle || pathFallback
    const st = String(sourceType || 'runbook')
    const sid = `${st}:url:${hash(parsed.href).slice(0, 12)}`
    return ingestRunbook({ title: finalTitle, text: text.trim(), appId, sourceId: sid, sourceType: st })
  }

  function kbErr(status, message) { const e = Object.assign(new Error(message), { status }); e.statusCode = status; return e }

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

  /** 反爬挑战页特征：Cloudflare/Nginx/应用层 WAF 的 JS 挑战、人机校验与拒绝访问占位页 */
  const CHALLENGE_RE = /just a moment|please wait|checking your browser|verify you are (?:human|browser)|attention required|access denied|enable javascript|ddos protection|captcha/i

  /**
   * 单次抓取：携带浏览器特征头降低被站点 WAF 拦截概率；
   * 响应头与 body 读取共用同一个 30s 超时窗口（避免慢速滴流 body 挂死请求）。
   * minimalHeaders：不发送任何自定义头，用运行时默认 UA —— 部分站点（如掘金）
   * 反而会针对"伪装浏览器头但无 JS 指纹"的请求下发挑战页，裸 fetch 能拿到完整 SSR 页面。
   */
  async function fetchPageText(href, { minimalHeaders = false } = {}) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), PAGE_FETCH_TIMEOUT_MS)
    let res
    try {
      res = await fetch(href, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: minimalHeaders ? undefined : {
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
    const isHtml = /html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(raw)
    const text = isHtml ? extractBodyText(raw) : raw
    const docTitle = isHtml ? extractHtmlTitle(raw) : ''

    // 有效性校验：拦截反爬挑战页、SPA 骨架页与空内容，避免把按钮/导航等噪音当作知识入库
    const trimmedLen = text.trim().length
    const skeletonLike = isHtml && raw.length > 20 * 1024 && trimmedLen < 500
    if (trimmedLen < 100 || skeletonLike || CHALLENGE_RE.test(docTitle) || CHALLENGE_RE.test(text.slice(0, 600))) {
      throw kbErr(422, skeletonLike
        ? '该页面为前端渲染（SPA），静态抓取只能获得页面骨架，请改用「上传文件」方式录入'
        : '未抓取到有效正文：该页面疑似被站点防护拦截或无可提取正文，请改用「上传文件」方式录入')
    }
    return { text, docTitle }
  }

  /** 提取 <title> 文本作为 URL 模式的默认标题 */
  function extractHtmlTitle(html) {
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html))
    if (!m) return ''
    return m[1].replace(/\s+/g, ' ').trim().slice(0, 120)
  }

  /**
   * 瞬时失败（超时/网络错误/远端 5xx）自动重试一次；URL 参数问题与远端 4xx 不重试。
   * 挑战页（422）先用最小请求头重试一次 —— 部分站点对"伪浏览器头无 JS 指纹"的
   * 请求下发挑战，裸 fetch 反而能拿到完整 SSR 页面；仍失败再抛给用户。
   */
  async function fetchPageTextWithRetry(href) {
    let lastErr
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await fetchPageText(href, { minimalHeaders: attempt === 2 })
      } catch (e) {
        lastErr = e
        const status = e?.status
        if (status === 422 && attempt === 1) continue // 挑战页 → 换最小头再试
        const retriable = status === 504 || status === 502 && !/^抓取失败：HTTP 4/.test(String(e?.message))
        if (!retriable || attempt === 2) throw e
        await new Promise(r => setTimeout(r, 800))
      }
    }
    throw lastErr
  }

  /**
   * 正文提取：优先 <article>/<main> 容器（聚焦正文、排除推荐/评论等外围），
   * 容器文本过短（<40% 全文）时回退全文。两路均经过 htmlToText 的噪音剔除。
   */
  function extractBodyText(raw) {
    const full = htmlToText(raw)
    for (const re of [/<article[^>]*>([\s\S]*?)<\/article>/i, /<main[^>]*>([\s\S]*?)<\/main>/i]) {
      const m = re.exec(String(raw))
      if (!m) continue
      try {
        const part = htmlToText(m[1])
        if (part.length >= Math.max(200, full.length * 0.4)) return part
      } catch { break }
    }
    return full
  }

  /**
   * HTML → 纯文本：去 script/style 与注释；整块剔除导航/页头尾/侧栏/表单控件/
   * 按钮/SVG 等非正文结构 —— 否则 SPA 骨架或 SSR 外壳会采出一堆「按钮文案」。
   */
  function htmlToText(html) {
    let s = String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(nav|header|footer|aside|form|button|select|option|label|svg|noscript|iframe|template)[\s\S]*?<\/\1\s*>/gi, '\n')
      .replace(/<(input|img|hr)\b[^>]*>/gi, '\n')
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

  /* ============ Article 模型（知识中枢 source of truth） ============ */
  // 概念：以 Article 为主对象，body 为可编辑权威正文；chunk 由其自动派生并向量化，
  // diagnoser 仍走 ai_kb_chunks。遗留来源（无 article 行）在列表/详情中合成，编辑即「升级」为可治理 Article。

  function parseJsonArr(x) { try { return x ? JSON.parse(x) : [] } catch { return [] } }
  function safeParse(x) { try { return x ? JSON.parse(x) : null } catch { return null } }
  function toVersion(v) { return 'v' + (Number(v) || 1) }

  async function getArticleRow(id) {
    return db.prepare(`select * from ${ARTICLE_TABLE} where id=?`).bind(id).first()
  }
  async function metaTypeOf(id) {
    const r = await db.prepare(`select source_type from ${META_TABLE} where source_id=? limit 1`).bind(id).first()
    return r?.source_type || null
  }

  /**
   * 列表（治理台全量 / 帮助中心 publicOnly）。
   * 合并「已治理 Article」与「遗留来源（无 article 行）」，统一字段形态供前端；
   * publicOnly=true 时仅返回 visibility=public 的 Article（帮助中心脱敏只读）。
   */
  async function listArticles({ page = 1, pageSize = 50, type = '', visibility = '', status = '', appScope = '', publicOnly = false, searchTerm = '' } = {}) {
    const where = []
    const params = []
    if (type) { where.push('a.type=?'); params.push(type) }
    if (publicOnly) { where.push('a.visibility=?'); params.push('public') }
    else if (visibility) { where.push('a.visibility=?'); params.push(visibility) }
    if (status) { where.push('a.status=?'); params.push(status) }
    if (appScope) { where.push('a.app_scope=?'); params.push(appScope) }
    if (searchTerm) { where.push('(a.title like ? or a.body like ?)'); params.push(`%${searchTerm}%`, `%${searchTerm}%`) }
    const clause = where.length ? 'where ' + where.join(' and ') : ''
    const totalRow = await db.prepare(`select count(*) as n from ${ARTICLE_TABLE} a ${clause}`).bind(...params).first()
    const size = Math.max(1, Math.min(Number(pageSize) || 50, 200))
    const offset = (Math.max(1, Number(page) || 1) - 1) * size
    const rows = (await db.prepare(
      `select a.id,a.title,a.type,a.visibility,a.status,a.app_scope,a.version,a.updated_at,a.tags_json,a.linked_errors_json,
              coalesce(q.ai_citations,0) as ai_citations, q.useful_rate, coalesce(q.feedback_count,0) as feedback_count
         from ${ARTICLE_TABLE} a left join ${QUALITY_TABLE} q on q.article_id=a.id
         ${clause} order by a.updated_at desc limit ? offset ?`
    ).bind(...params, size, offset).all()) || []
    const items = rows.map(a => ({
      id: a.id, chunkId: null, source_type: a.type, source_id: a.id, app: a.app_scope,
      title: a.title, excerpt: String(a.body || '').slice(0, 120), updatedAt: Number(a.updated_at || 0),
      visibility: a.visibility, status: a.status, version: toVersion(a.version),
      quality: { aiCitations: Number(a.ai_citations || 0), helpfulRate: a.useful_rate ?? null, feedbackCount: Number(a.feedback_count || 0) },
      linkedErrors: parseJsonArr(a.linked_errors_json), body: null, legacy: false
    }))
    let legacy = []
    if (!publicOnly) legacy = await listLegacySources({ type, appScope, searchTerm })
    return { items: items.concat(legacy), total: Number(totalRow?.n ?? 0) + legacy.length, page: Number(page) || 1, pageSize: size }
  }

  async function listLegacySources({ type = '', appScope = '', searchTerm = '' } = {}) {
    const where = ["not exists (select 1 from ai_kb_articles a where a.id = m.source_id)"]
    const params = []
    if (type) { where.push('m.source_type=?'); params.push(type) }
    if (appScope) { where.push('c.app_id=?'); params.push(appScope) }
    if (searchTerm) { where.push('m.source_id like ?'); params.push(`%${searchTerm}%`) }
    const titleExpr = db.dialect === 'postgres'
      ? `max(c.metadata_json ->> 'title') as title`
      : `max(coalesce(json_extract(c.metadata_json, '$.title'), null)) as title`
    const rows = (await db.prepare(
      `select m.source_type, m.source_id, m.version, m.updated_at, max(c.app_id) as app_id, ${titleExpr}, max(substr(c.text,1,120)) as excerpt
         from ${META_TABLE} m left join ${KB_TABLE} c on c.source_type=m.source_type and c.source_id=m.source_id
         where ${where.join(' and ')} group by m.source_type, m.source_id, m.version, m.updated_at`
    ).bind(...params).all()) || []
    return rows.map(r => ({
      id: r.source_id, chunkId: null, source_type: r.source_type, source_id: r.source_id, app: r.app_id || 'global',
      title: r.title || r.source_id, excerpt: r.excerpt || '', updatedAt: Number(r.updated_at || 0),
      visibility: 'internal', status: 'published', version: toVersion(r.version || 1),
      quality: { aiCitations: null, helpfulRate: null, feedbackCount: 0 }, linkedErrors: [], body: null, legacy: true
    }))
  }

  /** 详情：优先 article 行；无则按遗留来源合成（body 由 chunk 拼接，保留被治理前的可读性） */
  async function getArticle(id) {
    const row = await getArticleRow(id)
    if (row) {
      const q = await db.prepare(`select * from ${QUALITY_TABLE} where article_id=?`).bind(id).first()
      const hist = (await db.prepare(`select version,editor,note,created_at from ${HISTORY_TABLE} where article_id=? order by version desc limit 10`).bind(id).all()) || []
      return {
        id: row.id, slug: row.slug, title: row.title, type: row.type, body: row.body || '',
        visibility: row.visibility, status: row.status, appScope: row.app_scope, owner: row.owner,
        tags: parseJsonArr(row.tags_json), linkedErrors: parseJsonArr(row.linked_errors_json),
        source: safeParse(row.source_json), version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
        quality: q ? { aiCitations: q.ai_citations || 0, upCount: q.up_count || 0, downCount: q.down_count || 0, usefulRate: q.useful_rate, feedbackCount: q.feedback_count || 0, lastCitedAt: q.last_cited_at } : null,
        history: hist, legacy: false, chunkId: null
      }
    }
    const meta = await db.prepare(`select source_type, source_id from ${META_TABLE} where source_id=? limit 1`).bind(id).first()
    if (!meta) return null
    const chunks = (await db.prepare(`select id, text, chunk_idx, metadata_json, app_id from ${KB_TABLE} where source_type=? and source_id=? order by chunk_idx`).bind(meta.source_type, meta.source_id).all()) || []
    const body = chunks.map(c => c.text).join('\n\n')
    let title = meta.source_id
    try { const m = chunks[0]?.metadata_json ? JSON.parse(chunks[0].metadata_json) : null; if (m?.title) title = m.title } catch {}
    return {
      id, slug: null, title, type: meta.source_type, body,
      visibility: 'internal', status: 'published', appScope: chunks[0]?.app_id || 'global', owner: '',
      tags: [], linkedErrors: [], source: { kind: 'legacy' }, version: 1, createdAt: 0, updatedAt: 0,
      quality: null, history: [], legacy: true, chunkId: chunks[0]?.id || null
    }
  }

  /** 新建 Article：写主表 → 初始化质量行 → body 重切分落 chunks + 重嵌 → 记 meta */
  async function createArticle({ title, type, body, visibility = 'internal', status = 'published', tags = [], linkedErrors = [], appScope = 'global', owner = '', source = null } = {}) {
    const t = String(type || 'runbook')
    const id = `art:${hash(`${title}|${t}|${Date.now()}`).slice(0, 12)}`
    const now = Date.now()
    await db.prepare(
      `insert into ${ARTICLE_TABLE} (id,slug,title,type,body,visibility,status,tags_json,linked_errors_json,app_scope,owner,source_json,version,created_at,updated_at)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(id, null, String(title).trim(), t, String(body || ''), visibility, status,
      JSON.stringify(tags || []), JSON.stringify(linkedErrors || []), appScope || 'global', owner || '',
      source ? JSON.stringify(source) : null, 1, now, now).run()
    await db.prepare(`insert into ${QUALITY_TABLE} (article_id,ai_citations,up_count,down_count,useful_rate,feedback_count,last_cited_at) values (?,0,0,0,null,0,null) on conflict(article_id) do nothing`).bind(id).run()
    const chunks = deriveChunks(String(body || ''), id, t, appScope || 'global', String(title).trim())
    await putChunks(chunks)
    await indexChunkVectors(chunks)
    await upsertMeta({ sourceType: t, sourceId: id, contentHash: hash(body || ''), version: '1' })
    return { id, type: t, visibility, status, version: 1 }
  }

  /**
   * 编辑 Article（★替代只能删不能改）：清旧 chunks+meta+向量 → 重切分+重嵌 →
   * 更新主表 + 版本 +1 + 历史快照。无 article 行的遗留来源会被「升级」为可治理 Article。
   */
  async function editArticle(id, patch = {}) {
    const existing = await getArticleRow(id)
    const upgraded = !existing
    const prevType = existing?.type || patch.type || (await metaTypeOf(id)) || 'runbook'
    const type = String(patch.type || prevType)
    const appScope = patch.appScope || existing?.app_scope || 'global'
    const prev = existing
      ? { title: existing.title, type: existing.type, visibility: existing.visibility, status: existing.status, body: existing.body || '', tags: parseJsonArr(existing.tags_json), linkedErrors: parseJsonArr(existing.linked_errors_json) }
      : { title: patch.title, type: prevType, visibility: patch.visibility || 'internal', status: patch.status || 'published', body: patch.body || '', tags: [], linkedErrors: [] }
    const newVersion = (existing?.version || 1) + 1
    const now = Date.now()
    await removeBySource(type, id)
    const chunks = deriveChunks(String(patch.body || ''), id, type, appScope, String(patch.title).trim())
    await putChunks(chunks)
    await indexChunkVectors(chunks)
    await upsertMeta({ sourceType: type, sourceId: id, contentHash: hash(patch.body || ''), version: String(newVersion) })
    if (existing) {
      await db.prepare(
        `update ${ARTICLE_TABLE} set title=?,type=?,visibility=?,status=?,body=?,tags_json=?,linked_errors_json=?,app_scope=?,version=?,updated_at=? where id=?`
      ).bind(String(patch.title).trim(), type, patch.visibility || existing.visibility, patch.status || existing.status,
        String(patch.body || ''), JSON.stringify(patch.tags || parseJsonArr(existing.tags_json) || []),
        JSON.stringify(patch.linkedErrors || parseJsonArr(existing.linked_errors_json) || []),
        appScope, newVersion, now, id).run()
    } else {
      await db.prepare(
        `insert into ${ARTICLE_TABLE} (id,slug,title,type,body,visibility,status,tags_json,linked_errors_json,app_scope,owner,source_json,version,created_at,updated_at)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(id, null, String(patch.title).trim(), type, String(patch.body || ''), patch.visibility || 'internal', patch.status || 'published',
        JSON.stringify(patch.tags || []), JSON.stringify(patch.linkedErrors || []), appScope, '',
        JSON.stringify({ kind: 'manual' }), newVersion, now, now).run()
      await db.prepare(`insert into ${QUALITY_TABLE} (article_id,ai_citations,up_count,down_count,useful_rate,feedback_count,last_cited_at) values (?,0,0,0,null,0,null) on conflict(article_id) do nothing`).bind(id).run()
    }
    await db.prepare(
      `insert into ${HISTORY_TABLE} (id,article_id,version,editor,note,snapshot_json,created_at) values (?,?,?,?,?,?,?)`
    ).bind(`hist:${id}:${newVersion}`, id, newVersion - 1, patch.editor || '', upgraded ? '从来源升级为可编辑知识' : '编辑更新', JSON.stringify(prev), now).run()
    return { id, type, version: newVersion, upgraded }
  }

  /** 删除 Article：清 chunks+meta+向量 + 主表/质量/历史；遗留来源则仅清 chunks */
  async function deleteArticle(id) {
    const row = await getArticleRow(id)
    let type = row?.type
    if (!row) {
      const meta = await db.prepare(`select source_type from ${META_TABLE} where source_id=? limit 1`).bind(id).first()
      if (!meta) throw kbErr(404, '知识不存在')
      type = meta.source_type
    }
    await removeBySource(type, id)
    await db.prepare(`delete from ${ARTICLE_TABLE} where id=?`).bind(id).run()
    await db.prepare(`delete from ${QUALITY_TABLE} where article_id=?`).bind(id).run()
    await db.prepare(`delete from ${HISTORY_TABLE} where article_id=?`).bind(id).run()
    return { ok: true }
  }

  /** 有用反馈：更新有用率；「没用 + 补充解法」沉淀为 feedback 草稿待审核（PRD R11） */
  async function recordFeedback(articleId, { helpful = true, note = '', deposit = false } = {}) {
    const q = await db.prepare(`select * from ${QUALITY_TABLE} where article_id=?`).bind(articleId).first()
    let up = q?.up_count || 0, down = q?.down_count || 0
    if (helpful) up++; else down++
    const n = up + down
    const rate = n ? up / n : null
    await db.prepare(
      `insert into ${QUALITY_TABLE} (article_id,ai_citations,up_count,down_count,useful_rate,feedback_count,last_cited_at)
       values (?,0,?,?,?,1,?)
       on conflict(article_id) do update set up_count=excluded.up_count, down_count=excluded.down_count, useful_rate=excluded.useful_rate, feedback_count=feedback_count+1`
    ).bind(articleId, up, down, rate, Date.now()).run()
    let depositId = null
    if (deposit && !helpful && String(note || '').trim()) {
      const art = await getArticle(articleId)
      const title = art?.title ? `反馈补充：${art.title}` : '反馈补充知识'
      const created = await createArticle({ title, type: 'feedback', body: String(note).trim(), visibility: 'internal', status: 'draft', tags: [], linkedErrors: [], appScope: art?.appScope || 'global', owner: '', source: { kind: 'feedback', ref: articleId } })
      depositId = created.id
    }
    return { ok: true, usefulRate: rate, depositId }
  }

  /** 被 AI 诊断引用计数（best-effort，写质量表；遗留来源自动建质量行但不污染列表） */
  async function recordCitations(ids) {
    const list = (ids || []).filter(Boolean)
    if (!list.length) return 0
    const now = Date.now()
    const stmts = list.map(id => ({
      sql: `insert into ${QUALITY_TABLE} (article_id,ai_citations,up_count,down_count,useful_rate,feedback_count,last_cited_at)
            values (?,1,0,0,null,0,?)
            on conflict(article_id) do update set ai_citations=ai_citations+1, last_cited_at=excluded.last_cited_at`,
      values: [id, now]
    }))
    if (typeof db.batch === 'function') { await db.batch(stmts); return list.length }
    for (const s of stmts) await db.prepare(s.sql).bind(...s.values).run()
    return list.length
  }

  /** 全量重建：遍历所有 chunk 重新向量化（真正覆盖全部 source_type，而非仅 issue） */
  async function rebuildAll({ types = null } = {}) {
    const typeParams = (types && types.length) ? types : []
    const whereSql = typeParams.length ? `where source_type in (${typeParams.map(() => '?').join(',')})` : ''
    const rows = (await db.prepare(`select id, source_type, app_id, text, metadata_json from ${KB_TABLE} ${whereSql}`).bind(...typeParams).all()) || []
    if (!rows.length) return { ingested: 0, indexed: 0, byType: {} }
    const byType = {}
    const items = rows.map(r => { byType[r.source_type] = (byType[r.source_type] || 0) + 1; return { id: r.id, text: r.text, metadata: { app_id: r.app_id || '', source_type: r.source_type } } })
    let indexed = 0
    if (vectorStore && embedder && typeof embedder.embedBatch === 'function') {
      try {
        const vecs = await embedder.embedBatch(items.map(it => it.text))
        if (Array.isArray(vecs) && vecs.length === items.length) {
          await vectorStore.upsert(items.map((it, i) => ({ id: it.id, values: vecs[i], metadata: it.metadata })))
          indexed = items.length
        }
      } catch { indexed = 0 }
    }
    return { ingested: rows.length, indexed, byType }
  }

  function deriveChunks(text, id, type, appId, title) {
    const chunks = splitMarkdown(String(text || ''))
    if (!chunks.length) chunks.push({ title, text: String(text || '').trim() })
    return chunks.map((c, i) => ({
      id: `${id}:${hash(c.text).slice(0, 12)}:${i}`,
      sourceType: type, sourceId: id, appId: appId || 'global', chunkIdx: i,
      text: `# ${c.title || title}\n\n${c.text}`,
      metadata: { title: c.title || title, file: title }
    }))
  }

  /* stats 增强：合并 Article 与遗留来源；新增 byVisibility / publicCount / internalCount / aiCitations / feedbackCount */
  async function stats() {
    const aType = (await db.prepare(`select type, count(*) n from ${ARTICLE_TABLE} group by type`).all()) || []
    const aVis = (await db.prepare(`select visibility, count(*) n from ${ARTICLE_TABLE} group by visibility`).all()) || []
    const aLatest = await db.prepare(`select max(updated_at) latest from ${ARTICLE_TABLE}`).first()
    const qSum = await db.prepare(`select coalesce(sum(ai_citations),0) c, coalesce(sum(feedback_count),0) f from ${QUALITY_TABLE}`).first()
    const lType = (await db.prepare(`select source_type, count(*) n from ${META_TABLE} where not exists (select 1 from ${ARTICLE_TABLE} a where a.id=m.source_id) group by source_type`).all()) || []
    const lLatest = await db.prepare(`select max(updated_at) latest from ${META_TABLE} where not exists (select 1 from ${ARTICLE_TABLE} a where a.id=m.source_id)`).first()
    const byType = {}
    let total = 0
    for (const r of aType) { byType[r.type] = (byType[r.type] || 0) + Number(r.n); total += Number(r.n) }
    for (const r of lType) { byType[r.source_type] = (byType[r.source_type] || 0) + Number(r.n); total += Number(r.n) }
    const byVisibility = {}
    for (const r of aVis) byVisibility[r.visibility] = Number(r.n)
    return {
      total, byType, byVisibility,
      publicCount: byVisibility.public || 0,
      internalCount: byVisibility.internal || 0,
      aiCitations: Number(qSum?.c || 0),
      feedbackCount: Number(qSum?.f || 0),
      latestUpdated: Math.max(Number(aLatest?.latest || 0), Number(lLatest?.latest || 0)) || null
    }
  }

  // search 支持 publicOnly：仅保留 source_id 属于 public Article 的命中（帮助中心防泄露）
  const _search = search
  search = async function (query, { appId, topK = 8, limit = 5, publicOnly = false } = {}) {
    const matches = await _search(query, { appId, topK, limit })
    if (!publicOnly || !matches.length) return matches
    const pub = (await db.prepare(`select id from ${ARTICLE_TABLE} where visibility='public'`).all()) || []
    const pubSet = new Set(pub.map(r => r.id))
    return matches.filter(r => pubSet.has(r.source_id))
  }

  return { search, upsertChunk, removeBySource, getMeta, upsertMeta, getChunk, getFirstChunkBySource, listMeta, stats, ingestRunbook, ingestRunbookFromUrl,
    listArticles, getArticle, createArticle, editArticle, deleteArticle, recordFeedback, recordCitations, rebuildAll }
}
