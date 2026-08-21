/**
 * @file Embedding 调用封装
 *
 * 默认走 Workers AI `@cf/baai/bge-large-en-v1.5`（1024 维，免费额度内免 key）。
 * Node/PG 路径可通过 env 注入复用 Workers AI 或本地 embedding provider。
 * 统一返回：embedding 向量数组 `number[]`；批量 ≤100，失败重试 2 次。
 */
export const DEFAULT_EMBED_MODEL = '@cf/baai/bge-large-en-v1.5'
export const EMBED_DIM = 1024

/**
 * 创建 embedder。
 * @param {{backend?: 'cloudflare'|'node', ai?: any, embed?: (text:string)=>Promise<number[]>}} opts
 *   - backend='cloudflare'：用 Workers AI（opts.ai = env.AI），model 可配。
 *   - backend='node'：用 opts.embed 自定义实现（本地 provider / pgvector 共用），或 env 注入。
 */
export function createEmbedder(opts = {}) {
  const backend = opts.backend || 'cloudflare'
  const ai = opts.ai
  const model = opts.model || DEFAULT_EMBED_MODEL
  const custom = opts.embed

  async function embedOne(text) {
    if (typeof custom === 'function') return custom(text)
    if (!ai) throw new Error('embedder: Workers AI binding 缺失（AI 未注入）')
    const r = await ai.run(model, { text: String(text) })
    return (r?.data?.[0] ?? r?.data ?? r) || []
  }

  async function embedText(text, { retries = 2 } = {}) {
    let lastErr
    for (let attempt = 0; attempt <= retries; attempt++) {
      try { return await embedOne(text) }
      catch (e) { lastErr = e; if (attempt < retries) await sleep(200 * (attempt + 1)) }
    }
    throw lastErr
  }

  async function embedBatch(texts, { retries = 2 } = {}) {
    const out = []
    for (let i = 0; i < texts.length; i += 100) {
      const chunk = texts.slice(i, i + 100)
      const vectors = await Promise.all(chunk.map(t => embedText(t, { retries })))
      out.push(...vectors)
    }
    return out
  }

  return { embedText, embedBatch, dimension: EMBED_DIM }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
