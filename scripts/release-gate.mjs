#!/usr/bin/env node

/**
 * Live 发布门禁：对已启动的管理 API 做少量真实采样。
 *
 * 结构性契约在 test/release-gate.test.js 中运行；本脚本只负责验证部署后的
 * HTTP 状态、列表 envelope 和延迟预算，避免把网络/数据库波动混入单元测试。
 *
 * 用法：
 *   RELEASE_GATE_BASE_URL=http://127.0.0.1:8787 pnpm test:release-gate
 *   RELEASE_GATE_SAMPLES=5 RELEASE_GATE_LIST_BUDGET_MS=2000 pnpm test:release-gate
 */

const baseUrl = (process.env.RELEASE_GATE_BASE_URL || process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '')
const samples = positiveInt(process.env.RELEASE_GATE_SAMPLES, 3)
const healthBudgetMs = positiveInt(process.env.RELEASE_GATE_HEALTH_BUDGET_MS, 250)
const listBudgetMs = positiveInt(process.env.RELEASE_GATE_LIST_BUDGET_MS, 2000)
const endpoints = [
  { name: 'health', path: '/health', budgetMs: healthBudgetMs, kind: 'health' },
  { name: 'events', path: '/api/events?page=1&pageSize=10', budgetMs: listBudgetMs, kind: 'page' },
  { name: 'traces', path: '/api/traces?page=1&pageSize=10', budgetMs: listBudgetMs, kind: 'page' },
  { name: 'sessions', path: '/api/analytics/sessions?page=1&pageSize=10', budgetMs: listBudgetMs, kind: 'page' },
  { name: 'applications', path: '/api/applications?page=1&pageSize=10', budgetMs: listBudgetMs, kind: 'page' }
]

const failures = []
const report = []

for (const endpoint of endpoints) {
  const timings = []
  let lastBody = null
  let lastStatus = null
  for (let index = 0; index < samples; index++) {
    try {
      const result = await request(`${baseUrl}${endpoint.path}`, endpoint.budgetMs)
      timings.push(result.elapsedMs)
      lastStatus = result.status
      lastBody = result.body
      if (result.status < 200 || result.status >= 300) {
        failures.push(`${endpoint.name}: HTTP ${result.status}（${String(result.text).slice(0, 240)}）`)
        break
      }
      if (endpoint.kind === 'health') assertHealth(result.body, endpoint.name)
      else assertPageEnvelope(result.body, endpoint.name)
    } catch (error) {
      failures.push(`${endpoint.name}: ${error.message || error}`)
      break
    }
  }
  if (timings.length) {
    const max = Math.max(...timings)
    const p95 = percentile(timings, 0.95)
    if (max > endpoint.budgetMs) failures.push(`${endpoint.name}: 延迟 ${max.toFixed(1)}ms 超过 ${endpoint.budgetMs}ms 预算`)
    report.push({ name: endpoint.name, status: lastStatus, samples: timings.length, p95Ms: round(p95), maxMs: round(max), body: endpoint.kind === 'health' ? lastBody : summarizePage(lastBody) })
  }
}

process.stdout.write(JSON.stringify({ baseUrl, samples, budgets: { healthMs: healthBudgetMs, listMs: listBudgetMs }, report, failures }, null, 2) + '\n')
if (failures.length) process.exitCode = 1

async function request(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = performance.now()
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    const text = await response.text()
    let body = null
    try { body = text ? JSON.parse(text) : null } catch { body = null }
    return { status: response.status, text, body, elapsedMs: performance.now() - started }
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`请求超过 ${timeoutMs}ms 超时`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function assertHealth(body, name) {
  if (!body || body.ok !== true) throw new Error(`${name}: health 响应缺少 ok=true`)
}

function assertPageEnvelope(body, name) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(`${name}: 列表必须返回对象 envelope`)
  if (!Array.isArray(body.items)) throw new Error(`${name}: envelope.items 不是数组`)
  if (!Number.isInteger(Number(body.page)) || Number(body.page) < 1) throw new Error(`${name}: page 非法`)
  if (!Number.isInteger(Number(body.pageSize)) || Number(body.pageSize) < 1 || Number(body.pageSize) > 100) throw new Error(`${name}: pageSize 超出 1..100`)
  if (!Number.isInteger(Number(body.total)) || Number(body.total) < 0) throw new Error(`${name}: total 非法`)
  if (Number(body.total) < body.items.length) throw new Error(`${name}: total 小于当前页条数`)
}

function summarizePage(body) {
  if (!body || typeof body !== 'object') return body
  return { page: body.page, pageSize: body.pageSize, total: body.total, itemCount: Array.isArray(body.items) ? body.items.length : null }
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]
}

function positiveInt(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

function round(value) {
  return Math.round(value * 10) / 10
}
