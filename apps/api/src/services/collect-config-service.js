/**
 * @file PRD 04 远程配置——Node(PG) 管理端服务
 * 纯解析逻辑见 packages/collect-config.js（与 Worker 共享）。
 * config_version 取 collect_config_audit.max(id)：append-only 天然单调，免计数器。
 */
import { all, first, run } from '../db.js'
import {
  DEFAULT_COLLECT_CONFIG, diffConfigs, resolveCollectConfig,
  sanitizeCollectConfigInput, scopeMatches
} from '../../../../packages/collect-config.js'

/** 管理端保存：写入配置行 + 审计行，返回新 config_version */
export async function saveCollectConfig(input = {}) {
  const scope = normalizeScope(input.scope)
  const config = sanitizeCollectConfigInput(input.config || {})
  const operator = String(input.operator || 'admin').slice(0, 64)
  const now = Date.now()

  const before = await previewCollectConfig({ ...contextFromScope(scope), fallback: false })
  const diff = diffConfigs(before?.config || DEFAULT_COLLECT_CONFIG, config)

  const auditResult = await run(
    `insert into collect_config_audit (action, scope_json, config_snapshot, diff_json, operator, created_at)
     values (?, ?::jsonb, ?::jsonb, ?::jsonb, ?, ?) returning id`,
    [before ? 'update' : 'create', JSON.stringify(scope), JSON.stringify(config), JSON.stringify({ text: diff }), operator, now])
  const configVersion = Number(auditResult.rows[0].id)

  await run(
    `insert into collect_configs (scope_json, config_json, config_version, created_by, created_at)
     values (?, ?::jsonb, ?, ?, ?)`,
    [JSON.stringify(scope), JSON.stringify(config), configVersion, operator, now])
  return { ok: true, configVersion, diff }
}

/** 命中预览：输入 应用+平台+版本，输出将命中的配置与来源 scope */
export async function previewCollectConfig(input = {}) {
  const context = {
    appId: String(input.appId || '').slice(0, 64),
    platform: String(input.platform || '').slice(0, 32),
    sdkVersion: String(input.sdkVersion || '').slice(0, 32),
    release: String(input.appVersion || '').slice(0, 32)
  }
  if (input.fallback === false) {
    // 保存前对比用：无命中时返回 null 而不是默认配置
    return resolveOrNull(context)
  }
  const resolved = await resolveOrNull(context)
  if (resolved) return { ...resolved, matched: true }
  return { scope: {}, config: DEFAULT_COLLECT_CONFIG, configVersion: 0, matched: false }
}

async function resolveOrNull(context) {
  const rows = await all(`select scope_json, config_json, config_version from collect_configs order by created_at desc, id desc limit 200`)
  const resolved = resolveCollectConfig(rows, context)
  return resolved ? { ...resolved, matched: true } : null
}

/** 变更历史（审计时间线，append-only 不可改删） */
export async function listCollectConfigHistory() {
  const rows = await all(`select id, action, scope_json, config_snapshot, diff_json, operator, created_at
    from collect_config_audit order by created_at desc, id desc limit 100`)
  return rows.map(row => ({
    id: Number(row.id),
    action: row.action,
    scope: parseMaybe(row.scope_json),
    configSnapshot: parseMaybe(row.config_snapshot),
    diff: parseMaybe(row.diff_json)?.text || '',
    operator: row.operator,
    createdAt: Number(row.created_at)
  }))
}

/** 一键回滚：把历史快照复制为一条新配置（产生新的 config_version） */
export async function rollbackCollectConfig(historyId, input = {}) {
  const row = await first(`select * from collect_config_audit where id = ?`, [Number(historyId)])
  if (!row) throw new Error('历史记录不存在')
  const scope = parseMaybe(row.scope_json) || {}
  const snapshot = parseMaybe(row.config_snapshot) || DEFAULT_COLLECT_CONFIG
  const operator = String(input.operator || 'admin').slice(0, 64)
  const now = Date.now()
  const audit = await run(
    `insert into collect_config_audit (action, scope_json, config_snapshot, diff_json, operator, created_at)
     values ('rollback', ?::jsonb, ?::jsonb, ?::jsonb, ?, ?) returning id`,
    [JSON.stringify(scope), JSON.stringify(snapshot), JSON.stringify({ text: `回滚到历史 #${historyId}` }), operator, now])
  const configVersion = Number(audit.rows[0].id)
  await run(`insert into collect_configs (scope_json, config_json, config_version, created_by, created_at)
    values (?, ?::jsonb, ?, ?, ?)`, [JSON.stringify(scope), JSON.stringify(snapshot), configVersion, operator, now])
  return { ok: true, configVersion }
}

/** 命中统计：SDK 上报携带的 config_version 分布（近 24h 活跃会话） */
export async function collectConfigStats() {
  const since = Date.now() - 86400000
  let distribution = []
  try {
    distribution = await all(`
      select coalesce(props_json->>'configVersion', props_json->>'config_version',
        context_json->>'configVersion', context_json->>'config_version', '未上报') version,
        count(distinct session_id)::integer sessions
      from events where ts >= ? and coalesce(session_id, '') <> ''
      group by version order by sessions desc limit 20`, [since])
  } catch { distribution = [] }
  const latestRow = await first(`select max(id) latest from collect_config_audit`)
  const customScopes = await first(`select count(*)::integer count from (
      select distinct scope_json from collect_configs where scope_json <> '{}'::jsonb and scope_json is not null) scopes`)
  return {
    currentVersion: Number(latestRow?.latest || 0),
    customScopeCount: Number(customScopes?.count || 0),
    distribution: distribution.map(row => ({ version: row.version, sessions: Number(row.sessions) }))
  }
}

function normalizeScope(input = {}) {
  const scope = {}
  if (input.appId) scope.appId = String(input.appId).slice(0, 64)
  if (input.platform) scope.platform = String(input.platform).slice(0, 32)
  if (input.sdkVersionMax ?? input.sdk_version_max) scope.sdkVersionMax = String(input.sdkVersionMax ?? input.sdk_version_max).slice(0, 32)
  // appVersionMax 约束接入方应用 release 版本，与 sdkVersionMax（SDK 包版本）是独立维度
  if (input.appVersionMax ?? input.app_version_max) scope.appVersionMax = String(input.appVersionMax ?? input.app_version_max).slice(0, 32)
  return scope
}

function contextFromScope(scope) {
  return { appId: scope.appId || '', platform: scope.platform || '', sdkVersion: scope.sdkVersionMax || '', release: scope.appVersionMax || '' }
}

function parseMaybe(value) {
  try { return typeof value === 'string' ? JSON.parse(value) : value ?? null } catch { return null }
}

export { scopeMatches }
