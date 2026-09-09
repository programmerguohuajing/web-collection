/**
 * @file A3 · 实验分析服务（Node / Postgres，PRD 14）。
 * 实验 CRUD + 变体管理 + 状态机（draft→running→paused⇄running→completed→archived）
 * + 防打架（同 app_id+key 仅一个 running）+ 曝光入库（maybeRecordExposure）
 * + 分析报告聚合（§6.3 口径：曝光 cohort 内联 events 聚合）。
 *
 * 设计依据（对齐 synthetic-service / dsr-service 范式）：
 * - 分桶纯函数同源 packages/experiment-bucket.js（三端同输入同输出）；
 * - team 归属复用 applications.team_id；accounts 开启（session）跨 team → 403；
 *   accounts=false / api_key(system) 看全部（单租户全局可见，PRD P0-9）；
 * - 权限点 packages/rbac.js ROLE_MATRIX：expView / expCreate / expUpdate / expArchive（owner 恒允许）；
 * - SQL 红线：全部 `=?` 精确匹配占位符（经 toPgSql 转 $n），禁 JSONB `?` 算子（JSON 均 JS 端解析）；
 * - running 实验定义不可变（PUT 409）；删除仅 archived 可物理删（级联删曝光）。
 */
import { all, first, run } from '../db.js'
import { isAccountsEnabled } from './auth-service.js'
import { randomToken } from '../../../../packages/auth-crypto.js'
import { hasPermission } from '../../../../packages/rbac.js'
import { NODE_CAPABILITIES } from '../../../../packages/deployment-capabilities.js'
import { badRequest, conflict, forbidden, notFound } from '../utils/http-error.js'

/** 实验 key 规则（PRD P0-2）：^[a-z0-9_-]{2,64}$，app 内唯一 */
const KEY_PATTERN = /^[a-z0-9_-]{2,64}$/
/** 变体数量边界：必含 control，可加 1~2 个 treatment（上限 4 兼容未来分层） */
const VARIANTS_MIN = 2
const VARIANTS_MAX = 4
/** 目标指标类型（首版三选一，PRD §4） */
const GOAL_TYPES = ['conversion_event', 'error_rate', 'session_duration']
/** 状态机（PRD P1-1）：draft → running → paused ⇄ running → completed → archived */
const STATUS_TRANSITIONS = {
  draft: ['running'],
  running: ['paused', 'completed'],
  paused: ['running', 'completed'],
  completed: ['archived'],
  archived: []
}
/** 报告最小样本量提示阈值（每变体曝光数，PRD Q3：只提示不判定） */
export const MIN_SAMPLE_PER_VARIANT = 100
/** 配置比 vs 实际比漂移告警阈值（百分点，PRD §8：漂移 >5pp 标黄） */
export const DRIFT_THRESHOLD_PP = 5
/** sdk-config 下发 running 实验上限（架构 §3.3） */
const SDK_CONFIG_MAX_RUNNING = 20

// ==================== 身份与团队边界（对齐 dsr-service requireActor / assertRequestVisible） ====================

/**
 * 操作者权限断言：accounts=false 时单租户放行（PRD P0-9）；
 * accounts 开启后要求已登录且具备权限点（owner 恒允许）。
 */
function requirePermission(auth, permission) {
  if (!isAccountsEnabled()) return
  if (!auth?.userId) throw forbidden('实验管理需要开启账号体系并登录（ACCOUNTS_ENABLED=1）', 'FORBIDDEN')
  if (!hasPermission(auth.role, permission)) {
    throw forbidden(`无实验操作权限（${permission}）`, 'FORBIDDEN')
  }
}

/** 团队可见性断言：accounts 会话下跨 team 归属（team_id 非空且不等）拒绝。 */
function assertExperimentVisible(row, auth) {
  if (!isAccountsEnabled()) return
  if (auth?.via !== 'session' || !auth.teamId) return
  if (row.team_id && row.team_id !== auth.teamId) {
    throw forbidden('无权访问该实验（跨团队）', 'FORBIDDEN')
  }
}

