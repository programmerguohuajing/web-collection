import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { all, run, scalar } from './db.js'
import { buildAlertContext, createAlertDeliveries } from './alerting.js'

export const defaultSettings = {
  retention: { eventsDays: 30, logsDays: 14, replaysDays: 7, resolvedIssuesDays: 90, sourcemapsDays: 180, alertsDays: 90 },
  alerts: { enabled: true, cooldownMinutes: 10, errorCount: 1, error: true, logError: true, regression: true, lcp: 4000, inp: 500, cls: 0.25, longtask: 200 }
}

/** 应用隐私模式（存储意图）：balanced=SDK 采集层脱敏后入库；raw=全量采集、下游查询层脱敏。 */
const APP_PRIVACY_MODES = new Set(['balanced', 'raw'])

const knownVersions = new Set()
const applicationCache = new Map()
const rulesCache = new Map()

export async function ensureApplication(appId, release = 'unknown') {
  const key = `${appId}\n${release}`
  if (knownVersions.has(key)) return
  const now = Date.now()
  await run(
    `insert into applications (app_id, name, created_at, updated_at) values (?, ?, ?, ?)
     on conflict(app_id) do nothing`,
    [appId, appId, now, now]
  )
  await run(
    `insert into releases (app_id, release_name, created_at) values (?, ?, ?)
     on conflict(app_id, release_name) do nothing`,
    [appId, release, now]
  )
  if (knownVersions.size > 10000) knownVersions.clear()
  knownVersions.add(key)
}

export async function shouldCollect(appId, type) {
  let cached = applicationCache.get(appId)
  if (!cached || cached.expiresAt < Date.now()) {
    const rows = await all('select enabled, sample_rate, replay_sample_rate from applications where app_id = ? limit 1', [appId])
    cached = { app: rows[0], expiresAt: Date.now() + 30000 }
    applicationCache.set(appId, cached)
  }
  const app = cached.app
  if (!app?.enabled) return false
  const rate = Number(type === 'replay' ? app.replay_sample_rate : app.sample_rate)
  return rate >= 1 || (rate > 0 && Math.random() < rate)
}

export async function listApplications(filters = {}) {
  const page = pageOf(filters)
  const select = `select a.app_id, a.name, a.platform, a.owner, a.enabled, a.sample_rate, a.replay_sample_rate, a.rules_json, a.privacy_mode, a.created_at, a.updated_at,
    (a.collect_key_hash is not null) as collect_key_enabled, count(distinct r.release_name)::integer as release_count
    from applications a left join releases r on r.app_id = a.app_id
    group by a.app_id order by a.updated_at desc`
  const [items, total] = await Promise.all([
    all(`${select} limit ? offset ?`, [page.pageSize, (page.page - 1) * page.pageSize]),
    scalar('select count(*) count from applications')
  ])
  return { ...page, total, items }
}

export async function saveApplication(input) {
  const appId = String(input.appId || '').trim().slice(0, 64)
  if (!appId) throw new Error('appId is required')
  const now = Date.now()
  const sampleRate = clampRate(input.sampleRate)
  const replaySampleRate = clampRate(input.replaySampleRate)
  const privacyMode = normalizeAppPrivacyMode(input.privacyMode)
  await run(
    `insert into applications (app_id, name, platform, owner, enabled, sample_rate, replay_sample_rate, rules_json, privacy_mode, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?)
     on conflict(app_id) do update set name=excluded.name, platform=excluded.platform, owner=excluded.owner,
       enabled=excluded.enabled, sample_rate=excluded.sample_rate, replay_sample_rate=excluded.replay_sample_rate, rules_json=excluded.rules_json, privacy_mode=excluded.privacy_mode, updated_at=excluded.updated_at`,
    [appId, String(input.name || appId).slice(0, 128), String(input.platform || 'web').slice(0, 32), String(input.owner || '').slice(0, 128), input.enabled !== false, sampleRate, replaySampleRate, JSON.stringify(normalizeRules(input.rules)), privacyMode, now, now]
  )
  applicationCache.delete(appId)
  rulesCache.delete(appId)
  return { appId }
}

