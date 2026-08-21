/**
 * @file pgvector 向量存储（Node/PG 后端）
 *
 * 实现 packages/ai 统一的 vectorStore 接口（与 Cloudflare Vectorize 对齐）：
 *   query(vec,{topK,filter}) -> [{id,score}]          （score = 余弦相似度）
 *   upsert([{id,values,metadata}])
 *   deleteByIds(ids)
 *
 * 依赖 PostgreSQL `vector` 扩展（ai_kb_chunks.embedding vector(1024) 列）。
 * 无扩展/无向量列时查询返回空命中（调用方降级为关键词检索）。
 */
import { all, run, first } from './db.js'

let embeddingReady = null

async function ensureEmbeddingReady() {
  if (embeddingReady !== null) return embeddingReady
  try {
    const row = await first(`select column_name from information_schema.columns
      where table_name = 'ai_kb_chunks' and column_name = 'embedding'`)
    embeddingReady = Boolean(row && row.column_name)
  } catch { embeddingReady = false }
  return embeddingReady
}

function toVectorLiteral(values) {
  if (!Array.isArray(values) || !values.length) return '[0]'
  return `[${values.map(v => Number(v).toFixed(6)).join(',')}]`
}

function whereFilter(filter = '', appId) {
  const parts = []
  const params = []
  if (appId) { parts.push('app_id = ?'); params.push(appId) }
  if (filter) { parts.push(filter) }
  return { clause: parts.length ? ` where ${parts.join(' and ')}` : '', params }
}

export const vectorStore = {
  async ready() { return ensureEmbeddingReady() },

  async query(vec, { topK = 8, filter = '', appId = '' } = {}) {
    if (!(await ensureEmbeddingReady())) return []
    const vectorLiteral = toVectorLiteral(Array.isArray(vec) ? vec : vec?.data || [])
    const { clause, params } = whereFilter(filter, appId)
    const sql = `select id, 1 - (embedding <=> '${vectorLiteral}'::vector) as score
      from ai_kb_chunks${clause}
      order by embedding <=> '${vectorLiteral}'::vector asc
      limit ?`
    const rows = await all(sql, [...params, topK])
    return rows.map(r => ({ id: r.id, score: Number(r.score ?? 0) }))
  },

  async upsert(vectors) {
    if (!(await ensureEmbeddingReady())) return
    for (const v of (vectors || [])) {
      const vectorLiteral = toVectorLiteral(Array.isArray(v.values) ? v.values : v.values?.data || [])
      const metadata = v.metadata || {}
      // 幂等写入向量列（原文内容由 kb.upsertChunk 负责，此处仅回填 embedding）
      await run(`update ai_kb_chunks set embedding = '${vectorLiteral}'::vector
        where id = ?`, [v.id])
      // 若 KB chunk 尚未写入（异常顺序），补插一条占位。
      const row = await first(`select 1 from ai_kb_chunks where id = ?`, [v.id])
      if (!row) {
        await run(`insert into ai_kb_chunks (id,source_type,app_id,text,metadata_json,embedding,updated_at)
          values (?,?,?,?,?,?,?)`, [v.id, metadata.source_type || 'doc', metadata.app_id || null, '', '{}', `'${vectorLiteral}'::vector`, Date.now()])
      }
    }
  },

  async deleteByIds(ids) {
    if (!(await ensureEmbeddingReady()) || !ids?.length) return
    const placeholders = ids.map(() => '?').join(',')
    await run(`update ai_kb_chunks set embedding = null where id in (${placeholders})`, ids)
  }
}
