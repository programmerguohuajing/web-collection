/**
 * @file SLO / 错误预算 / 多窗口多燃烧率 —— 双端共享纯数学真相源（B2）。
 *
 * 设计要点：
 * - 零三方依赖；Node (apps/api) 与 Cloudflare Worker (cloudflare/worker.js) 同源 import，
 *   杜绝两端判定漂移（与 D2 packages/rbac.js 同源思路一致）。
 * - 仅放无 IO 的纯函数：错误预算 / 燃烧率数学、Google SRE 多窗口多燃烧率阈值表、
 *   快照状态判定、燃尽告警文案构造。
 * - **SLI→events 的聚合 SQL 因 PG / D1 方言差异分置两端**（service 层负责），本模块不碰查询。
 *
 * 多窗口多燃烧率算法（Google SRE《Multi-Window Multi-Burn-Rate Alerts》）：
 * 对每一条阈值（长窗 + 短窗成对）独立判定，长窗燃烧率与短窗燃烧率**同时**越界才告警，
 * 抗单窗抖动；任一对越界即触发。30d 长窗无对应短窗（慢燃尽）。
 */

/** Google SRE 多窗口多燃烧率阈值表（默认；可被 slo.alert_policy 覆盖同结构数组）。 */
export const BURN_RATE_THRESHOLDS = [
  // 2% / 1h：长窗 1h×14.4 与短窗 5m×19 同时越界 → critical（page）
  { budget: 0.02, longWindowMs: 60 * 60 * 1000, longThreshold: 14.4, shortWindowMs: 5 * 60 * 1000, shortThreshold: 19, level: 'critical' },
  // 5% / 6h：长窗 6h×6 与短窗 30m×12 → critical（page）
  { budget: 0.05, longWindowMs: 6 * 60 * 60 * 1000, longThreshold: 6, shortWindowMs: 30 * 60 * 1000, shortThreshold: 12, level: 'critical' },
  // 10% / 3d：长窗 3d×3 与短窗 2h×6 → warning（ticket）
  { budget: 0.10, longWindowMs: 3 * 24 * 60 * 60 * 1000, longThreshold: 3, shortWindowMs: 2 * 60 * 60 * 1000, shortThreshold: 6, level: 'warning' },
  // 100% / 30d：长窗 30d×1，无短窗 → warning（ticket，慢燃尽）
  { budget: 1.00, longWindowMs: 30 * 24 * 60 * 60 * 1000, longThreshold: 1, shortWindowMs: null, shortThreshold: null, level: 'warning' }
]

/** 默认告警策略（severity → channelIds 列表，无绑定）。可被 slo.alert_policy 覆盖。 */
export const DEFAULT_ALERT_POLICY = { critical: [], warning: [] }

/**
 * 错误预算分钟数：窗口内允许不可用的总时长。
 * @param {number} objective 目标可用率（如 0.999）
 * @param {number} windowDays 窗口天数（28 | 30）
 * @returns {number} 允许的错误分钟数
 */
export function errorBudgetMinutes(objective, windowDays) {
  return Math.max(0, (1 - Number(objective)) * Number(windowDays) * 1440)
}

/**
 * 达标率 goodRatio = 1 - bad/total；无数据（total=0）→ 视为 100%。
 * @param {number} bad 坏事件数
 * @param {number} total 分母事件数
 * @returns {number} 0~1
 */
export function computeGoodRatio(bad, total) {
  const t = Number(total) || 0
  if (t <= 0) return 1.0
  return Math.max(0, Math.min(1, 1 - (Number(bad) || 0) / t))
}

/**
 * 全窗口燃烧率 burnRate = (bad/total) / (1 - objective)。
 * 事件型 SLO 中 burnRate == budgetUsed（全窗口视角）。
 * @param {number} bad 坏事件数
 * @param {number} total 分母事件数
 * @param {number} objective 目标可用率
 * @returns {number} ≥0（可 >1 表示超支）
 */
export function computeBurnRate(bad, total, objective) {
  const t = Number(total) || 0
  if (t <= 0) return 0
  const obj = Number(objective)
  const denom = 1 - obj
  if (denom <= 0) return 0
  return (Number(bad) || 0) / t / denom
}

/** 已消耗错误预算比例（全窗口 == burnRate）。 */
export function computeBudgetUsed(bad, total, objective) {
  return computeBurnRate(bad, total, objective)
}

/** 剩余错误预算比例（0~1，超支截断为 0）。 */
export function computeBudgetRemaining(bad, total, objective) {
  return Math.max(0, 1 - computeBudgetUsed(bad, total, objective))
}

/**
 * 快照状态：依据已消耗预算比例判定。
 * - budgetUsed >= 1      → 'burnt'
 * - budgetUsed >= 0.5    → 'warning'（半预算告警，可被 policy 调）
 * - 否则                  → 'healthy'
 * @param {number} goodRatio 达标率（保留参数，与 budgetUsed 同序判定）
 * @param {number} budgetUsed 已消耗预算比例
 * @returns {'healthy'|'warning'|'burnt'}
 */