export async function deleteApplication(appId) {
  // 先删除该应用所有入库的采集数据（releases 通过 ON DELETE CASCADE 自动删除）
  await run('delete from events where app_id=?', [appId])
  await run('delete from issues where app_id=?', [appId])
  await run('delete from replay_events where app_id=?', [appId])
  await run('delete from sourcemaps where app_id=?', [appId])
  await run('delete from alert_history where app_id=?', [appId]) // alert_deliveries 通过 ON DELETE CASCADE 级联
  await run('delete from funnel_definitions where app_id=?', [appId])
  // 最后删除应用记录
  await run('delete from applications where app_id=?', [appId])
  applicationCache.delete(appId)
  rulesCache.delete(appId)
  for (const key of knownVersions) if (key.startsWith(`${appId}\n`)) knownVersions.delete(key)
  return { ok: true }
}

export async function rotateCollectKey(appId) {
  await ensureApplication(appId)
  const key = `eys_${randomBytes(24).toString('base64url')}`
  await run('update applications set collect_key_hash=?, updated_at=? where app_id=?', [hashKey(key), Date.now(), appId])
  return { appId, collectKey: key }
}

export async function authorizeCollect(appId, key) {
  const rows = await all('select collect_key_hash from applications where app_id=?', [appId])
  const expected = rows[0]?.collect_key_hash
  if (!expected) return true
  const actual = hashKey(String(key || ''))
  return actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
}

export async function passesRules(event) {
  let cached = rulesCache.get(event.appId)
  if (!cached || cached.expiresAt < Date.now()) {
    const rows = await all('select rules_json from applications where app_id=?', [event.appId])
    cached = { rules: normalizeRules(rows[0]?.rules_json), expiresAt: Date.now() + 30000 }
    rulesCache.set(event.appId, cached)
  }
  const rules = cached.rules
  if (rules.blockedTypes.includes(event.type) || rules.blockedNames.includes(event.name)) return false
  if (rules.allowedOrigins.length && !rules.allowedOrigins.includes('*') && !rules.allowedOrigins.includes(originOf(event.url))) return false
  return true
}

export async function listReleases(appId, filters = {}) {
  const page = pageOf(filters)
  const [items, total] = await Promise.all([
    all('select app_id, release_name, status, created_at from releases where app_id = ? order by created_at desc limit ? offset ?', [appId, page.pageSize, (page.page - 1) * page.pageSize]),
    scalar('select count(*) count from releases where app_id=?', [appId])
  ])
  return { ...page, total, items }
}

export async function saveRelease(appId, input) {
  const release = String(input.release || '').trim().slice(0, 64)
  if (!release) throw new Error('release is required')
  await ensureApplication(appId, release)
  await run('update releases set status = ? where app_id = ? and release_name = ?', [String(input.status || 'active').slice(0, 32), appId, release])
  return { appId, release }
}

export async function deleteRelease(appId, release) {
  await run('delete from releases where app_id=? and release_name=?', [appId, release])
  knownVersions.delete(`${appId}\n${release}`)
  return { ok: true }
}

export async function getSettings() {
  const rows = await all('select config_json from platform_settings where id = 1')
  return mergeSettings(rows[0]?.config_json)
}

export async function saveSettings(input) {
  const config = normalizeSettings(input)
  await run(
    `insert into platform_settings (id, config_json, updated_at) values (1, ?::jsonb, ?)
     on conflict(id) do update set config_json=excluded.config_json, updated_at=excluded.updated_at`,
    [JSON.stringify(config), Date.now()]
  )
  return config
}

