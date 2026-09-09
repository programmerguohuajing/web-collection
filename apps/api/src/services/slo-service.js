/**
 * @file B2 · SLO 服务（Node / Postgres）。
 * SLO CRUD + SLI 聚合（复用 analytics-service events 聚合）+ 错误预算/燃烧率数学
 * （packages/slo.js 双端同源）+ 快照写入 + 多窗口多燃烧率判定 + 燃尽告警复用现有告警中心。
 *
 * 设计依据（对齐 D2 范式）：
 * - team 归属复用 applications.team_id；accounts 开启（session）按 req.auth.teamId 过滤，跨 team → 403；
 *   accounts=false / api_key(system) 看全部（team_id is null 的存量 SLO 全员可见）。
 * - SLI 信号映射（架构 §3.4，已纠正 PRD 误写）：
 *     error_rate     分子=count(type='error')，分母=count(type='behavior' and name='pv')
 *     availability    分子=props.status>=400 的 fetch/xhr，分母=fetch/xhr 总数
 *     latency_threshold 样本级：value>阈值 计为坏，分母为各 Web Vitals 样本数
 * - 燃尽告警不新建通道：写 alert_history(metric='slo_burn', level, value, app_id, context{sloId})
 *   → 复用 createAlertDeliveries 经现有 alert_channels（metrics_json 含 slo_burn）投递。
 */
import { all, first, run, scalar } from '../db.js'
import { whereFor } from './analytics-service.js'
import { createAlertDeliveries } from '../alerting.js'
import { isAccountsEnabled } from './auth-service.js'
import { randomToken } from '../../../../packages/auth-crypto.js'
import {
  computeGoodRatio,
  computeBurnRate,
  sloStatus,
  evaluateMultiWindowBurnRate,
  buildSloBurnAlert,
  parseJson,
  BURN_RATE_THRESHOLDS
} from '../../../../packages/slo.js'
import { badRequest, forbidden, notFound } from '../utils/http-error.js'

/** 燃尽告警冷却：同一 SLO + 同 level 在该窗口内已告警则跳过，避免每个 tick 重复刷屏。 */
const SLO_ALERT_COOLDOWN_MS = Number(process.env.SLO_ALERT_COOLDOWN_MS || 30 * 60 * 1000)

// ==================== 内部工具 ====================

function pageOf(filters = {}) {
  const page = Math.max(1, Math.min(1000000, Math.floor(Number(filters.page) || 1)))
  const pageSize = Math.max(1, Math.min(100, Math.floor(Number(filters.pageSize) || 20)))
  return { page, pageSize }
}

/** 解析 sli_config / alert_policy（兼容 PG jsonb 已解析对象与 D1 文本 JSON）。 */
function parseConfig(value) {
  return parseJson(value, {})
}

/** SLO 阈值覆盖：alert_policy.thresholds（数组，同 BURN_RATE_THRESHOLDS 结构）；无则默认表。 */
function sloThresholds(slo) {
  const policy = parseConfig(slo.alert_policy)
  return Array.isArray(policy.thresholds) && policy.thresholds.length ? policy.thresholds : BURN_RATE_THRESHOLDS
}

/** 团队可见性断言：accounts 开启 + session + 有 teamId 时，跨 team 归属（team_id 非空且不等）拒绝。 */
function assertSloVisible(slo, auth) {
  if (!isAccountsEnabled()) return
  if (auth?.via !== 'session' || !auth.teamId) return
  if (slo.team_id && slo.team_id !== auth.teamId) {
    throw forbidden('无权访问该 SLO（跨团队）', 'FORBIDDEN')
  }
}

/** DB 行 → API 视图（解析 jsonb）。 */
function publicSlo(row) {
  const cfg = parseConfig(row.sli_config)
  const policy = parseConfig(row.alert_policy)
  return {
    id: row.id,
    appId: row.app_id,
    teamId: row.team_id || null,
    name: row.name,
    objective: Number(row.objective),
    windowDays: Number(row.window_days),
    sliType: row.sli_type,
    sliConfig: cfg,
    alertPolicy: policy,
    createdBy: row.created_by || null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  }
}