/** 按 id 取实验行并做 team 可见性校验，不存在抛 404。 */
async function requireExperiment(id, auth) {
  const row = await first('select * from experiments where id=?', [String(id || '').slice(0, 32)])
  if (!row) throw notFound('实验不存在', 'NOT_FOUND')
  assertExperimentVisible(row, auth)
  return row
}

/** 实验归属应用所属 team 校验：team 会话下跨队应用拒绝（对齐 dsr-service appScope）。 */
async function assertAppAllowed(appId, auth) {
  if (!isAccountsEnabled() || auth?.via !== 'session' || !auth.teamId) return
  const app = await first('select app_id, team_id from applications where app_id=?', [appId])
  if (app && app.team_id && app.team_id !== auth.teamId) {
    throw forbidden('目标应用不属于当前团队', 'FORBIDDEN')
  }
}

// ==================== 视图与解析 ====================

/** DB 行 → API 视图（camelCase，JSON 字段解析为对象，对齐 synthetic publicCheck）。 */
function publicExperiment(row) {
  return {
    id: row.id,
    appId: row.app_id,
    teamId: row.team_id || null,
    key: row.key,
    name: row.name,
    description: row.description || null,
    status: row.status || 'draft',
    salt: row.salt,
    trafficPct: Number(row.traffic_pct),
    variants: parseVariants(row.variants_json),
    goalMetric: parseGoalMetric(row.goal_metric_json),
    startedAt: row.started_at == null ? null : Number(row.started_at),
    endedAt: row.ended_at == null ? null : Number(row.ended_at),
    createdBy: row.created_by || null,
    updatedBy: row.updated_by || null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  }
}

/** 解析 variants_json 并规范化排序（weight 降序、control 优先——分桶累积顺序，三端一致）。 */
function parseVariants(text) {
  let list = []
  try { list = JSON.parse(typeof text === 'string' ? text : '[]') } catch { list = [] }
  if (!Array.isArray(list)) list = []
  return list
    .map(item => ({
      name: String(item?.name || '').trim().slice(0, 32),
      weight: Math.max(0, Math.floor(Number(item?.weight) || 0))
    }))
    .filter(item => item.name)
    .sort((a, b) => (b.weight - a.weight) || (a.name === 'control' ? -1 : b.name === 'control' ? 1 : 0))
}

/** 解析 goal_metric_json（缺省 session_duration 兜底，防历史脏数据）。 */
function parseGoalMetric(text) {
  let value = null
  try { value = JSON.parse(typeof text === 'string' ? text : 'null') } catch { value = null }
  if (!value || typeof value !== 'object' || !GOAL_TYPES.includes(value.type)) {
    return { type: 'session_duration', event_name: null, window_days: 7 }
  }
  return {
    type: value.type,
    event_name: value.event_name ? String(value.event_name).slice(0, 160) : null,
    window_days: Number.isFinite(Number(value.window_days)) && Number(value.window_days) > 0 ? Math.floor(Number(value.window_days)) : 7
  }
}

/** 变体入参校验：必含 control 且 name 唯一、weight 合计 >0（PRD P0-2）。失败返回错误文案。 */
function validateVariants(input) {
  if (!Array.isArray(input) || input.length < VARIANTS_MIN || input.length > VARIANTS_MAX) {
    return `变体数量须在 ${VARIANTS_MIN}~${VARIANTS_MAX} 个之间`
  }
  const seen = new Set()
  let hasControl = false
  let totalWeight = 0
  for (const item of input) {
    const name = String(item?.name || '').trim().slice(0, 32)
    if (!/^[a-z0-9_-]{1,32}$/.test(name)) return `变体名「${name}」非法（仅允许小写字母/数字/_/-，≤32 字符）`
    if (seen.has(name)) return `变体名「${name}」重复`
    seen.add(name)
    if (name === 'control') hasControl = true
    const weight = Math.floor(Number(item?.weight))
    if (!Number.isFinite(weight) || weight < 0 || weight > 100) return `变体「${name}」权重须为 0~100 的整数`
    totalWeight += weight
  }
  if (!hasControl) return '变体列表必须包含 control（对照组）'
  if (totalWeight <= 0) return '变体权重合计必须大于 0'
  return null
}

