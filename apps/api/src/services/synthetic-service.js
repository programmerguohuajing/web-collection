/**
 * @file B3 · 合成监控服务（Node / Postgres）。
 * 探针 CRUD + runProbe（fetch + SSRF 双层校验）+ 连续失败告警（复刻 recordBurnAlert 范式）
 * + timeline / stats 聚合 + 调度 tick 共用入口。
 *
 * 设计依据（对齐 B2 slo-service 范式）：
 * - 判定规则 / SSRF 字面量校验 / 到期判断 / 参数收敛全部同源 packages/synthetic.js（纯函数真相源）；
 * - SSRF 第二层为 Node 独有：dns.lookup 解析后 assertIpsAllowed 校验私网 IP（Workers 不暴露 DNS）；
 * - team 归属复用 applications.team_id；accounts 开启（session）跨 team → 403；
 *   accounts=false / api_key(system) 看全部（team_id null 的存量探针全员可见）；
 * - 告警零新增通道：写 alert_history(metric='synthetic', fingerprint='synthetic:{checkId}')
 *   → createAlertDeliveries（30min 冷却去重）投递至 metrics_json 含 synthetic 的通道；
 *   `consecutive_failures == fail_threshold` 精确触发防重（配合冷却双保险）；
 * - 恢复通知首版不做：连续成功时仅归零 consecutive_failures，不发告警（Lead 决策）。
 */
import { lookup as dnsLookup } from 'node:dns'
import { promisify } from 'node:util'
import { all, first, run } from '../db.js'
import { createAlertDeliveries } from '../alerting.js'
import { isAccountsEnabled } from './auth-service.js'
import { randomToken } from '../../../../packages/auth-crypto.js'
import {
  assertIpsAllowed,
  BODY_SNIPPET_LIMIT,
  clipError,
  evaluateProbe,
  normalizeCheckInput,
  TICK_BATCH_LIMIT,
  validateProbeUrl
} from '../../../../packages/synthetic.js'
import { badRequest, forbidden, notFound } from '../utils/http-error.js'

const dnsLookupAll = promisify(dnsLookup)

/** 告警冷却：同一探针 + 同 level 在该窗口内已告警则跳过，避免阈值重达时重复刷屏。 */
const SYNTHETIC_ALERT_COOLDOWN_MS = Number(process.env.SYNTHETIC_ALERT_COOLDOWN_MS || 30 * 60 * 1000)

/** stats 支持的窗口（PRD：1h/24h/7d）。 */
const STAT_WINDOWS = { '1h': 3600000, '24h': 86400000, '7d': 7 * 86400000 }

// ==================== 内部工具 ====================

function pageOf(filters = {}) {
  const page = Math.max(1, Math.min(1000000, Math.floor(Number(filters.page) || 1)))
  const pageSize = Math.max(1, Math.min(100, Math.floor(Number(filters.pageSize) || 20)))
  return { page, pageSize }
}

/** 团队可见性断言：accounts 开启 + session + 有 teamId 时，跨 team 归属（team_id 非空且不等）拒绝。 */
function assertCheckVisible(check, auth) {
  if (!isAccountsEnabled()) return
  if (auth?.via !== 'session' || !auth.teamId) return
  if (check.team_id && check.team_id !== auth.teamId) {
    throw forbidden('无权访问该探针（跨团队）', 'FORBIDDEN')
  }
}

