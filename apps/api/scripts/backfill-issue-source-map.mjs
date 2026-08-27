/**
 * @file 历史 issues 行回填——用 stack 第一帧解析出 source/line/column 写入 original_json
 * 一次性的修复脚本，可重入（只回填 original_json 为空的行）。
 *
 * 用法：
 *   node scripts/backfill-issue-source-map.mjs            # 真正写入
 *   DRY_RUN=1 node scripts/backfill-issue-source-map.mjs  # 只统计，不修改
 *   node scripts/backfill-issue-source-map.mjs --dry-run  # 同上
 */
import { Pool } from 'pg'
import { config } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env') })

const DRY_RUN = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run')
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:123456@127.0.0.1:5432/web_eys'
})

let count = 0
try {
  const r = await pool.query(
    "select fingerprint, stack, original_json from issues where original_json is null or coalesce(original_json::text, '') in ('null', '')"
  )
  for (const row of r.rows) {
    const stack = row.stack || ''
    // 栈帧样式：'    at NAME (file:line:col)' 或 '    at file:line:col'
    // 从 stack 中找第一帧（跳过错误 message 行与 SDK 自身帧），优先取用户代码帧
    const lines = stack.split('\n').map(line => line.trim()).filter(Boolean)
    let original = null
    let fallback = null
    for (const line of lines) {
      const parenMatch = /\(([^()]+):(\d+):(\d+)\)/.exec(line)
      const bareMatch = !parenMatch && /\bat\s+([^\s()]+):(\d+):(\d+)/.exec(line)
      const fileMatch = parenMatch || bareMatch
      if (fileMatch && /\.(js|ts|jsx|tsx|mjs|cjs|vue|html|css|scss)/i.test(fileMatch[1])) {
        if (/web-collection-sdk(?:\.[\w-]+)?\.js/i.test(fileMatch[1])) continue // 跳过 SDK 自身帧，优先用户代码
        original = { source: fileMatch[1], line: Number(fileMatch[2]), column: Number(fileMatch[3]) }
        break
      }
      if (!fallback) fallback = line.replace(/^at\s+/, '')
    }
    if (!original) {
      if (fallback) original = { source: fallback, line: 0, column: 0 }
      else continue
    }
    if (DRY_RUN) {
      console.log(`[dry-run] 将回填 ${row.fingerprint}:`, original)
    } else {
      await pool.query('update issues set original_json = $1::jsonb where fingerprint = $2', [JSON.stringify(original), row.fingerprint])
    }
    count++
  }
  console.log(DRY_RUN ? `[dry-run] 预计回填 issues.original_json 行数: ${count}` : `回填 issues.original_json 行数: ${count}`)
} finally {
  await pool.end()
}
