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

export function createKb({ db, vectorStore, embedder }) {
  async function search(query, { appId, topK = 8, limit = 5 } = {}) {
    if (!vectorStore) return []
    const vec = await embedder.embedText(query)
    const filter = appId ? `app_id = '${appId}'` : ''
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
    if (vectorStore && ids.length) await vectorStore.deleteByIds(ids)
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

  return { search, upsertChunk, removeBySource, getMeta, upsertMeta }
}
