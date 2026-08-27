/**
 * @file 历史 issues 行回填（Cloudflare D1 / 生产后端）
 * 用 stack 第一帧解析出 source/line/column 写入 original_json。
 * 与 PG 版 backfill-issue-source-map.mjs 同语义，但操作线上 D1（worker.js 所在库）；
 * 可重入（只回填 original_json 为空的行）。
 *
 * 前置：已 `wrangler login`，且仓库根有 wrangler.jsonc（含 web-collection 绑定）。
 * 用法：
 *   node scripts/backfill-issue-source-map-d1.mjs            # 真正写入（远程 D1）
 *   DRY_RUN=1 node scripts/backfill-issue-source-map-d1.mjs  # 只统计，不写入
 *   node scripts/backfill-issue-source-map-d1.mjs --dry-run  # 同上
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DB = process.env.D1_DB || 'web-collection'
const DRY_RUN = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run')

/** 调用 wrangler d1 execute，返回 stdout 文本（--json 时即为 JSON 文本） */
function wranglerD1(args) {
  const res = spawnSync('wrangler', ['d1', 'execute', DB, '--remote', ...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 50
  })
  if (res.status !== 0) {
    console.error('wrangler 调用失败：\n', res.stderr || res.stdout || '(无输出)')
    process.exit(1)
  }
  return res.stdout || ''
}

/** 容错解析 wrangler --json 输出（兼容不同版本结构） */
function extractRows(text) {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1) return []
  let data
  try { data = JSON.parse(text.slice(start, end + 1)) } catch { return [] }
  const arr = Array.isArray(data) ? data : [data]
  for (const node of arr) {
    if (Array.isArray(node?.results)) return node.results
    if (Array.isArray(node?.result)) {
      for (const r of node.result) if (Array.isArray(r?.results)) return r.results
    }
  }
  return []
}

/** 从 stack 第一帧解析 source/line/column（与 PG 版 backfill 同逻辑） */
function parseOriginal(stack) {
  const lines = String(stack || '').split('\n').map(l => l.trim()).filter(Boolean)
  let fallback = null
  for (const line of lines) {
    const parenMatch = /\(([^()]+):(\d+):(\d+)\)/.exec(line)
    const bareMatch = !parenMatch && /\bat\s+([^\s()]+):(\d+):(\d+)/.exec(line)
    const fileMatch = parenMatch || bareMatch
    if (fileMatch && /\.(js|ts|jsx|tsx|mjs|cjs|vue|html|css|scss)/i.test(fileMatch[1])) {
      if (/web-collection-sdk(?:\.[\w-]+)?\.js/i.test(fileMatch[1])) continue // 跳过 SDK 自身帧，优先用户代码
      return { source: fileMatch[1], line: Number(fileMatch[2]), column: Number(fileMatch[3]) }
    }
    if (!fallback) fallback = line.replace(/^at\s+/, '')
  }
  return fallback ? { source: fallback, line: 0, column: 0 } : null
}

/** SQLite 字符串转义：单引号 -> 双单引号 */
function sqlStr(s) { return `'${String(s).replace(/'/g, "''")}'` }

function main() {
  const selectSql = "select fingerprint, stack from issues where original_json is null or original_json = 'null' or original_json = ''"
  console.log('读取线上 D1 issues（original_json 为空的行）...')
  const rows = extractRows(wranglerD1(['--json', '--command', selectSql]))
  console.log(`待回填 issues 行数: ${rows.length}`)

  const updates = []
  for (const row of rows) {
    const original = parseOriginal(row.stack)
    if (!original) continue
    const json = JSON.stringify(original).replace(/'/g, "''")
    updates.push(`update issues set original_json = '${json}' where fingerprint = ${sqlStr(row.fingerprint)};`)
  }

  if (DRY_RUN) {
    console.log(`[dry-run] 预计写入 original_json 行数: ${updates.length}`)
    if (updates.length) console.log('示例:', updates[0])
    return
  }

  if (!updates.length) { console.log('无需回填。'); return }
  const file = join(mkdtempSync(join(tmpdir(), 'd1-backfill-')), 'updates.sql')
  writeFileSync(file, updates.join('\n'))
  console.log(`执行 ${updates.length} 条 UPDATE（远程 D1 ${DB}）...`)
  const out = wranglerD1(['--file', file])
  console.log('回填完成。wrangler 输出：\n', out.slice(0, 2000))
}

main()