function mapAlert(row) {
  const context = parseConfig(row.context_json)
  return {
    id: Number(row.id),
    appId: row.app_id,
    metric: row.metric,
    level: row.level,
    value: row.value,
    message: row.message,
    status: row.status || 'pending',
    context,
    createdAt: Number(row.created_at)
  }
}

async function latestSnapshot(sloId) {
  return first('select * from slo_burn_snapshots where slo_id=? order by snap_at desc limit 1', [sloId])
}

// ==================== SLI 聚合（复用 events 表现） ====================

/**
 * 计算某 SLO 在 [startTs, endTs] 窗口内的 { total, bad }。
 * @param {object} slo SLO 定义行
 * @param {number} startTs 窗口起点（ms）
 * @param {number} endTs 窗口终点（ms）
 * @returns {Promise<{total:number, bad:number}>}
 */
export async function computeSli(slo, startTs, endTs) {
  const cfg = parseConfig(slo.sli_config)
  const base = { appId: slo.app_id, startTime: startTs, endTime: endTs }
  if (cfg.release) base.release = String(cfg.release)

  if (slo.sli_type === 'error_rate') {
    const wBad = whereFor(base, ["type='error'"])
    const bad = await scalar(`select count(*) count from events ${wBad.where}`, wBad.params)
    const wTotal = whereFor(base, ["type='behavior'", "name='pv'"])
    const total = await scalar(`select count(*) count from events ${wTotal.where}`, wTotal.params)
    return { total, bad }
  }

  if (slo.sli_type === 'availability') {
    const w = whereFor(base, ["type='perf'", "metric in ('fetch','xhr')"])
    const total = await scalar(`select count(*) count from events ${w.where}`, w.params)
    const bad = await scalar(
      `select count(*) count from events ${w.where} and coalesce((props_json->>'status')::integer, 0) >= 400`,
      w.params
    )
    return { total, bad }
  }

  // latency_threshold：样本级（Web Vitals 本就是样本指标）；逐 metric 计 value>阈值的坏样本。
  const metrics = ['lcp', 'fcp', 'cls', 'inp']
  const thr = {
    lcp: cfg.thresholds?.lcp ?? 2500,
    fcp: cfg.thresholds?.fcp ?? 1800,
    cls: cfg.thresholds?.cls ?? 0.1,
    inp: cfg.thresholds?.inp ?? 200
  }
  let total = 0
  let bad = 0
  for (const m of metrics) {
    const w = whereFor(base, ["type='perf'"])
    const params = [...w.params, m]
    total += await scalar(`select count(*) count from events ${w.where} and metric = ?`, params)
    bad += await scalar(`select count(*) count from events ${w.where} and metric = ? and value > ?`, [...params, thr[m]])
  }
  return { total, bad }
}

// ==================== SLO CRUD ====================

function validateSli(input) {
  const name = String(input.name || '').trim().slice(0, 80)
  if (!name) throw badRequest('SLO 名称不能为空', 'BAD_REQUEST')
  const objective = Number(input.objective)
  if (!Number.isFinite(objective) || objective <= 0 || objective >= 1) {
    throw badRequest('objective 须在 (0,1) 区间', 'BAD_REQUEST')
  }
  const windowDays = [28, 30].includes(Number(input.windowDays)) ? Number(input.windowDays) : 30
  const sliType = ['error_rate', 'latency_threshold', 'availability'].includes(input.sliType) ? input.sliType : null
  if (!sliType) throw badRequest('sliType 必须为 error_rate | latency_threshold | availability', 'BAD_REQUEST')
  return { name, objective, windowDays, sliType }
}

/**
 * 创建或更新 SLO（body 带 id 即更新）。沿用 saveFunnel 风格 upsert。
 * @returns {Promise<{id:string, created?:boolean, updated?:boolean}>}
 */
