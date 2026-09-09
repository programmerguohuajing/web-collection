/**
 * @file D3 · 用量计量与套餐/定价服务层（Node / Postgres，PRD 15）。
 *
 * 职责边界（对齐 dsr-service / experiment-service 分层）：
 * - 采集热路径：events 批量 upsert + replay_sessions 去重会话 upsert（**best-effort，绝不阻断入库**）；
 * - 席位日快照：usage_daily(team_id, app_id='', metric='seats', day) 覆盖写，月度取 max；
 * - 套餐档位：plans（配置式）+ team_plans（含 per-team override）；无绑定行 → 逻辑默认 free 档；
 * - 超限检测：soft(soft_limit_pct)/hard(100%) 两段，quota_events 唯一约束保证只提醒一次；
 *   投递复用 packages/alerting.js 的 alert_history(metric='quota') + createAlertDeliveries。
 *
 * 口径与红线：
 * - `day` = yyyyMMdd（UTC 自然日），与 metric_daily_stats（0022）同范式；period_key='YYYY-MM' 与之互推；
 *   月度用量 = 当月日快照求和（seats 取 max），**不建 usage_monthly 冗余表**。
 * - 回放会话键 = `coalesce(base_session_id, session_id)`（架构 §2.6 裁定：PRD 的 PG 写法
 *   `count(distinct (app_id, session_id))` 得到的是「段数」，会让长会话客户被重复计费）。
 *   去重点查：有 baseSessionId → 月内去重（索引不含 created_at，当日去重会退化全表扫）；
 *   无 baseSessionId（历史数据）→ 当日去重。
 * - SQL 红线：全部 `=?` 精确匹配占位符（经 toPgSql 转 $n）；JSON 一律 text + JS 端解析
 *   （禁 JSONB `?`/`?|`/`?&` 算子）；PG `on conflict` 需带表名前缀 `usage_daily.value + excluded.value`。
 * - 配额告警 app_id 恒 `''`（团队级配额挂到应用语义不对），前端提示「请使用未限定应用的通知渠道」。
 */
import { all, first, run } from '../db.js'
import { isAccountsEnabled } from './auth-service.js'
import { randomToken } from '../../../../packages/auth-crypto.js'
import { hasPermission } from '../../../../packages/rbac.js'
import { NODE_CAPABILITIES } from '../../../../packages/deployment-capabilities.js'
import { badRequest, forbidden, notFound } from '../utils/http-error.js'
import { createAlertDeliveries } from '../alerting.js'

/** 计量维度（PRD §4）；retention_days 是套餐能力项，不是计量维度。 */
export const METRICS = ['events', 'replay_sessions', 'seats']
/** 维度展示名（告警文案与前端共用语义，前端另有中文映射） */
const METRIC_LABELS = { events: '事件数', replay_sessions: '回放会话数', seats: '席位' }
/** 计量数据保留期（自然月，PRD Q4：覆盖 2 年账单与争议期） */
export const RETENTION_MONTHS = 25
/** 档位/生效配额缓存 TTL（改档位 1 分钟内生效；避免每事件读库） */
const PLAN_CACHE_TTL_MS = 60000
/** 超限检测内存节流：同一 (team, metric, period) 60s 内只检测一次 */
const QUOTA_CHECK_THROTTLE_MS = 60000
/** 默认软限百分比（档位未给时的兜底） */
const DEFAULT_SOFT_LIMIT_PCT = 80
/** 周期键格式 YYYY-MM */
const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/
/** 日键格式 yyyyMMdd */
const DAY_PATTERN = /^\d{8}$/

/** 档位缓存：teamId → { at, value } */
const planCache = new Map()
/** 应用 → 团队 归属缓存：appId → { at, teamId } */
const appTeamCache = new Map()
/** 超限检测节流表：`team|metric|period` → 上次检测时间戳 */
const lastQuotaCheck = new Map()

// ==================== 纯函数：日切与周期换算（双栈共用同一实现，Worker 侧逐字镜像） ====================

/**
 * UTC 自然日键：yyyyMMdd。
 * @param {number} ts 毫秒时间戳
 * @returns {number} 如 20260901
 */
export function dayKeyOf(ts) {
  const at = Number.isFinite(Number(ts)) && Number(ts) > 0 ? Number(ts) : Date.now()
  return Number(new Date(at).toISOString().slice(0, 10).replace(/-/g, ''))
}

/**
 * 日键 → 周期键：'YYYY-MM'。
 * @param {number|string} day yyyyMMdd
 * @returns {string}
 */
export function periodKeyOf(day) {
  const text = String(day || '').padStart(8, '0').slice(0, 8)
  return `${text.slice(0, 4)}-${text.slice(4, 6)}`
}

