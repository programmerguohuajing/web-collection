/**
 * @file 双后端统一查询适配层
 *
 * Cloudflare D1 与 PostgreSQL（apps/api db.js）两种存储后端的抽象接口。
 * AI 相关只读查询（packages/ai/queries.js / kb.js）只依赖这里定义的统一接口，
 * 不感知后端；D1 与 PG 各自提供适配器，保证双后端逻辑不漂移。
 *
 * 统一接口（语义对齐 D1）：
 *   db.prepare(sql)          → stmt
 *   stmt.bind(...values)     → stmt
 *   stmt.all()   → Promise<row[]>          每个 row 为普通对象
 *   stmt.first() → Promise<row|null>
 *   stmt.run()   → Promise<{ changes, lastRowId }>
 */
import { createHash } from 'node:crypto'

export function hash(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex')
}

/** Cloudflare D1 适配器：包装 env.DB */
export function createD1Adapter({ DB }) {
  return {
    prepare(sql) {
      const stmt = DB.prepare(sql)
      return {
        bind(...values) {
          const bound = stmt.bind(...values)
          return {
            async all() { const r = await bound.all(); return r.results || [] },
            async first() { return (await bound.first()) ?? null },
            async run() { const r = await bound.run(); return { changes: Number(r.meta?.changes ?? 0), lastRowId: r.meta?.last_row_id ?? null } }
          }
        }
      }
    },
    // 向量检索由外部 Vectorize 完成，DB 侧只读 ai_kb_chunks 原文
  }
}

/**
 * PostgreSQL 适配器：依赖注入的实现（由 apps/api/src/db.js 提供 all/run）。
 * query 参数占位符统一使用 `?`，由 db.js 的 toPgSql 负责转换为 $n。
 */
export function createPgAdapter(query) {
  return {
    prepare(sql) {
      const qs = String(sql)
      return {
        bind(...values) {
          return {
            async all() { return (await query.all(qs, values)) || [] },
            async first() { const rows = (await query.all(qs, values)) || []; return rows[0] ?? null },
            async run() {
              const r = await query.run(qs, values)
              return { changes: Number(r?.rowCount ?? 0), lastRowId: r?.rows?.[0]?.id ?? null }
            }
          }
        }
      }
    }
  }
}