export async function processAlert(event, issue) {
  const settings = await getSettings()
  if (!settings.alerts.enabled) return
  const trigger = alertTrigger(event, issue, settings.alerts)
  if (!trigger) return
  const fingerprint = issue?.fingerprint || `${event.metric || event.name || event.type}:${event.url || event.path || ''}`.slice(0, 128)
  const since = Date.now() - settings.alerts.cooldownMinutes * 60000
  const recent = await all('select id from alert_history where app_id=? and metric=? and fingerprint=? and created_at>=? limit 1', [event.appId, trigger.metric, fingerprint, since])
  if (recent.length) return
  const result = await run(
    `insert into alert_history (app_id, metric, fingerprint, level, value, message, notified, context_json, created_at)
     values (?, ?, ?, ?, ?, ?, false, ?::jsonb, ?) returning id`,
    [event.appId, trigger.metric, fingerprint, trigger.level, trigger.value, trigger.message, JSON.stringify(buildAlertContext(event, trigger.threshold)), Date.now()]
  )
  await createAlertDeliveries(Number(result.rows[0].id))
}

export async function listAlerts(filters = {}) {
  const page = safePage(filters.page, 1, 1000000)
  const pageSize = safePage(filters.pageSize, 10, 100)
  const conditions = []
  const values = []
  for (const [field, value] of [['app_id', filters.appId], ['level', filters.level], ['metric', filters.metric], ['status', filters.status]]) {
    if (value) { conditions.push(`a.${field}=?`); values.push(String(value).slice(0, 64)) }
  }
  if (filters.keyword) { conditions.push('(a.message ilike ? or a.app_id ilike ? or a.metric ilike ?)'); values.push(...Array(3).fill(`%${String(filters.keyword).slice(0, 200)}%`)) }
  const where = conditions.length ? `where ${conditions.join(' and ')}` : ''
  const [items, total] = await Promise.all([
    all(`select a.*,
      nullif(a.context_json->>'traceId','') as trace_id,
      nullif(a.context_json->>'threshold','')::double precision as threshold,
      (select count(*) from alert_deliveries d where d.alert_id=a.id) delivery_total,
      (select count(*) from alert_deliveries d where d.alert_id=a.id and d.status='sent') delivery_sent,
      (select count(*) from alert_deliveries d where d.alert_id=a.id and d.status in ('failed','dead')) delivery_failed,
      (select count(*) from alert_deliveries d where d.alert_id=a.id and d.status in ('pending','sending')) delivery_pending
      from alert_history a ${where} order by a.created_at desc limit ? offset ?`, [...values, pageSize, (page - 1) * pageSize]),
    scalar(`select count(*) count from alert_history a ${where}`, values)
  ])
  return { items, total, page, pageSize }
}

const alertStatuses = new Set(['pending', 'acknowledged', 'resolved', 'dismissed'])

export async function updateAlertStatus(id, status) {
  const alertId = Number(id)
  if (!Number.isInteger(alertId) || alertId <= 0) throw httpError(400, '告警 ID 无效')
  const nextStatus = String(status || '').trim()
  if (!alertStatuses.has(nextStatus)) throw httpError(400, '告警状态无效')
  const rows = await all('update alert_history set status=?,updated_at=? where id=? returning *', [nextStatus, Date.now(), alertId])
  if (!rows.length) throw httpError(404, '告警不存在')
  return rows[0]
}

export async function cleanupExpiredData() {
  const { retention } = await getSettings()
  const now = Date.now()
  const deleted = {}
  deleted.logs = (await run(`delete from events where type='log' and ts < ?`, [cutoff(now, retention.logsDays)])).rowCount
  deleted.events = (await run(`delete from events where type<>'log' and ts < ?`, [cutoff(now, retention.eventsDays)])).rowCount
  deleted.replays = (await run('delete from replay_events where created_at < ?', [cutoff(now, retention.replaysDays)])).rowCount
  deleted.issues = (await run(`delete from issues where status = 'resolved' and last_seen < ?`, [cutoff(now, retention.resolvedIssuesDays)])).rowCount
  deleted.sourcemaps = (await run('delete from sourcemaps where created_at < ?', [cutoff(now, retention.sourcemapsDays)])).rowCount
  deleted.alerts = (await run('delete from alert_history where created_at < ?', [cutoff(now, retention.alertsDays)])).rowCount
  return deleted
}