/** 当前 UTC 自然月周期键。 */
export function currentPeriodKey() {
  return periodKeyOf(dayKeyOf(Date.now()))
}

/**
 * 周期键 → 该月首/末日键。
 * @param {string} periodKey 'YYYY-MM'
 * @returns {{dayFrom:number, dayTo:number}}
 */
export function periodRange(periodKey) {
  const key = normalizePeriodKey(periodKey)
  const year = Number(key.slice(0, 4))
  const month = Number(key.slice(5, 7))
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const prefix = key.replace('-', '')
  return { dayFrom: Number(`${prefix}01`), dayTo: Number(`${prefix}${String(lastDay).padStart(2, '0')}`) }
}

/** 周期键 → 该月首日 00:00 UTC 毫秒时间戳。 */
function periodStartMs(day) {
  const key = periodKeyOf(day)
  const year = Number(key.slice(0, 4))
  const month = Number(key.slice(5, 7))
  return Date.UTC(year, month - 1, 1)
}

/** 日键 → 当日 00:00 UTC 毫秒时间戳。 */
function dayStartMs(day) {
  const text = String(day || '').padStart(8, '0').slice(0, 8)
  return Date.UTC(Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8)))
}

/** 周期键校验（非法抛 400）。 */
function normalizePeriodKey(periodKey) {
  const key = String(periodKey || '').trim()
  if (!PERIOD_PATTERN.test(key)) throw badRequest('周期格式非法（应为 YYYY-MM）', 'INVALID_PERIOD')
  return key
}

/** 日键校验（非法抛 400）。 */
function normalizeDay(day) {
  const text = String(day ?? '').trim()
  if (!DAY_PATTERN.test(text)) throw badRequest('日期格式非法（应为 yyyyMMdd）', 'INVALID_DAY')
  return Number(text)
}

// ==================== 身份与团队边界（对齐 experiment-service requirePermission） ====================

/** 权限断言：accounts=false 单租户放行；开启后要求已登录且具备权限点（owner 恒允许）。 */
function requirePermission(auth, permission) {
  if (!isAccountsEnabled()) return
  if (!auth?.userId) throw forbidden('用量计量需要开启账号体系并登录（ACCOUNTS_ENABLED=1）', 'FORBIDDEN')
  if (!hasPermission(auth.role, permission)) {
    throw forbidden(`无用量计量操作权限（${permission}）`, 'FORBIDDEN')
  }
}

/**
 * 当前请求的团队边界：accounts 会话 → auth.teamId；否则 ''（单租户 / api_key 全局视野）。
 * 与 index.js /api/applications 的 teamScope 注入口径一致。
 */
export function teamScopeOf(auth) {
  if (isAccountsEnabled() && auth?.via === 'session' && auth.teamId) return String(auth.teamId).slice(0, 32)
  return ''
}

/** 应用 → 团队归属（60s 缓存；applications.team_id 为 null 时回落 ''）。 */
async function teamIdOfApp(appId) {
  const key = String(appId || '').slice(0, 64)
  if (!key) return ''
  const cached = appTeamCache.get(key)
  if (cached && Date.now() - cached.at < PLAN_CACHE_TTL_MS) return cached.teamId
  let teamId = ''
  try {
    const row = await first('select team_id from applications where app_id=?', [key])
    teamId = row?.team_id ? String(row.team_id).slice(0, 32) : ''
  } catch (error) {
    console.warn('[metering] resolve app team failed:', error?.message || error)
  }
  appTeamCache.set(key, { at: Date.now(), teamId })
  if (appTeamCache.size > 5000) appTeamCache.clear()
  return teamId
}

// ==================== usage_daily 写入（upsert） ====================

/**
 * 累加型 upsert（events / replay_sessions）：value = value + delta。
 * @param {string} teamId
 * @param {string} appId
 * @param {string} metric
 * @param {number} day yyyyMMdd
 * @param {number} delta
 */
async function upsertDelta(teamId, appId, metric, day, delta) {
  await run(`insert into usage_daily (team_id, app_id, metric, day, value, updated_at)
    values (?, ?, ?, ?, ?, ?)
    on conflict (team_id, app_id, metric, day)
    do update set value = usage_daily.value + excluded.value, updated_at = excluded.updated_at`,
    [String(teamId || '').slice(0, 32), String(appId || '').slice(0, 64), metric, Number(day), Number(delta) || 0, Date.now()])
}

/**
 * 覆盖型 upsert（seats 日快照）：value = value。
 * @param {string} teamId
 * @param {string} metric
 * @param {number} day yyyyMMdd
 * @param {number} value
 */
