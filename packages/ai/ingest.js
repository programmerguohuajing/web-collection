/**
 * @file RAG 摄取核心函数（双后端共享）
 *
 * 将已解决 issue（含 resolution_notes）摄取为知识 chunk。
 * Cloudflare 路径：D1(原文) + Vectorize(向量)；Node/PG 路径：pgvector + ai_kb_chunks。
 * 增量：ai_kb_meta.content_hash 判定。
 *
 * 性能（CF Worker subrequest 限额关键）：全部 D1 语句合并为单次 batch，
 * 向量「单次批量嵌入 + 单次 upsert + 一次旧向量清理」——
 * 远程调用总数为常数（≈7 次），与 issue 数量解耦；否则每条 issue 约 5 次调用，
 * 几十条 issue 即触发 Workers 免费版 50 subrequest/请求上限（表现为 internal error）。
 */
import { hash } from './db-adapter.js'
import { KB_TABLE, META_TABLE } from './kb.js'

export async function ingestResolvedIssues({ db, kb, embedder, vectorStore, force = false } = {}) {
  void kb
  const rows = (await db.prepare(
    `select fingerprint, app_id, name, message, stack, resolution_notes, release_name
       from issues where status in ('resolved','regression') and resolution_notes is not null`
  ).all()) || []

  // 增量判断所需 meta 全量读入内存（一条 SQL），避免逐 issue 查询
  const metas = new Map(
    ((await db.prepare(`select source_id, content_hash from ${META_TABLE} where source_type='issue'`).all()) || [])
      .map(m => [m.source_id, m.content_hash])
  )

  const records = []
  for (const issue of rows) {
    const contentHash = hash(`${issue.name}|${issue.message}|${issue.stack}|${issue.resolution_notes}`)
    if (!force && metas.get(issue.fingerprint) === contentHash) continue
    const text = [
      `# 错误${issue.name || 'unknown'}`,
      `消息${issue.message || ''}`,
      `堆栈${firstLines(issue.stack, 30)}`,
      `解法${issue.resolution_notes || ''}`
    ].filter(Boolean).join('\n')
    records.push({
      sourceId: issue.fingerprint,
      contentHash,
      text,
      id: `${issue.fingerprint}:${hash(text).slice(0, 12)}`,
      appId: issue.app_id || 'global',
      metadata: JSON.stringify({ name: issue.name, release: issue.release_name })
    })
  }

  if (!records.length) return { ingested: 0, skipped: rows.length, indexed: 0 }

  const sourceIds = records.map(r => r.sourceId)
  const srcPh = sourceIds.map(() => '?').join(',')

  // 旧 chunk 一次性查出（供 DB 与向量两处清理）
  const oldRows = (await db.prepare(
    `select id from ${KB_TABLE} where source_type='issue' and source_id in (${srcPh})`
  ).bind(...sourceIds).all()) || []
  const oldIds = oldRows.map(r => r.id)

  // 主 batch：删旧 chunks + 删旧 meta + 写新 chunks + 写新 meta —— 单次往返
  const now = Date.now()
  const stmts = []
  if (oldIds.length) {
    stmts.push({ sql: `delete from ${KB_TABLE} where id in (${oldIds.map(() => '?').join(',')})`, values: oldIds })
  }
  stmts.push({ sql: `delete from ${META_TABLE} where source_type='issue' and source_id in (${srcPh})`, values: sourceIds })
  for (const r of records) {
    stmts.push({
      sql: `insert into ${KB_TABLE} (id,source_type,source_id,app_id,chunk_idx,text,metadata_json,updated_at)
            values (?,?,?,?,?,?,?,?)
            on conflict(id) do update set text=excluded.text,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`,
      values: [r.id, 'issue', r.sourceId, r.appId, 0, r.text, r.metadata, now]
    })
    stmts.push({
      sql: `insert into ${META_TABLE} (id,source_type,source_id,content_hash,version,updated_at)
            values (?,?,?,?,?,?)
            on conflict(id) do update set content_hash=excluded.content_hash,version=excluded.version,updated_at=excluded.updated_at`,
      values: [`issue:${r.sourceId}`, 'issue', r.sourceId, r.contentHash, '1', now]
    })
  }
  await runStatements(db, stmts)

  // 向量：批量嵌入 + 单次 upsert；失败静默降级（原文已入库，可稍后重建索引补齐）
  let indexed = 0
  if (vectorStore && embedder && typeof embedder.embedBatch === 'function') {
    try {
      if (oldIds.length && typeof vectorStore.deleteByIds === 'function') await vectorStore.deleteByIds(oldIds)
      const vecs = await embedder.embedBatch(records.map(r => r.text))
      if (Array.isArray(vecs) && vecs.length === records.length) {
        await vectorStore.upsert(records.map((r, i) => ({
          id: r.id, values: vecs[i], metadata: { app_id: r.appId || '', source_type: 'issue' }
        })))
        indexed = records.length
      }
    } catch { indexed = 0 }
  }

  return { ingested: records.length, skipped: rows.length - records.length, indexed }
}

/** 无 batch 能力的注入实现退化为逐条执行 */
async function runStatements(db, stmts) {
  if (typeof db.batch === 'function') return db.batch(stmts)
  for (const s of stmts) await db.prepare(s.sql).bind(...(s.values || [])).run()
}

function firstLines(s, n) { return String(s || '').split('\n').slice(0, n).join('\n') }
