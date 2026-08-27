/**
 * @file PRD 04 远程配置下发——共享纯逻辑（Node 与 Worker 双端复用）
 *
 * 三级控制模型：L1 事件拉黑 / L2 插件开关 / L3 总开关+采样，附上限保护。
 * 匹配规则：最具体者生效（约束数多者优先）；同特异性取 config_version 最新。
 * 失败安全约定：SDK 拉取失败沿用上次配置，从未拉到则使用 DEFAULT_CONFIG。
 */

/** 内置默认配置：全开。SDK 在从未拉到配置时按此运行，绝不因配置系统故障停采 */
export const DEFAULT_COLLECT_CONFIG = {
  master_switch: 'on',
  sampling: { error: 1, performance: 0.1, replay: 0.05, behavior: 1 },
  blocked_events: [],
  plugins: { performance: true, error: true, replay: true, behavior: true, exposure: true, trace: true },
  rate_limits: { per_event_per_user_10min: 500 }
}

const PLUGIN_KEYS = ['performance', 'error', 'replay', 'behavior', 'exposure', 'trace']
const SAMPLING_KEYS = ['error', 'performance', 'replay', 'behavior']

/**
 * scope 特异性：约束数越多越具体（版本区间 > 应用 > 全局）。
 * @param {{appId?:string, platform?:string, sdkVersionMax?:string}} scope
 * @returns {number}
 */
export function scopeSpecificity(scope) {
  let score = 0
  if (scope?.appId) score += 1
  if (scope?.platform) score += 1
  if (scope?.sdkVersionMax) score += 2 // 版本区间最难命中，权重最高
  return score
}

/**
 * 判断 scope 是否命中上下文；sdkVersionMax 支持 <= 区间语义。
 * 版本号按点段数值逐段比较（0.1.0-alpha.12 → [0,1,0] 前缀），避免字符串比较错序。
 */
export function scopeMatches(scope, context) {
  if (!scope || typeof scope !== 'object') return true
  if (scope.appId && scope.appId !== context.appId) return false
  if (scope.platform && scope.platform !== context.platform) return false
  if (scope.sdkVersionMax && !versionLte(context.sdkVersion, scope.sdkVersionMax)) return false
  return true
}

export function versionLte(candidate, ceiling) {
  const a = versionParts(candidate)
  const b = versionParts(ceiling)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index] ?? 0
    const right = b[index] ?? 0
    if (left !== right) return left < right
  }
  return true
}

function versionParts(value) {
  return String(value || '')
    .split('.')
    .map(part => parseInt(part, 10))
    .map(number => Number.isFinite(number) ? number : 0)
}

/**
 * 从候选配置行中解析出命中结果：最具体者生效，同特异性取版本最新。
 * @param {Array<{scope_json: object|string, config_json: object|string, config_version: number}>} rows 按 created_at desc 排列的候选
 * @param {{appId?:string, platform?:string, sdkVersion?:string}} context
 * @returns {{scope:object, config:object, configVersion:number}|null}
 */
export function resolveCollectConfig(rows, context) {
  let best = null
  for (const row of rows || []) {
    const scope = typeof row.scope_json === 'string' ? safeParse(row.scope_json, {}) : row.scope_json || {}
    if (!scopeMatches(scope, context)) continue
    const score = scopeSpecificity(scope)
    const version = Number(row.config_version || 0)
    if (!best || score > best.score || (score === best.score && version > best.version)) {
      const config = typeof row.config_json === 'string' ? safeParse(row.config_json, {}) : row.config_json || {}
      best = { score, version, scope, config }
    }
  }
  if (!best) return null
  return { scope: best.scope, config: mergeConfig(best.config), configVersion: best.version }
}

/** 深合并默认值：下发配置允许只携带变更字段 */
export function mergeConfig(partial) {
  const base = structuredCloneDefault()
  return {
    master_switch: partial.master_switch === 'off' ? 'off' : 'on',
    sampling: pickRates(partial.sampling, base.sampling),
    blocked_events: Array.isArray(partial.blocked_events) ? partial.blocked_events.map(item => String(item).slice(0, 160)).slice(0, 200) : base.blocked_events,
    plugins: pickBooleans(partial.plugins, base.plugins),
    rate_limits: normalizeRateLimits(partial.rate_limits)
  }
}

function structuredCloneDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_COLLECT_CONFIG))
}

function pickRates(input, fallback) {
  const out = { ...fallback }
  if (input && typeof input === 'object') {
    for (const key of SAMPLING_KEYS) {
      if (input[key] != null) out[key] = clampRate(input[key])
    }
  }
  return out
}

function pickBooleans(input, fallback) {
  const out = { ...fallback }
  if (input && typeof input === 'object') {
    for (const key of PLUGIN_KEYS) {
      if (input[key] != null) out[key] = Boolean(input[key])
    }
  }
  return out
}

function normalizeRateLimits(input) {
  const fallback = DEFAULT_COLLECT_CONFIG.rate_limits
  if (!input || typeof input !== 'object') return { ...fallback }
  const limit = Number(input.per_event_per_user_10min)
  return { per_event_per_user_10min: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : fallback.per_event_per_user_10min }
}

function clampRate(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return Math.max(0, Math.min(1, number))
}

/**
 * 管理端保存入参规范化：白名单字段 + 裁剪，防注入任意键。
 */
export function sanitizeCollectConfigInput(input = {}) {
  return mergeConfig({
    master_switch: input.masterSwitch ?? input.master_switch,
    sampling: input.sampling,
    blocked_events: Array.isArray(input.blockedEvents ?? input.blocked_events)
      ? (input.blockedEvents ?? input.blocked_events)
      : parseIfJson(input.blockedEvents ?? input.blocked_events),
    plugins: input.plugins,
    rate_limits: input.rateLimits ?? input.rate_limits
  })
}

function parseIfJson(value) {
  if (typeof value !== 'string') return undefined
  try { return JSON.parse(value) } catch { return [] }
}

/** 计算 diff 摘要（审计展示用） */
export function diffConfigs(before, after) {
  const lines = []
  if ((before.master_switch ?? 'on') !== after.master_switch) lines.push(`master_switch: ${before.master_switch ?? 'on'} → ${after.master_switch}`)
  for (const key of SAMPLING_KEYS) {
    const prev = before.sampling?.[key]
    const next = after.sampling?.[key]
    if (prev !== next) lines.push(`sampling.${key}: ${prev} → ${next}`)
  }
  const prevBlocked = JSON.stringify(before.blocked_events || [])
  const nextBlocked = JSON.stringify(after.blocked_events || [])
  if (prevBlocked !== nextBlocked) lines.push(`blocked_events: ${prevBlocked} → ${nextBlocked}`)
  for (const key of PLUGIN_KEYS) {
    const prev = before.plugins?.[key]
    const next = after.plugins?.[key]
    if (prev !== next) lines.push(`plugins.${key}: ${prev} → ${next}`)
  }
  if (JSON.stringify(before.rate_limits || {}) !== JSON.stringify(after.rate_limits || {})) {
    lines.push(`rate_limits: ${JSON.stringify(before.rate_limits || {})} → ${JSON.stringify(after.rate_limits || {})}`)
  }
  return lines.join('\n')
}

function safeParse(text, fallback) {
  try { return typeof text === 'string' ? JSON.parse(text) : text ?? fallback } catch { return fallback }
}