async function upsertSnapshot(teamId, metric, day, value) {
  await run(`insert into usage_daily (team_id, app_id, metric, day, value, updated_at)
    values (?, '', ?, ?, ?, ?)
    on conflict (team_id, app_id, metric, day)
    do update set value = excluded.value, updated_at = excluded.updated_at`,
    [String(teamId || '').slice(0, 32), metric, Number(day), Number(value) || 0, Date.now()])
}

// ==================== 采集热路径注入（best-effort，绝不向上抛） ====================

/**
 * Node 采集注入点（store.js recordEvents 循环后调用）：按 (teamId, appId) 聚合落库事件数并累加。
 * 每请求最多 N_app 次 upsert（而非每事件一次）。异常一律 console.warn，绝不阻断入库。
 * @param {Array<object>} events 已成功落库的事件（recordEvents 返回值）
 */
export async function meteringRecordCollected(events) {
  try {
    if (!NODE_CAPABILITIES.metering) return
    if (!Array.isArray(events) || !events.length) return
    const day = dayKeyOf(Date.now())
    const periodKey = periodKeyOf(day)
    const counts = new Map()
    for (const event of events) {
      if (!event || event.type === 'replay') continue
      const appId = String(event.appId || '').slice(0, 64)
      if (!appId) continue
      const teamId = await teamIdOfApp(appId)
      const key = `${teamId}\u0000${appId}`
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    for (const [key, delta] of counts) {
      const separator = key.indexOf('\u0000')
      const teamId = key.slice(0, separator)
      const appId = key.slice(separator + 1)
      await upsertDelta(teamId, appId, 'events', day, delta)
      await checkQuota(teamId, 'events', periodKey)
    }
  } catch (error) {
    // 计量丢 1 条可重算，用户数据丢 1 条不可逆 → 只告警，绝不向上抛。
    console.warn('[metering] events recording failed:', error?.message || error)
  }
}

/**
 * Node 回放段注入点（store.js recordReplay 落库成功后调用）：会话去重后 +1。
 * 点查计数语义：0 = 未落库（不计）；1 = 首个段（+1）；>1 = 已计过（分段续传不重复计）。
 * @param {object} event 回放事件（含 appId / sessionId / baseSessionId / ts）
 */
export async function meteringRecordReplay(event) {
  try {
    if (!NODE_CAPABILITIES.metering) return
    const appId = String(event?.appId || '').slice(0, 64)
    if (!appId) return
    const day = dayKeyOf(Number(event?.ts) || Date.now())
    const baseSessionId = event?.baseSessionId ? String(event.baseSessionId).slice(0, 128) : ''
    const sessionId = event?.sessionId ? String(event.sessionId).slice(0, 128) : ''
    const sessionKey = baseSessionId || sessionId
    if (!sessionKey) return
    // 有 baseSessionId → 月内去重（idx_replay_events_base_session 不含 created_at，当日去重会退化全表扫）；
    // 无（历史数据）→ 当日去重（走 idx_replay_events_app_session_ts）。
    const row = baseSessionId
      ? await first('select count(*) as c from replay_events where base_session_id=? and created_at>=?', [sessionKey, periodStartMs(day)])
      : await first('select count(*) as c from replay_events where app_id=? and session_id=? and created_at>=?', [appId, sessionKey, dayStartMs(day)])
    const count = Number(row?.c || 0)
    if (count !== 1) return
    const teamId = await teamIdOfApp(appId)
    await upsertDelta(teamId, appId, 'replay_sessions', day, 1)
    await checkQuota(teamId, 'replay_sessions', periodKeyOf(day))
  } catch (error) {
    console.warn('[metering] replay recording failed:', error?.message || error)
  }
}

// ==================== 席位日快照 ====================

/**
 * 席位日快照（幂等覆盖写）：team_members 中 status='active' 的去重 user_id 数。
 * accounts=false（单租户，无团队维度）时直接跳过——不写 seats 维度，接口返回 null。
 * @param {string} teamId
 * @param {number} day yyyyMMdd
 * @returns {Promise<number|null>} 席位数；跳过时返回 null
 */
export async function ensureSeatSnapshot(teamId, day) {
  if (!isAccountsEnabled()) return null
  const team = String(teamId || '').slice(0, 32)
  if (!team) return null
  const row = await first("select count(distinct user_id) as c from team_members where team_id=? and status='active'", [team])
  const seats = Number(row?.c || 0)
  await upsertSnapshot(team, 'seats', Number(day), seats)
  return seats
}

/** 全部团队的席位日快照（定时 tick 调用；单团队失败不影响其余）。 */
async function snapshotAllSeats(day) {
  if (!isAccountsEnabled()) return
  const rows = await all('select id from teams')
  for (const row of rows) {
    try {
      await ensureSeatSnapshot(String(row.id || '').slice(0, 32), day)
    } catch (error) {
      console.warn(`[metering] seat snapshot failed (team=${row.id}):`, error?.message || error)
    }
  }
}

// ==================== 套餐档位与生效配额 ====================

/** DB 行 → 档位视图（camelCase；JSON 字段 JS 端解析，规避 JSONB `?` 算子）。 */
function publicPlan(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    quota: parseQuota(row.quota_json),
    softLimitPct: Number(row.soft_limit_pct) || DEFAULT_SOFT_LIMIT_PCT,
    hardAction: row.hard_action || 'none',
    priceHint: parseJsonText(row.price_hint_json, null),
    enabled: row.enabled === true || row.enabled === 1 || row.enabled === '1'
  }
}

