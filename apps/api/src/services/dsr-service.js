/**
 * @file D1 · 数据主体权利 DSR 服务（Node / Postgres，PRD 13）。
 * 工单 CRUD + 状态机（服务端强制）+ 命中量预览 + 匿名化/硬删分批执行 + access 导出打包 + append-only 审计。
 *
 * 设计依据（对齐 outputs/d1-dsr-architecture.md §5 伪代码）：
 * - 状态机迁移校验：非法迁移 409 + 审计留痕（illegal_transition）；审批人 ≠ 发起人服务端强制（403）；
 * - 命中口径：events/replays 按主体列 = 精确匹配（防误伤）；issues 无独立个人列，按
 *   props_json/original_json like '%subjectValue%' 保守口径（PRD §4 非目标：不做 props 内部 PII 挖掘）；
 * - 擦除默认匿名化：个人字段置 '[DSR-ERASED]'（session_id 保留，PRD §8.2）；硬删按工单显式勾选 + 执行时确认；
 *   分批 ≤10000 行/批（id 子查询圈定），批间 sleep 50ms（D1 限速保护，PG 无害，统一行为便于审计口径一致）；
 * - issues 匿名化（Lead 裁决②保守口径）：按命中 like 将 props_json/original_json 中的主体原文整段替换为占位符，
 *   affected_users 统计口径不减（架构 §七.3）；
 * - access 导出：events/issues/replays 三表分别拉行（≤10000 行/表，超限截断并在 result_json 标注
 *   「已截断，全量走 JSON 分页导出」，Lead 裁决③），csv → CSV 文本（BOM），json → 单包 JSON 文本；
 * - subject_value 限权：所有 DSR 路由均要求 dsr:view 及以上（矩阵全为 admin+），原文仅在这些路由返回；
 *   擦除执行完成（completed）后服务端清空 subject_value → '[DSR-CLEARED]'（PRD §8.1 降级决策）；
 * - 团队边界：accounts 会话按 auth.teamId 圈定 team 内应用（applications.team_id）；api_key（owner）跨队可见；
 * - 审计：dsr_audit_logs append-only，每次迁移一条，含影响行数/批次游标/过滤口径 detail_json。
 */
import { all, first, run } from '../db.js'
import { randomToken } from '../../../../packages/auth-crypto.js'
import { hasPermission } from '../../../../packages/rbac.js'
import { isAccountsEnabled } from './auth-service.js'
import { badRequest, conflict, forbidden, notFound } from '../utils/http-error.js'

/** 单批行数（QA #3 裁决：10000 → 1000，D1 单语句友好；PG 同伪代码复用，统一审计口径；双端同值） */
const BATCH = 1000
/** 批间限速（ms）；D1 30s 红线保护，PG 无害 */
const BATCH_SLEEP_MS = 50
/** 单次调用分批上限（QA #3：≤30 批 = 30000 行，达上限返回 partial 并保持 executing，前端「继续执行」幂等重跑；双端同值） */
const MAX_BATCHES_PER_CALL = 30
/** 匿名化占位值（PRD §8.2 默认口径） */
const ERASED = '[DSR-ERASED]'
/** 工单完成后主体标识原文清空占位（PRD §8.1 降级决策） */
const CLEARED = '[DSR-CLEARED]'
/** 分批循环安全上限（防异常数据死循环；已被 MAX_BATCHES_PER_CALL 的共享预算取代，保留兜底） */
const MAX_BATCHES = MAX_BATCHES_PER_CALL
/** 法定期限 SLA（GDPR 一个月口径，前端列表高亮用） */
export const DSR_SLA_DAYS = 30

/** 主体标识类型 → events 列（events 全列可等值匹配） */
const EVENT_SUBJECT_COL = {
  user_id: 'user_id',
  user_name: 'user_name',
  user_phone: 'user_phone',
  device_id: 'device_id',
  session_id: 'session_id'
}
/** 主体标识类型 → replay_events 列（回放表无 device_id 列 → device_id 主体命中恒 0） */
const REPLAY_SUBJECT_COL = {
  user_id: 'user_id',
  user_name: 'user_name',
  user_phone: 'user_phone',
  device_id: null,
  session_id: 'session_id'
}