function alertTrigger(event, issue, config) {
  if (event.type === 'log' && event.name === 'error' && config.logError) return makeTrigger('log_error', 1, 'error', event)
  if (event.type === 'error' && issue?.status === 'regression' && config.regression) return makeTrigger('regression', 1, 'critical', event)
  if (event.type === 'error' && config.error && Number(issue?.count || 1) >= config.errorCount) return makeTrigger('error', Number(issue?.count || 1), 'error', event)
  if (event.type !== 'perf' || !Number.isFinite(Number(event.value))) return null
  const metric = String(event.metric || event.name || '').toLowerCase()
  const threshold = Number(config[metric])
  return Number.isFinite(threshold) && Number(event.value) > threshold ? makeTrigger(metric, Number(event.value), 'warning', event, threshold) : null
}

function makeTrigger(metric, value, level, event, threshold) {
  const page = event.path || event.url || '-'
  const message = event.type === 'perf'
    ? `[Web Collection] ${event.appId} ${metric.toUpperCase()} ${value}${metric === 'cls' ? '' : 'ms'}，超过阈值 ${threshold}${metric === 'cls' ? '' : 'ms'}，页面 ${page}`
    : `[Web Collection] ${event.appId} ${event.name || metric}: ${event.message || '未知错误'}，页面 ${page}，版本 ${event.release || '-'}，Trace ${event.traceId || '-'}`
  return { metric, value, level, message, threshold }
}

function pageOf(filters) {
  return {
    page: safePage(filters?.page, 1, 1000000),
    pageSize: safePage(filters?.pageSize, 10, 100)
  }
}

function safePage(value, fallback, max) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(1, Math.min(max, Math.floor(number))) : fallback
}

function httpError(status, message) {
  const error = new Error(message)
  error.statusCode = status
  return error
}

function normalizeSettings(input = {}) {
  const merged = mergeSettings(input)
  for (const key of Object.keys(defaultSettings.retention)) merged.retention[key] = clampInt(merged.retention[key], 1, 3650)
  merged.alerts.cooldownMinutes = clampInt(merged.alerts.cooldownMinutes, 1, 1440)
  merged.alerts.errorCount = clampInt(merged.alerts.errorCount, 1, 100000)
  for (const key of ['lcp', 'inp', 'cls', 'longtask']) merged.alerts[key] = Math.max(0, Number(merged.alerts[key]) || defaultSettings.alerts[key])
  return merged
}

function mergeSettings(input = {}) {
  return { retention: { ...defaultSettings.retention, ...(input?.retention || {}) }, alerts: { ...defaultSettings.alerts, ...(input?.alerts || {}) } }
}

function clampRate(value) { return Math.max(0, Math.min(1, Number(value ?? 1))) }
function clampInt(value, min, max) { return Math.max(min, Math.min(max, Math.round(Number(value) || min))) }
function cutoff(now, days) { return now - Number(days) * 86400000 }
function hashKey(value) { return createHash('sha256').update(value).digest('hex') }
function normalizeRules(input = {}) { return { allowedOrigins: strings(input?.allowedOrigins), blockedTypes: strings(input?.blockedTypes), blockedNames: strings(input?.blockedNames) } }
function normalizeAppPrivacyMode(value) {
  // 应用隐私模式：balanced（默认，SDK 采集层脱敏后入库）/ raw（全量采集，下游查询层脱敏）。
  // 仅这两档用于表达「存储意图」；SDK 的 off/strict 等采集档由 Phase 3 按此映射消费。
  const v = String(value || '').trim().toLowerCase()
  return APP_PRIVACY_MODES.has(v) ? v : 'balanced'
}
function strings(value) { return Array.isArray(value) ? value.map(String).map(item => item.trim()).filter(Boolean).slice(0, 100) : [] }
function originOf(value) { try { return new URL(value).origin } catch { return '' } }