/** 解析 quota_json（缺字段回落 -1 不限量，retention_days 回落 0 表示未配置）。 */
function parseQuota(text) {
  const raw = parseJsonText(text, {})
  const source = raw && typeof raw === 'object' ? raw : {}
  return {
    events: Number.isFinite(Number(source.events)) ? Number(source.events) : -1,
    replay_sessions: Number.isFinite(Number(source.replay_sessions)) ? Number(source.replay_sessions) : -1,
    seats: Number.isFinite(Number(source.seats)) ? Number(source.seats) : -1,
    retention_days: Number.isFinite(Number(source.retention_days)) ? Number(source.retention_days) : 0
  }
}

/** JSON 文本解析（失败回落默认值，绝不抛）。 */
function parseJsonText(text, fallback) {
  if (text == null || text === '') return fallback
  try {
    const value = typeof text === 'string' ? JSON.parse(text) : text
    return value ?? fallback
  } catch {
    return fallback
  }
}

/**
 * 解析团队当前档位：team_plans 有行 → 其 plan_id；无行 → code='free' 的档位（逻辑默认，不写物理行）。
 * 60s 缓存（改档位不发版，1 分钟内生效）。
 * @param {string} teamId
 * @returns {Promise<{plan:object, override:object|null, teamPlan:object|null}>}
 */
async function resolvePlan(teamId) {
  const team = String(teamId || '').slice(0, 32)
  const cached = planCache.get(team)
  if (cached && Date.now() - cached.at < PLAN_CACHE_TTL_MS) return cached.value

  const teamPlan = await first('select * from team_plans where team_id=?', [team])
  let plan = null
  if (teamPlan?.plan_id) {
    const row = await first('select * from plans where id=?', [String(teamPlan.plan_id).slice(0, 32)])
    if (row) plan = publicPlan(row)
  }
  if (!plan) {
    const row = await first("select * from plans where code='free'")
    if (!row) {
      // 种子缺失（极端场景）→ 用内置兜底档位，保证接口不 500
      plan = { id: 'plan_free', code: 'free', name: '免费版', quota: parseQuota('{"events":100000,"replay_sessions":1000,"seats":3,"retention_days":7}'), softLimitPct: DEFAULT_SOFT_LIMIT_PCT, hardAction: 'none', priceHint: null, enabled: true }
    } else {
      plan = publicPlan(row)
    }
  }
  const value = {
    plan,
    override: parseJsonText(teamPlan?.quota_override_json ?? null, null),
    teamPlan: teamPlan || null
  }
  planCache.set(team, { at: Date.now(), value })
  if (planCache.size > 5000) planCache.clear()
  return value
}

/** 档位变更 / 覆盖变更后的缓存失效。 */
function invalidatePlanCache(teamId) {
  planCache.delete(String(teamId || '').slice(0, 32))
}

/**
 * 生效配额：override 优先于档位默认（enterprise 议价场景）。
 * @param {string} teamId
 * @returns {Promise<{planCode:string, planName:string, quota:object, softLimitPct:number, hardAction:string, customized:boolean}>}
 */
async function effectiveQuota(teamId) {
  const { plan, override } = await resolvePlan(teamId)
  const quota = { ...plan.quota }
  for (const key of ['events', 'replay_sessions', 'seats', 'retention_days']) {
    if (override && Number.isFinite(Number(override[key]))) quota[key] = Number(override[key])
  }
  return {
    planCode: plan.code,
    planName: plan.name,
    quota,
    softLimitPct: plan.softLimitPct,
    hardAction: plan.hardAction,
    customized: Boolean(override)
  }
}

// ==================== 超限检测与提醒 ====================

