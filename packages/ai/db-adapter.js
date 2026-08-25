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
  const prepare = sql => {
    const stmt = DB.prepare(sql)
    const makeBound = values => {
      const bound = stmt.bind(...values)
      return {
        async all() { const r = await bound.all(); return r.results || [] },
        async first() { return (await bound.first()) ?? null },
        async run() { const r = await bound.run(); return { changes: Number(r.meta?.changes ?? 0), lastRowId: r.meta?.last_row_id ?? null } }
      }
    }
    return {
      bind: (...values) => makeBound(values),
      // 无参数语句允许直接执行（对齐 D1 原生 prepared statement 语义）
      all: () => makeBound([]).all(),
      first: () => makeBound([]).first(),
      run: () => makeBound([]).run()
    }
  }
  return {
    prepare,
    dialect: 'sqlite',
    // D1 原生批量：多条语句一次往返，且只计 1 个 subrequest（摄取路径的关键优化）
    async batch(entries) {
      const list = entries || []
      if (!list.length) return []
      const stmts = list.map(e => DB.prepare(String(e.sql)).bind(...(e.values || [])))
      return DB.batch(stmts) || []
    }
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
      const makeBound = values => ({
        async all() { return (await query.all(qs, values)) || [] },
        async first() { const rows = (await query.all(qs, values)) || []; return rows[0] ?? null },
        async run() {
          const r = await query.run(qs, values)
          return { changes: Number(r?.rowCount ?? 0), lastRowId: r?.rows?.[0]?.id ?? null }
        }
      })
      return {
        bind: (...values) => makeBound(values),
        // 无参数语句允许直接执行（与 D1 适配器语义对齐）
        all: () => makeBound([]).all(),
        first: () => makeBound([]).first(),
        run: () => makeBound([]).run()
      }
    },
    dialect: 'postgres',
    // PG 无 subrequest 限额，batch 语义按顺序执行逐条落库（与 D1 batch 结果形态对齐）
    async batch(entries) {
      const results = []
      for (const e of (entries || [])) {
        results.push(await query.run(String(e.sql), e.values || []))
      }
      return results
    }
  }
}
