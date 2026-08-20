/**
 * Phase 0 · P0-6 性能基线基准脚本（可复跑 + CI 门禁）。
 *
 * 对三个重查询接口组（summary / paths / governance）各跑 N 次，
 * 输出 p50 / p95 / max 延迟，并按预算判断是否超标。
 *
 * 用法见 docs/performance-budget.md。
 *
 * 退出码：
 *   0  正常（无 --gate 时，即使超标也只告警）；或目标不可达且未加 --fail-if-unreachable
 *   1  --gate 模式下任一接口组 P95 超预算；或 --fail-if-unreachable 且不可达
 *   2  参数/运行错误
 */
import { writeFileSync } from 'node:fs'

const DEFAULTS = {
  baseUrl: 'http://localhost:3000',
  appId: '',
  iterations: 20,
  budgetPaths: 800,
  budgetGovernance: 800,
  budgetSummary: 1500
}

function parseArgs(argv) {
  const args = { ...DEFAULTS }
  const raw = { start: null, end: null, gate: false, failIfUnreachable: false, out: null }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const num = (key) => {
      const v = Number(argv[++i])
      if (!Number.isFinite(v)) throw new Error(`参数 ${key} 需要数字`)
      return v
    }
    switch (a) {
      case '--base-url': args.baseUrl = argv[++i]; break
      case '--app-id': args.appId = argv[++i]; break
      case '--iterations': args.iterations = num('--iterations'); break
      case '--budget-paths': args.budgetPaths = num('--budget-paths'); break
      case '--budget-governance': args.budgetGovernance = num('--budget-governance'); break
      case '--budget-summary': args.budgetSummary = num('--budget-summary'); break
      case '--start-time': raw.start = num('--start-time'); break
      case '--end-time': raw.end = num('--end-time'); break
      case '--gate': raw.gate = true; break
      case '--fail-if-unreachable': raw.failIfUnreachable = true; break
      case '--out': raw.out = argv[++i]; break
      default: throw new Error(`未知参数: ${a}`)
    }
  }
  args.raw = raw
  return args
}

function percentile(sorted, p) {
  if (!sorted.length) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? null
  }
}

function buildQuery(appId, raw) {
  const q = new URLSearchParams()
  if (appId) q.set('appId', appId)
  if (raw.start != null) q.set('startTime', String(raw.start))
  if (raw.end != null) q.set('endTime', String(raw.end))
  return q.toString()
}

async function timeGet(url) {
  const started = performance.now()
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  const body = await res.text()
  const elapsed = performance.now() - started
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`)
  return { elapsed, ok: true }
}

async function benchGroup(name, urls, iterations) {
  const samples = []
  let unreachable = false
  let lastError = null
  for (let i = 0; i < iterations; i++) {
    const url = urls[i % urls.length]
    try {
      const { elapsed } = await timeGet(url)
      samples.push(elapsed)
    } catch (err) {
      // 仅在第一次失败时判定为不可达，避免单次抖动误判；但仍记录错误
      if (i === 0) { unreachable = true; lastError = err }
      samples.push(NaN)
      lastError = err
    }
  }
  if (unreachable) return { name, unreachable: true, error: String(lastError?.message || lastError) }
  const clean = samples.filter((s) => Number.isFinite(s))
  return { name, ...stats(clean), error: lastError && !Number.isFinite(samples[samples.length - 1]) ? String(lastError.message) : null }
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv)
  } catch (err) {
    console.error(`参数错误: ${err.message}`)
    process.exit(2)
  }
  const { baseUrl, appId, iterations, raw } = args
  const q = buildQuery(appId, raw)
  const withQuery = (path) => `${baseUrl}${path}${q ? `?${q}` : ''}`

  // 三组接口：summary / paths / governance（applications + releases）
  const groups = [
    { name: 'summary', budget: args.budgetSummary, urls: [withQuery('/api/summary')] },
    { name: 'paths', budget: args.budgetPaths, urls: [withQuery('/api/analytics/paths')] },
    {
      name: 'governance',
      budget: args.budgetGovernance,
      urls: appId
        ? [withQuery('/api/applications'), withQuery(`/api/applications/${encodeURIComponent(appId)}/releases`)]
        : [withQuery('/api/applications')]
    }
  ]

  console.log(`# 性能基准 · base-url=${baseUrl} · appId=${appId || '(全量)'} · iterations=${iterations}`)
  console.log(`# 预算 P95(ms): summary=${args.budgetSummary} paths=${args.budgetPaths} governance=${args.budgetGovernance}`)
  console.log('')

  const results = []
  let breached = false
  let anyUnreachable = false

  for (const g of groups) {
    const r = await benchGroup(g.name, g.urls, iterations)
    if (r.unreachable) {
      anyUnreachable = true
      console.log(`- ${g.name.padEnd(12)} SKIP (不可达: ${r.error})`)
      results.push({ group: g.name, status: 'skipped', error: r.error })
      continue
    }
    const over = r.p95 > g.budget
    if (over) breached = true
    const flag = over ? ' ⚠ 超预算' : ''
    console.log(
      `- ${g.name.padEnd(12)} p50=${r.p50.toFixed(1)}ms p95=${r.p95.toFixed(1)}ms max=${r.max.toFixed(1)}ms (预算 ${g.budget}ms)${flag}`
    )
    results.push({ group: g.name, p50: r.p50, p95: r.p95, max: r.max, budget: g.budget, breached: over })
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    appId: appId || null,
    iterations,
    budgets: { summary: args.budgetSummary, paths: args.budgetPaths, governance: args.budgetGovernance },
    results
  }
  if (raw.out) {
    writeFileSync(raw.out, JSON.stringify(payload, null, 2))
    console.log(`\n已写出基线 JSON: ${raw.out}`)
  }

  if (anyUnreachable && raw.failIfUnreachable) {
    console.error('\n目标服务不可达且 --fail-if-unreachable 已开启，退出 1')
    process.exit(1)
  }
  if (breached) {
    if (raw.gate) {
      console.error('\n[gate] 存在接口组 P95 超预算，退出 1')
      process.exit(1)
    }
    console.warn('\n[warn] 存在接口组 P95 超预算，但未开启 --gate，仅告警')
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('基准脚本运行失败:', err)
  process.exit(2)
})