/**
 * 超限检测（60s 内存节流 + quota_events 唯一约束去重）。
 * quota <= 0（即 -1 不限量）直接返回；达阈值写 quota_events（on conflict do nothing）
 * 并复用告警通道投递 alert_history(metric='quota')。
 * @param {string} teamId
 * @param {string} metric events | replay_sessions | seats
 * @param {string} periodKey 'YYYY-MM'
 */
export async function checkQuota(teamId, metric, periodKey) {
  const team = String(teamId || '').slice(0, 32)
  const throttleKey = `${team}|${metric}|${periodKey}`
  const now = Date.now()
  const last = Number(lastQuotaCheck.get(throttleKey) || 0)
  if (now - last < QUOTA_CHECK_THROTTLE_MS) return
  lastQuotaCheck.set(throttleKey, now)
  if (lastQuotaCheck.size > 5000) lastQuotaCheck.clear()

  const plan = await effectiveQuota(team)
  const quota = Number(plan.quota?.[metric])
  if (!Number.isFinite(quota) || quota <= 0) return
  const { dayFrom, dayTo } = periodRange(periodKey)
  const used = await usedOf(team, metric, dayFrom, dayTo)
  const pct = quota > 0 ? Math.round((used / quota) * 1000) / 10 : 0
  const softPct = Number(plan.softLimitPct) || DEFAULT_SOFT_LIMIT_PCT
  const level = pct >= 100 ? 'hard' : pct >= softPct ? 'soft' : null
  if (!level) return

  const id = `qe_${randomToken(12)}`
  const result = await run(`insert into quota_events (id, team_id, metric, period_key, level, value, quota, notified, created_at)
    values (?, ?, ?, ?, ?, ?, ?, 0, ?)
    on conflict (team_id, metric, period_key, level) do nothing`,
    [id, team, metric, periodKey, level, used, quota, now])
  // 受影响行数为 0 → 并发已写或本周期已提醒过 → 不重复投递
  if (!Number(result?.rowCount)) return
  try {
    await emitQuotaAlert(team, metric, periodKey, level, used, quota, pct, softPct, plan.hardAction)
    await run('update quota_events set notified=1 where id=?', [id])
  } catch (error) {
    console.error('[metering] quota alert delivery failed:', error?.message || error)
  }
}

/** 写 alert_history(metric='quota') + 复用 createAlertDeliveries 投递（复刻 slo-service recordBurnAlert 范式）。 */
async function emitQuotaAlert(teamId, metric, periodKey, level, used, quota, pct, softPct, hardAction) {
  const alertLevel = level === 'hard' ? 'critical' : 'warning'
  const label = METRIC_LABELS[metric] || metric
  const scope = teamId || '默认团队'
  const message = level === 'hard'
    ? `[Web Collection] 团队「${scope}」的${label}用量已达配额上限：${used}/${quota}（${pct}%）。P0 阶段不阻断数据接收（hard_action=${hardAction || 'none'}），请及时升档或调低采样率。`
    : `[Web Collection] 团队「${scope}」的${label}用量已达配额 ${softPct}%：${used}/${quota}（${pct}%），超出后可能影响数据接收。`
  const context = { teamId, metric, periodKey, level, used, quota, pct, softLimitPct: softPct, hardAction: hardAction || 'none' }
  const result = await run(`insert into alert_history (app_id, metric, fingerprint, level, value, message, status, context_json, created_at, updated_at)
    values (?, 'quota', ?, ?, ?, ?, 'pending', ?::jsonb, ?, ?) returning id`,
    // 配额是团队级概念 → app_id 恒 ''（限定了 appIds 的通道收不到，UI 提示使用未限定应用的渠道）
    ['', `quota:${teamId}:${metric}:${periodKey}:${level}`, alertLevel, used, message, JSON.stringify(context), Date.now(), Date.now()])
  const alertId = Number(result?.rows?.[0]?.id)
  if (alertId) await createAlertDeliveries(alertId)
}

/** 周期用量：seats 取每日快照 max，其余取 sum。 */
async function usedOf(teamId, metric, dayFrom, dayTo) {
  if (metric === 'seats') {
    const row = await first('select max(value) as v from usage_daily where team_id=? and app_id=? and metric=? and day>=? and day<=?',
      [teamId, '', 'seats', dayFrom, dayTo])
    return Number(row?.v || 0)
  }
  const row = await first('select sum(value) as v from usage_daily where team_id=? and metric=? and day>=? and day<=?',
    [teamId, metric, dayFrom, dayTo])
  return Number(row?.v || 0)
}

// ==================== 管理面：用量查询 ====================

/**
 * GET /api/metering/usage：当前（或指定）自然月的用量 + 配额 + 百分比 + 超限标记。
 * @param {object} auth
 * @param {string} [period] 'YYYY-MM'
 */
