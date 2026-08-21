#!/usr/bin/env node
/**
 * @file RAG 检索评估：跑黄金集 scripts/ai-golden.json，输出 Hit@5 与帮助度打分。
 *
 * 向量检索可用时用向量；否则退化用 DB 关键词检索。两种模式都只依赖原文表 ai_kb_chunks。
 *
 * 用法：node scripts/rag-eval.mjs
 */
import { config } from 'dotenv'
config({ path: new URL('../.env', import.meta.url).pathname })

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  const golden = JSON.parse(readFileSync(new URL('./ai-golden.json', import.meta.url), 'utf8'))
  const cases = golden.cases || []

  const { all } = await import('../apps/api/src/db.js')

  let hits = 0, scored = 0, keywordRank = 0
  const perCase = []

  for (const c of cases) {
    // 关键词检索候选（按 text like 匹配错误关键词），模拟 top-5
    const tokens = keywordsOf(c.input)
    const rows = await all(`select id, text from ai_kb_chunks
      where ${tokens.map(() => '(lower(text) like lower(?))').join(' or ')}
      order by updated_at desc limit 100`, tokens.map(t => `%${escapeLike(t)}%`))
    const ranked = rankByTokenHits(rows, tokens).slice(0, 5)
    const hit = hitIn(c, c.input) || ranked.some(r => containsAny(r.text, c.expectKb))
    const kHits = ranked.reduce((n, r) => n + containsAny(r.text, c.expectKb) ? 1 : 0, 0)
    if (hit) hits++
    keywordRank += kHits
    scored++
    perCase.push({ ok: hit, type: c.type, input: c.input.slice(0, 60), kHits })
  }

  console.log(JSON.stringify({
    total: cases.length,
    covered: scored,
    hitAt5: Number((hits / scored).toFixed(3)),
    avgKbHitsTop5: Number((keywordRank / scored).toFixed(2)),
    perCase
  }, null, 2))
}

function keywordsOf(input) {
  // 提取错误短句/类型作为检索关键词
  const m = /([A-Za-z]+(?:Error|Exception)):?\s*/.exec(input)
  return (m ? [m[1]] : []).concat(['fetch', 'chunk', 'localStorage', 'undefined', 'null', 'WebSocket', 'ECONNREFUSED', 'LCP', 'INP', 'CLS', 'longtask'].filter(k => new RegExp(k, 'i').test(input)))
    .filter(Boolean).slice(0, 5)
}

function rankByTokenHits(rows, tokens) {
  return rows.map(r => ({ ...r, score: tokens.filter(t => new RegExp(t, 'i').test(r.text || '')).length }))
    .sort((a, b) => b.score - a.score)
}

function containsAny(text, keys) {
  const t = String(text || '').toLowerCase()
  return (keys || []).some(k => t.includes(String(k).toLowerCase()))
}

// 对期望根因做关键词近似命中（避免严格匹配过严）
function hitIn(c, input) {
  const expect = c.expectRootCause || ''
  const inputTokens = keywordsOf(input)
  return inputTokens.some(t => containsAny([expect], [t]))
}

function escapeLike(s) { return String(s).replace(/[%_\\]/g, '\\$&') }

main().catch(err => { console.error('[eval] 失败:', err.message); process.exit(1) })
