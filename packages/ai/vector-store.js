/**
 * @file 向量存储统一适配（Cloudflare 侧）
 *
 * 包装 env.AI_KB（Vectorize index）。Node/PG 侧 pgvector 实现在
 * apps/api/src/vector-store.js（依赖 pool + vector 扩展），接口保持一致：
 *   query(vec,{topK,filter}) -> [{id,score}]
 *   upsert([{id,values,metadata}])
 *   deleteByIds(ids)
 */
export function createVectorizeStore(index) {
  if (!index) return null
  return {
    async query(vec, { topK = 8, filter = '' } = {}) {
      const opts = { topK }
      if (filter) opts.filter = filter
      const res = await index.query(vec, opts)
      return (res?.matches || []).map(m => ({ id: m.id, score: m.score }))
    },
    async upsert(vectors) { await index.upsert(vectors) },
    async deleteByIds(ids) { await index.deleteByIds(ids) }
  }
}