export async function getUsage(auth, period) {
  requirePermission(auth, 'meterView')
  const teamId = teamScopeOf(auth)
  const periodKey = normalizePeriodKey(period || currentPeriodKey())
  const { dayFrom, dayTo } = periodRange(periodKey)
  const plan = await effectiveQuota(teamId)
  const seatsSupported = isAccountsEnabled()
  const metrics = []
  for (const metric of METRICS) {
    const quota = Number(plan.quota?.[metric])
    const unlimited = !Number.isFinite(quota) || quota <= 0
    if (metric === 'seats' && !seatsSupported) {
      // 单租户无团队维度：不填 0 冒充，返回 null + 顶层 seatsSupported=false（PRD §6.2）
      metrics.push({ metric, used: null, quota: null, pct: null, level: 'ok', unlimited: true })
      continue
    }
    const used = await usedOf(teamId, metric, dayFrom, dayTo)
    const pct = unlimited ? 0 : Math.round((used / quota) * 1000) / 10
    metrics.push({
      metric,
      used,
      quota: unlimited ? -1 : quota,
      pct,
      level: unlimited ? 'ok' : pct >= 100 ? 'hard' : pct >= (plan.softLimitPct || DEFAULT_SOFT_LIMIT_PCT) ? 'soft' : 'ok',
      unlimited
    })
  }
  return {
    period: periodKey,
    periodStart: dayFrom,
    periodEnd: dayTo,
    daysRemaining: daysRemainingOf(periodKey),
    plan: {
      code: plan.planCode,
      name: plan.planName,
      customized: plan.customized,
      softLimitPct: plan.softLimitPct,
      hardAction: plan.hardAction
    },
    retentionDays: Number(plan.quota?.retention_days) || 0,
    seatsSupported,
    metrics
  }
}

/** 距周期结束剩余天数（UTC，按月末 23:59:59.999 计）。 */
function daysRemainingOf(periodKey) {
  const { dayTo } = periodRange(periodKey)
  const endMs = dayStartMs(dayTo) + 86400000 - 1
  return Math.max(0, Math.ceil((endMs - Date.now()) / 86400000))
}

/**
 * GET /api/metering/usage/daily：按日序列（MiniLineChart 数据源）。
 * @param {object} auth
 * @param {{from?:string, to?:string, appId?:string}} params
 */
export async function getDaily(auth, params = {}) {
  requirePermission(auth, 'meterView')
  const teamId = teamScopeOf(auth)
  const periodKey = normalizePeriodKey(params.period || currentPeriodKey())
  const { dayFrom, dayTo } = periodRange(periodKey)
  const from = params.from ? normalizeDay(params.from) : dayFrom
  const to = params.to ? normalizeDay(params.to) : dayTo
  const values = [teamId, Math.min(from, to), Math.max(from, to)]
  const appId = String(params.appId || '').slice(0, 64)
  const appClause = appId ? ' and app_id=?' : ''
  if (appId) values.push(appId)
  const rows = await all(`select day,
      sum(case when metric = 'events' then value else 0 end) as events,
      sum(case when metric = 'replay_sessions' then value else 0 end) as replay_sessions
    from usage_daily
    where team_id=? and day>=? and day<=?${appClause}
    group by day
    order by day asc`, values)
  return rows.map(row => ({
    day: Number(row.day),
    events: Number(row.events || 0),
    replay_sessions: Number(row.replay_sessions || 0)
  }))
}

/**
 * GET /api/metering/usage/by-app：按应用拆分（按 events 降序，Top 50）。
 * @param {object} auth
 * @param {string} [period]
 */
export async function getByApp(auth, period) {
  requirePermission(auth, 'meterView')
  const teamId = teamScopeOf(auth)
  const periodKey = normalizePeriodKey(period || currentPeriodKey())
  const { dayFrom, dayTo } = periodRange(periodKey)
  const rows = await all(`select app_id,
      sum(case when metric = 'events' then value else 0 end) as events,
      sum(case when metric = 'replay_sessions' then value else 0 end) as replay_sessions
    from usage_daily
    where team_id=? and day>=? and day<=? and app_id <> ''
    group by app_id
    order by events desc
    limit 50`, [teamId, dayFrom, dayTo])
  const apps = await all('select app_id, name from applications')
  const nameOf = new Map(apps.map(row => [row.app_id, row.name || row.app_id]))
  const total = rows.reduce((sum, row) => sum + Number(row.events || 0), 0)
  return rows.map(row => {
    const events = Number(row.events || 0)
    return {
      appId: row.app_id,
      appName: nameOf.get(row.app_id) || row.app_id,
      events,
      replay_sessions: Number(row.replay_sessions || 0),
      pct: total > 0 ? Math.round((events / total) * 1000) / 10 : 0
    }
  })
}

