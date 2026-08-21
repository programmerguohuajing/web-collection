/**
 * @file 反馈→KB 自动沉淀（M5）
 *
 * 当用户对某条诊断给「踩（down）」并补充修正建议（correction）时，把该修正沉淀为
 * 知识库 chunk（source_type='feedback'），供后续相似错误检索复用。复用 kb.upsertChunk
 * （原文入 ai_kb_chunks + 向量入 vectorStore），与 ingest.js 走同一套幂等/增量机制。
 *
 * 用法：
 *   const kb = createKb({ db, vectorStore, embedder })
 *   await sedimentFeedback({ db, kb, diagnosisId, correction })
 */
import { hash } from './db-adapter.js'

/** 沉淀一条「踩+修正」反馈为 KB chunk。无 correction 或未配置向量则跳过（返回 null）。 */
export async function sedimentFeedback({ db, kb, diagnosisId, rating, correction, appId }) {
  if (rating !== 'down' || !correction || !String(correction).trim()) return null
  // 只对有真实诊断上下文（ai_diagnoses 记录）的反馈沉淀；无记录则跳过
  const diag = diagnosisId
    ? await db.prepare('select * from ai_diagnoses where id=? or ref_id=? order by created_at desc limit 1')
      .bind(diagnosisId, diagnosisId).first()
    : null
  const sourceId = diag?.id || diagnosisId ? String(diagnosisId || diag?.id) : `fb-${hash(String(correction))}`
  const contentHash = hash(`feedback|${String(diagnosisId || '')}|${String(correction)}`)
  const meta = await kb.getMeta('feedback', sourceId)
  if (meta && meta.content_hash === contentHash) return { ingested: 0, skipped: 1, id: sourceId }

  const text = [
    `# 诊断修正反馈`,
    `被反馈的诊断：${diag?.ref_id || diagnosisId || ''}`,
    `修正建议：${String(correction).slice(0, 2000)}`
  ].filter(Boolean).join('\n')

  // 复用 ingest.js 的 chunk id 约定：sourceId:hash 片段
  const id = `${sourceId}:${hash(text).slice(0, 12)}`
  await kb.removeBySource('feedback', sourceId)
  await kb.upsertChunk({
    id,
    sourceType: 'feedback',
    sourceId,
    appId: (diag?.app_id || appId || 'global'),
    chunkIdx: 0,
    text,
    metadata: {
      title: '用户诊断修正反馈',
      diagnosisId: diag?.id || diagnosisId || null,
      refType: diag?.ref_type || null,
      refId: diag?.ref_id || null
    }
  })
  await kb.upsertMeta({ sourceType: 'feedback', sourceId, contentHash, version: '1' })
  return { ingested: 1, skipped: 0, id: sourceId }
}