/** 状态机（服务端强制，双栈同伪代码）：executing 仅允许服务端执行完成后迁移 completed */
const DSR_TRANSITIONS = {
  draft: ['pending_approval', 'cancelled'],
  pending_approval: ['approved', 'rejected', 'cancelled'],
  approved: ['executing'],
  executing: ['completed'],
  completed: [],
  rejected: [],
  cancelled: []
}

const STATUS_TO_ACTION = { pending_approval: 'submit', approved: 'approve', rejected: 'reject', cancelled: 'cancel', completed: 'complete' }

// ==================== 身份与团队边界 ====================

/**
 * DSR 操作者断言：账号体系开启 + 已登录 + 具备指定权限点（矩阵全为 admin+，owner 恒允许）。
 * accounts=false 部署下 DSR 不可用（工单的发起/审批/执行责任主体无法成立），返回 403 而非静默放行。
 */
function requireActor(auth, permission) {
  if (!isAccountsEnabled() || !auth?.userId) {
    throw forbidden('DSR 需要开启账号体系并登录（ACCOUNTS_ENABLED=1）', 'FORBIDDEN')
  }
  if (!hasPermission(auth.role, permission)) {
    throw forbidden('无 DSR 操作权限（需要 Admin 及以上角色）', 'FORBIDDEN')
  }
  return auth
}

/** 团队可见性断言：accounts 会话下跨 team 归属（team_id 非空且不等）拒绝（对齐 synthetic assertCheckVisible）。 */
function assertRequestVisible(row, auth) {
  if (!isAccountsEnabled()) return
  if (auth?.via !== 'session' || !auth.teamId) return
  if (row.team_id && row.team_id !== auth.teamId) {
    throw forbidden('无权访问该 DSR 工单（跨团队）', 'FORBIDDEN')
  }
}

/**
 * 应用范围子句（三表统一）：
 * - 指定 appId → app_id = ?（归属校验：team 会话下跨队应用拒绝）
 * - team 会话有 teamId → team 内应用 in (...)；团队暂无应用 → 恒假子句（命中 0）
 * - api_key（owner，无 teamId）→ 无应用过滤（全量，与存量「team_id null 全员可见」口径一致）
 */
async function appScope(auth, appId) {
  const appIdNorm = String(appId || '').trim().slice(0, 64)
  if (appIdNorm) {
    if (isAccountsEnabled() && auth?.via === 'session' && auth.teamId) {
      const app = await first('select app_id, team_id from applications where app_id=?', [appIdNorm])
      if (app && app.team_id && app.team_id !== auth.teamId) {
        throw forbidden('目标应用不属于当前团队', 'FORBIDDEN')
      }
    }
    return { sql: ' and app_id = ?', vals: [appIdNorm] }
  }
  if (isAccountsEnabled() && auth?.via === 'session' && auth.teamId) {
    const apps = await all('select app_id from applications where team_id=?', [auth.teamId])
    if (!apps.length) return { sql: ' and 1=0', vals: [] }
    return { sql: ` and app_id in (${apps.map(() => '?').join(',')})`, vals: apps.map(row => row.app_id) }
  }
  return { sql: '', vals: [] }
}

// ==================== 命中口径（架构 §5.2） ====================

/**
 * issues 保守口径命中片段（QA #4 裁决「宁多勿漏」：users_json OR props_json OR original_json 三列 LIKE；
 * PG 方言：jsonb 需 ::text 后 like，对齐 repositories/issues-repo.js 范式）。
 * ⚠ 双栈方言分叉（QA Round 2 · Lead 裁决方案二）：D1 的 issues 表无 users_json 列，
 * Worker 侧（worker.js DSR_ISSUES_HIT_W）为 props_json OR original_json 两列口径——
 * 未来 D1 issues 增列时需同步恢复三列；本端三列口径保持不变，两端注释互相指明防漂移。
 */
function issuesHitSql() {
  return `(users_json::text like ? or props_json::text like ? or original_json::text like ?)`
}

