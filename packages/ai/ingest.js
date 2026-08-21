/**
 * @file RAG 摄取核心函数（双后端共享）
 *
 * 将已解决 issue（含 resolution_notes）摄取为知识库 chunk。
 * Cloudflare 路径：D1(原文) + Vectorize(向量)；Node/PG 路径：pgvector + ai_kb_chunks。
 * 增量：ai_kb_meta.content_hash 判定。
 */
import { hash } from './db-adapter.js'

export async function ingestResolvedIssues({ db, kb, force = false } = {}) {
  let ingested = 0, skipped = 0
  const rows = (await db.prepare(
    `select fingerprint, app_id, name, message, stack, resolution_notes, release_name
       from issues where status in ('resolved','regression') and resolution_notes is not null`
  ).all()) || []
  for (const issue of rows) {
    const sourceId = issue.fingerprint
    const contentHash = hash(`${issue.name}|${issue.message}|${issue.stack}|${issue.resolution_notes}`)
    const meta = await kb.getMeta('issue', sourceId)
    if (!force && meta && meta.content_hash === contentHash) { skipped++; continue }
    const text = [
      `# 错误：${issue.name || 'unknown'}`,
      `消息：${issue.message || ''}`,
      `堆栈：${firstLines(issue.stack, 30)}`,
      `解法：${issue.resolution_notes || ''}`
    ].filter(Boolean).join('\n')
    const id = `${sourceId}:${hash(text).slice(0, 12)}`
    await kb.removeBySource('issue', sourceId)
    await kb.upsertChunk({
      id, sourceType: 'issue', sourceId, appId: issue.app_id || 'global',
      chunkIdx: 0, text, metadata: { name: issue.name, release: issue.release_name }
    })
    await kb.upsertMeta({ sourceType: 'issue', sourceId, contentHash, version: '1' })
    ingested++
  }
  return { ingested, skipped }
}

function firstLines(s, n) { return String(s || '').split('\n').slice(0, n).join('\n') }
