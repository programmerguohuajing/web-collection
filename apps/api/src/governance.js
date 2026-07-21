import { all, run } from './db.js'

export const defaultSettings = {
  retention: { eventsDays: 30, replaysDays: 7, resolvedIssuesDays: 90, sourcemapsDays: 180, alertsDays: 90 },
  alerts: { enabled: true, cooldownMinutes: 10, error: true, regression: true, lcp: 4000, inp: 500, cls: 0.25, longtask: 200 }
}

const knownVersions = new Set()
const applicationCache = new Map()

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

export async function listApplications() {
  return all(`select a.*, count(distinct r.release_name)::integer as release_count
    from applications a left join releases r on r.app_id = a.app_id
    group by a.app_id order by a.updated_at desc`)
}

export async function saveApplication(input) {
  const appId = String(input.appId || '').trim().slice(0, 64)
  if (!appId) throw new Error('appId is required')
  const now = Date.now()
  const sampleRate = clampRate(input.sampleRate)
  const replaySampleRate = clampRate(input.replaySampleRate)
  await run(
    `insert into applications (app_id, name, platform, owner, enabled, sample_rate, replay_sample_rate, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(app_id) do update set name=excluded.name, platform=excluded.platform, owner=excluded.owner,
       enabled=excluded.enabled, sample_rate=excluded.sample_rate, replay_sample_rate=excluded.replay_sample_rate, updated_at=excluded.updated_at`,
    [appId, String(input.name || appId).slice(0, 128), String(input.platform || 'web').slice(0, 32), String(input.owner || '').slice(0, 128), input.enabled !== false, sampleRate, replaySampleRate, now, now]
  )
  applicationCache.delete(appId)
  return { appId }
}

export async function listReleases(appId) {
  return all('select app_id, release_name, status, created_at from releases where app_id = ? order by created_at desc', [appId])
}

export async function saveRelease(appId, input) {
  const release = String(input.release || '').trim().slice(0, 64)
  if (!release) throw new Error('release is required')
  await ensureApplication(appId, release)
  await run('update releases set status = ? where app_id = ? and release_name = ?', [String(input.status || 'active').slice(0, 32), appId, release])
  return { appId, release }
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
  const result = await notify(trigger.message)
  await run(
    `insert into alert_history (app_id, metric, fingerprint, level, value, message, notified, notify_error, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [event.appId, trigger.metric, fingerprint, trigger.level, trigger.value, trigger.message, result.ok, result.error || null, Date.now()]
  )
}

export async function listAlerts(limit = 100) {
  return all('select * from alert_history order by created_at desc limit ?', [Math.min(500, Number(limit) || 100)])
}

export async function cleanupExpiredData() {
  const { retention } = await getSettings()
  const now = Date.now()
  const deleted = {}
  deleted.events = (await run('delete from events where ts < ?', [cutoff(now, retention.eventsDays)])).rowCount
  deleted.replays = (await run('delete from replay_events where created_at < ?', [cutoff(now, retention.replaysDays)])).rowCount
  deleted.issues = (await run(`delete from issues where status = 'resolved' and last_seen < ?`, [cutoff(now, retention.resolvedIssuesDays)])).rowCount
  deleted.sourcemaps = (await run('delete from sourcemaps where created_at < ?', [cutoff(now, retention.sourcemapsDays)])).rowCount
  deleted.alerts = (await run('delete from alert_history where created_at < ?', [cutoff(now, retention.alertsDays)])).rowCount
  return deleted
}

function alertTrigger(event, issue, config) {
  if (event.type === 'error' && issue?.status === 'regression' && config.regression) return makeTrigger('regression', 1, 'critical', event)
  if (event.type === 'error' && config.error) return makeTrigger('error', 1, 'error', event)
  if (event.type !== 'perf' || !Number.isFinite(Number(event.value))) return null
  const metric = String(event.metric || event.name || '').toLowerCase()
  const threshold = Number(config[metric])
  return Number.isFinite(threshold) && Number(event.value) > threshold ? makeTrigger(metric, Number(event.value), 'warning', event) : null
}

function makeTrigger(metric, value, level, event) {
  return { metric, value, level, message: `[Web Collection] ${event.appId} ${metric} 告警，值 ${value}，页面 ${event.url || event.path || '-'}` }
}

async function notify(message) {
  const webhook = process.env.FEISHU_WEBHOOK_URL
  if (!webhook) return { ok: false, error: 'FEISHU_WEBHOOK_URL 未配置' }
  try {
    const response = await fetch(webhook, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text: message } }),
      signal: AbortSignal.timeout(5000)
    })
    return response.ok ? { ok: true } : { ok: false, error: `HTTP ${response.status}` }
  } catch (error) {
    return { ok: false, error: String(error.message || error).slice(0, 500) }
  }
}

function normalizeSettings(input = {}) {
  const merged = mergeSettings(input)
  for (const key of Object.keys(defaultSettings.retention)) merged.retention[key] = clampInt(merged.retention[key], 1, 3650)
  merged.alerts.cooldownMinutes = clampInt(merged.alerts.cooldownMinutes, 1, 1440)
  for (const key of ['lcp', 'inp', 'cls', 'longtask']) merged.alerts[key] = Math.max(0, Number(merged.alerts[key]) || defaultSettings.alerts[key])
  return merged
}

function mergeSettings(input = {}) {
  return { retention: { ...defaultSettings.retention, ...(input?.retention || {}) }, alerts: { ...defaultSettings.alerts, ...(input?.alerts || {}) } }
}

function clampRate(value) { return Math.max(0, Math.min(1, Number(value ?? 1))) }
function clampInt(value, min, max) { return Math.max(min, Math.min(max, Math.round(Number(value) || min))) }
function cutoff(now, days) { return now - Number(days) * 86400000 }