/** 三表命中量计数（创建工单时同步执行；subject 对 events/replays 精确等值，issues like 聚合列） */
async function countHits(scope, subjectType, subjectValue) {
  const eventCol = EVENT_SUBJECT_COL[subjectType]
  const replayCol = REPLAY_SUBJECT_COL[subjectType]
  const likeVals = [`%${subjectValue}%`, `%${subjectValue}%`, `%${subjectValue}%`]
  const [eventsRow, replaysRow, issuesRow] = await Promise.all([
    first(`select count(*) count from events where 1=1${scope.sql} and ${eventCol} = ?`, [...scope.vals, subjectValue]),
    replayCol
      ? first(`select count(*) count from replay_events where 1=1${scope.sql} and ${replayCol} = ?`, [...scope.vals, subjectValue])
      : Promise.resolve({ count: 0 }),
    first(`select count(*) count from issues where 1=1${scope.sql} and ${issuesHitSql()}`, [...scope.vals, ...likeVals])
  ])
  return {
    events: Number(eventsRow?.count || 0),
    issues: Number(issuesRow?.count || 0),
    replays: Number(replaysRow?.count || 0)
  }
}

// ==================== 审计（append-only） ====================

async function insertAudit(requestId, actorId, action, detail = {}) {
  await run(
    'insert into dsr_audit_logs (id, request_id, actor_id, action, detail_json, ts) values (?, ?, ?, ?, ?, ?)',
    [`dal_${randomToken(12)}`, requestId, String(actorId || 'system').slice(0, 64), String(action).slice(0, 24), JSON.stringify(detail).slice(0, 8000), Date.now()]
  )
}

// ==================== 状态机（架构 §5.1，服务端强制） ====================

/**
 * 状态迁移：非法迁移 409 + 审计留痕；approve 自批 403（双人制衡服务端强制）。
 * @param {string|null} actionOverride 审计 action 覆盖（executing 迁移按 PRD 归入 execute_export/execute_erasure）
 * @returns {Promise<object>} 迁移后的工单行（snake_case）
 */
async function transition(row, to, actorId, patch = {}, actionOverride = null) {
  if (!(DSR_TRANSITIONS[row.status] || []).includes(to)) {
    await insertAudit(row.id, actorId, 'illegal_transition', { from: row.status, to })
    throw conflict(`非法状态迁移：${row.status} → ${to}`, 'ILLEGAL_TRANSITION')
  }
  if (to === 'approved' && String(actorId) === String(row.requested_by)) {
    // QA #2：自批拦截落审计（action='blocked'），与 Worker 端同逻辑，保证审批制衡留痕零缺口
    await insertAudit(row.id, actorId, 'blocked', { reason: 'self_approve', from: row.status, to })
    throw forbidden('审批人不得为发起人（双人制衡）', 'FORBIDDEN')
  }
  const keys = ['status', ...Object.keys(patch)]
  const vals = [to, ...Object.values(patch)]
  await run(`update dsr_requests set ${keys.map(key => `${key}=?`).join(', ')} where id=?`, [...vals, row.id])
  await insertAudit(row.id, actorId, actionOverride || STATUS_TO_ACTION[to] || to, { from: row.status, to, ...patch })
  return first('select * from dsr_requests where id=?', [row.id])
}

// ==================== 视图映射 ====================

/** DB 行 → API 视图（camelCase，双栈同形状）。subject_value 仅 dsr:view 可达路由返回，此处恒携带。 */
function publicRequest(row) {
  return {
    id: row.id,
    teamId: row.team_id || null,
    appId: row.app_id || '',
    subjectType: row.subject_type,
    subjectValue: row.subject_value,
    requestType: row.request_type,
    mode: row.mode || null,
    exportFormat: row.export_format || null,
    status: row.status,
    hitEvents: Number(row.hit_events || 0),
    hitIssues: Number(row.hit_issues || 0),
    hitReplays: Number(row.hit_replays || 0),
    requestedBy: row.requested_by,
    approvedBy: row.approved_by || null,
    executedBy: row.executed_by || null,
    rejectReason: row.reject_reason || null,
    rowsAffectedEvents: Number(row.rows_affected_events || 0),
    rowsAffectedIssues: Number(row.rows_affected_issues || 0),
    rowsAffectedReplays: Number(row.rows_affected_replays || 0),
    result: safeParseJson(row.result_json, null),
    createdAt: Number(row.created_at),
    decidedAt: row.decided_at == null ? null : Number(row.decided_at),
    executedAt: row.executed_at == null ? null : Number(row.executed_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at)
  }
}