export async function saveSlo(input = {}, auth, { requireExisting = false } = {}) {
  const appId = String(input.appId || '').slice(0, 64)
  if (!appId) throw badRequest('appId 不能为空', 'BAD_REQUEST')
  const app = await first('select app_id, team_id from applications where app_id=?', [appId])
  if (!app) throw notFound('应用不存在', 'NOT_FOUND')
  const id = String(input.id || '').slice(0, 32) || `slo_${randomToken(10)}`
  const existing = await first('select * from slo_definitions where id=?', [id])
  if (requireExisting && !existing) throw notFound('SLO 不存在', 'NOT_FOUND')
  // 更新场景：归属校验（跨 team 拒绝）
  if (existing) assertSloVisible(existing, auth)
  const { name, objective, windowDays, sliType } = validateSli(input)
  const sliConfig = parseConfig(input.sliConfig)
  const policy = parseConfig(input.alertPolicy)
  const now = Date.now()
  const teamId = app.team_id || null
  if (existing) {
    await run(
      `update slo_definitions set name=?, objective=?, window_days=?, sli_type=?, sli_config=?::jsonb, alert_policy=?::jsonb, updated_at=? where id=?`,
      [name, objective, windowDays, sliType, JSON.stringify(sliConfig), JSON.stringify(policy || {}), now, id]
    )
    return { id, updated: true }
  }
  await run(
    `insert into slo_definitions (id, app_id, team_id, name, objective, window_days, sli_type, sli_config, alert_policy, created_by, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?)`,
    [id, appId, teamId, name, objective, windowDays, sliType, JSON.stringify(sliConfig), JSON.stringify(policy || {}), auth?.userId || null, now, now]
  )
  return { id, created: true }
}

/** POST /api/slo 创建/更新（body 带 id 即更新）。 */
export async function createSlo(input = {}, auth) {
  return saveSlo(input, auth, { requireExisting: false })
}

/** PUT/更新：要求已存在。 */
export async function updateSloById(id, input = {}, auth) {
  return saveSlo({ ...input, id }, auth, { requireExisting: true })
}

/** 列表（按 app_id；accounts 下按 teamId 过滤；含最新预算快照）。 */
export async function listSlo(filters = {}) {
  const { page, pageSize } = pageOf(filters)
  const conditions = []
  const values = []
  if (filters.appId) { conditions.push('app_id=?'); values.push(filters.appId) }
  if (filters.teamId) { conditions.push('(team_id is null or team_id=?)'); values.push(filters.teamId) }
  const where = conditions.length ? `where ${conditions.join(' and ')}` : ''
  const [rows, total] = await Promise.all([
    all(`select * from slo_definitions ${where} order by updated_at desc limit ? offset ?`, [...values, pageSize, (page - 1) * pageSize]),
    scalar(`select count(*) count from slo_definitions ${where}`, values)
  ])
  const items = []
  for (const row of rows) {
    const snap = await latestSnapshot(row.id)
    items.push({
      ...publicSlo(row),
      latestBudget: snap
        ? { goodRatio: Number(snap.good_ratio), budgetUsed: Number(snap.budget_used), burnRate: Number(snap.burn_rate), status: snap.status, snapAt: Number(snap.snap_at) }
        : null
    })
  }
  return { items, total, page, pageSize }
}

/** 列表所有 SLO id（定时器遍历用，不限页）。 */
export async function listSloIds() {
  const rows = await all('select id from slo_definitions')
  return rows.map(row => row.id)
}

/** 详情（定义 + 当前预算/燃烧率/状态，取最新快照）。 */
export async function getSlo(id, auth) {
  const slo = await first('select * from slo_definitions where id=?', [id])
  if (!slo) throw notFound('SLO 不存在', 'NOT_FOUND')
  assertSloVisible(slo, auth)
  const snap = await latestSnapshot(id)
  const budget = snap
    ? {
        goodRatio: Number(snap.good_ratio),
        budgetUsed: Number(snap.budget_used),
        burnRate: Number(snap.burn_rate),
        status: snap.status,
        snapAt: Number(snap.snap_at),
        windowStart: Number(snap.window_start),
        windowEnd: Number(snap.window_end)
      }
    : { goodRatio: 1, budgetUsed: 0, burnRate: 0, status: 'healthy', noData: true }
  return { definition: publicSlo(slo), budget }
}

/** 删除（级联删快照）。 */
export async function deleteSlo(id, auth) {
  const slo = await first('select * from slo_definitions where id=?', [id])
  if (!slo) throw notFound('SLO 不存在', 'NOT_FOUND')
  assertSloVisible(slo, auth)
  await run('delete from slo_burn_snapshots where slo_id=?', [id])
  await run('delete from slo_definitions where id=?', [id])
  return { ok: true }
}

// ==================== 预算 / 快照 / 趋势 ====================