// ==================== 管理面：档位 ====================

/** GET /api/metering/plans：档位列表（含 quota / softLimitPct / hardAction），用于对比表。 */
export async function listPlans(auth) {
  requirePermission(auth, 'meterView')
  const rows = await all("select * from plans where enabled=true order by case code when 'free' then 0 when 'pro' then 1 else 2 end, created_at asc")
  return rows.map(publicPlan)
}

/** GET /api/metering/plan：当前团队档位 + 生效配额（含 override 标记）+ 变更人/时间。 */
export async function getTeamPlan(auth) {
  requirePermission(auth, 'meterView')
  const teamId = teamScopeOf(auth)
  const { plan, override, teamPlan } = await resolvePlan(teamId)
  const quota = { ...plan.quota }
  for (const key of ['events', 'replay_sessions', 'seats', 'retention_days']) {
    if (override && Number.isFinite(Number(override[key]))) quota[key] = Number(override[key])
  }
  return {
    teamId,
    plan: { id: plan.id, code: plan.code, name: plan.name },
    quota,
    customized: Boolean(override),
    bound: Boolean(teamPlan),
    updatedBy: teamPlan?.updated_by || null,
    updatedAt: teamPlan?.updated_at == null ? null : Number(teamPlan.updated_at)
  }
}

/**
 * PUT /api/metering/plan：变更档位或写 per-team 覆盖（降配额由前端 ElMessageBox 二次确认）。
 * @param {object} auth
 * @param {{planCode?:string, quotaOverride?:object|null}} body
 */