function safeParseJson(text, fallback) {
  try { return typeof text === 'string' ? JSON.parse(text) : (text ?? fallback) } catch { return fallback }
}

function auditView(row) {
  return {
    id: row.id,
    requestId: row.request_id,
    actorId: row.actor_id,
    action: row.action,
    detail: safeParseJson(row.detail_json, {}),
    ts: Number(row.ts)
  }
}

/** 按 id 取工单行并做团队可见性校验，不存在抛 404。 */
async function requireRequest(id, auth) {
  const row = await first('select * from dsr_requests where id=?', [String(id || '').slice(0, 32)])
  if (!row) throw notFound('DSR 工单不存在', 'NOT_FOUND')
  assertRequestVisible(row, auth)
  return row
}

// ==================== 输入收敛 ====================

const SUBJECT_TYPES = Object.keys(EVENT_SUBJECT_COL)

function normalizeCreateInput(input) {
  const subjectType = String(input.subjectType || '').trim()
  if (!SUBJECT_TYPES.includes(subjectType)) {
    throw badRequest(`subjectType 必须为 ${SUBJECT_TYPES.join(' / ')}`, 'BAD_REQUEST')
  }
  const subjectValue = String(input.subjectValue || '').trim().slice(0, 256)
  if (!subjectValue) throw badRequest('subjectValue 不能为空', 'BAD_REQUEST')
  const requestType = input.requestType === 'erasure' ? 'erasure' : input.requestType === 'access' ? 'access' : null
  if (!requestType) throw badRequest('requestType 必须为 access | erasure', 'BAD_REQUEST')
  let mode = null
  let exportFormat = null
  if (requestType === 'erasure') {
    mode = input.mode === 'hard_delete' ? 'hard_delete' : 'anonymize'
    if (mode === 'hard_delete' && !String(input.reason || '').trim()) {
      throw badRequest('硬删除必须填写理由（审批与审计留痕）', 'BAD_REQUEST')
    }
  } else {
    exportFormat = input.exportFormat === 'json' ? 'json' : 'csv'
  }
  return { subjectType, subjectValue, requestType, mode, exportFormat, reason: String(input.reason || '').trim().slice(0, 512) }
}

// ==================== CRUD ====================

/**
 * POST /api/dsr/requests：创建工单（draft），服务端同步计算命中量快照 + 审计 create。
 * @returns {Promise<object>} 工单视图（含 hitEvents/hitIssues/hitReplays）
 */