/**
 * 计算并写入全窗口滚动快照（定时 tick 与手动「立即计算」共用）。
 * @returns {Promise<object>} 快照对象
 */
export async function computeSnapshot(sloId, now = Date.now()) {
  const slo = await first('select * from slo_definitions where id=?', [sloId])
  if (!slo) throw notFound('SLO 不存在', 'NOT_FOUND')
  const windowMs = Number(slo.window_days) * 86400000
  const windowEnd = now
  const windowStart = now - windowMs
  const { total, bad } = await computeSli(slo, windowStart, windowEnd)
  const goodRatio = computeGoodRatio(bad, total)
  const burnRate = computeBurnRate(bad, total, slo.objective)
  const budgetUsed = burnRate
  const status = sloStatus(goodRatio, budgetUsed)
  const id = `sb_${randomToken(10)}`
  await run(
    `insert into slo_burn_snapshots (id, slo_id, snap_at, window_start, window_end, total, bad, good_ratio, budget_used, burn_rate, status)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, sloId, now, windowStart, windowEnd, total, bad, goodRatio, budgetUsed, burnRate, status]
  )
  return { id, sloId, snapAt: now, windowStart, windowEnd, total, bad, goodRatio, budgetUsed, burnRate, status }
}

/**
 * 多窗口多燃烧率判定 + 越界写燃尽告警（复用现有告警中心投递）。
 * @param {string} sloId
 * @param {object} [snapshotInput] 可选快照（否则取最新全窗口快照）
 * @returns {Promise<{breach:boolean, alert?:object}>}
 */
export async function evaluateAlerts(sloId, snapshotInput) {
  const slo = await first('select * from slo_definitions where id=?', [sloId])
  if (!slo) return { breach: false }
  const now = Date.now()
  const thresholds = sloThresholds(slo)
  // 计算每条阈值的长/短窗燃烧率
  const windows = []
  for (const entry of thresholds) {
    const long = await computeSli(slo, now - entry.longWindowMs, now)
    const longBurn = computeBurnRate(long.bad, long.total, slo.objective)
    let shortBurn = longBurn
    if (entry.shortWindowMs != null) {
      const short = await computeSli(slo, now - entry.shortWindowMs, now)
      shortBurn = computeBurnRate(short.bad, short.total, slo.objective)
    }
    windows.push({ longWindowMs: entry.longWindowMs, shortWindowMs: entry.shortWindowMs, longBurnRate: longBurn, shortBurnRate: shortBurn })
  }
  const breach = evaluateMultiWindowBurnRate({ windows, policy: thresholds })
  if (!breach.breach) return { breach: false }

  // 告警文案用全窗口燃烧率（错误预算消耗视角）
  const full = await computeSli(slo, now - Number(slo.window_days) * 86400000, now)
  const fullBurn = computeBurnRate(full.bad, full.total, slo.objective)
  const snapshot = snapshotInput || {
    goodRatio: computeGoodRatio(full.bad, full.total),
    budgetUsed: fullBurn,
    burn_rate: fullBurn,
    status: sloStatus(computeGoodRatio(full.bad, full.total), fullBurn)
  }
  const alert = await recordBurnAlert(slo, snapshot, breach)
  return { breach: true, alert }
}

/** 写 alert_history + 复用 createAlertDeliveries 投递（带冷却去重）。 */
async function recordBurnAlert(slo, snapshot, breach) {
  const alert = buildSloBurnAlert(slo, snapshot, breach)
  // 冷却：同 slo + 同 level 最近 SLO_ALERT_COOLDOWN_MS 内已告警则跳过
  const recent = await first(
    `select id, created_at from alert_history where metric='slo_burn' and app_id=? and context_json->>'sloId'=? and level=? order by created_at desc limit 1`,
    [slo.app_id, slo.id, alert.level]
  )
  if (recent && Date.now() - Number(recent.created_at) < SLO_ALERT_COOLDOWN_MS) return null
  const now = Date.now()
  const result = await run(
    `insert into alert_history (app_id, metric, level, value, message, status, context_json, created_at, updated_at)
     values (?, 'slo_burn', ?, ?, ?, 'pending', ?::jsonb, ?, ?) returning id`,
    [slo.app_id, alert.level, alert.value, alert.message, JSON.stringify(alert.context), now, now]
  )
  const id = Number(result.rows[0].id)
  await createAlertDeliveries(id)
  return { id, ...alert }
}

/** 该 SLO 的燃尽告警列表（alert_history where metric='slo_burn' and context.sloId）。 */
export async function listSloAlerts(sloId, filters = {}) {
  const { page, pageSize } = pageOf(filters)
  const [rows, total] = await Promise.all([
    all(`select * from alert_history where metric='slo_burn' and context_json->>'sloId'=? order by created_at desc limit ? offset ?`, [sloId, pageSize, (page - 1) * pageSize]),
    scalar(`select count(*) count from alert_history where metric='slo_burn' and context_json->>'sloId'=?`, [sloId])
  ])
  return { items: rows.map(mapAlert), total, page, pageSize }
}

/**
 * 错误预算 + 燃烧率（读快照，无快照则按 window 查询时计算，作为 ad-hoc 长窗口补充）。
 * 同时返回 total/bad 供前端展示分母。
 */
export async function computeBudget(sloId, windowDaysOverride, auth) {
  const slo = await first('select * from slo_definitions where id=?', [sloId])
  if (!slo) throw notFound('SLO 不存在', 'NOT_FOUND')
  assertSloVisible(slo, auth)
  const windowDays = Number(windowDaysOverride) || Number(slo.window_days)
  const now = Date.now()
  const windowEnd = now
  const windowStart = now - windowDays * 86400000
  const { total, bad } = await computeSli(slo, windowStart, windowEnd)
  const goodRatio = computeGoodRatio(bad, total)
  const burnRate = computeBurnRate(bad, total, slo.objective)
  const status = sloStatus(goodRatio, burnRate)
  return {
    goodRatio,
    budgetUsed: burnRate,
    budgetRemaining: Math.max(0, 1 - burnRate),
    burnRate,
    status,
    windowStart,
    windowEnd,
    total,
    bad
  }
}

/** 达标率趋势（按日桶，读 slo_burn_snapshots）。 */
export async function computeTrend(sloId, start, end, auth) {
  const slo = await first('select * from slo_definitions where id=?', [sloId])
  if (!slo) throw notFound('SLO 不存在', 'NOT_FOUND')
  assertSloVisible(slo, auth)
  const startTime = Number(start) || (Date.now() - 30 * 86400000)
  const endTime = Number(end) || Date.now()
  const rows = await all(
    `select floor(snap_at/86400000)*86400000 as bucket,
            avg(good_ratio) as good_ratio,
            avg(budget_used) as budget_used,
            avg(burn_rate) as burn_rate,
            max(case when status='burnt' then 2 when status='warning' then 1 else 0 end) as status_rank
     from slo_burn_snapshots where slo_id=? and snap_at>=? and snap_at<=?
     group by 1 order by 1`,
    [sloId, startTime, endTime]
  )
  const points = rows.map(row => ({
    bucket: Number(row.bucket),
    goodRatio: Number(row.good_ratio || 0),
    budgetUsed: Number(row.budget_used || 0),
    burnRate: Number(row.burn_rate || 0),
    status: row.status_rank >= 2 ? 'burnt' : row.status_rank >= 1 ? 'warning' : 'healthy'
  }))
  return { points }
}

/** 配置多窗口阈值 + 绑定 channelIds（severity→[channelId]）。 */
export async function setAlertPolicy(sloId, input = {}, auth) {
  const slo = await first('select * from slo_definitions where id=?', [sloId])
  if (!slo) throw notFound('SLO 不存在', 'NOT_FOUND')
  assertSloVisible(slo, auth)
  const thresholds = Array.isArray(input.policy) && input.policy.length ? input.policy : null
  const channelIds = Array.isArray(input.channelIds) ? input.channelIds.slice(0, 20).map(String).filter(Boolean) : []
  const merged = parseConfig(slo.alert_policy)
  const next = {
    ...(merged.thresholds ? { thresholds: merged.thresholds } : {}),
    ...(thresholds ? { thresholds } : {}),
    channels: { critical: channelIds, warning: channelIds }
  }
  await run(`update slo_definitions set alert_policy=?::jsonb, updated_at=? where id=?`, [JSON.stringify(next), Date.now(), sloId])
  return { ok: true }
}