/** DB 行 → API 视图（boolean 映射为 JS boolean，前端永远收到 boolean）。 */
function publicCheck(row) {
  return {
    id: row.id,
    appId: row.app_id,
    teamId: row.team_id || null,
    name: row.name,
    url: row.url,
    method: row.method || 'GET',
    intervalSeconds: Number(row.interval_seconds),
    timeoutMs: Number(row.timeout_ms),
    expectedStatus: Number(row.expected_status),
    keyword: row.keyword || null,
    latencyThresholdMs: row.latency_threshold_ms == null ? null : Number(row.latency_threshold_ms),
    failThreshold: Number(row.fail_threshold),
    enabled: Boolean(row.enabled),
    lastStatus: row.last_status || 'unknown',
    lastRunAt: row.last_run_at == null ? null : Number(row.last_run_at),
    consecutiveFailures: Number(row.consecutive_failures || 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  }
}

/** 按 id 取探针行并做 team 可见性校验，不存在抛 404。 */
async function requireCheck(id, auth) {
  const check = await first('select * from synthetic_checks where id=?', [id])
  if (!check) throw notFound('探针不存在', 'NOT_FOUND')
  assertCheckVisible(check, auth)
  return check
}

// ==================== CRUD ====================

/**
 * 创建或更新探针（body 带 id 即更新）。沿用 saveFunnel 风格 upsert。
 * @returns {Promise<{id: string, created?: boolean, updated?: boolean}>}
 */
export async function saveCheck(input = {}, auth) {
  const appId = String(input.appId || '').trim().slice(0, 64)
  if (!appId) throw badRequest('appId 不能为空', 'BAD_REQUEST')
  const app = await first('select app_id, team_id from applications where app_id=?', [appId])
  if (!app) throw notFound('应用不存在', 'NOT_FOUND')
  const id = String(input.id || '').trim().slice(0, 32) || `sc_${randomToken(10)}`
  const existing = await first('select * from synthetic_checks where id=?', [id])
  // 更新场景：归属校验（跨 team 拒绝）
  if (existing) assertCheckVisible(existing, auth)
  // 参数收敛 + SSRF 第一层（仅 https + 字面量黑名单），双端同源
  const normalized = normalizeCheck(input)
  const v = normalized.value
  const now = Date.now()
  const teamId = app.team_id || null
  if (existing) {
    await run(
      `update synthetic_checks set name=?, url=?, method=?, interval_seconds=?, timeout_ms=?, expected_status=?, keyword=?, latency_threshold_ms=?, fail_threshold=?, enabled=?, updated_at=? where id=?`,
      [v.name, v.url, v.method, v.intervalSeconds, v.timeoutMs, v.expectedStatus, v.keyword, v.latencyThresholdMs, v.failThreshold, v.enabled, now, id]
    )
    return { id, updated: true }
  }
  await run(
    `insert into synthetic_checks (id, app_id, team_id, name, url, method, interval_seconds, timeout_ms, expected_status, keyword, latency_threshold_ms, fail_threshold, enabled, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, appId, teamId, v.name, v.url, v.method, v.intervalSeconds, v.timeoutMs, v.expectedStatus, v.keyword, v.latencyThresholdMs, v.failThreshold, v.enabled, now, now]
  )
  return { id, created: true }
}

/** normalizeCheckInput 包装：失败统一抛 400（收敛包内的错误语义）。 */
function normalizeCheck(input) {
  const result = normalizeCheckInput(input)
  if (!result.ok) throw badRequest(result.error, 'BAD_REQUEST')
  return result
}

/** 列表（按 app_id；accounts 下按 teamId 过滤），含近 24h 可用率单值摘要。 */
export async function listChecks(filters = {}) {
  const { page, pageSize } = pageOf(filters)
  const conditions = []
  const values = []
  if (filters.appId) { conditions.push('app_id=?'); values.push(filters.appId) }
  if (filters.teamId) { conditions.push('(team_id is null or team_id=?)'); values.push(filters.teamId) }
  const where = conditions.length ? `where ${conditions.join(' and ')}` : ''
  const [rows, total] = await Promise.all([
    all(`select * from synthetic_checks ${where} order by updated_at desc limit ? offset ?`, [...values, pageSize, (page - 1) * pageSize]),
    first(`select count(*) count from synthetic_checks ${where}`, values)
  ])
  // 近 24h 可用率单值（一次 group 聚合，避免逐探针 N 次查询）
  const availability = new Map()
  if (rows.length) {
    const ids = rows.map(row => row.id)
    const avRows = await all(
      `select check_id, avg(case when ok then 1.0 else 0.0 end) rate from synthetic_results where checked_at>=? and check_id in (${ids.map(() => '?').join(',')}) group by check_id`,
      [Date.now() - 86400000, ...ids]
    )
    for (const row of avRows) availability.set(row.check_id, Number(row.rate))
  }
  const items = rows.map(row => ({
    ...publicCheck(row),
    availability24h: availability.has(row.id) ? availability.get(row.id) : null
  }))
  return { items, total: Number(total?.count || 0), page, pageSize }
}

/** 详情（定义 + last_status/last_run_at/consecutive_failures）。 */
export async function getCheck(id, auth) {
  const check = await requireCheck(id, auth)
  return { check: publicCheck(check) }
}

/** 删除（级联删 results）。 */
export async function deleteCheck(id, auth) {
  await requireCheck(id, auth)
  await run('delete from synthetic_results where check_id=?', [id])
  await run('delete from synthetic_checks where id=?', [id])
  return { ok: true }
}

// ==================== 探测执行 ====================

/**
 * 执行单次探测并落库（手动 run 与 scheduler tick 共用）。
 * 流程：SSRF 字面量校验 → DNS 解析 + 私网 IP 校验（Node 第二层）→
 * fetch（AbortSignal.timeout）→ evaluateProbe 四步判定 → 写 results + 推进计数 → 告警判定。
 * @param {object} check 探针定义行（snake_case 字段）
 * @returns {Promise<{ok: boolean, outcome: string, status_code: ?number, latency_ms: ?number, latency_exceeded: boolean, error: ?string}>}
 */
export async function runProbe(check) {
  const url = String(check.url || '')
  // SSRF 第一层：字面量校验（双端同源；存量定义执行时兜底复检）
  const literal = validateProbeUrl(url)
  if (!literal.ok) {
    return persistProbeResult(check, { ok: false, outcome: 'fail', statusCode: null, latencyMs: 0, latencyExceeded: false, error: `SSRF 拒绝：${literal.error}` })
  }
  // SSRF 第二层：DNS 解析后私网 IP 校验（Node 独有）
  let addresses = []
  try {
    addresses = (await dnsLookupAll(literal.value.hostname, { all: true })).map(entry => entry.address)
  } catch (err) {
    return persistProbeResult(check, { ok: false, outcome: 'fail', statusCode: null, latencyMs: 0, latencyExceeded: false, error: `DNS 解析失败：${err?.message || err}` })
  }
  const ipCheck = assertIpsAllowed(addresses)
  if (!ipCheck.ok) {
    return persistProbeResult(check, { ok: false, outcome: 'fail', statusCode: null, latencyMs: 0, latencyExceeded: false, error: ipCheck.error })
  }

  const timeoutMs = Math.max(1, Number(check.timeout_ms) || 10000)
  const started = Date.now()
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'WebCollection-Synthetic/1.0', accept: '*/*' }
    })
    const latencyMs = Date.now() - started
    // keyword 匹配需读响应体：content-length 预判跳过超大响应体（如下载流），片段上限 64KB（Q3 不落库原文）
    let bodySnippet = ''
    try {
      const contentLength = Number(response.headers.get('content-length') || 0)
      if (!contentLength || contentLength <= BODY_SNIPPET_LIMIT) {
        bodySnippet = String(await response.text()).slice(0, BODY_SNIPPET_LIMIT)
      }
    } catch { /* 响应体读取失败不影响状态码判定 */ }
    const verdict = evaluateProbe({ check, statusCode: response.status, bodySnippet, latencyMs, error: null })
    return persistProbeResult(check, { ...verdict, statusCode: response.status, latencyMs })
  } catch (err) {
    const latencyMs = Date.now() - started
    const verdict = evaluateProbe({ check, statusCode: null, bodySnippet: '', latencyMs, error: err })
    return persistProbeResult(check, { ...verdict, statusCode: null, latencyMs })
  }
}

/** POST /api/synthetic/:id/run：立即探测（同步执行单次并返回结果）。 */
export async function runProbeById(id, auth) {
  const check = await requireCheck(id, auth)
  return runProbe(check)
}

/**
 * 结果落库 + 计数推进 + 告警判定（判定规则推进的唯一写库点，双栈同逻辑）：
 * 失败 → consecutive_failures += 1；成功 → 归零 + last_status='success'。
 * 告警：fail 且 consecutive_failures == fail_threshold（== 而非 >=，配合冷却避免每 tick 重复插记录）。
 */
async function persistProbeResult(check, verdict) {
  const now = Date.now()
  const id = `sr_${randomToken(10)}`
  await run(
    `insert into synthetic_results (id, check_id, ok, outcome, status_code, latency_ms, latency_exceeded, error, checked_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, check.id, Boolean(verdict.ok), String(verdict.outcome || 'fail'), verdict.statusCode ?? null, verdict.latencyMs ?? null, Boolean(verdict.latencyExceeded), verdict.error ? clipError(verdict.error) : null, now]
  )
  const failed = !verdict.ok
  const consecutiveFailures = failed ? Number(check.consecutive_failures || 0) + 1 : 0
  const lastStatus = verdict.outcome === 'timeout' ? 'timeout' : failed ? 'fail' : 'success'
  await run(
    `update synthetic_checks set last_status=?, last_run_at=?, consecutive_failures=?, updated_at=? where id=?`,
    [lastStatus, now, consecutiveFailures, now, check.id]
  )
  // 恢复（连续成功）首版仅归零计数，不发恢复通知（Lead 决策）
  if (failed && consecutiveFailures === Number(check.fail_threshold || 3)) {
    await recordSyntheticAlert(check, verdict, consecutiveFailures)
  }
  return {
    ok: Boolean(verdict.ok),
    outcome: String(verdict.outcome || 'fail'),
    status_code: verdict.statusCode ?? null,
    latency_ms: verdict.latencyMs ?? null,
    latency_exceeded: Boolean(verdict.latencyExceeded),
    error: verdict.error || null
  }
}

/** 写 alert_history(metric='synthetic') + 复用 createAlertDeliveries 投递（带冷却去重）。 */
async function recordSyntheticAlert(check, verdict, consecutiveFailures) {
  // 探针级 severity：fail_threshold ≤ 3 记 critical（首版简化，架构 §3.6）
  const level = Number(check.fail_threshold) <= 3 ? 'critical' : 'warning'
  // 冷却：同探针 + 同 level 最近 SYNTHETIC_ALERT_COOLDOWN_MS 内已告警则跳过
  const recent = await first(
    `select id, created_at from alert_history where metric='synthetic' and app_id=? and context_json->>'checkId'=? and level=? order by created_at desc limit 1`,
    [check.app_id, check.id, level]
  )
  if (recent && Date.now() - Number(recent.created_at) < SYNTHETIC_ALERT_COOLDOWN_MS) return null
  const message = `[Web Collection] 合成监控「${check.name}」连续 ${consecutiveFailures} 次探测失败（${verdict.outcome}）：${verdict.error || '-'}`
  const context = {
    checkId: check.id,
    checkName: check.name,
    url: check.url,
    outcome: verdict.outcome,
    error: verdict.error || null,
    consecutiveFailures
  }
  const now = Date.now()
  const result = await run(
    `insert into alert_history (app_id, metric, fingerprint, level, value, message, status, context_json, created_at, updated_at)
     values (?, 'synthetic', ?, ?, ?, ?, 'pending', ?::jsonb, ?, ?) returning id`,
    [check.app_id, `synthetic:${check.id}`, level, consecutiveFailures, message, JSON.stringify(context), now, now]
  )
  const id = Number(result.rows[0].id)
  await createAlertDeliveries(id)
  return { id, level, message }
}

// ==================== 调度 / 时间线 / 统计 ====================

/** 取到期探针（enabled 且 last_run_at + interval*1000 <= now），单次最多 TICK_BATCH_LIMIT 条，超出顺延。 */
export async function listDueChecks(now = Date.now()) {
  return all(
    `select * from synthetic_checks where enabled = true and (last_run_at is null or last_run_at + interval_seconds * 1000 <= ?) order by last_run_at asc limit ?`,
    [now, TICK_BATCH_LIMIT]
  )
}

/** 调度 tick：逐条执行到期探针，单探针异常不阻断其余（console.error 可观测）。 */
export async function tick(now = Date.now()) {
  const due = await listDueChecks(now)
  let executed = 0
  for (const check of due) {
    try {
      await runProbe(check)
      executed++
    } catch (error) {
      console.error(`[synthetic] probe failed for ${check.id}`, error?.stack || error?.message || error)
    }
  }
  return { due: due.length, executed }
}

/** 最近 N 次结果时间线（默认 50，max 200，时间倒序）。 */
export async function getTimeline(id, auth, limit = 50) {
  await requireCheck(id, auth)
  const capped = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)))
  const rows = await all('select * from synthetic_results where check_id=? order by checked_at desc limit ?', [id, capped])
  return {
    items: rows.map(row => ({
      checkedAt: Number(row.checked_at),
      ok: Boolean(row.ok),
      outcome: row.outcome,
      statusCode: row.status_code == null ? null : Number(row.status_code),
      latencyMs: row.latency_ms == null ? null : Number(row.latency_ms),
      latencyExceeded: Boolean(row.latency_exceeded),
      error: row.error || null
    }))
  }
}

/** 可用率 + P50/P95 时延（窗口 1h/24h/7d；PG percentile_cont 单查询）。 */
export async function getStats(id, auth, window = '24h') {
  await requireCheck(id, auth)
  const windowKey = STAT_WINDOWS[window] ? window : '24h'
  const start = Date.now() - STAT_WINDOWS[windowKey]
  const row = await first(
    `select count(*) total,
            sum(case when ok then 1 else 0 end) ok_count,
            sum(case when latency_exceeded then 1 else 0 end) latency_exceeded_count,
            percentile_cont(0.5) within group (order by latency_ms) p50,
            percentile_cont(0.95) within group (order by latency_ms) p95
     from synthetic_results where check_id=? and checked_at>=?`,
    [id, start]
  )
  const total = Number(row?.total || 0)
  const okCount = Number(row?.ok_count || 0)
  return {
    window: windowKey,
    total,
    okCount,
    availability: total > 0 ? okCount / total : null,
    p50: row?.p50 == null ? null : Number(row.p50),
    p95: row?.p95 == null ? null : Number(row.p95),
    latencyExceededCount: Number(row?.latency_exceeded_count || 0)
  }
}