export async function createDsrRequest(input = {}, auth) {
  const actor = requireActor(auth, 'dsrCreate')
  const v = normalizeCreateInput(input)
  const scope = await appScope(auth, input.appId)
  const hits = await countHits(scope, v.subjectType, v.subjectValue)
  const id = `dsr_${randomToken(12)}`
  const now = Date.now()
  const teamId = isAccountsEnabled() && auth?.teamId ? auth.teamId : null
  await run(
    `insert into dsr_requests (id, team_id, app_id, subject_type, subject_value, request_type, mode, export_format, status,
      hit_events, hit_issues, hit_replays, requested_by, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
    [id, teamId, String(input.appId || '').trim().slice(0, 64), v.subjectType, v.subjectValue, v.requestType, v.mode, v.exportFormat,
      hits.events, hits.issues, hits.replays, actor.userId, now]
  )
  await insertAudit(id, actor.userId, 'create', {
    subjectType: v.subjectType, requestType: v.requestType, mode: v.mode, exportFormat: v.exportFormat,
    appId: input.appId || '', teamId, hits, hardDeleteReason: v.mode === 'hard_delete' ? v.reason : undefined
  })
  return publicRequest(await requireRequest(id, auth))
}

/**
 * GET /api/dsr/requests：列表（status/requestType/appId 过滤 + team 会话团队过滤），created_at 倒序。
 */
export async function listDsrRequests(query = {}, auth) {
  requireActor(auth, 'dsrView')
  const page = Math.max(1, Math.min(1000000, Math.floor(Number(query.page) || 1)))
  const pageSize = Math.max(1, Math.min(100, Math.floor(Number(query.pageSize) || 20)))
  const conditions = []
  const values = []
  if (query.status) { conditions.push('status=?'); values.push(String(query.status).slice(0, 24)) }
  if (query.requestType) { conditions.push('request_type=?'); values.push(String(query.requestType).slice(0, 16)) }
  if (query.appId) { conditions.push('app_id=?'); values.push(String(query.appId).slice(0, 64)) }
  if (isAccountsEnabled() && auth?.via === 'session' && auth.teamId) {
    conditions.push('(team_id is null or team_id=?)')
    values.push(auth.teamId)
  }
  const where = conditions.length ? `where ${conditions.join(' and ')}` : ''
  const [rows, totalRow] = await Promise.all([
    all(`select * from dsr_requests ${where} order by created_at desc limit ? offset ?`, [...values, pageSize, (page - 1) * pageSize]),
    first(`select count(*) count from dsr_requests ${where}`, values)
  ])
  return { items: rows.map(publicRequest), total: Number(totalRow?.count || 0), page, pageSize }
}

/** GET /api/dsr/requests/:id：详情（工单 + 审计时间线一次带出，省一次请求；audit 路由保留供轮询）。 */
export async function getDsrRequest(id, auth) {
  requireActor(auth, 'dsrView')
  const row = await requireRequest(id, auth)
  const audit = await listDsrAudit(id, auth)
  return { request: publicRequest(row), audit: audit.items }
}

// ==================== 状态迁移动作 ====================

/** POST /:id/submit：draft → pending_approval。 */
export async function submitDsrRequest(id, auth) {
  const actor = requireActor(auth, 'dsrCreate')
  const row = await requireRequest(id, auth)
  const next = await transition(row, 'pending_approval', actor.userId)
  return publicRequest(next)
}

/**
 * POST /:id/approve：{decision:'approve'|'reject', reason?}。
 * approve：服务端强制审批人 ≠ 发起人；写 approved_by / decided_at。
 * reject：写 reject_reason / decided_at（终态）。
 */
export async function approveDsrRequest(id, body = {}, auth) {
  const actor = requireActor(auth, 'dsrApprove')
  const row = await requireRequest(id, auth)
  const decision = body.decision === 'reject' ? 'reject' : body.decision === 'approve' ? 'approve' : null
  if (!decision) throw badRequest('decision 必须为 approve | reject', 'BAD_REQUEST')
  const now = Date.now()
  if (decision === 'approve') {
    const next = await transition(row, 'approved', actor.userId, { approved_by: actor.userId, decided_at: now })
    return publicRequest(next)
  }
  const reason = String(body.reason || '').trim().slice(0, 512) || null
  const next = await transition(row, 'rejected', actor.userId, { reject_reason: reason, decided_at: now })
  return publicRequest(next)
}

/** POST /:id/cancel：仅发起人本人，draft/pending_approval 可取消（终态）。 */
export async function cancelDsrRequest(id, auth) {
  const actor = requireActor(auth, 'dsrCreate')
  const row = await requireRequest(id, auth)
  if (String(actor.userId) !== String(row.requested_by)) {
    throw forbidden('仅发起人本人可取消工单', 'FORBIDDEN')
  }
  const next = await transition(row, 'cancelled', actor.userId)
  return publicRequest(next)
}

// ==================== 执行：擦除（架构 §5.3，分批） ====================

/** 批间限速（sleep 50ms；D1 限速保护，PG 无害） */
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

/**
 * events / replay_events 分批匿名化或硬删。
 * 匿名化：个人字段置 '[DSR-ERASED]'（session_id 保留）；已擦除行不再命中主体条件 → 批次自然收敛。
 * 硬删：id 子查询圈定（对齐架构 §5.3；PG 无 delete...limit 方言差异，统一同构写法）。
 * QA #3：批大小 BATCH(1000)；budget 为跨表共享预算对象 {left}，单次调用 ≤MAX_BATCHES_PER_CALL(30) 批，
 * 预算耗尽返回 { partial: true }，工单保持 executing 由前端「继续执行」幂等重跑。
 * @returns {Promise<{changed: number, partial: boolean}>} 实际影响行数 + 是否因预算耗尽截断
 */
async function eraseRowsBatched(table, hitWhere, hitVals, mode, withDeviceId, budget) {
  let changed = 0
  for (let i = 0; i < MAX_BATCHES; i++) {
    if (budget.left <= 0) return { changed, partial: true }
    budget.left--
    let result
    if (mode === 'hard_delete') {
      result = await run(
        `delete from ${table} where id in (select id from ${table} where ${hitWhere} limit ${BATCH})`,
        hitVals
      )
    } else {
      result = await run(
        `update ${table} set user_id=?, user_name=?, user_phone=?${withDeviceId ? ', device_id=?' : ''}
         where id in (select id from ${table} where ${hitWhere} limit ${BATCH})`,
        withDeviceId ? [ERASED, ERASED, ERASED, ERASED, ...hitVals] : [ERASED, ERASED, ERASED, ...hitVals]
      )
    }
    const affected = Number(result?.rowCount || 0)
    changed += affected
    if (affected < BATCH) return { changed, partial: false }
    await sleep(BATCH_SLEEP_MS)
  }
  return { changed, partial: true }
}

/**
 * issues 聚合表匿名化（Lead 裁决②保守口径 + QA #4 三列口径）：
 * 按命中 like 将 users_json/props_json/original_json 中的主体原文整段替换为 '[DSR-ERASED]'；
 * affected_users 统计口径不减（架构 §七.3）。聚合表行数有限，单条 UPDATE 不分批。
 */
async function eraseIssues(scope, subjectValue) {
  const result = await run(
    `update issues set
       users_json = replace(users_json::text, ?, ?)::jsonb,
       props_json = replace(props_json::text, ?, ?)::jsonb,
       original_json = replace(original_json::text, ?, ?)::jsonb
     where 1=1${scope.sql} and ${issuesHitSql()}`,
    [subjectValue, ERASED, subjectValue, ERASED, subjectValue, ERASED, ...scope.vals, `%${subjectValue}%`, `%${subjectValue}%`, `%${subjectValue}%`]
  )
  return Number(result?.rowCount || 0)
}

/** 擦除执行主流程：events / replay_events 分批 + issues 聚合替换，返回 {rowsAffected, batches, partial, processed}。 */
async function executeErasure(row, scope) {
  const subjectValue = row.subject_value
  const eventCol = EVENT_SUBJECT_COL[row.subject_type]
  const replayCol = REPLAY_SUBJECT_COL[row.subject_type]
  const batches = []
  // 跨表共享批次预算（QA #3：单次调用 ≤30 批 = 30000 行，耗尽即 partial，工单保持 executing）
  const budget = { left: MAX_BATCHES_PER_CALL }
  // events：主体列精确匹配 + 应用范围（擦除后不再命中 → 分批自然收敛）
  const eventHit = `1=1${scope.sql} and ${eventCol} = ?`
  const eventRes = await eraseRowsBatched('events', eventHit, [...scope.vals, subjectValue], row.mode, true, budget)
  batches.push({ table: 'events', changed: eventRes.changed })
  // replay_events：无 device_id 列；device_id 主体不命中回放（与命中口径一致）；预算耗尽则跳过后续
  let replayChanged = 0
  if (replayCol && budget.left > 0) {
    const replayHit = `1=1${scope.sql} and ${replayCol} = ?`
    const replayRes = await eraseRowsBatched('replay_events', replayHit, [...scope.vals, subjectValue], row.mode, false, budget)
    replayChanged = replayRes.changed
  }
  batches.push({ table: 'replay_events', changed: replayChanged })
  // issues 聚合表：like 整段替换（不分批）；预算耗尽则顺延至下次「继续执行」
  let issueChanged = 0
  if (budget.left > 0) {
    issueChanged = await eraseIssues(scope, subjectValue)
  }
  batches.push({ table: 'issues', changed: issueChanged })
  const rowsAffected = { events: eventRes.changed, issues: issueChanged, replays: replayChanged }
  const processed = eventRes.changed + issueChanged + replayChanged
  const partial = eventRes.partial || budget.left <= 0
  return { rowsAffected, batches, partial, processed }
}

// ==================== 执行：导出（access） ====================

/** CSV 序列化（与 index.js toCsv 同逻辑；独立实现避免 index.js ↔ service 循环 import） */
function csvOf(rows) {
  if (!rows.length) return ''
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))]
  const cell = value => `"${String(value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : value).replaceAll('"', '""')}"`
  return [columns.map(cell).join(','), ...rows.map(row => columns.map(column => cell(row[column])).join(','))].join('\r\n')
}

/**
 * access 导出：三表分别拉行（≤10000 行/表，超限截断标注），csv → CSV 文本（BOM 由前端 blob 处理）/ json → 单包。
 * replay_events 导出排除 events_json（rrweb 录屏体积大，明细随回放系统走）。
 */
async function buildExport(row, scope, auth) {
  const subjectValue = row.subject_value
  const likeVals = [`%${subjectValue}%`, `%${subjectValue}%`, `%${subjectValue}%`]
  const eventCol = EVENT_SUBJECT_COL[row.subject_type]
  const replayCol = REPLAY_SUBJECT_COL[row.subject_type]
  const LIMIT = BATCH
  const [eventRows, issueRows, replayRows] = await Promise.all([
    all(`select * from events where 1=1${scope.sql} and ${eventCol} = ? order by ts desc limit ${LIMIT}`, [...scope.vals, subjectValue]),
    all(`select * from issues where 1=1${scope.sql} and ${issuesHitSql()} order by last_seen desc limit ${LIMIT}`, [...scope.vals, ...likeVals]),
    replayCol
      ? all(`select id, app_id, session_id, segment_id, user_id, user_name, user_phone, created_at, url, release, end_reason, base_session_id
             from replay_events where 1=1${scope.sql} and ${replayCol} = ? order by created_at desc limit ${LIMIT}`, [...scope.vals, subjectValue])
      : Promise.resolve([])
  ])
  const datasets = { events: eventRows, issues: issueRows, replays: replayRows }
  const files = []
  const rowsAffected = { events: 0, issues: 0, replays: 0 }
  for (const kind of ['events', 'issues', 'replays']) {
    const rows = datasets[kind]
    rowsAffected[kind] = rows.length
    const name = `dsr-${row.id}-${kind}.${row.export_format === 'json' ? 'json' : 'csv'}`
    const content = row.export_format === 'json'
      ? JSON.stringify({ kind, requestId: row.id, subjectType: row.subject_type, count: rows.length, rows }, null, 2)
      : `\ufeff${csvOf(rows)}`
    files.push({ kind, name, content })
  }
  const truncated = rowsAffected.events >= LIMIT || rowsAffected.issues >= LIMIT || rowsAffected.replays >= LIMIT
  const result = {
    format: row.export_format || 'csv',
    truncated,
    note: truncated ? '命中超过单表 10000 行上限，导出已截断，全量走 JSON 分页导出（P1-3 规划中）' : null,
    replayExported: rowsAffected.replays > 0
  }
  return { files, rowsAffected, result, actorId: auth.userId }
}

// ==================== 执行入口（架构 §5.4） ====================

/**
 * POST /:id/execute：approved → executing（占位迁移防并发重复执行）→ 执行 → completed。
 * - erasure：{hardDeleteConfirmed?:boolean} 硬删需显式确认；完成后清空 subject_value（PRD §8.1 降级）。
 * - access：{replaysConfirm?:boolean} 命中回放需二次确认（录屏敏感，PRD P0-4）；返回导出文件包。
 */
export async function executeDsrRequest(id, body = {}, auth) {
  const actor = requireActor(auth, 'dsrExecute')
  const row = await requireRequest(id, auth)
  const scope = await appScope(auth, row.app_id)
  const isErasure = row.request_type === 'erasure'
  if (isErasure && row.mode === 'hard_delete' && body?.hardDeleteConfirmed !== true) {
    throw badRequest('硬删除需显式确认（hardDeleteConfirmed=true，不可逆操作）', 'BAD_REQUEST')
  }
  if (!isErasure && Number(row.hit_replays || 0) > 0 && body?.replaysConfirm !== true) {
    throw badRequest('导出包含会话回放（录屏敏感数据），需勾选确认（replaysConfirm=true）', 'BAD_REQUEST')
  }
  // 占位迁移：approved → executing（防并发重复执行；非法迁移 409 兜底）；执行人/时间随迁移落库。
  // now 先于 transition 求值（Bug#1 修复：原先引用声明在前，TDZ 导致 execute 全场景 500 且吞掉 409/400 分支）
  const now = Date.now()
  // 续跑语义：partial 后工单保持 executing，本端点幂等重跑（QA #3）；其余非 approved 状态仍走状态机 409 兜底
  const executing = row.status === 'executing'
    ? row
    : await transition(
        row, 'executing', actor.userId, { executed_by: actor.userId, executed_at: now },
        isErasure ? 'execute_erasure' : 'execute_export'
      )
  try {
    const outcome = isErasure
      ? await executeErasure(executing, scope)
      : await buildExport(executing, scope, auth)
    // QA #3 partial 语义：单次调用预算耗尽（>30 批）→ 工单保持 executing 不回滚、不 completed；
    // rows_affected_* 累加（多调用累计），前端「继续执行」复用本端点幂等重跑，剩余行因已擦行不再命中自然收敛
    if (isErasure && outcome.partial) {
      await run(
        `update dsr_requests set rows_affected_events=rows_affected_events+?, rows_affected_issues=rows_affected_issues+?, rows_affected_replays=rows_affected_replays+?
         where id=? and status='executing'`,
        [outcome.rowsAffected.events, outcome.rowsAffected.issues, outcome.rowsAffected.replays, row.id]
      )
      await insertAudit(row.id, actor.userId, 'execute_erasure', {
        stage: 'partial', mode: executing.mode, processed: outcome.processed,
        rowsAffected: outcome.rowsAffected, batches: outcome.batches,
        note: `单次调用处理上限 ${MAX_BATCHES_PER_CALL} 批（${MAX_BATCHES_PER_CALL * BATCH} 行），可再次执行继续`
      })
      const current = publicRequest(await requireRequest(id, auth))
      return { request: current, rowsAffected: outcome.rowsAffected, batches: outcome.batches, partial: true, processed: outcome.processed }
    }
    const resultNote = isErasure ? { mode: executing.mode } : outcome.result
    // 执行完成：累加影响行数 + 执行人/时间 + completed + subject_value 清空（PRD §8.1 降级决策）
    await run(
      `update dsr_requests set status='completed', rows_affected_events=rows_affected_events+?, rows_affected_issues=rows_affected_issues+?, rows_affected_replays=rows_affected_replays+?,
        executed_by=?, executed_at=?, completed_at=?, subject_value=?, result_json=? where id=? and status='executing'`,
      [outcome.rowsAffected.events, outcome.rowsAffected.issues, outcome.rowsAffected.replays,
        actor.userId, now, now, CLEARED, JSON.stringify(resultNote), row.id]
    )
    await insertAudit(row.id, actor.userId, isErasure ? 'execute_erasure' : 'execute_export', {
      stage: 'done', mode: executing.mode, rowsAffected: outcome.rowsAffected,
      batches: isErasure ? outcome.batches : undefined,
      files: isErasure ? undefined : outcome.files.map(f => ({ kind: f.kind, name: f.name })),
      result: resultNote
    })
    await insertAudit(row.id, actor.userId, 'complete', {
      rowsAffected: outcome.rowsAffected, subjectValueCleared: true
    })
    const done = publicRequest(await requireRequest(id, auth))
    return isErasure
      ? { request: done, rowsAffected: outcome.rowsAffected, batches: outcome.batches }
      : { request: done, files: outcome.files, rowsAffected: outcome.rowsAffected, result: outcome.result }
  } catch (err) {
    // 执行失败：executing 回滚到 approved（可重试）；审计留痕
    await run(`update dsr_requests set status='approved' where id=? and status='executing'`, [row.id])
    await insertAudit(row.id, actor.userId, 'illegal_transition', { from: 'executing', to: 'approved', reason: String(err?.message || err).slice(0, 300) })
    throw err
  }
}

// ==================== 审计时间线 ====================

/** GET /:id/audit：审计时间线（ts 升序，PRD §9 举证口径零缺口）。 */
export async function listDsrAudit(id, auth) {
  requireActor(auth, 'dsrView')
  await requireRequest(id, auth)
  const rows = await all('select * from dsr_audit_logs where request_id=? order by ts asc limit 500', [String(id || '').slice(0, 32)])
  return { items: rows.map(auditView) }
}
