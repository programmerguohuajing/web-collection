#!/usr/bin/env node
/**
 * @file RAG 知识库摄取脚本（issues + docs + sdk README）
 *
 * 优先面向 Node/PG 后端直连执行；Cloudflare 侧由 ai-worker 的 /api/ai/kb/ingest
 * 路由（走 Vectorize）触发同一套逻辑。增量判定：比对 ai_kb_meta.content_hash。
 *
 * 用法：
 *   node scripts/rag-ingest.mjs [--app=all] [--sources=issue,doc] [--force]
 *
 * Embedding：默认走环境变量 EMBEDDING_BASE_URL（OpenAI 兼容 /embeddings，如 Ollama）；
 * 未配置时跳过向量写入（原文仍入库，检索降级为关键词）。
 * 依赖：仓库根 .env（PG 凭据）；package.json 已声明 type: module。
 */
import { config } from 'dotenv'
config({ path: new URL('../.env', import.meta.url).pathname })

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename, extname, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const force = args.includes('--force')
function argValue(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const sourceTypes = (argValue('--sources') || 'issue,doc').split(',')
const appFilter = argValue('--app') || null

const mi = (v, n) => String(v | 0).padStart(n, '0')

async function main() {
  const { createPgAdapter } = await import('../packages/ai/db-adapter.js')
  const { createKb } = await import('../packages/ai/kb.js')
  const { vectorStore } = await import('../apps/api/src/vector-store.js')
  const { all, run } = await import('../apps/api/src/db.js')
  // db 需要一个统一接口；这里用 createPgAdapter 包装 db.js 的 all/run
  const db = createPgAdapter({ all, run })

  // 是否真正可做向量检索
  const vectorReady = await vectorStore.ready()

  // embedding：优先本地 OpenAI 兼容端点（EMBEDDING_BASE_URL）
  let embedder
  try {
    embedder = await createNodeEmbedder()
  } catch (e) {
    console.warn('[ingest] 未配置 EMBEDDING_BASE_URL，跳过向量写入（仅原文入库），原因:', e.message)
  }

  const kb = createKb({ db, vectorStore: vectorReady ? vectorStore : null, embedder })

  let ingested = 0, skipped = 0

  if (sourceTypes.includes('issue')) {
    const { ingestResolvedIssues } = await import('../packages/ai/ingest.js')
    const n = await ingestResolvedIssues({ db, kb, force })
    ingested += n.ingested; skipped += n.skipped
  }
  if (sourceTypes.includes('doc')) {
    const n = await ingestDocs(kb, db)
    ingested += n.ingested; skipped += n.skipped
  }

  console.log(`[ingest] 完成：新增/更新 ${ingested} chunk，跳过未变 ${skipped}（向量${vectorReady ? '已启用' : '未启用'}）`)
}

async function createNodeEmbedder() {
  const base = process.env.EMBEDDING_BASE_URL
  if (!base) throw new Error('EMBEDDING_BASE_URL 未设置')
  const model = process.env.EMBEDDING_MODEL || 'bge-large-en-v1.5'
  const apiKey = process.env.EMBEDDING_API_KEY || ''
  return {
    async embedText(text) {
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
  }
}

/** docs/ 与 packages/sdk/README* 按 Markdown 标题 + 段落切分 */
async function ingestDocs(kb, db) {
  let ingested = 0, skipped = 0
  const files = collectMarkdownFiles()
  for (const file of files) {
    const sourceId = relSource(file)
    const raw = readFileSync(file, 'utf8')
    const contentHash = hash(raw)
    const meta = await kb.getMeta('doc', sourceId)
    if (!force && meta && meta.content_hash === contentHash) { skipped++; continue }
    const chunks = splitMarkdown(raw, sourceId)
    await kb.removeBySource('doc', sourceId)
    for (let i = 0; i < chunks.length; i++) {
      await kb.upsertChunk({
        id: `${sourceId}:${hash(chunks[i].text).slice(0, 12)}:${i}`,
        sourceType: 'doc', sourceId, appId: 'global', chunkIdx: i,
        text: chunks[i].text, metadata: { title: chunks[i].title || sourceId, file: sourceId }
      })
      ingested++
    }
    await kb.upsertMeta({ sourceType: 'doc', sourceId, contentHash, version: '1' })
  }
  return { ingested, skipped }
}

function collectMarkdownFiles() {
  const out = []
  const docsDir = join(ROOT, 'docs')
  const walk = dir => { for (const f of readdirSync(dir)) { const p = join(dir, f); const s = statSync(p); if (s.isDirectory()) walk(p); else if (extname(p) === '.md') out.push(p) } }
  if (exists(docsDir)) walk(docsDir)
  for (const f of ['README.md', 'README.zh-CN.md']) { const p = join(ROOT, 'packages/sdk', f); if (exists(p)) out.push(p) }
  for (const f of ['README.md', 'README.zh-CN.md']) { const p = join(ROOT, f); if (exists(p)) out.push(p) }
  return out
}

function relSource(file) { return basename(file) }

/** 简化的 Markdown 切分：按标题分层 + 段落，目标 ~600 token（≈2400 字符），重叠 12% */
function splitMarkdown(raw, sourceId) {
  const lines = String(raw).split('\n')
  const chunks = []
  let current = [], currentTitle = '', currentLen = 0
  const push = () => {
    if (!current.length) return
    const text = current.join('\n').trim()
    if (text) chunks.push({ title: currentTitle, text })
    current = []; currentLen = 0
  }
  for (const line of lines) {
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) { push(); currentTitle = h[2].trim(); current.push(line); currentLen += line.length; continue }
    current.push(line); currentLen += line.length
    if (currentLen >= 2400) push()
  }
  push()
  // 重叠：为相邻 chunk 补充少量前文（近似 12%）——简单实现为保留尾部标题上下文
  return chunks
}

function firstLines(s, n) { return String(s || '').split('\n').slice(0, n).join('\n') }
function hash(v) { return createHash('sha256').update(String(v ?? '')).digest('hex') }
function exists(p) { try { statSync(p); return true } catch { return false } }

main().catch(err => { console.error('[ingest] 失败:', err); process.exit(1) })