// ==================== CRUD ====================

/**
 * 创建或更新实验（body 带 id 即更新，saveFunnel 风格 upsert）。
 * 校验：key 正则、变体必含 control 且 name 唯一、weight 合计 >0、traffic_pct 0-100；
 * running 状态拒绝改定义（409）；同 key 撞唯一索引（跨实验）返回 409。
 * @param {object} input - { id?, appId, key, name, description?, variants, trafficPct, goalMetric? }
 * @param {object|null} auth - req.auth
 */
export async function saveExperiment(input = {}, auth) {
  requirePermission(auth, 'expCreate')
  const appId = String(input.appId || '').trim().slice(0, 64)
  if (!appId) throw badRequest('appId 不能为空', 'BAD_REQUEST')
  const app = await first('select app_id, team_id from applications where app_id=?', [appId])
  if (!app) throw notFound('应用不存在', 'NOT_FOUND')
  await assertAppAllowed(appId, auth)

  const key = String(input.key || '').trim().slice(0, 64)
  if (!KEY_PATTERN.test(key)) throw badRequest('key 非法：须匹配 ^[a-z0-9_-]{2,64}$', 'BAD_REQUEST')
  const name = String(input.name || '').trim().slice(0, 80)
  if (!name) throw badRequest('实验名称不能为空', 'BAD_REQUEST')
  const description = input.description == null ? null : String(input.description).slice(0, 512)
  const variantsError = validateVariants(input.variants)
  if (variantsError) throw badRequest(variantsError, 'BAD_REQUEST')
  const variants = input.variants
    .map(item => ({ name: String(item.name).trim().slice(0, 32), weight: Math.floor(Number(item.weight)) }))
    .sort((a, b) => (b.weight - a.weight) || (a.name === 'control' ? -1 : b.name === 'control' ? 1 : 0))
  const trafficPct = Math.max(0, Math.min(100, Math.floor(Number(input.trafficPct ?? input.traffic_pct ?? 100))))
  const goalMetric = normalizeGoalMetric(input.goalMetric ?? input.goal_metric)

  const now = Date.now()
  const id = String(input.id || '').trim().slice(0, 32) || `exp_${randomToken(12)}`
  const existing = await first('select * from experiments where id=?', [id])
  if (existing) {
    assertExperimentVisible(existing, auth)
    if (existing.status === 'running') {
      throw conflict('running 状态的实验不可修改定义（需先暂停），请通过状态迁移接口操作', 'RUNNING_IMMUTABLE')
    }
    // key 撞到另一条实验（唯一索引 uq_experiments_app_key）→ 409 防打架
    const keyClash = await first(`select id, name from experiments where app_id=? and key=? and id<>?`, [appId, key, id])
    if (keyClash) {
      throw conflict(`实验 key「${key}」已被实验「${keyClash.name}」（${keyClash.id}）占用`, 'KEY_CONFLICT')
    }
    const operator = String(auth?.userId || 'system').slice(0, 64)
    await run(
      `update experiments set app_id=?, key=?, name=?, description=?, traffic_pct=?, variants_json=?, goal_metric_json=?, updated_by=?, updated_at=? where id=?`,
      [appId, key, name, description, trafficPct, JSON.stringify(variants), JSON.stringify(goalMetric), operator, now, id]
    )
    return { id, updated: true }
  }

  const keyClash = await first(`select id, name from experiments where app_id=? and key=?`, [appId, key])
  if (keyClash) {
    throw conflict(`实验 key「${key}」已被实验「${keyClash.name}」（${keyClash.id}）占用`, 'KEY_CONFLICT')
  }
  const operator = String(auth?.userId || 'system').slice(0, 64)
  await run(
    `insert into experiments (id, app_id, team_id, key, name, description, status, salt, traffic_pct, variants_json, goal_metric_json, created_by, updated_by, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, appId, app.team_id || null, key, name, description, randomToken(16).replace(/[^a-zA-Z0-9]/g, '').slice(0, 32) || randomToken(12), trafficPct, JSON.stringify(variants), JSON.stringify(goalMetric), operator, operator, now, now]
  )
  return { id, created: true }
}

/** goal_metric 入参规范化（非法回落 session_duration 默认窗口 7d）。 */
function normalizeGoalMetric(input) {
  const type = GOAL_TYPES.includes(input?.type) ? input.type : 'session_duration'
  const eventName = input?.event_name ? String(input.event_name).slice(0, 160) : (input?.eventName ? String(input.eventName).slice(0, 160) : null)
  const windowDaysRaw = Number(input?.window_days ?? input?.windowDays ?? 7)
  const windowDays = Number.isFinite(windowDaysRaw) && windowDaysRaw > 0 ? Math.min(365, Math.floor(windowDaysRaw)) : 7
  if (type === 'conversion_event' && !eventName) throw badRequest('goal_metric=conversion_event 时 event_name 必填', 'BAD_REQUEST')
  return { type, event_name: type === 'conversion_event' ? eventName : null, window_days: windowDays }
}

/**
 * 实验列表（app_id 过滤 + team 过滤），附每实验曝光数摘要（总量 + 近 7 天）。
 * @param {object} filters - { appId, teamId?, page?, pageSize? }
 * @param {object|null} auth
 */
export async function listExperiments(filters = {}, auth) {
  requirePermission(auth, 'expView')
  const appId = String(filters.appId || '').trim().slice(0, 64)
  if (!appId) throw badRequest('appId 不能为空', 'BAD_REQUEST')
  await assertAppAllowed(appId, auth)
  const page = Math.max(1, Math.min(1000000, Math.floor(Number(filters.page) || 1)))
  const pageSize = Math.max(1, Math.min(100, Math.floor(Number(filters.pageSize) || 20)))
  const conditions = ['app_id=?']
  const values = [appId]
  if (filters.teamId) { conditions.push('(team_id is null or team_id=?)'); values.push(filters.teamId) }
  const status = String(filters.status || '').trim().slice(0, 16)
  if (status) { conditions.push('status=?'); values.push(status) }
  const where = `where ${conditions.join(' and ')}`
  const [rows, total] = await Promise.all([
    all(`select * from experiments ${where} order by updated_at desc limit ? offset ?`, [...values, pageSize, (page - 1) * pageSize]),
    first(`select count(*) count from experiments ${where}`, values)
  ])
  // 曝光摘要：一次 group 聚合，避免逐实验 N 次查询
  const exposureSummary = new Map()
  if (rows.length) {
    const ids = rows.map(row => row.id)
    const summaryRows = await all(
      `select experiment_id, count(*) exposures, count(case when exposed_at>=? then 1 end) exposures7d from experiment_exposures where experiment_id in (${ids.map(() => '?').join(',')}) group by experiment_id`,
      [Date.now() - 7 * 86400000, ...ids]
    )
    for (const row of summaryRows) {
      exposureSummary.set(row.experiment_id, { exposures: Number(row.exposures), exposures7d: Number(row.exposures7d) })
    }
  }
  const items = rows.map(row => {
    const summary = exposureSummary.get(row.id) || { exposures: 0, exposures7d: 0 }
    return { ...publicExperiment(row), exposureCount: summary.exposures, exposureCount7d: summary.exposures7d }
  })
  return { items, total: Number(total?.count || 0), page, pageSize }
}

/** 实验详情（含 variants/goal_metric 解析后的 JSON）。 */
export async function getExperiment(id, auth) {
  requirePermission(auth, 'expView')
  const row = await requireExperiment(id, auth)
  return publicExperiment(row)
}

/** 删除（仅 archived 可物理删，级联删曝光）。 */
export async function deleteExperiment(id, auth) {
  requirePermission(auth, 'expArchive')
  const row = await requireExperiment(id, auth)
  if (row.status !== 'archived') {
    throw conflict('仅 archived 状态的实验可删除（需先完成并归档）', 'NOT_ARCHIVED')
  }
  await run('delete from experiment_exposures where experiment_id=?', [row.id])
  await run('delete from experiments where id=?', [row.id])
  return { ok: true }
}

// ==================== 状态机 + 防打架 ====================

/**
 * 状态迁移（PRD P1-1 / P1-2）：
 * - 状态机校验（非法迁移 400）；
 * - 防打架：置 running 时同 app_id+key 已有 running（含 paused 复活场景）→ 409 并返回冲突实验信息；
 * - 每次迁移写 updated_by 与时间戳；running→running 以外的合法迁移不触碰 started_at。
 * @param {string} id
 * @param {string} status - 目标状态
 * @param {object|null} auth
 */
export async function changeExperimentStatus(id, status, auth) {
  requirePermission(auth, 'expUpdate')
  const target = String(status || '').trim().slice(0, 16)
  if (!['draft', 'running', 'paused', 'completed', 'archived'].includes(target)) {
    throw badRequest(`非法状态：${target}`, 'BAD_REQUEST')
  }
  const row = await requireExperiment(id, auth)
  const current = row.status || 'draft'
  if (!(STATUS_TRANSITIONS[current] || []).includes(target)) {
    throw badRequest(`非法状态迁移：${current} → ${target}（合法迁移：${(STATUS_TRANSITIONS[current] || []).join(' / ') || '无'}）`, 'BAD_REQUEST')
  }
  const now = Date.now()
  const operator = String(auth?.userId || 'system').slice(0, 64)
  if (target === 'running') {
    // 防打架（P1-2）：同 app_id + key 已有 running → 409 返回冲突实验 {id,name,key}
    const clash = await first(
      `select id, name, key from experiments where app_id=? and key=? and status='running' and id<>?`,
      [row.app_id, row.key, row.id]
    )
    if (clash) {
      throw conflict(`实验 key「${row.key}」已存在运行中的实验「${clash.name}」（${clash.id}），同一时刻仅允许一个 running`, 'RUNNING_CONFLICT')
    }
    const startedAt = row.started_at == null ? now : Number(row.started_at) // paused 复活不重置首次开始时间
    await run(`update experiments set status='running', started_at=?, ended_at=null, updated_by=?, updated_at=? where id=?`, [startedAt, operator, now, row.id])
  } else if (target === 'completed' || target === 'archived') {
    await run(`update experiments set status=?, ended_at=?, updated_by=?, updated_at=? where id=?`, [target, now, operator, now, row.id])
  } else {
    await run(`update experiments set status=?, updated_by=?, updated_at=? where id=?`, [target, operator, now, row.id])
  }
  return { id: row.id, status: target, previousStatus: current }
}

// ==================== 曝光入库（采集端注入点） ====================

/**
 * 曝光识别（Node 侧注入点：store.js recordEvents 单事件落库后调用）。
 * 仅当：事件为 behavior/exposure、props 带 experiment_key、实验 running 时写入 experiment_exposures；
 * 同一 visitor 同实验仅记首条（唯一索引 on conflict do nothing），已记录变体永不改写（PRD Q5）。
 * 查不到 running 实验 → 静默忽略（事件仍按普通 exposure 留在 events）。
 * 能力位关闭时完全不建曝光记录（PRD P0-5）。
 * @param {object} event - 已落库的标准化事件（deviceId=anonymousId 同源）
 */
export async function maybeRecordExposure(event) {
  if (!NODE_CAPABILITIES.experiments) return
  const experimentKey = String(event?.props?.experiment_key || '').slice(0, 64)
  const visitorId = String(event?.deviceId || '').slice(0, 64)
  if (!experimentKey || !visitorId) return
  const row = await first(
    `select id, team_id from experiments where app_id=? and key=? and status='running'`,
    [String(event?.appId || '').slice(0, 64), experimentKey]
  )
  if (!row) return
  await run(
    `insert into experiment_exposures (id, experiment_id, app_id, team_id, visitor_id, session_id, variant, exposed_at)
     values (?, ?, ?, ?, ?, ?, ?, ?) on conflict(experiment_id, visitor_id) do nothing`,
    [`expv_${randomToken(12)}`, row.id, String(event.appId || '').slice(0, 64), row.team_id || null, visitorId, event.sessionId ? String(event.sessionId).slice(0, 64) : null, String(event.props?.variant || '').slice(0, 32), Number(event.ts) || Date.now()]
  )
}

// ==================== /sdk-config 下发 ====================

/**
 * 拉取指定应用的 running 实验定义（/sdk-config experiments 块，架构 §3.3）。
 * 仅 running；按 updated_at desc，上限 20；variants 已按 weight 降序、control 优先排序。
 * @param {string} appId
 * @returns {Promise<Array<{key,salt,traffic_pct,variants}>>}
 */
export async function listRunningExperimentsForApp(appId) {
  const rows = await all(
    `select key, salt, traffic_pct, variants_json, updated_at from experiments where app_id=? and status='running' order by updated_at desc limit ?`,
    [String(appId || '').slice(0, 64), SDK_CONFIG_MAX_RUNNING]
  )
  return rows.map(row => ({
    key: row.key,
    salt: row.salt,
    traffic_pct: Number(row.traffic_pct),
    variants: parseVariants(row.variants_json),
    updated_at: Number(row.updated_at) || 0
  }))
}

// ==================== 分析报告（§6.3 口径，PG 方言） ====================

/**
 * 实验分析报告：曝光 cohort 内联 events 聚合（零新增采集）。
 * 指标口径：
 * - 曝光数/访客数：experiment_exposures 按变体 count / count(distinct visitor_id)；
 * - 会话数：曝光 distinct session_id；
 * - 错误率：曝光会话中含 type='error' 事件的会话占比；
 * - 目标转化率 conversion_event：曝光后 window_days 窗口内出现指定 event name 的访客占比；
 * - 会话时长 session_duration：曝光会话 avg(max(ts)-min(ts))（对齐 analytics-service 既有口径）。
 * 附：样本量提示（<MIN_SAMPLE_PER_VARIANT）+ 配置比 vs 实际比（漂移 >DRIFT_THRESHOLD_PP 标黄）。
 */
export async function getExperimentReport(id, auth) {
  requirePermission(auth, 'expView')
  const row = await requireExperiment(id, auth)
  const experiment = publicExperiment(row)
  const goal = experiment.goalMetric
  const windowMs = goal.window_days * 86400000
  const variants = experiment.variants
  const totalWeight = variants.reduce((sum, item) => sum + item.weight, 0)

  const [baseRows, errorRows, conversionRows, durationRows, dailyRows] = await Promise.all([
    // (a) 每变体曝光/访客/会话基数
    all(
      `select variant, count(*) as exposures, count(distinct visitor_id) as visitors, count(distinct session_id) as sessions
       from experiment_exposures where experiment_id = ? group by variant`,
      [row.id]
    ),
    // (b) 错误率（join 而非子查询）
    all(
      `select x.variant,
              count(distinct x.session_id) as total_sessions,
              count(distinct case when ev.type = 'error' then x.session_id end) as err_sessions
       from experiment_exposures x
       left join events ev
              on ev.session_id = x.session_id and ev.app_id = x.app_id and ev.type = 'error'
       where x.experiment_id = ?
       group by x.variant`,
      [row.id]
    ),
    // (c) 目标转化率（conversion_event 才计算；goal=error_rate/session_duration 时复用 (b)/(c') 数据）
    goal.type === 'conversion_event'
      ? all(
          `select x.variant,
                  count(distinct x.visitor_id) as cohort_visitors,
                  count(distinct case when ev.id is not null then x.visitor_id end) as converted
           from experiment_exposures x
           left join events ev
                  on ev.device_id = x.visitor_id
                 and ev.app_id = x.app_id
                 and ev.name = ?
                 and ev.ts >= x.exposed_at and ev.ts <= x.exposed_at + ?
           where x.experiment_id = ?
           group by x.variant`,
          [goal.event_name, windowMs, row.id]
        )
      : Promise.resolve([]),
    // (c') 曝光会话平均时长（session_duration 才计算）
    goal.type === 'session_duration'
      ? all(
          `select x.variant, avg(d.dur) as avg_duration
           from experiment_exposures x
           join (
             select session_id, max(ts) - min(ts) as dur
             from events
             where app_id = ? and session_id in (
               select session_id from experiment_exposures where experiment_id = ? and session_id is not null
             )
             group by session_id
           ) d on d.session_id = x.session_id
           where x.experiment_id = ?
           group by x.variant`,
          [row.app_id, row.id, row.id]
        )
      : Promise.resolve([]),
    // (e) 按天时间序列（PG：floor 除法取整天号）
    all(
      `select variant, floor(exposed_at / 86400000.0)::bigint as day, count(*) as exposures
       from experiment_exposures where experiment_id = ? group by variant, day order by day`,
      [row.id]
    )
  ])

  const baseByVariant = new Map(baseRows.map(item => [item.variant, item]))
  const errorByVariant = new Map(errorRows.map(item => [item.variant, item]))
  const conversionByVariant = new Map(conversionRows.map(item => [item.variant, item]))
  const durationByVariant = new Map(durationRows.map(item => [item.variant, item]))

  const totalExposures = baseRows.reduce((sum, item) => sum + Number(item.exposures || 0), 0)
  const metricRows = variants.map(item => {
    const base = baseByVariant.get(item.name)
    const errorStat = errorByVariant.get(item.name)
    const conversionStat = conversionByVariant.get(item.name)
    const durationStat = durationByVariant.get(item.name)
    const exposures = Number(base?.exposures || 0)
    const visitors = Number(base?.visitors || 0)
    const sessions = Number(base?.sessions || 0)
    const totalSessions = Number(errorStat?.total_sessions || 0)
    const errSessions = Number(errorStat?.err_sessions || 0)
    const cohortVisitors = Number(conversionStat?.cohort_visitors || 0)
    const converted = Number(conversionStat?.converted || 0)
    return {
      name: item.name,
      weight: item.weight,
      configPct: totalWeight > 0 ? Number(((item.weight / totalWeight) * experiment.trafficPct).toFixed(2)) : 0,
      exposures,
      visitors,
      sessions,
      errorRate: totalSessions > 0 ? Number((errSessions / totalSessions).toFixed(4)) : null,
      conversionRate: goal.type === 'conversion_event' && cohortVisitors > 0 ? Number((converted / cohortVisitors).toFixed(4)) : null,
      converted,
      avgDuration: goal.type === 'session_duration' && durationStat?.avg_duration != null ? Math.round(Number(durationStat.avg_duration)) : null
    }
  })

  // 相对 control 差值（目标指标口径内；error_rate 低于 control 为优，符号即差值方向）
  const control = metricRows.find(item => item.name === 'control') || metricRows[0] || null
  const metricOf = item => (goal.type === 'conversion_event' ? item.conversionRate : goal.type === 'error_rate' ? item.errorRate : item.avgDuration)
  const controlValue = control ? metricOf(control) : null
  const metricRowsWithDiff = metricRows.map(item => {
    const value = metricOf(item)
    return {
      ...item,
      diffVsControl: item.name === 'control' || controlValue == null || value == null || controlValue === 0
        ? null
        : Number(((value - controlValue) / controlValue).toFixed(4))
    }
  })

  // (d) 配置比 vs 实际比（JS 端计算，不入 SQL）；漂移 >5pp 标黄
  const actual = metricRowsWithDiff.map(item => {
    const actualPct = totalExposures > 0 ? Number(((item.exposures / totalExposures) * 100).toFixed(2)) : 0
    return {
      variant: item.name,
      configPct: item.configPct,
      actualPct,
      drift: Math.abs(actualPct - item.configPct) > DRIFT_THRESHOLD_PP
    }
  })

  const insufficient = metricRowsWithDiff.filter(item => item.exposures < MIN_SAMPLE_PER_VARIANT).map(item => item.name)

  return {
    experiment,
    goal: { type: goal.type, eventName: goal.event_name, windowDays: goal.window_days },
    minSample: MIN_SAMPLE_PER_VARIANT,
    totalExposures,
    variants: metricRowsWithDiff,
    actual,
    insufficient,
    daily: dailyRows.map(item => ({
      day: Number(item.day),
      variant: item.variant,
      exposures: Number(item.exposures)
    }))
  }
}