export async function putTeamPlan(auth, body = {}) {
  requirePermission(auth, 'meterManage')
  const teamId = teamScopeOf(auth)
  const now = Date.now()
  const operator = String(auth?.userId || auth?.email || 'system').slice(0, 64)
  const { plan, teamPlan } = await resolvePlan(teamId)

  let planId = teamPlan?.plan_id ? String(teamPlan.plan_id).slice(0, 32) : plan.id
  if (body.planCode !== undefined && body.planCode !== null && body.planCode !== '') {
    const target = await first('select * from plans where code=? and enabled=true', [String(body.planCode).slice(0, 32)])
    if (!target) throw notFound('套餐档位不存在或已下架', 'PLAN_NOT_FOUND')
    planId = target.id
  }
  let overrideText = teamPlan?.quota_override_json ?? null
  if (body.quotaOverride !== undefined) {
    if (body.quotaOverride === null) {
      overrideText = null
    } else if (body.quotaOverride && typeof body.quotaOverride === 'object' && !Array.isArray(body.quotaOverride)) {
      const override = {}
      for (const key of ['events', 'replay_sessions', 'seats', 'retention_days']) {
        if (body.quotaOverride[key] !== undefined && body.quotaOverride[key] !== null && body.quotaOverride[key] !== '') {
          const value = Number(body.quotaOverride[key])
          if (!Number.isFinite(value)) throw badRequest(`配额覆盖字段 ${key} 必须是数字`, 'INVALID_QUOTA_OVERRIDE')
          override[key] = Math.trunc(value)
        }
      }
      overrideText = Object.keys(override).length ? JSON.stringify(override) : null
    } else {
      throw badRequest('配额覆盖必须是对象或 null', 'INVALID_QUOTA_OVERRIDE')
    }
  }
  await run(`insert into team_plans (team_id, plan_id, quota_override_json, updated_by, updated_at)
    values (?, ?, ?, ?, ?)
    on conflict (team_id) do update set plan_id=excluded.plan_id, quota_override_json=excluded.quota_override_json,
      updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
    [teamId, planId, overrideText, operator, now])
  invalidatePlanCache(teamId)
  return getTeamPlan(auth)
}

/** GET /api/metering/quota-events：超限历史（按周期过滤）。 */
export async function listQuotaEvents(auth, period) {
  requirePermission(auth, 'meterView')
  const teamId = teamScopeOf(auth)
  const values = [teamId]
  let clause = ''
  if (period) {
    clause = ' and period_key=?'
    values.push(normalizePeriodKey(period))
  }
  const rows = await all(`select * from quota_events where team_id=?${clause} order by created_at desc limit 200`, values)
  return rows.map(row => ({
    id: row.id,
    teamId: row.team_id,
    metric: row.metric,
    periodKey: row.period_key,
    level: row.level,
    value: Number(row.value || 0),
    quota: Number(row.quota || 0),
    notified: Number(row.notified || 0) === 1,
    createdAt: Number(row.created_at || 0)
  }))
}

// ==================== P1：重算与导出 ====================

/**
 * POST /api/metering/recompute?day=yyyyMMdd：从 events 真实 COUNT 与回放去重会话 COUNT
 * 重建当天快照（幂等，修复热路径 upsert 丢失）。
 * @param {object} auth
 * @param {string|number} day yyyyMMdd
 */
export async function recomputeDay(auth, day) {
  requirePermission(auth, 'meterManage')
  const dayKey = normalizeDay(day)
  const startMs = dayStartMs(dayKey)
  const endMs = startMs + 86400000
  // 幂等重建：先清当天两个累加维度，再按事实源重算（不建月度冗余表，仅日粒度）
  await run("delete from usage_daily where day=? and metric in ('events','replay_sessions')", [dayKey])
  const eventRows = await all('select app_id, count(*) as c from events where ts>=? and ts<? group by app_id', [startMs, endMs])
  const replayRows = await all(`select app_id, count(*) as c from (
      select app_id, coalesce(base_session_id, session_id) as session_key
      from replay_events where created_at>=? and created_at<? group by app_id, session_key
    ) t group by app_id`, [startMs, endMs])
  const appIds = new Set([...eventRows.map(row => row.app_id), ...replayRows.map(row => row.app_id)])
  const eventMap = new Map(eventRows.map(row => [row.app_id, Number(row.c || 0)]))
  const replayMap = new Map(replayRows.map(row => [row.app_id, Number(row.c || 0)]))
  const rebuilt = { events: 0, replay_sessions: 0 }
  for (const appId of appIds) {
    const app = String(appId || '').slice(0, 64)
    if (!app) continue
    const teamId = await teamIdOfApp(app)
    const events = Number(eventMap.get(appId) || 0)
    const replays = Number(replayMap.get(appId) || 0)
    if (events > 0) {
      await upsertDelta(teamId, app, 'events', dayKey, events)
      rebuilt.events += events
    }
    if (replays > 0) {
      await upsertDelta(teamId, app, 'replay_sessions', dayKey, replays)
      rebuilt.replay_sessions += replays
    }
  }
  return { day: dayKey, ...rebuilt, apps: appIds.size }
}

/**
 * GET /api/metering/usage/export：按应用 × 按日明细 CSV（财务对账 / 成本分摊）。
 * @param {object} auth
 * @param {string} period 'YYYY-MM'
 * @returns {Promise<string>} CSV 文本（含 BOM 由路由层添加）
 */
export async function exportUsageCsv(auth, period) {
  requirePermission(auth, 'meterView')
  const teamId = teamScopeOf(auth)
  const periodKey = normalizePeriodKey(period || currentPeriodKey())
  const { dayFrom, dayTo } = periodRange(periodKey)
  const rows = await all(`select day, app_id,
      sum(case when metric = 'events' then value else 0 end) as events,
      sum(case when metric = 'replay_sessions' then value else 0 end) as replay_sessions
    from usage_daily
    where team_id=? and day>=? and day<=?
    group by day, app_id
    order by day asc, app_id asc`, [teamId, dayFrom, dayTo])
  const lines = [['day', 'app_id', 'events', 'replay_sessions'].join(',')]
  for (const row of rows) {
    lines.push([Number(row.day), row.app_id, Number(row.events || 0), Number(row.replay_sessions || 0)].join(','))
  }
  return lines.join('\r\n')
}

// ==================== 定时 tick ====================

/**
 * 6h 定时：席位日快照（幂等）+ 25 个自然月保留清理。
 * usage_daily / quota_events **不在** governance cleanupExpiredData() 清单内，其清理独立执行。
 */
export async function meteringDailyTick() {
  if (!NODE_CAPABILITIES.metering) return { skipped: true }
  const day = dayKeyOf(Date.now())
  try {
    await snapshotAllSeats(day)
  } catch (error) {
    console.warn('[metering] seat snapshot tick failed:', error?.message || error)
  }
  const cutoff = retentionCutoffDay()
  let deletedUsage = 0
  let deletedEvents = 0
  try {
    deletedUsage = Number((await run('delete from usage_daily where day < ?', [cutoff.day]))?.rowCount || 0)
    deletedEvents = Number((await run('delete from quota_events where created_at < ?', [cutoff.ms]))?.rowCount || 0)
  } catch (error) {
    console.warn('[metering] retention cleanup failed:', error?.message || error)
  }
  return { day, seats: isAccountsEnabled(), deletedUsage, deletedEvents }
}

/** 25 个自然月前的日键与毫秒时间戳（供双栈共用同一口径）。 */
function retentionCutoffDay() {
  const now = new Date()
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - RETENTION_MONTHS, 1))
  return { day: dayKeyOf(cutoff.getTime()), ms: cutoff.getTime() }
}