export function sloStatus(goodRatio, budgetUsed) {
  const used = Number(budgetUsed)
  if (used >= 1) return 'burnt'
  if (used >= 0.5) return 'warning'
  return 'healthy'
}

/** SLO_STATUS 别名导出（兼容架构类图命名）。 */
export const SLO_STATUS = sloStatus

/**
 * 多窗口多燃烧率判定（双端同源）。
 *
 * 输入 `windows` 为已计算的燃烧率数组，每项为某条阈值对应的长/短窗燃烧率：
 *   { longWindowMs, shortWindowMs, longBurnRate, shortBurnRate }
 * 对阈值表（默认 BURN_RATE_THRESHOLDS 或被 alert_policy 覆盖）逐条判定：
 * 长窗燃烧率 ≥ 长阈值 且 短窗燃烧率 ≥ 短阈值（无短窗则只看长窗）时即越界告警。
 * 任一条越界即返回首个 breach（按阈值表顺序，critical 优先于 warning 因为表序如此）。
 *
 * @param {object} params
 * @param {Array<{longWindowMs:number, shortWindowMs:?number, longBurnRate:number, shortBurnRate:number}>} [params.windows]
 * @param {Array} [params.policy] 覆盖阈值表（同 BURN_RATE_THRESHOLDS 结构）
 * @returns {{breach:boolean, level?:string, entry?:object, value?:number, window?:object}}
 */
export function evaluateMultiWindowBurnRate({ windows = [], policy } = {}) {
  const thresholds = Array.isArray(policy) && policy.length ? policy : BURN_RATE_THRESHOLDS
  for (const entry of thresholds) {
    const w = (windows || []).find(x =>
      x.longWindowMs === entry.longWindowMs && x.shortWindowMs === entry.shortWindowMs
    )
    if (!w) continue
    const longOk = Number(w.longBurnRate) >= Number(entry.longThreshold)
    const shortOk = entry.shortWindowMs == null ? true : Number(w.shortBurnRate) >= Number(entry.shortThreshold)
    if (longOk && shortOk) {
      return {
        breach: true,
        level: entry.level,
        entry,
        window: w,
        value: Math.max(Number(w.longBurnRate), Number(w.shortBurnRate))
      }
    }
  }
  return { breach: false }
}

/**
 * 构造燃尽告警对象（写入 alert_history 前的入参；字段对齐现有 alert_history 表）。
 * 复用现有告警中心投递：metric='slo_burn'、level、value=max(长/短燃烧率)、
 * context 含 sloId / 窗口标签 / 快照指标。
 * @param {object} slo SLO 定义（含 id/name/objective/window_days/sli_type/app_id）
 * @param {object} snapshot 最新快照（含 goodRatio/budgetUsed/burn_rate）
 * @param {object} breach evaluateMultiWindowBurnRate 返回的越界结果
 * @returns {{metric:string, level:string, value:number, message:string, appId:?string, context:object}}
 */
export function buildSloBurnAlert(slo, snapshot, breach) {
  const value = Number(breach?.value ?? snapshot?.burn_rate ?? 0)
  const level = breach?.level || 'warning'
  const windowLabel = (() => {
    const e = breach?.entry
    if (!e) return ''
    const fmt = ms => `${Math.round(ms / 60000)}m`
    return e.shortWindowMs != null ? `${fmt(e.longWindowMs)}/${fmt(e.shortWindowMs)}` : fmt(e.longWindowMs)
  })()
  const name = slo?.name || slo?.id || 'SLO'
  const objective = slo?.objective ? `${(slo.objective * 100).toFixed(2)}%` : ''
  const budgetPct = ((Number(snapshot?.budgetUsed ?? 0)) * 100).toFixed(1)
  const message = `SLO 燃尽告警「${name}」(目标 ${objective})：燃烧率 ${value.toFixed(1)}× 超过阈值` +
    `${windowLabel ? `（窗口 ${windowLabel}）` : ''}，错误预算已消耗 ${budgetPct}%`
  return {
    metric: 'slo_burn',
    level,
    value,
    message,
    appId: slo?.app_id || null,
    context: {
      sloId: slo?.id || null,
      name,
      objective: slo?.objective ?? null,
      windowDays: slo?.window_days ?? null,
      sliType: slo?.sli_type || null,
      goodRatio: snapshot?.goodRatio ?? null,
      budgetUsed: snapshot?.budgetUsed ?? null,
      burnRate: snapshot?.burn_rate ?? null,
      windowLabel,
      breachEntry: breach?.entry
        ? {
            budget: breach.entry.budget,
            longWindowMs: breach.entry.longWindowMs,
            longThreshold: breach.entry.longThreshold,
            shortWindowMs: breach.entry.shortWindowMs,
            shortThreshold: breach.entry.shortThreshold
          }
        : null
    }
  }
}

/** 解析 sli_config（兼容 PG jsonb 已解析对象与 D1 文本 JSON）。 */
export function parseJson(value, fallback) {
  if (value == null) return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}
