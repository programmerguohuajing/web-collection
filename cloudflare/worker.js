import { SourceMapConsumer } from 'source-map-js'
import { alertContext, channelMatches, decryptSecrets, encryptSecrets, normalizeChannel, publicChannel, publishDelivery, sendChannel, verifyQStash } from '../packages/alerting.js'
import { buildCapabilities, WORKER_CAPABILITIES } from '../packages/deployment-capabilities.js'
import { maybeAutoDiagnose } from '../packages/ai/alert-diagnosis.js'
import { buildDistributedTrace } from '../packages/ai/queries.js'
import { missingMetricDailyDays, writeMetricDailyStats } from '../packages/ai/baseline.js'
import { createD1Adapter } from '../packages/ai/db-adapter.js'
import { DEFAULT_COLLECT_CONFIG, diffConfigs, resolveCollectConfig, sanitizeCollectConfigInput } from '../packages/collect-config.js'
import { applyAccessLevel, normalizeLevel } from '../packages/access-level.js'
// D2：认证加密原语与 RBAC 真相源直接复用共享包（与 Node 同源，不复制逻辑）
import { hashPassword, verifyPassword, signJwt, verifyJwt, randomToken, sha256Hex } from '../packages/auth-crypto.js'
import { isRole, defaultLevelForRole, hasPermission, checkRoleChange, checkLevelChange } from '../packages/rbac.js'
// B2：SLO 纯数学真相源与 Node 同源（错误预算/燃烧率/多窗口多燃烧率判定），杜绝两端判定漂移
import { computeGoodRatio, computeBurnRate, sloStatus, evaluateMultiWindowBurnRate, buildSloBurnAlert, parseJson, BURN_RATE_THRESHOLDS } from '../packages/slo.js'
import { evaluateProbe, normalizeCheckInput, validateProbeUrl, BODY_SNIPPET_LIMIT, TICK_BATCH_LIMIT } from '../packages/synthetic.js'
import { mapSentryIssue, mapSentryIssues } from '../packages/sentry-import.js'
import { keyFieldsOf } from '../packages/event-keyfields.js'
// Next Horizon A1：留存/同期群聚合逻辑与 Node/PostgreSQL 端同源（纯函数，无运行时依赖）
import { buildRetentionReport, RETENTION_DAY_MS } from '../packages/retention.js'

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } })

// ── 入库自监控（防 2026-08-28 式「全绿但零入库」静默失败） ──────────────────────
// 统计最近窗口内的 collect 请求数、进入写入的事件数、成功入库数、失败数与最近错误。
// 写库异常原本被 collect 的 ctx.waitUntil 静默吞掉（表象 health 绿、接口 200、但零数据），
// 现改为：捕获 → console.error（wrangler tail 可见）→ 计数 → 自动写 alert_history 告警。
const ingestionMonitor = {
  windowMs: 10 * 60 * 1000,
  since: Date.now(),
  received: 0, // collect 请求数
  eventsAccepted: 0, // 通过校验进入写入的事件数
  written: 0, // 成功入库的事件数
  failed: 0, // 写入失败的事件数
  lastError: null, // { message, at, appId }
  errors: [], // 最近错误（最多 20 条）
  reset() {
    this.since = Date.now()
    this.received = 0
    this.eventsAccepted = 0
    this.written = 0
    this.failed = 0
    this.errors = []
  },
  tick() {
    if (Date.now() - this.since > this.windowMs) this.reset()
  }
}

// 持久化入库健康（跨隔离 / 冷启动不丢），PRD R0-3 核心信号：
// 内存计数器会在隔离冷启动或 10min 窗口重置后归零，无法反映「已停写 X 分钟」；
// 故额外从 D1 真实 max(ts) 与近 1h 入库告警数补充，30s 缓存降低查询压力。
let _dbHealthCache = { at: 0, lastWriteTs: null, ingestErrorCount: 0 }
async function dbIngestionHealth(env) {
  const now = Date.now()
  if (now - _dbHealthCache.at < 30000) return _dbHealthCache
  const [maxRow, errRow] = await Promise.all([
    env.DB.prepare('select max(ts) as m from events').first().catch(() => null),
    env.DB.prepare("select count(*) as c from alert_history where metric='ingestion' and created_at>=?").bind(now - 3600 * 1000).first().catch(() => null)
  ])
  _dbHealthCache = {
    at: now,
    lastWriteTs: maxRow?.m != null ? Number(maxRow.m) : null,
    ingestErrorCount: Number(errRow?.c || 0)
  }
  return _dbHealthCache
}

// staleMs：最后一次成功入库距现在的毫秒数（null = 无数据）。
function ingestionStatus(db) {
  const { received, eventsAccepted, written, failed } = ingestionMonitor
  // 实时窗口内判定
  if (failed >= eventsAccepted && eventsAccepted > 0 && written === 0) return 'critical'
  if (failed > 0) return 'degraded'
  // 跨隔离 / 冷启动：基于数据库真实最后写入时间
  if (db && db.lastWriteTs != null) {
    const stalled = Date.now() - db.lastWriteTs
    if (stalled > 15 * 60 * 1000) return 'critical'
    if (stalled > 5 * 60 * 1000) return 'degraded'
  }
  if (db && db.ingestErrorCount > 0) return 'degraded'
  return 'healthy'
}

async function healthPayload(env) {
  ingestionMonitor.tick()
  const db = await dbIngestionHealth(env)
  const lastWriteTs = db.lastWriteTs
  return {
    ok: true, // 存活探针保持 200，便于外部 uptime 检查；入库健康度见 ingestion 字段。
    runtime: 'cloudflare-workers',
    ingestion: {
      status: ingestionStatus(db),
      received: ingestionMonitor.received,
      eventsAccepted: ingestionMonitor.eventsAccepted,
      written: ingestionMonitor.written,
      failed: ingestionMonitor.failed,
      failureRate: Number(ingestionMonitor.eventsAccepted ? ingestionMonitor.failed / ingestionMonitor.eventsAccepted : 0).toFixed(4),
      lastWriteTs,
      stalledMs: lastWriteTs != null ? Date.now() - lastWriteTs : null,
      lastErrorAt: ingestionMonitor.lastError?.at || null,
      lastErrorMessage: ingestionMonitor.lastError ? String(ingestionMonitor.lastError.message || '').slice(0, 300) : null,
      ingestErrorCount: db.ingestErrorCount,
      since: ingestionMonitor.since
    }
  }
}

async function ingestionMonitorSnapshot(env) {
  ingestionMonitor.tick()
  const db = await dbIngestionHealth(env)
  return {
    status: ingestionStatus(db),
    received: ingestionMonitor.received,
    eventsAccepted: ingestionMonitor.eventsAccepted,
    written: ingestionMonitor.written,
    failed: ingestionMonitor.failed,
    failureRate: Number(ingestionMonitor.eventsAccepted ? ingestionMonitor.failed / ingestionMonitor.eventsAccepted : 0).toFixed(4),
    lastWriteTs: db.lastWriteTs,
    stalledMs: db.lastWriteTs != null ? Date.now() - db.lastWriteTs : null,
    lastError: ingestionMonitor.lastError,
    recentErrors: ingestionMonitor.errors.slice(-10).map(e => ({ message: String(e.message || '').slice(0, 300), at: e.at, appId: e.appId })),
    ingestErrorCount: db.ingestErrorCount,
    since: ingestionMonitor.since
  }
}

// PRD R2-1：端到端回传校验——供 SDK/控制台确认「我发的事件到底有没有落库」。
// 性能：SDK 健康页每 30s 轮询本端点（实测 902 次/天），此前每次 3 连查（其中
// alert_history count 无索引全表扫 1733 行，单端点日耗 156 万行读——2026-09-10 D1 配额事故主因）。
// 现 ① 0038 迁移补 (metric, app_id, created_at) 索引；② 按 appId 做 30s 结果缓存（对齐
// dbIngestionHealth 既有模式）：诊断数据秒级新鲜度足够，重复查询直接命中内存。
// 性能：SDK 健康页每 30s 轮询本端点（实测 902-1246 次/天）。2026-09-11 复盘：30s 缓存
// 与 30s 轮询是「踩 TTL 边缘」的最坏组合——几乎每次轮询都刚好过期必 miss，缓存形同虚设
// （当日 1246+1312 次查询合计 198 万行读）。诊断数据（末次事件时间 / 1h 计数 / 错误数）
// 5 分钟新鲜度完全够用，TTL 拉长至 300s，行读降为原来的 1/10。
const _diagCache = new Map() // appId -> { at, payload }
async function diagnostics(request, env, url) {
  const appId = clip(url.searchParams.get('appId') || 'default', 64)
  const now = Date.now()
  const cached = _diagCache.get(appId)
  if (cached && now - cached.at < 300000) {
    return json({ ...cached.payload, stalledMs: cached.payload.lastEventTs != null ? now - cached.payload.lastEventTs : null, cached: true })
  }
  const [last, cnt, errs] = await Promise.all([
    env.DB.prepare('select max(ts) as m from events where app_id=?').bind(appId).first().catch(() => null),
    env.DB.prepare('select count(*) as c from events where app_id=? and ts>=?').bind(appId, now - 3600 * 1000).first().catch(() => null),
    env.DB.prepare("select count(*) as c from alert_history where app_id=? and metric='ingestion' and created_at>=?").bind(appId, now - 3600 * 1000).first().catch(() => null)
  ])
  const lastEventTs = last?.m != null ? Number(last.m) : null
  const stalledMs = lastEventTs != null ? Date.now() - lastEventTs : null
  let status = 'healthy'
  if ((lastEventTs != null && Date.now() - lastEventTs > 15 * 60 * 1000) || Number(errs?.c || 0) > 0) status = 'critical'
  else if (lastEventTs != null && Date.now() - lastEventTs > 5 * 60 * 1000) status = 'degraded'
  const payload = {
    appId,
    lastEventTs,
    stalledMs,
    receivedLast1h: Number(cnt?.c || 0),
    ingestErrorCount: Number(errs?.c || 0),
    status
  }
  if (_diagCache.size > 64) _diagCache.clear() // 防泄漏：appId 理论有限，保守上限
  _diagCache.set(appId, { at: now, payload })
  return json(payload)
}

// ===== Next Horizon E4/E1 补齐：SDK 端交付自监控 + SDK 体积开销 =====
// 这两块此前在 sdk-health 页只有「暂缺能力」占位：SelfMonitor 统计只存在浏览器内存（#1），
// SDK 体积只有构建产物侧数据（#2）。这里补齐后端存储与查询，使前端可真实展示（无数据时优雅空态）。

/** #1：SDK 端自监控快照上报（认证同 /api/collect：appId + x-app-key）。 */
async function reportSdkMonitoring(request, env) {
  const url = new URL(request.url)
  const appId = clip(url.searchParams.get('appId') || '', 64)
  if (!appId) return new Response('missing appId', { status: 400 })
  const key = request.headers.get('x-app-key') || ''
  const app = await env.DB.prepare('select collect_key_hash from applications where app_id=?').bind(appId).first().catch(() => null)
  if (app?.collect_key_hash && await sha256(key) !== app.collect_key_hash) return new Response('bad app key', { status: 401 })
  let body
  try { body = await request.json() } catch { return new Response('invalid json', { status: 400 }) }
  if (!body || typeof body !== 'object') return new Response('invalid body', { status: 400 })
  const now = Date.now()
  const num = v => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0)
  const sessionId = clip(String(body.sessionId || ''), 64)
  const sdkVersion = clip(String(body.sdkVersion || ''), 32)
  const health = clip(String(body.health || ''), 16)
  const payload = typeof body.payload === 'object' && body.payload ? JSON.stringify(body.payload).slice(0, 4000) : null
  await env.DB.prepare(
    'insert into sdk_monitoring(app_id,sdk_version,session_id,ts,sent,dropped,retried,timeouts,rate_limited,queue_full,storage_quota,health,payload) values(?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(
    appId, sdkVersion || null, sessionId || null, now,
    num(body.sent), num(body.dropped), num(body.retried), num(body.timeouts),
    num(body.rateLimited), num(body.queueFull), num(body.storageQuota),
    health || null, payload
  ).run().catch(err => { throw err })
  return json({ ok: true, ts: now })
}

/** #1：读取某 appId 在窗口内的自监控聚合（无数据时返回空聚合，前端据此显示「待 SDK 上报」）。 */
async function getSdkMonitoring(env, url) {
  const appId = clip(url.searchParams.get('appId') || '', 64)
  const hours = Math.max(1, Math.min(720, Number(url.searchParams.get('hours') || 24) || 24))
  const since = Date.now() - hours * 3600 * 1000
  if (!appId) return json({ appId: '', windowHours: hours, since, hasData: false, totals: {}, latest: null, samples: 0 })
  const agg = await env.DB.prepare(
    `select count(*) as samples,
            coalesce(sum(sent),0) as sent, coalesce(sum(dropped),0) as dropped,
            coalesce(sum(retried),0) as retried, coalesce(sum(timeouts),0) as timeouts,
            coalesce(sum(rate_limited),0) as rate_limited, coalesce(sum(queue_full),0) as queue_full,
            coalesce(sum(storage_quota),0) as storage_quota, max(ts) as last_ts
     from sdk_monitoring where app_id=? and ts>=?`
  ).bind(appId, since).first().catch(() => null)
  if (!agg || Number(agg.samples) === 0) {
    return json({ appId, windowHours: hours, since, hasData: false, totals: {}, latest: null, samples: 0 })
  }
  const latest = await env.DB.prepare(
    'select sdk_version, health, ts from sdk_monitoring where app_id=? and ts>=? order by ts desc limit 1'
  ).bind(appId, since).first().catch(() => null)
  return json({
    appId,
    windowHours: hours,
    since,
    hasData: true,
    samples: Number(agg.samples),
    totals: {
      sent: Number(agg.sent), dropped: Number(agg.dropped), retried: Number(agg.retried),
      timeouts: Number(agg.timeouts), rateLimited: Number(agg.rate_limited),
      queueFull: Number(agg.queue_full), storageQuota: Number(agg.storage_quota)
    },
    latest: latest ? { sdkVersion: latest.sdk_version, health: latest.health, ts: Number(latest.ts) } : null
  })
}

/** #2：SDK 体积开销上报（CI 在发版步骤调用；体积数据非敏感，仅做轻量 CI token 校验）。 */
async function reportSdkSize(request, env) {
  const ciToken = request.headers.get('x-ci-token') || ''
  const expect = env.CI_REPORT_TOKEN || ''
  if (expect && ciToken !== expect) return new Response('bad ci token', { status: 401 })
  let body
  try { body = await request.json() } catch { return new Response('invalid json', { status: 400 }) }
  if (!body || typeof body !== 'object' || !body.version) return new Response('missing version', { status: 400 })
  const num = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : null)
  const version = clip(String(body.version), 32)
  const runtimeMem = typeof body.runtimeMem === 'object' && body.runtimeMem ? JSON.stringify(body.runtimeMem).slice(0, 2000) : null
  await env.DB.prepare(
    'insert into sdk_size(version,gz_bytes,raw_bytes,min_bytes,runtime_mem,reported_at,ci_run) values(?,?,?,?,?,?,?)'
  ).bind(
    version, num(body.gzBytes), num(body.rawBytes), num(body.minBytes), runtimeMem, Date.now(), clip(String(body.ciRun || ''), 64) || null
  ).run().catch(err => { throw err })
  return json({ ok: true })
}

/** #2：读取体积开销（按版本；不传 version 返回各版本最新一条）。 */
async function getSdkSize(env, url) {
  const version = clip(url.searchParams.get('version') || '', 32)
  const rows = version
    ? await env.DB.prepare('select version,gz_bytes,raw_bytes,min_bytes,runtime_mem,reported_at,ci_run from sdk_size where version=? order by reported_at desc limit 1').bind(version).all().catch(() => null)
    : await env.DB.prepare('select version,gz_bytes,raw_bytes,min_bytes,runtime_mem,reported_at,ci_run from sdk_size order by reported_at desc').all().catch(() => null)
  const list = (rows?.results || []).map(r => ({
    version: r.version,
    gzBytes: r.gz_bytes != null ? Number(r.gz_bytes) : null,
    rawBytes: r.raw_bytes != null ? Number(r.raw_bytes) : null,
    minBytes: r.min_bytes != null ? Number(r.min_bytes) : null,
    runtimeMem: r.runtime_mem ? safeParse(r.runtime_mem) : null,
    reportedAt: Number(r.reported_at),
    ciRun: r.ci_run || null
  }))
  return json({ hasData: list.length > 0, list })
}

function safeParse(s) { try { return JSON.parse(s) } catch { return null } }

// 入库失败自动告警：复用 alert_history，使失败在现有告警 UI / 渠道可见（防静默）。
// 同隔离内 60s 仅写一次，避免失败风暴刷爆 alert_history / D1；跨隔离靠 D1 cooldown 去重。
let ingestionAlertedAt = 0
async function maybeIngestionAlert(env, appId, err) {
  const now = Date.now()
  if (now - ingestionAlertedAt < 60000) return
  ingestionAlertedAt = now
  const app = appId || 'default'
  const config = await settings(env).catch(() => ({ alerts: {} }))
  const cooldown = Number(config?.alerts?.cooldownMinutes || 30) * 60000
  const fingerprint = `ingestion:${app}`
  const recent = await env.DB.prepare('select id from alert_history where app_id=? and metric=? and fingerprint=? and created_at>=?').bind(app, 'ingestion', fingerprint, now - cooldown).first().catch(() => null)
  if (recent) return
  const result = await env.DB.prepare('insert into alert_history(app_id,metric,fingerprint,level,value,message,threshold,notified,context_json,created_at) values(?,?,?,?,?,?,?,0,?,?)').bind(app, 'ingestion', fingerprint, 'critical', 1, `[Web Collection] 入库失败：${String(err?.message || err).slice(0, 300)}`, 0, JSON.stringify({ source: 'ingestion_monitor' }), now).run()
  try { await createAlertDeliveries(env, Number(result.meta.last_row_id)) } catch {}
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), request)
    try {
      let response
      if (url.pathname === '/health') response = json(await healthPayload(env))
      else if (url.pathname === '/sdk-config') response = await sdkConfig(request, env, url)
      // D4 白标：公开运行时品牌脚本（run_worker_first 已含 /brand.js；不进 AUTH_PUBLIC_PREFIXES——顶层路径天然公开）
      else if (url.pathname === '/brand.js') response = await brandScriptW(request, env)
      else if (url.pathname === '/brand.js') response = await brandScriptW(request, env)
      else if (url.pathname === '/api/collect' && request.method === 'POST') response = await collect(request, env, ctx)
      else if (url.pathname === '/api/collect.gif') response = await collectGif(url, env)
      // BUG-002 修复：统一双端点契约——/health 的 ingestion 字段与 /api/monitoring/ingestion
      // 此前一个嵌套一个扁平，前端需双路径兼容。现统一为 { ingestion: {...} } 信封
      //（数据同源 ingestionMonitorSnapshot，与 /health.ingestion 完全同构）。
      else if (url.pathname === '/api/monitoring/ingestion') response = json({ ingestion: await ingestionMonitorSnapshot(env) })
      else if (url.pathname === '/api/diagnostics') response = await diagnostics(request, env, url)
      else if (url.pathname === '/api/monitoring/sdk' && request.method === 'POST') response = await reportSdkMonitoring(request, env)
      else if (url.pathname === '/api/monitoring/sdk') response = await getSdkMonitoring(env, url)
      else if (url.pathname === '/api/sdk-size' && request.method === 'POST') response = await reportSdkSize(request, env)
      else if (url.pathname === '/api/sdk-size') response = await getSdkSize(env, url)
      else if (url.pathname.startsWith('/api/dashboards/shared/')) response = await publicDashboard(request, env, url)
      else if (url.pathname.startsWith('/api/ai/')) response = await proxyAi(request, env, url)
      else if (url.pathname.startsWith('/api/')) response = await adminApi(request, env, url)
      else if (url.pathname.startsWith('/embed/')) response = await embedShell(request, env)
      else if (url.pathname.startsWith('/sdk/')) response = await env.ASSETS.fetch(new Request(new URL(url.pathname, request.url), request))
      else {
        const res = await env.ASSETS.fetch(request)
        // CDN 缓存事故根治：入口 HTML（SPA 路由）必须 no-store。此前仅靠 _headers 的 no-cache，
        // 而 Cloudflare 的 Cache Everything 类规则会无视 no-cache 缓存 HTML（线上实测 HIT），
        // 导致前端部署后长时间不生效（旧 HTML 持续引用旧 chunk）。no-store 是更强的不可缓存信号；
        // /assets/* 哈希资源不经 worker（run_worker_first 未包含），仍走 _headers 的 immutable 长缓存。
        const headers = new Headers(res.headers)
        headers.set('cache-control', 'no-store')
        response = new Response(res.body, { status: res.status, statusText: res.statusText, headers })
      }
      return cors(response, request)
    } catch (error) {
      return cors(new Response(error?.message || 'server error', { status: 500 }), request)
    }
  },
  async scheduled(controller, env) {
    await retryPendingAlertDeliveries(env)
    if (controller.cron === '17 3 * * *') {
      // D1 行读优化 ①②：日表 EOD 回填 + 小时表 48h 自愈（防部署空窗漏算），再执行保留期清理
      await metricDailyRollupW(env)
      await hourlyRollupRangeW(env, Date.now() - 48 * 3600000, Date.now()).catch(() => {})
      await cleanup(env)
    }
    // D2 · SLO：每 5 分钟快照 + 燃尽判定（sloEnabledW 内部自检，未开启时空转）
    if (controller.cron === '*/5 * * * *') {
      await sloTickW(env)
      // D1 行读优化 ②：小时级预聚合复用本 cron——账户 cron 触发器已达 Workers 免费版
      // 5 个/账户上限（API 10072），无法新增 0 * * * *；用小时桶守卫收敛为每小时首跳执行一次
      //（隔离重启后守卫归零最多多跑一次，writer 幂等无害；缺口由每日 17:3 的 48h 自愈兜底）。
      await maybeHourlyRollupW(env, controller.scheduledTime)
    }
    // B3 · 合成监控：每分钟探针 tick（SYNTHETIC_ENABLED≠1 时首行空转返回，零开销）
    if (controller.cron === '* * * * *') await syntheticTickW(env)
  }
}

async function collect(request, env, ctx) {
  const payload = await request.json()
  const inputs = payload.type === 'replay' ? [payload] : Array.isArray(payload.events) ? payload.events : Array.isArray(payload) ? payload : [payload]
  const appId = clip(inputs[0]?.appId || 'default', 64)
  if (inputs.some(item => clip(item?.appId || 'default', 64) !== appId)) return new Response('mixed app ids', { status: 400 })
  const app = await env.DB.prepare('select enabled, sample_rate, replay_sample_rate, collect_key_hash, rules_json, team_id from applications where app_id=?').bind(appId).first()
  if (app?.collect_key_hash && await sha256(request.headers.get('x-app-key') || '') !== app.collect_key_hash) return new Response('bad app key', { status: 401 })
  const events = inputs.slice(0, 100).map(sanitize)
  ingestionMonitor.tick()
  ingestionMonitor.received++
  ingestionMonitor.eventsAccepted += events.length
  // ponytail: acknowledge after validation; add a Queue if guaranteed ingestion is required.
  // 关键：写库异常原本被 waitUntil 静默吞掉（health 绿、接口 200、但零入库，即 2026-08-28 事故根因）。
  // 现捕获 → console.error（wrangler tail 可见）→ 计数 → 自动告警，确保「入库失败」可被发现。
  ctx.waitUntil((async () => {
    for (const event of events) {
      try {
        await record(env, event, app, ctx)
        ingestionMonitor.written++
      } catch (err) {
        ingestionMonitor.failed++
        const message = String(err?.message || err)
        ingestionMonitor.lastError = { message, at: Date.now(), appId: event.appId }
        ingestionMonitor.errors.push({ message, at: Date.now(), appId: event.appId })
        if (ingestionMonitor.errors.length > 20) ingestionMonitor.errors.shift()
        console.error('[ingestion] record failed', err)
        try { await maybeIngestionAlert(env, event.appId, err) } catch {}
      }
    }
    // D3 用量计量（METERING_ENABLED=1 门禁）：按批聚合后至多 2 次 upsert，杜绝逐事件写放大；
    // fail-safe：计量失败仅打日志，绝不影响采集主链路（红线：采集层不丢数据）。
    if (METERING_ENABLED(env)) {
      const evCount = events.reduce((n, e) => n + (e.type === 'replay' ? 0 : 1), 0)
      const rpCount = events.length - evCount
      const teamId = app?.team_id || ''
      try { if (evCount > 0) await meteringIncrementW(env, teamId, appId, 'events', evCount) } catch (me) { console.error('[metering] events increment failed', me) }
      try { if (rpCount > 0) await meteringIncrementW(env, teamId, appId, 'replay_sessions', rpCount) } catch (me) { console.error('[metering] replay increment failed', me) }
    }
  })())
  return json({ ok: true, accepted: events.length, received: inputs.length })
}

async function collectGif(url, env) {
  const data = url.searchParams.get('data')
  if (data) {
    try {
      await record(env, sanitize(JSON.parse(data)))
      ingestionMonitor.tick()
      ingestionMonitor.received++
      ingestionMonitor.eventsAccepted++
      ingestionMonitor.written++
    } catch (err) {
      ingestionMonitor.failed++
      const message = String(err?.message || err)
      ingestionMonitor.lastError = { message, at: Date.now(), appId: 'gif' }
      ingestionMonitor.errors.push({ message, at: Date.now(), appId: 'gif' })
      console.error('[ingestion] gif record failed', err)
      try { await maybeIngestionAlert(env, 'gif', err) } catch {}
    }
  }
  return new Response(Uint8Array.from(atob('R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw=='), c => c.charCodeAt(0)), { headers: { 'content-type': 'image/gif', 'cache-control': 'no-store' } })
}

// ==================== D3 用量计量（METERING_ENABLED 门禁，usage_daily 聚合账本） ====================
// 0035 迁移：usage_daily(team_id, app_id, metric, day) 主键；metric ∈ events|replay_sessions|seats。
// 红线：计量失败只记日志，绝不影响采集主链路（采集层不丢数据）；seats 为快照值由管理端维护，采集路径不写。
const METERING_ENABLED = (env) => env.METERING_ENABLED === '1'

async function meteringIncrementW(env, teamId, appId, metric, delta) {
  // day = UTC yyyyMMdd（与 0022 metric_daily_stats 同范式）
  const day = Number(new Date().toISOString().slice(0, 10).replace(/-/g, ''))
  await env.DB.prepare(
    'insert into usage_daily (team_id, app_id, metric, day, value, updated_at) values (?,?,?,?,?,?) ' +
    'on conflict(team_id, app_id, metric, day) do update set value = value + excluded.value, updated_at = excluded.updated_at'
  ).bind(clip(teamId || '', 32), clip(appId || 'default', 64), clip(metric || 'events', 24), day, Number(delta) || 0, Date.now()).run()
}

// ==================== BUG-011 修复：/api/metering/* 读端点（PRD 15 §7/§8） ====================
// 守卫：能力未开启统一 503（PRD 15 §验收「Worker 未设 METERING_ENABLED=1 时 /api/metering/* 全部 503」）；
// 开启后 usage / usage/daily / usage/by-app 从 usage_daily 聚合账本按月/按日/按应用读取（月粒度由日行求和，不落月表）。

/** PRD 15 守卫：metering 能力未开启（env.METERING_ENABLED≠1）时统一 503（复刻 guardDsrW 文案范式）。 */
function guardMeteringW(env, run) {
  if (env.METERING_ENABLED !== '1') return json({ error: '用量计量能力未启用（需设置 METERING_ENABLED=1）' }, 503)
  return run()
}

const METERING_PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/
/** 解析 ?period=YYYY-MM（缺省当月，UTC）→ { key, startDay, endDay, daysRemaining }（day 为 yyyyMMdd 整数）。 */
function meteringPeriodRange(period) {
  const now = new Date()
  const key = METERING_PERIOD_RE.test(String(period || '')) ? String(period)
    : `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  const [y, m] = key.split('-').map(Number)
  const startDay = y * 10000 + m * 100 + 1
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate() // 下月 0 日 = 当月最后一天
  const endDay = y * 10000 + m * 100 + lastDay
  const daysRemaining = Math.max(0, Math.ceil((Date.UTC(y, m, 1) - now.getTime()) / 86400000))
  return { key, startDay, endDay, daysRemaining }
}

/** 内置回落档位（PRD 15：档位入库不入码——plans 表有数据时以表为准，无数据时按 free 档展示）。 */
const METERING_FALLBACK_QUOTA = { events: 1000000, replay_sessions: 2000, seats: 5 }

/** GET /api/metering/usage：当前（或 ?period=YYYY-MM）周期用量 + 配额 + 百分比 + 剩余天数。 */
async function meteringUsageW(env, url) {
  const { key, startDay, endDay, daysRemaining } = meteringPeriodRange(url.searchParams.get('period'))
  const rows = await qm(env, 'select metric, sum(value) total from usage_daily where day between ? and ? group by metric', [startDay, endDay])
  const metrics = ['events', 'replay_sessions', 'seats'].map(name => {
    const used = Number(rows.find(r => r.metric === name)?.total || 0)
    const quota = METERING_FALLBACK_QUOTA[name] ?? null
    const pct = quota ? Math.round((used / quota) * 1000) / 10 : null
    return { metric: name, used, quota, pct, level: pct == null ? 'ok' : pct >= 100 ? 'exceeded' : pct >= 80 ? 'warning' : 'ok', unlimited: quota == null }
  })
  return json({ period: key, periodStart: startDay, periodEnd: endDay, daysRemaining, metrics })
}

/** GET /api/metering/usage/daily：?from&to&appId → [{day, events, replay_sessions}]（MiniLineChart 序列）。 */
async function meteringDailyW(env, url) {
  const nowDay = Number(new Date().toISOString().slice(0, 10).replace(/-/g, ''))
  const from = Number(url.searchParams.get('from')) || (Math.floor(nowDay / 100) * 100 + 1)
  const to = Number(url.searchParams.get('to')) || nowDay
  const appId = clip(url.searchParams.get('appId') || '', 64)
  const rows = await qm(env, `select day, metric, sum(value) total from usage_daily where day between ? and ? ${appId ? 'and app_id=?' : ''} group by day, metric`, appId ? [from, to, appId] : [from, to])
  const byDay = new Map()
  for (const r of rows) {
    const item = byDay.get(Number(r.day)) || { day: Number(r.day), events: 0, replay_sessions: 0 }
    if (r.metric === 'events') item.events = Number(r.total)
    if (r.metric === 'replay_sessions') item.replay_sessions = Number(r.total)
    byDay.set(Number(r.day), item)
  }
  return json([...byDay.values()].sort((a, b) => a.day - b.day))
}

/** GET /api/metering/usage/by-app：?period → [{appId, appName, events, replay_sessions, pct}]（按 events 降序 Top 50）。 */
async function meteringByAppW(env, url) {
  const { startDay, endDay } = meteringPeriodRange(url.searchParams.get('period'))
  const rows = await qm(env, "select app_id, metric, sum(value) total from usage_daily where day between ? and ? and app_id<>'' group by app_id, metric", [startDay, endDay])
  const apps = await qm(env, 'select app_id, name from applications')
  const nameMap = new Map(apps.map(a => [a.app_id, a.name || a.app_id]))
  const byApp = new Map()
  let totalEvents = 0
  for (const r of rows) {
    const item = byApp.get(r.app_id) || { appId: r.app_id, appName: nameMap.get(r.app_id) || r.app_id, events: 0, replay_sessions: 0 }
    if (r.metric === 'events') { item.events = Number(r.total); totalEvents += Number(r.total) }
    if (r.metric === 'replay_sessions') item.replay_sessions = Number(r.total)
    byApp.set(r.app_id, item)
  }
  return json([...byApp.values()]
    .map(item => ({ ...item, pct: totalEvents ? Math.round((item.events / totalEvents) * 1000) / 10 : 0 }))
    .sort((a, b) => b.events - a.events)
    .slice(0, 50))
}

// ==================== D4 白标：公开 /brand.js 运行时品牌脚本 ====================
// 与 apps/api/src/services/branding-service.js 逐字段镜像（Worker 不能 import Node 服务）：
// 优先级 DB(settings.config_json.brand) > env(BRAND_*) > 内置默认；WHITE_LABEL_ENABLED=1 才启用。
const BRAND_DEFAULTS_W = Object.freeze({
  name: 'Web Collection', shortName: 'WC', logoUrl: '', faviconUrl: '', primaryColor: '#4f46e5',
  loginTitle: '', loginSubtitle: '前端遥测平台', loginFooter: '', consoleDomain: '', collectDomain: ''
})

function brandNormalizeColorW(value) {
  if (typeof value !== 'string') return null
  let h = value.trim()
  if (/^#[0-9a-fA-F]{3}$/.test(h)) h = `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`
  if (/^#[0-9a-fA-F]{6}$/.test(h)) return h.toLowerCase()
  return null
}

function brandSafeUrlW(value) {
  if (typeof value !== 'string') return ''
  const v = value.trim()
  return /^(https?:\/\/|\/)/.test(v) ? v : ''
}

function brandPublicW(brand) {
  const b = brand && typeof brand === 'object' ? brand : {}
  const color = brandNormalizeColorW(b.primaryColor) || BRAND_DEFAULTS_W.primaryColor
  return {
    name: b.name || BRAND_DEFAULTS_W.name,
    shortName: b.shortName || BRAND_DEFAULTS_W.shortName,
    logoUrl: brandSafeUrlW(b.logoUrl),
    faviconUrl: brandSafeUrlW(b.faviconUrl),
    primaryColor: color,
    loginTitle: b.loginTitle || b.name || BRAND_DEFAULTS_W.name,
    loginSubtitle: b.loginSubtitle || BRAND_DEFAULTS_W.loginSubtitle,
    loginFooter: b.loginFooter || '',
    consoleDomain: b.consoleDomain || '',
    collectDomain: b.collectDomain || ''
  }
}

// 主色 → Element Plus 全套主色变量（HSL 亮度偏移，与 Node 侧 derivePalette 同参数）
function brandPaletteW(hex) {
  const h6 = (hex || '').replace('#', '')
  const r0 = parseInt(h6.slice(0, 2), 16) || 0
  const g0 = parseInt(h6.slice(2, 4), 16) || 0
  const b0 = parseInt(h6.slice(4, 6), 16) || 0
  const r = r0 / 255, g = g0 / 255, b = b0 / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0, s = 0
  const d = max - min
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h /= 6
  }
  const clamp01 = (v) => Math.min(1, Math.max(0, v))
  const hslToHex = (hh, ss, ll) => {
    let rr, gg, bb
    if (ss === 0) { rr = gg = bb = ll } else {
      const hue2rgb = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p }
      const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss
      const p = 2 * ll - q
      rr = hue2rgb(p, q, hh + 1 / 3); gg = hue2rgb(p, q, hh); bb = hue2rgb(p, q, hh - 1 / 3)
    }
    const to2 = (x) => Math.round(x * 255).toString(16).padStart(2, '0')
    return `#${to2(rr)}${to2(gg)}${to2(bb)}`
  }
  const hover = hslToHex(h, s, clamp01(l - 0.08))
  const soft = hslToHex(h, clamp01(s - 0.05), Math.min(0.96, clamp01(l + 0.50)))
  return { hover, soft, light3: hslToHex(h, s, clamp01(l + 0.18)), light5: hslToHex(h, s, clamp01(l + 0.28)), light7: hslToHex(h, s, clamp01(l + 0.38)), light8: hslToHex(h, s, clamp01(l + 0.45)), light9: soft, dark2: hover, ring: `rgba(${r0}, ${g0}, ${b0}, .18)` }
}

function brandSafeJsonW(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

/** 读取合并后的品牌配置（优先级 DB settings.config_json.brand > env BRAND_* > 内置默认；brandScriptW 与 /api/brand 同源）。 */
async function brandMergedW(env) {
  let brandBlock = null
  try {
    const row = await env.DB.prepare('select config_json from settings where id=1').first()
    const cfg = parse(row?.config_json, {})
    if (cfg && cfg.brand && typeof cfg.brand === 'object') brandBlock = cfg.brand
  } catch {}
  const fromEnv = {
    name: env.BRAND_NAME || '', shortName: env.BRAND_SHORT_NAME || '', logoUrl: env.BRAND_LOGO_URL || '',
    faviconUrl: env.BRAND_FAVICON_URL || '', primaryColor: env.BRAND_PRIMARY_COLOR || '',
    loginTitle: env.BRAND_LOGIN_TITLE || '', loginSubtitle: env.BRAND_LOGIN_SUBTITLE || ''
  }
  const merged = { ...BRAND_DEFAULTS_W }
  for (const [k, v] of Object.entries(fromEnv)) { if (v) merged[k] = v }
  if (brandBlock) { for (const [k, v] of Object.entries(brandBlock)) { if (v !== undefined && v !== null && v !== '') merged[k] = v } }
  return merged
}

// ==================== D4 · /api/brand 三端点（PRD 16 D6；镜像 Node apps/api 契约） ====================
// GET 公开（登录页未登录也读白标）：whiteLabel 关闭 → {enabled:false, brand:null}（200，非静默 404）；
// PUT / POST reset：能力位关闭 → 503「白标能力未启用」（PRD 16 §164/165）；开启时 merge 写 settings.config_json.brand。

/** 品牌 PUT 可写字段白名单（PRD 16 §163；collectDomain 由 SDK init 生效，仅记录展示）。 */
const BRAND_WRITABLE_W = ['name', 'shortName', 'logoUrl', 'faviconUrl', 'primaryColor', 'loginTitle', 'loginSubtitle', 'loginFooter', 'consoleDomain', 'collectDomain']

async function brandGetW(env) {
  try {
    const enabled = env.WHITE_LABEL_ENABLED === '1'
    if (!enabled) return json({ enabled: false, brand: null })
    return json({ enabled: true, brand: brandPublicW(await brandMergedW(env)) })
  } catch (err) {
    console.error('[brand] get failed', err)
    return json({ error: '品牌配置读取失败' }, 500)
  }
}

/** 写权限：accounts=false 单租户放行（与 saveSettings 同语义）；开启时需登录（session/api-key）且 admin+（owner 恒可）。 */
function brandWriteAuthzW(env, auth) {
  if (!accountsEnabled(env)) return null
  if (!auth) return json({ error: '未登录' }, 401)
  const role = String(auth.role || '')
  if (role !== 'owner' && role !== 'admin') return json({ error: '需要 Admin 及以上角色（owner 恒可）' }, 403)
  return null
}

async function brandPutW(request, env, auth) {
  if (env.WHITE_LABEL_ENABLED !== '1') return json({ error: '白标能力未启用（需设置 WHITE_LABEL_ENABLED=1）' }, 503)
  const denied = brandWriteAuthzW(env, auth)
  if (denied) return denied
  let body
  try { body = await request.json() } catch { body = {} }
  if (!body || typeof body !== 'object') return json({ error: '请求体须为 JSON 对象' }, 400)
  // 白名单过滤 → 归一化（颜色/URL 安全校验同 brandPublicW）→ merge 保留未提交字段的现值
  const current = await brandMergedW(env)
  const next = { ...current }
  for (const key of BRAND_WRITABLE_W) {
    if (body[key] !== undefined) next[key] = String(body[key] ?? '')
  }
  const normalized = brandPublicW(next)
  try {
    const row = await env.DB.prepare('select config_json from settings where id=1').first()
    const cfg = parse(row?.config_json, {})
    cfg.brand = { ...(cfg.brand || {}), ...normalized }
    await env.DB.prepare('insert into settings(id, config_json, updated_at) values(1,?,?) on conflict(id) do update set config_json=excluded.config_json, updated_at=excluded.updated_at')
      .bind(JSON.stringify(cfg), Date.now()).run()
    return json({ ok: true, brand: normalized })
  } catch (err) {
    console.error('[brand] put failed', err)
    return json({ error: '品牌配置保存失败' }, 500)
  }
}

async function brandResetW(request, env, auth) {
  if (env.WHITE_LABEL_ENABLED !== '1') return json({ error: '白标能力未启用（需设置 WHITE_LABEL_ENABLED=1）' }, 503)
  const denied = brandWriteAuthzW(env, auth)
  if (denied) return denied
  try {
    const row = await env.DB.prepare('select config_json from settings where id=1').first()
    const cfg = parse(row?.config_json, {})
    if (cfg.brand) {
      delete cfg.brand
      await env.DB.prepare('insert into settings(id, config_json, updated_at) values(1,?,?) on conflict(id) do update set config_json=excluded.config_json, updated_at=excluded.updated_at')
        .bind(JSON.stringify(cfg), Date.now()).run()
    }
    return json({ ok: true, brand: brandPublicW({ ...BRAND_DEFAULTS_W }) })
  } catch (err) {
    console.error('[brand] reset failed', err)
    return json({ error: '品牌配置重置失败' }, 500)
  }
}

async function brandScriptW(request, env) {
  const headers = { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }
  try {
    const enabled = env.WHITE_LABEL_ENABLED === '1'
    if (!enabled) return new Response('window.__BRAND__ = null;', { headers })
    const merged = await brandMergedW(env)
    const b = brandPublicW(merged)
    const p = brandPaletteW(b.primaryColor)
    const setProps = [
      ['--c-primary', b.primaryColor], ['--c-primary-hover', p.hover], ['--c-primary-soft', p.soft],
      ['--el-color-primary', b.primaryColor], ['--el-color-primary-light-3', p.light3], ['--el-color-primary-light-5', p.light5],
      ['--el-color-primary-light-7', p.light7], ['--el-color-primary-light-8', p.light8], ['--el-color-primary-light-9', p.light9],
      ['--el-color-primary-dark-2', p.dark2], ['--sh-focus', p.ring]
    ].map(([k, v]) => `  document.documentElement.style.setProperty(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n')
    const favicon = b.faviconUrl ? `  (function(){var __icons=document.querySelectorAll('link[rel~="icon"]');for(var i=0;i<__icons.length;i++){try{__icons[i].setAttribute('href', ${brandSafeJsonW(b.faviconUrl)});}catch(e){}}})();` : ''
    const script = [
      '(function(){\n  try {',
      `  window.__BRAND__ = ${brandSafeJsonW(b)};`,
      setProps,
      favicon,
      `  document.title = ${brandSafeJsonW(b.name)};`,
      '  } catch (e) { /* 品牌脚本容错：失败不阻断页面 */ }',
      '})();'
    ].filter(Boolean).join('\n')
    return new Response(script, { headers })
  } catch (err) {
    console.error('[brand] render failed', err)
    return new Response('window.__BRAND__ = null;', { headers })
  }
}

// 导出供运行时 QA（test/worker-d3-d4.runtime.test.js）；wrangler 只消费 default export，无影响。
export { brandScriptW, meteringIncrementW, brandPaletteW }

// M5：后端服务 span 上报（spans 表 + /api/spans），支持跨服务诊断
async function recordSpans(env, payload) {
  const raw = Array.isArray(payload) ? payload : Array.isArray(payload?.spans) ? payload.spans : payload && typeof payload === 'object' ? [payload] : []
  if (!raw.length) return json({ ok: true, count: 0, received: 0, rejected: 0 })
  const now = Date.now()
  const accepted = raw.slice(0, 1000).map((s, i) => normalizeBackendSpan(s, now, i)).filter(Boolean)
  for (let offset = 0; offset < accepted.length; offset += 100) {
    const batch = accepted.slice(offset, offset + 100)
    const ph = batch.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')
    const vals = batch.flatMap(sp => [sp.id, sp.traceId, sp.spanId, sp.parentSpanId, sp.serviceName, sp.operationName, sp.kind, sp.startTs, sp.duration, sp.statusCode, sp.statusMessage, JSON.stringify(sp.attributes), now])
    await storageWrite(env, `insert into spans (id,trace_id,span_id,parent_span_id,service_name,operation_name,kind,start_ts,duration,status_code,status_message,attributes_json,ts) values ${ph} on conflict(id) do update set duration=excluded.duration,status_code=excluded.status_code,status_message=excluded.status_message,attributes_json=excluded.attributes_json`, vals)
  }
  return json({ ok: true, count: accepted.length, received: raw.length, rejected: raw.length - accepted.length })
}

function normalizeBackendSpan(span = {}, now = Date.now(), index = 0) {
  if (!span || typeof span !== 'object') return null
  const traceId = clip(span.traceId || span.trace_id || '', 64)
  if (!traceId) return null
  const spanId = clip(span.spanId || span.span_id || `ingest-${now}-${index}`, 32)
  const parentSpanId = clip(span.parentSpanId || span.parent_span_id || '', 32)
  let attributes = span.attributes || span.attributes_json
  attributes = typeof attributes === 'string' ? parse(attributes, {}) : attributes
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) attributes = {}
  return {
    id: clip(span.id || `${traceId}-${spanId}-${now}-${index}`, 64),
    traceId, spanId, parentSpanId,
    serviceName: clip(span.serviceName || span.service_name || 'unknown', 128),
    operationName: clip(span.operationName || span.operation_name || 'span', 256),
    kind: clip(span.kind || 'INTERNAL', 16),
    startTs: Number(span.startTime ?? span.start_ts ?? now) || now,
    duration: Math.max(0, Number(span.duration ?? 0) || 0),
    statusCode: clip(span.status?.code || span.status_code || 'UNSET', 16),
    statusMessage: clip(span.status?.message || span.status_message || '', 2000),
    attributes
  }
}

async function resolveReplayEvents(event) {
  const raw = event?.events
  if (event?.compression === 'gzip' && typeof raw === 'string') {
    try {
      const bytes = Uint8Array.from(atob(raw), c => c.charCodeAt(0))
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
      const text = await new Response(stream).text()
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) return parsed
    } catch {}
    return []
  }
  // SDK 在不支持 CompressionStream 的环境会 fallback 为 compression:'none' + base64(JSON(events))；
  // 若不加此分支，none 编码的回放被解压为空数组，record 因 events.length===0 直接丢弃，
  // 导致 replays 表恒为空、回放列表/详情无数据。
  if (event?.compression === 'none' && typeof raw === 'string') {
    try {
      const bytes = Uint8Array.from(atob(raw), c => c.charCodeAt(0))
      const text = new TextDecoder().decode(bytes)
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) return parsed.slice(0, 200)
    } catch {}
    return []
  }
  if (Array.isArray(raw)) return raw.slice(0, 200)
  return []
}

async function record(env, event, application, ctx) {
  const now = Date.now()
  if (event.type === 'error' && event.props?.name) event.name = clip(event.props.name, 160)
  await storageWrite(env, `insert into applications (app_id,name,enabled,sample_rate,replay_sample_rate,created_at,updated_at) values (?,?,1,1,1,?,?) on conflict(app_id) do nothing`, [event.appId, event.appId, now, now])
  await storageWrite(env, `insert into releases (app_id,release_name,status,created_at) values (?,?, 'active', ?) on conflict(app_id,release_name) do nothing`, [event.appId, event.release, now])
  const app = application || await env.DB.prepare('select enabled,sample_rate,replay_sample_rate,rules_json from applications where app_id=?').bind(event.appId).first()
  if (app && (!app.enabled || Math.random() > Number(event.type === 'replay' ? app.replay_sample_rate : app.sample_rate))) return false
  const rules = parse(app?.rules_json, {})
  if (rules.blockedTypes?.includes(event.type) || rules.blockedNames?.includes(event.name) || (rules.allowedOrigins?.length && !rules.allowedOrigins.includes('*') && !rules.allowedOrigins.includes(origin(event.url)))) return false
  if (event.type === 'replay') {
    const events = await resolveReplayEvents(event)
    if (event.sessionId && events.length) await storageWrite(env, `insert into replays (session_id,app_id,user_id,user_name,user_phone,created_at,url,release_name,end_reason,events_json,base_session_id,user_agent) values (?,?,?,?,?,?,?,?,?,?,?,?)`, [event.sessionId,event.appId,event.userId,event.userName,event.userPhone,event.ts,event.url,event.release,event.segmentEndReason||null,JSON.stringify(events),event.baseSessionId||null,event.userAgent||null])
    return true
  }
  const id = crypto.randomUUID()
  const storedProps = event.parentSpanId ? { ...(event.props || {}), __parentSpanId: event.parentSpanId } : event.props
  await storageWrite(env, `insert into events (id,ts,type,app_id,release_name,user_id,user_name,user_phone,session_id,device_id,trace_id,span_id,url,path,title,referrer,user_agent,sdk_version,environment,source,context_json,name,metric,value,message,stack,props_json,breadcrumbs_json, app_version, product_id, event_id, request_id, occurred_at, received_at, schema_version, batch_id, retry_count, contract_status, contract_errors_json, device, os, browser) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id,event.ts,event.type,event.appId,event.release,event.userId,event.userName,event.userPhone,event.sessionId,event.deviceId,event.traceId,event.spanId,event.url,event.path,event.title,event.referrer,event.userAgent,event.sdkVersion,event.environment,event.source,JSON.stringify(event.context||null),event.name,event.metric,event.value,event.message,event.stack,JSON.stringify(storedProps||null),JSON.stringify(event.breadcrumbs||null), event.appVersion || event.release, event.productId || null, event.eventId || id, event.requestId || null, event.occurredAt || event.ts, now, event.schemaVersion || '1', event.batchId || null, event.retryCount || 0, 'accepted', null, deriveDevice(event.userAgent), deriveOs(event.userAgent), deriveBrowser(event.userAgent)])
  const issue = event.type === 'error' ? await upsertIssue(env, event) : null
  if (event.type === 'error' || (event.type === 'log' && event.name === 'error') || event.type === 'perf') await alert(env, event, issue, ctx)
  // A3 · 实验曝光识别（PRD 14 P0-5，架构 §3.2 Worker 注入点）：
  // behavior/exposure + props.experiment_key 且 EXPERIMENTS_ENABLED=1 且实验 running → 写 experiment_exposures
  //（唯一索引 on conflict(experiment_id, visitor_id) do nothing 兜底去重，已记录变体永不改写）。
  // best-effort：异常吞掉打 warn，不阻断事件主链路；无 running 实验时静默忽略（事件仍留在 events）。
  if (event.type === 'behavior' && event.name === 'exposure' && event.props?.experiment_key && env.EXPERIMENTS_ENABLED === '1') {
    try { await recordExperimentExposure(env, event) } catch (error) { console.warn('[experiment] exposure recording failed', error) }
  }
  return true
}

// 从 user_agent 派生设备/系统/浏览器，对齐 Postgres 版（apps/api/src/index.js）。
// D1 events 表此前缺少这三列，导致 journey/timeline 查询报 "no such column: e.device"。
function deriveBrowser(ua) {
  if (/Edg/i.test(ua)) return 'Edge'
  if (/Chrome/i.test(ua)) return 'Chrome'
  if (/Safari/i.test(ua)) return 'Safari'
  if (/Firefox/i.test(ua)) return 'Firefox'
  return 'Unknown'
}
function deriveOs(ua) {
  if (/Windows/i.test(ua)) return 'Windows'
  if (/Mac OS/i.test(ua)) return 'macOS'
  if (/Android/i.test(ua)) return 'Android'
  if (/iPhone|iPad/i.test(ua)) return 'iOS'
  if (/Linux/i.test(ua)) return 'Linux'
  return 'Unknown'
}
function deriveDevice(ua) {
  return /Mobile|Android|iPhone/i.test(ua) ? 'Mobile' : 'Desktop'
}

async function storageWrite(env, sql, values) {
  const run = () => env.DB.prepare(sql).bind(...(values || [])).run()
  try {
    return await run()
  } catch (error) {
    if (!/maximum DB size|SQLITE_FULL|database or disk is full/i.test(String(error?.message || error))) throw error
    // 库满兜底只清理 events（错误事件优先保留），不再删回放：回放不可再生，
    // 被批量清走会造成「列表有会话、点开无数据」；events 可随采样率重新积累。
    const freed = await env.DB.prepare(`delete from events where id in (select id from events order by case when type='error' then 1 else 0 end,ts asc limit 1000)`).run()
    if (!Number(freed.meta.changes)) throw error
    return run()
  }
}

async function upsertIssue(env, event) {
  const fingerprint = await sha256(issueKey(event))
  const previous = await env.DB.prepare('select * from issues where fingerprint=?').bind(fingerprint).first()
  const status = previous?.status === 'resolved' && previous.release_name !== event.release ? 'regression' : previous?.status || 'open'
  const sourceMap = await resolveSourceMap(env, event)
  // 与 PG 后端（store.js）保持一致：sourceMap 还原结果合并进 original_json 并写入 traceId；
  // 新事件未解析出 sourceMap 时沿用历史 original（避免覆盖已存在的 stack 反解结果）。
  const original = sourceMap
    ? { traceId: event.traceId || null, ...sourceMap }
    : parse(previous?.original_json, null)
  // props 同步合并 traceId（历史行无 traceId 时沿用上一次的，保证聚合表三处 traceId 一致）
  const previousProps = parse(previous?.props_json, null) || {}
  const props = { ...(event.props || {}), ...(event.traceId ? { traceId: event.traceId } : (previousProps.traceId ? { traceId: previousProps.traceId } : {})) }
  await env.DB.prepare(`insert into issues (fingerprint,status,app_id,release_name,name,message,stack,url,props_json,breadcrumbs_json,original_json,count,first_seen,last_seen,resolved_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(fingerprint) do update set status=excluded.status,release_name=excluded.release_name,message=excluded.message,stack=excluded.stack,url=excluded.url,props_json=excluded.props_json,breadcrumbs_json=excluded.breadcrumbs_json,original_json=excluded.original_json,count=issues.count+1,last_seen=excluded.last_seen`).bind(fingerprint,status,event.appId,event.release,event.name,event.message,event.stack,event.url,JSON.stringify(props),JSON.stringify(event.breadcrumbs||null),JSON.stringify(original),1,previous?.first_seen||event.ts,event.ts,previous?.resolved_at||null).run()
  return { fingerprint, status, count: Number(previous?.count || 0) + 1 }
}

export function issueKey(event) { const source=['FetchError','ResourceError','SseError','WebSocketError'].includes(event.name)?event.props?.source:'';return`${event.appId}|${event.name}|${source||String(event.stack||event.message).split('\n').slice(0,3).join('\n')}` }

// 将前端 /api/ai/* 请求代理到独立 ai-worker（web-collection-ai）。
// ai-worker 提供 D1 + Vectorize(ai-kb) + Workers AI 的诊断能力，隔离 LLM/向量故障对采集热路径的影响。
// ai-worker 鉴权是「同源免 key，开放调用需 x-ai-key」；主 worker 服务端转发时：
//   - 去掉 host，避免目标 URL 被误判；
//   - 去掉 origin/referer，避免 ai-worker 把主 worker 域名当作调用方来源导致 401；
//   - 若主 worker 配置了 AI_API_KEY，透传为 x-ai-key 走开放 API 鉴权路径。
async function proxyAi(request, env, url) {
  const workerUrl = env.AI_WORKER_URL
  if (!workerUrl) return json({ error: 'AI 诊断未配置（主 worker 缺少 AI_WORKER_URL）' }, 503)
  const target = new URL(url.pathname + url.search, String(workerUrl).replace(/\/?$/, '/'))
  const headers = new Headers(request.headers)
  headers.delete('host')
  headers.delete('origin')
  headers.delete('referer')
  if (env.AI_API_KEY) headers.set('x-ai-key', env.AI_API_KEY)
  const res = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(),
    redirect: 'manual'
  })
  return new Response(res.body, res)
}

async function adminApi(request, env, url) {
  const path = url.pathname
  // D2 · 身份解析（FR-9）：accounts=false 时恒为 null（存量零破坏）；
  // Bearer JWT → 会话校验 → 成员角色/等级；x-api-key → 虚拟主体 system（owner/L4）。
  const auth = await resolveAuth(request, env)
  // 严格模式（ACCOUNTS_ENFORCE=1）：受控管理接口未登录 → 401（公开前缀豁免，对齐 Node AUTH_PUBLIC_PREFIXES）
  if (!auth && accountsEnabled(env) && accountsEnforced(env) && requiresAuthPath(path)) return json({ error: '未登录或会话已失效' }, 401)
  if (path === '/api/capabilities') return json(buildCapabilities(WORKER_CAPABILITIES, { accounts: accountsEnabled(env), slo: sloEnabledW(env), synthetic: env.SYNTHETIC_ENABLED === '1', dsr: env.DSR_ENABLED === '1', experiments: env.EXPERIMENTS_ENABLED === '1', metering: env.METERING_ENABLED === '1', whiteLabel: env.WHITE_LABEL_ENABLED === '1' }))
  // ==================== D3 · 用量计量（PRD 15；METERING_ENABLED 门禁） ====================
  // BUG-011 修复：此前 /api/metering/* 落到 404，而 PRD 15 §验收承诺能力未开启时统一 503+文案。
  // 未开启 → guardMeteringW 统一 503；开启 → usage/daily/by-app 从 usage_daily 聚合账本读取。
  if (path === '/api/metering/usage' && request.method === 'GET') return guardMeteringW(env, () => meteringUsageW(env, url))
  if (path === '/api/metering/usage/daily' && request.method === 'GET') return guardMeteringW(env, () => meteringDailyW(env, url))
  if (path === '/api/metering/usage/by-app' && request.method === 'GET') return guardMeteringW(env, () => meteringByAppW(env, url))
  if (path.startsWith('/api/metering/')) return guardMeteringW(env, () => json({ error: 'not implemented' }, 501))
  // ==================== D4 · 白标品牌端点（PRD 16；镜像 Node apps/api 三端点契约） ====================
  // BUG-010 修复：GET 公开返回 {enabled, brand}；PUT/reset 需能力位开启（关闭 → 503）。
  if (path === '/api/brand' && request.method === 'GET') return brandGetW(env)
  if (path === '/api/brand' && request.method === 'PUT') return brandPutW(request, env, auth)
  if (path === '/api/brand/reset' && request.method === 'POST') return brandResetW(request, env, auth)
  if (path === '/api/spans' && request.method === 'POST') return recordSpans(env, await request.json())
  if (path === '/api/internal/alerts/deliver' && request.method === 'POST') return consumeAlertDelivery(request, env)
  if (path === '/api/events') return pagedEvents(env, url)
  if (path === '/api/logs') return pagedEvents(env, url, 'log')
  if (path === '/api/summary') return summary(env, url)
  if (path === '/api/issues') return paged(env, 'issues', url, 'last_seen')
  if (path === '/api/replays') return replayList(env, url)
  if (/^\/api\/replays\//.test(path)) return replayEvents(env, decodeURIComponent(path.split('/').at(-1)))
  if (path === '/api/traces') return traces(env, url)
  if (path === '/api/traces/') return traceEvents(env, '', url)
  if (/^\/api\/traces\/[^/]+\/distributed$/.test(path)) return distributedTrace(env, decodeURIComponent(path.split('/').at(-2)))
  // BUG-013 修复：topology-plan F1 承诺的调用拓扑端点（服务端按「页面 → API」归并，与 Node getTraceTopology 同构）。
  if (/^\/api\/traces\/[^/]+\/topology$/.test(path)) return traceTopology(env, decodeURIComponent(path.split('/').at(-2)))
  if (/^\/api\/traces\/[^/]+$/.test(path)) return traceEvents(env, decodeURIComponent(path.split('/').at(-1)), url)
  if (path === '/api/analytics/sessions') return sessions(env, url)
  if (/^\/api\/analytics\/sessions\//.test(path)) return sessionEvents(env, decodeURIComponent(path.split('/').at(-1)), url)
  if (path === '/api/analytics/paths') return paths(env, url)
  if (path === '/api/analytics/click-paths') return clickPaths(env, url)
  if (path === '/api/analytics/heatmap') return heatmap(env, url)
  if (path === '/api/analytics/live') return live(env, url)
  if (path === '/api/analytics/releases') return releasesReport(env, url)
  if (path === '/api/analytics/event-names') return funnelEventNames(env, url)
  if (path === '/api/applications' && request.method === 'GET') return applicationList(env, url, auth)
  if (/^\/api\/applications\/[^/]+$/.test(path) && request.method === 'DELETE') { const id=decodeURIComponent(path.split('/').at(-1)); await env.DB.prepare('delete from releases where app_id=?').bind(id).run(); await env.DB.prepare('delete from experiment_exposures where app_id=?').bind(id).run(); await env.DB.prepare('delete from experiments where app_id=?').bind(id).run(); await env.DB.prepare('delete from applications where app_id=?').bind(id).run(); return json({ok:true}) }
  if (/^\/api\/applications\/[^/]+$/.test(path) && request.method === 'PUT') return saveApplication(env, decodeURIComponent(path.split('/').at(-1)), await request.json())
  if (/\/collect-key$/.test(path) && request.method === 'POST') return rotateKey(env, decodeURIComponent(path.split('/').at(-2)))
  if (/\/releases$/.test(path) && request.method === 'GET') return releaseList(env, decodeURIComponent(path.split('/').at(-2)), url)
  if (/\/releases\/[^/]+$/.test(path) && request.method === 'DELETE') { await env.DB.prepare('delete from releases where app_id=? and release_name=?').bind(decodeURIComponent(path.split('/').at(-3)),decodeURIComponent(path.split('/').at(-1))).run(); return json({ok:true}) }
  if (/\/releases\/[^/]+$/.test(path) && request.method === 'PUT') return saveRelease(env, decodeURIComponent(path.split('/').at(-3)), decodeURIComponent(path.split('/').at(-1)), await request.json())
  if (path === '/api/settings') return request.method === 'PUT' ? saveSettings(env, await request.json()) : json(await settings(env))
  if (path === '/api/alerts') return alertList(env, url)
  if (/^\/api\/alerts\/\d+$/.test(path) && request.method === 'PATCH') return alertPatch(env, Number(path.split('/').at(-1)), await request.json())
  if (path === '/api/alert-channels' && request.method === 'GET') return alertChannelList(env, url)
  if (path === '/api/alert-channels' && request.method === 'POST') return saveAlertChannel(env, null, await request.json())
  if (/^\/api\/alert-channels\/\d+$/.test(path) && request.method === 'PUT') return saveAlertChannel(env, Number(path.split('/').at(-1)), await request.json())
  if (/^\/api\/alert-channels\/\d+$/.test(path) && request.method === 'DELETE') return removeAlertChannel(env, Number(path.split('/').at(-1)))
  if (/^\/api\/alert-channels\/\d+\/test$/.test(path) && request.method === 'POST') return testAlertChannel(env, Number(path.split('/').at(-2)))
  if (path === '/api/alert-deliveries' && request.method === 'GET') return alertDeliveryList(env, url)
  if (/^\/api\/alert-deliveries\/\d+\/retry$/.test(path) && request.method === 'POST') return retryAlertDelivery(env, Number(path.split('/').at(-2)))
  if (/\/issues\/[^/]+\/resolve$/.test(path) && request.method === 'POST') { const id=decodeURIComponent(path.split('/').at(-2)); const resNote=(await request.json().catch(()=>({})))?.resolutionNotes||null; await env.DB.prepare(`update issues set status='resolved',resolved_at=?,resolution_notes=coalesce(?,resolution_notes) where fingerprint=?`).bind(Date.now(),resNote,id).run(); return json(await env.DB.prepare('select * from issues where fingerprint=?').bind(id).first()) }
  if (path === '/api/sourcemaps' && request.method === 'POST') return saveSourceMap(env, await request.json())
  if (path === '/api/funnels' && request.method === 'GET') return funnelList(env, url)
  if (path === '/api/funnels' && request.method === 'POST') return saveFunnel(env, await request.json())
  if (/^\/api\/funnels\/\d+$/.test(path) && request.method === 'DELETE') { await env.DB.prepare('delete from funnel_definitions where id=?').bind(Number(path.split('/').at(-1))).run(); return json({ok:true}) }
  if (path === '/api/dashboards' && request.method === 'GET') return json((await env.DB.prepare('select * from dashboards order by updated_at desc').all()).results.map(row => ({...row,widgets_json:parse(row.widgets_json,[])})))
  if (path === '/api/dashboards' && request.method === 'POST') return saveDashboard(env, await request.json())
  if (/^\/api\/dashboards\/\d+$/.test(path) && request.method === 'DELETE') { await env.DB.prepare('delete from dashboards where id=?').bind(Number(path.split('/').at(-1))).run(); return json({ok:true}) }
  // A2 · 自定义看板分享：分享/取消走现有鉴权通道（与 adminApi 同口径，无独立门禁）。
  if (/^\/api\/dashboards\/\d+\/share$/.test(path) && request.method === 'POST') return shareDashboard(env, Number(path.split('/')[3]))
  if (/^\/api\/dashboards\/\d+\/share$/.test(path) && request.method === 'DELETE') return unshareDashboard(env, Number(path.split('/')[3]))
  if (path === '/api/maintenance/cleanup' && request.method === 'POST') return json(await cleanup(env))
  // ==================== D2 账号/团队/RBAC（镜像 apps/api Node 实现，字段/语义一致） ====================
  // 公开端点（register/login/refresh、邀请接受）不走严格 401 门；其余端点经上方 requiresAuthPath 门禁。
  if (path === '/api/auth/register' && request.method === 'POST') return authRegister(request, env)
  if (path === '/api/auth/login' && request.method === 'POST') return authLogin(request, env)
  if (path === '/api/auth/refresh' && request.method === 'POST') return authRefresh(request, env)
  if (path === '/api/auth/logout' && request.method === 'POST') return authLogout(request, env, auth)
  if (path === '/api/me' && request.method === 'GET') return authMe(env, auth)
  if (path === '/api/me/password' && request.method === 'POST') return authChangePassword(request, env, auth)
  if (path === '/api/me/sessions' && request.method === 'GET') return authSessionList(env, auth)
  if (/^\/api\/me\/sessions\/[^/]+$/.test(path) && request.method === 'DELETE') return authSessionRevoke(env, auth, decodeURIComponent(path.split('/').at(-1)))
  if (path === '/api/teams' && request.method === 'POST') return teamCreate(request, env, auth)
  if (/^\/api\/teams\/[^/]+$/.test(path) && request.method === 'GET') return teamGet(env, auth, decodeURIComponent(path.split('/').at(-1)))
  if (/^\/api\/teams\/[^/]+$/.test(path) && request.method === 'PUT') return teamUpdate(request, env, auth, decodeURIComponent(path.split('/').at(-1)))
  if (/^\/api\/teams\/[^/]+\/members$/.test(path) && request.method === 'GET') return teamMemberList(env, auth, decodeURIComponent(path.split('/')[3]))
  if (/^\/api\/teams\/[^/]+\/members\/[^/]+\/role$/.test(path) && request.method === 'PUT') return teamMemberRole(request, env, auth, decodeURIComponent(path.split('/')[3]), decodeURIComponent(path.split('/')[5]))
  if (/^\/api\/teams\/[^/]+\/members\/[^/]+\/access-level$/.test(path) && request.method === 'PUT') return teamMemberLevel(request, env, auth, decodeURIComponent(path.split('/')[3]), decodeURIComponent(path.split('/')[5]))
  if (/^\/api\/teams\/[^/]+\/members\/[^/]+$/.test(path) && request.method === 'DELETE') return teamMemberRemove(env, auth, decodeURIComponent(path.split('/')[3]), decodeURIComponent(path.split('/')[5]))
  if (/^\/api\/teams\/[^/]+\/invitations$/.test(path) && request.method === 'POST') return teamInviteCreate(request, env, auth, decodeURIComponent(path.split('/')[3]))
  if (/^\/api\/teams\/[^/]+\/invitations$/.test(path) && request.method === 'GET') return teamInviteList(env, auth, decodeURIComponent(path.split('/')[3]))
  if (/^\/api\/teams\/[^/]+\/invitations\/[^/]+$/.test(path) && request.method === 'DELETE') return teamInviteRevoke(env, auth, decodeURIComponent(path.split('/')[3]), decodeURIComponent(path.split('/').at(-1)))
  if (/^\/api\/invitations\/[^/]+\/accept$/.test(path) && request.method === 'POST') return invitationAccept(request, env, auth, decodeURIComponent(path.split('/')[3]))
  if (/^\/api\/teams\/[^/]+\/applications$/.test(path) && request.method === 'POST') return teamAssignApplication(request, env, auth, decodeURIComponent(path.split('/')[3]))
  if (/^\/api\/teams\/[^/]+\/audit$/.test(path) && request.method === 'GET') return teamAuditList(env, auth, decodeURIComponent(path.split('/')[3]))
  if (path === '/api/maintenance/migrate-members' && request.method === 'POST') return teamMigrateMembers(env, auth)
  // ==================== B2 · SLO/错误预算（镜像 apps/api Node 实现，数学同源 packages/slo.js） ====================
  // 能力位默认 false（原则 #4：Worker 验收前不上报 slo），env.SLO_ENABLED=1 开启后生效。
  if (path === '/api/slo' && request.method === 'POST') return guardSloW(env, () => sloSaveW(request, env, auth))
  if (path === '/api/slo' && request.method === 'GET') return guardSloW(env, () => sloListW(env, auth, url))
  if (/^\/api\/slo\/[^/]+\/budget$/.test(path) && request.method === 'GET') return guardSloW(env, () => sloBudgetW(env, auth, decodeURIComponent(path.split('/')[3]), url))
  if (/^\/api\/slo\/[^/]+\/trend$/.test(path) && request.method === 'GET') return guardSloW(env, () => sloTrendW(env, auth, decodeURIComponent(path.split('/')[3]), url))
  if (/^\/api\/slo\/[^/]+\/alerts$/.test(path) && request.method === 'GET') return guardSloW(env, () => sloAlertsW(env, decodeURIComponent(path.split('/')[3]), url))
  if (/^\/api\/slo\/[^/]+\/alert-policy$/.test(path) && request.method === 'POST') return guardSloW(env, () => sloPolicyW(request, env, auth, decodeURIComponent(path.split('/')[3])))
  if (/^\/api\/slo\/[^/]+\/compute$/.test(path) && request.method === 'POST') return guardSloW(env, () => sloComputeRouteW(env, auth, decodeURIComponent(path.split('/')[3])))
  if (/^\/api\/slo\/[^/]+$/.test(path) && request.method === 'GET') return guardSloW(env, () => sloGetW(env, auth, decodeURIComponent(path.split('/').at(-1))))
  if (/^\/api\/slo\/[^/]+$/.test(path) && request.method === 'DELETE') return guardSloW(env, () => sloDeleteW(env, auth, decodeURIComponent(path.split('/').at(-1))))
  // ==================== B3 · 合成监控（镜像 apps/api Node 实现，判定同源 packages/synthetic.js） ====================
  // 能力位默认 false（原则 #4：Worker 验收前不上报 synthetic），env.SYNTHETIC_ENABLED=1 开启后生效。
  // 注意顺序：/:id/run|timeline|stats 多段正则置于 /:id 单段之前（对齐 slo 区块"具体先于通配"排布）。
  if (path === '/api/synthetic' && request.method === 'POST') return guardSyntheticW(env, () => syntheticSaveW(request, env, auth))
  if (path === '/api/synthetic' && request.method === 'GET') return guardSyntheticW(env, () => syntheticListW(env, auth, url))
  if (/^\/api\/synthetic\/[^/]+\/run$/.test(path) && request.method === 'POST') return guardSyntheticW(env, () => syntheticRunW(env, auth, decodeURIComponent(path.split('/')[3])))
  if (/^\/api\/synthetic\/[^/]+\/timeline$/.test(path) && request.method === 'GET') return guardSyntheticW(env, () => syntheticTimelineW(env, auth, decodeURIComponent(path.split('/')[3]), url))
  if (/^\/api\/synthetic\/[^/]+\/stats$/.test(path) && request.method === 'GET') return guardSyntheticW(env, () => syntheticStatsW(env, auth, decodeURIComponent(path.split('/')[3]), url))
  if (/^\/api\/synthetic\/[^/]+$/.test(path) && request.method === 'GET') return guardSyntheticW(env, () => syntheticGetW(env, auth, decodeURIComponent(path.split('/').at(-1))))
  if (/^\/api\/synthetic\/[^/]+$/.test(path) && request.method === 'DELETE') return guardSyntheticW(env, () => syntheticDeleteW(env, auth, decodeURIComponent(path.split('/').at(-1))))
  // ==================== D1 · 数据主体权利 DSR（镜像 apps/api services/dsr-service.js；同路径同 JSON 契约） ====================
  // 能力位默认 false（原则 #4），env.DSR_ENABLED=1 开启后生效；权限点走共享 packages/rbac.js（全为 admin+，owner 恒允许），
  // 审批制衡（审批人 ≠ 发起人）由状态机服务端强制。注意顺序：多段动作路由先于 /:id 单段详情。
  if (path === '/api/dsr/requests' && request.method === 'POST') return guardDsrW(env, () => dsrCreateW(request, env, auth))
  if (path === '/api/dsr/requests' && request.method === 'GET') return guardDsrW(env, () => dsrListW(env, auth, url))
  if (/^\/api\/dsr\/requests\/[^/]+\/submit$/.test(path) && request.method === 'POST') return guardDsrW(env, () => dsrSubmitW(env, auth, decodeURIComponent(path.split('/')[4])))
  if (/^\/api\/dsr\/requests\/[^/]+\/approve$/.test(path) && request.method === 'POST') return guardDsrW(env, () => dsrApproveW(request, env, auth, decodeURIComponent(path.split('/')[4])))
  if (/^\/api\/dsr\/requests\/[^/]+\/execute$/.test(path) && request.method === 'POST') return guardDsrW(env, () => dsrExecuteW(request, env, auth, decodeURIComponent(path.split('/')[4])))
  if (/^\/api\/dsr\/requests\/[^/]+\/cancel$/.test(path) && request.method === 'POST') return guardDsrW(env, () => dsrCancelW(env, auth, decodeURIComponent(path.split('/')[4])))
  if (/^\/api\/dsr\/requests\/[^/]+\/audit$/.test(path) && request.method === 'GET') return guardDsrW(env, () => dsrAuditW(env, auth, decodeURIComponent(path.split('/')[4])))
  if (/^\/api\/dsr\/requests\/[^/]+$/.test(path) && request.method === 'GET') return guardDsrW(env, () => dsrDetailW(env, auth, decodeURIComponent(path.split('/').at(-1))))
  // ==================== A3 · 实验分析（镜像 apps/api services/experiment-service.js；同路径同 JSON 契约） ====================
  // 能力位默认 false（原则 #4），env.EXPERIMENTS_ENABLED=1 开启后生效；权限点走共享 packages/rbac.js
  // （expView 全员 / expCreate·expUpdate Admin+ / expArchive Admin，owner 恒允许）；accounts=false 单租户全局可见。
  // 注意顺序：/:id/report|status 多段正则先于 /:id 单段详情。
  if (path === '/api/experiments' && request.method === 'POST') return guardExperimentsW(env, () => expSaveW(request, env, auth))
  if (path === '/api/experiments' && request.method === 'GET') return guardExperimentsW(env, () => expListW(env, auth, url))
  if (/^\/api\/experiments\/[^/]+\/report$/.test(path) && request.method === 'GET') return guardExperimentsW(env, () => expReportW(env, auth, decodeURIComponent(path.split('/')[3])))
  if (/^\/api\/experiments\/[^/]+\/status$/.test(path) && request.method === 'POST') return guardExperimentsW(env, () => expStatusW(request, env, auth, decodeURIComponent(path.split('/')[3])))
  if (/^\/api\/experiments\/[^/]+$/.test(path) && request.method === 'GET') return guardExperimentsW(env, () => expGetW(env, auth, decodeURIComponent(path.split('/').at(-1))))
  if (/^\/api\/experiments\/[^/]+$/.test(path) && request.method === 'DELETE') return guardExperimentsW(env, () => expDeleteW(env, auth, decodeURIComponent(path.split('/').at(-1))))
  // C2 集成市场：Sentry issue 导入（指纹走本栈 issueKey+sha256，与原生事件去重对齐）
  if (path === '/api/integrations/sentry/import' && request.method === 'POST') return sentryImportW(request, env, auth)
  if (path === '/api/integrations/sentry/preview' && request.method === 'POST') return sentryPreviewW(request)
  if (/^\/api\/export\/(events|issues|replays)\.csv$/.test(path)) return exportCsv(env, RegExp.$1, url)
  // ==================== PRD 集合：洞察/治理层 ====================
  // PRD 01 用户链路（注意顺序：names 先于 :name 通配）
  if (path === '/api/journey/sessions') return journeySessions(env, url, auth)
  if (path === '/api/journey/timeline') return journeyTimeline(env, url, auth)
  if (path === '/api/events/dictionary') return dictionaryList(env, url)
  if (path === '/api/events/dictionary/names') return dictionaryNames(env, url)
  const dictName = /^\/api\/events\/dictionary\/([^/]+)$/.exec(path)
  if (dictName && request.method === 'PUT') return dictionaryRegister(env, decodeURIComponent(dictName[1]), await request.json())
  if (dictName) return dictionaryDetail(env, decodeURIComponent(dictName[1]), url, auth)
  // PRD 03 版本质量
  if (path === '/api/releases/quality') return releaseQuality(env, url, auth)
  if (path === '/api/releases/quality/compare') return releaseQualityCompare(env, url, auth)
  // PRD 04 远程配置——管理端
  if (path === '/api/collect-config' && request.method === 'GET') return collectConfigPreview(env, url)
  if (path === '/api/collect-config' && request.method === 'PUT') return collectConfigSave(env, await request.json())
  if (path === '/api/collect-config/history') return json((await env.DB.prepare('select id,action,scope_json,config_snapshot,diff_json,operator,created_at from collect_config_audit order by created_at desc limit 100').all()).results.map(row => ({ id: Number(row.id), action: row.action, scope: parse(row.scope_json, null), configSnapshot: parse(row.config_snapshot, null), diff: parse(row.diff_json, {})?.text || '', operator: row.operator, createdAt: Number(row.created_at) })))
  if (path === '/api/collect-config/rollback' && request.method === 'POST') return collectConfigRollback(env, await request.json())
  if (path === '/api/collect-config/stats') return collectConfigStats(env)
  // PRD 05 漏斗报告（PRD 形状，复用 runFunnel 引擎输出整形）
  if (/\/funnels\/\d+\/report$/.test(path)) return funnelReport(env, Number(path.split('/').at(-2)), url)
  // PRD 06 页面参与度
  if (path === '/api/analytics/engagement') return engagementList(env, url)
  if (path === '/api/analytics/engagement/detail') return engagementDetail(env, url, auth)
  // Next Horizon A1 · 留存 / 同期群分析（镜像 apps/api services/retention-service.js：
  // 同路径、同 JSON 契约，聚合逻辑同源 packages/retention.js，仅取数 SQL 用 D1/SQLite 方言）
  if (path === '/api/analytics/retention') return retentionList(env, url)
  if (path === '/api/analytics/api-health') return apiHealth(env, url)
  // PRD 07 数据访问等级
  // PRD 07 数据访问等级（D2 FR-9 扩展：已登录取 auth.level，匿名回落全局等级，前端不破）
  if (path === '/api/me/access-level') { const level = auth?.level || globalLevel(env); return json({ level, label: ({ L1: '只读统计', L2: '业务分析', L3: '运维诊断', L4: '完整数据' })[level], ...(auth?.userId ? { role: auth.role || null, teamId: auth.teamId || null, userId: auth.userId } : {}) }) }
  if (path === '/api/members' && request.method === 'GET') return json((await env.DB.prepare('select * from members order by updated_at desc limit 200').all().catch(() => ({ results: [] }))).results.map(row => ({ id: row.id, name: row.name, role: row.role || '', level: normalizeLevel(row.access_level), lastActiveAt: row.last_active_at ? Number(row.last_active_at) : null, updatedAt: Number(row.updated_at || 0) })))
  if (path === '/api/members' && request.method === 'POST') return memberSave(env, await request.json())
  if (/^\/api\/members\/[^/]+\/level$/.test(path) && request.method === 'PUT') return memberLevel(env, decodeURIComponent(path.split('/').at(-2)), await request.json())
  if (path === '/api/audit/data-access') return json((await env.DB.prepare('select * from data_access_audit order by created_at desc limit 200').all().catch(() => ({ results: [] }))).results.map(row => ({ id: Number(row.id), memberId: row.member_id, action: row.action, target: row.target, detail: parse(row.detail_json, null), createdAt: Number(row.created_at) })))
  return new Response('not found', { status: 404 })
}

async function pagedEvents(env, url, forcedType) {
  const { where, values } = filters(url, forcedType)
  const page = Math.max(1, Number(url.searchParams.get('page') || 1)), pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') || 10)))
  const [items, total] = await Promise.all([env.DB.prepare(`select * from events ${where} order by ts desc limit ? offset ?`).bind(...values,pageSize,(page-1)*pageSize).all(), env.DB.prepare(`select count(*) count from events ${where}`).bind(...values).first()])
  return json({ items: items.results.map(mapEvent), total: total.count, page, pageSize })
}

async function paged(env, table, url, order) {
  const page=Math.max(1,Number(url.searchParams.get('page')||1)), pageSize=Math.min(100,Math.max(1,Number(url.searchParams.get('pageSize')||10)))
  const {where,values}=table==='issues'?issueFilters(url):{where:'',values:[]}
  const issueUsers=`(select count(distinct coalesce(nullif(e.user_id,''),nullif(e.device_id,''),nullif(e.session_id,''))) from events e where e.type='error' and e.app_id=issues.app_id and e.name=issues.name and e.message=issues.message) affected_users`
  const select=table==='issues'?`select *,${issueUsers} from issues`:`select * from ${table}`
  const [rows,total]=await Promise.all([env.DB.prepare(`${select} ${where} order by ${order} desc limit ? offset ?`).bind(...values,pageSize,(page-1)*pageSize).all(),env.DB.prepare(`select count(*) count from ${table} ${where}`).bind(...values).first()])
  return json({items:rows.results.map(mapIssue),total:total.count,page,pageSize})
}

// ==================== D1 行读优化：预聚合 writer（① metric_daily_stats 日表 / ② events_hourly_stats 小时表） ====================
// 背景：D1 免费版 rows_read 按扫描行数计费，2026-09-10 曾日耗 534 万超 500 万上限导致全站读端点 500。
// ① AI 基线检测器（baseline-deviation）权威源 metric_daily_stats 长期空置，每次降级扫 events 全表
//   （insights 实测 3.1 万行/次 × 17 次/天）；② summary 的 byType/behavior/perfStats 聚合随 events
//   增长线性变贵。两个 writer 均幂等（upsert 覆盖重算），cron 驱动，不依赖请求流量。

/** UTC 日键 yyyyMMdd（与 baseline.js yyyymmdd 同口径，worker 侧独立实现避免导出扩散）。 */
function utcDayKeyW(ts) { const d = new Date(ts); return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate() }

/** ① 日表 EOD 回填：补最近 lookbackDays 个完整日（UTC）的缺口。不写“今天”（未完结日会污染基线观测日语义）。 */
async function metricDailyRollupW(env, lookbackDays = 14) {
  try {
    const db = createD1Adapter({ DB: env.DB })
    const now = Date.now(), today = utcDayKeyW(now)
    const missing = await missingMetricDailyDays(db, { fromDay: utcDayKeyW(now - lookbackDays * 86400000), toDay: today })
    const days = missing.filter(d => d < today)
    if (!days.length) return { written: 0, days: [] }
    const r = await writeMetricDailyStats(db, { days })
    console.log(`[metric-daily] rollup done: days=${days.join(',')} written=${r.written}`)
    return r
  } catch (error) {
    console.error('[metric-daily] rollup failed:', error?.message || error, error?.stack || '')
    return { written: 0, days: [] }
  }
}

/** 与 summary perfStats 完全同口径的 perf 守卫（预聚合写入与在线查询必须一致，否则缝合结果漂移）。 */
const PERF_GUARD_W = "typeof(value) in ('integer','real') and (ifnull(metric,'')<>'page_load' or value>0)"

/** ② 小时表幂等重算 [fromTs, toTs) 的每小时聚合（upsert 覆盖）。 */
async function hourlyRollupRangeW(env, fromTs, toTs) {
  const g = PERF_GUARD_W
  await env.DB.prepare(`insert into events_hourly_stats (app_id, hour_ts, type, metric, name, cnt, perf_cnt, value_sum)
    select app_id, cast(ts/3600000 as integer)*3600000, ifnull(type,''), ifnull(metric,''), ifnull(name,''),
      count(*),
      count(case when type='perf' and ${g} then 1 end),
      coalesce(sum(case when type='perf' and ${g} then value else null end), 0)
    from events where ts>=? and ts<?
    group by 1,2,3,4,5
    on conflict(app_id, hour_ts, type, metric, name) do update set cnt=excluded.cnt, perf_cnt=excluded.perf_cnt, value_sum=excluded.value_sum`).bind(fromTs, toTs).run()
}

/** ② 小时级 cron（0 * * * *）：刷新上一小时（已完结）+ 当前小时（部分，下轮覆盖）；首部署回填 14d；顺带 ① 日表回填。 */
async function hourlyRollupW(env) {
  try {
    const now = Date.now(), HOUR = 3600000, curHour = Math.floor(now / HOUR) * HOUR
    // 首部署探空必须在常规刷新之前——刷新写入后表恒非空，14d 回填将永不触发（线上实测踩坑）
    const existing = await env.DB.prepare('select count(*) as c from events_hourly_stats').first().catch(() => null)
    const firstRun = Number(existing?.c || 0) === 0
    await hourlyRollupRangeW(env, curHour - HOUR, now)
    if (firstRun) {
      // 首次部署：一次性回填 14 天历史（之后由每小时增量 + 每日 48h 自愈维持全覆盖）
      await hourlyRollupRangeW(env, curHour - 14 * 86400000, curHour - HOUR)
      console.log('[hourly-rollup] initial 14d backfill done')
    }
    await metricDailyRollupW(env)
  } catch (error) { console.error('[hourly-rollup] failed:', error?.message || error, error?.stack || '') }
}

/**
 * ② 小时桶守卫：复用「每 5 分钟」cron 执行小时级预聚合（账户 cron 触发器达免费版 5 个上限，
 * 无法新增独立小时触发器）。同一小时桶只跑一次；隔离冷启动后守卫归零最多多跑一次（幂等无害）。
 */
let _lastHourlyBucketW = 0
async function maybeHourlyRollupW(env, scheduledTime) {
  const bucket = Math.floor(Number(scheduledTime) || Date.now()) / 3600000 | 0
  if (bucket === _lastHourlyBucketW) return
  _lastHourlyBucketW = bucket
  await hourlyRollupW(env)
}

/**
 * ② summary 缝合计划：筛选仅含 appId/时间 且窗口 ≤7d 且小时表全覆盖时返回拼接参数，否则 null（走直扫）。
 * 小时表无 release/user/session/path/keyword 维度——带这些筛选的查询不缝合（口径不一致会出错）。
 * “全覆盖”= [h1,h2) 内 distinct hour 数与期望一致；当前小时（部分数据）恒被排除在缝合区间外。
 */
async function hourlyStitchPlan(env, url) {
  try {
    const p = url.searchParams
    for (const key of p.keys()) if (!['appId', 'startTime', 'endTime'].includes(key)) return null
    const HOUR = 3600000, now = Date.now()
    const fromTs = Number(p.get('startTime')) || now - 90 * 86400000
    const toTs = Number(p.get('endTime')) || now
    if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || toTs - fromTs > 7 * 86400000) return null
    const h1 = Math.ceil(fromTs / HOUR) * HOUR, h2 = Math.floor(toTs / HOUR) * HOUR
    if (h2 - h1 < HOUR) return null
    const appId = p.get('appId') || ''
    const expected = Math.round((h2 - h1) / HOUR)
    const cov = await env.DB.prepare(`select count(distinct hour_ts) as n from events_hourly_stats where hour_ts>=? and hour_ts<?${appId ? ' and app_id=?' : ''}`).bind(...(appId ? [h1, h2, appId] : [h1, h2])).first().catch(() => null)
    if (Number(cov?.n || 0) < expected) return null
    return { h1, h2, fromTs, toTs, appId }
  } catch { return null }
}

/**
 * ② 缝合执行：整小时读 events_hourly_stats（体积约为 events 的 1/50），两端不足 1 小时直扫 events。
 * 返回与直扫同构的三组行：byTypeRows / behaviorRows / perfStats（含 count 与 avg）。
 */
async function summaryStitchedAggregates(env, plan) {
  const g = PERF_GUARD_W
  const appCond = plan.appId ? ' and app_id=?' : ''
  const appVals = plan.appId ? [plan.appId] : []
  const edgeSql = `select type, ifnull(metric,'') metric, ifnull(name,'') name, count(*) cnt,
    count(case when type='perf' and ${g} then 1 end) perf_cnt,
    sum(case when type='perf' and ${g} then value else null end) value_sum
    from events where ts>=? and ts<?${appCond} group by 1,2,3`
  const jobs = [
    env.DB.prepare(`select type, sum(cnt) count from events_hourly_stats where hour_ts>=? and hour_ts<?${appCond} group by type`).bind(plan.h1, plan.h2, ...appVals).all().catch(() => ({ results: [] })),
    env.DB.prepare(`select name, sum(cnt) count from events_hourly_stats where hour_ts>=? and hour_ts<? and type in ('behavior','track')${appCond} group by name`).bind(plan.h1, plan.h2, ...appVals).all().catch(() => ({ results: [] })),
    env.DB.prepare(`select metric, sum(perf_cnt) count, sum(value_sum) value_sum from events_hourly_stats where hour_ts>=? and hour_ts<? and type='perf'${appCond} group by metric`).bind(plan.h1, plan.h2, ...appVals).all().catch(() => ({ results: [] })),
    plan.fromTs < plan.h1 ? env.DB.prepare(edgeSql).bind(plan.fromTs, plan.h1, ...appVals).all().catch(() => ({ results: [] })) : Promise.resolve({ results: [] }),
    plan.h2 < plan.toTs ? env.DB.prepare(edgeSql).bind(plan.h2, plan.toTs, ...appVals).all().catch(() => ({ results: [] })) : Promise.resolve({ results: [] })
  ]
  const [byTypeH, behaviorH, perfH, edgeL, edgeR] = await Promise.all(jobs)
  const edges = [...((edgeL && edgeL.results) || []), ...((edgeR && edgeR.results) || [])]
  // 合并（小时表 name/metric 存 ''，直扫为 null——统一映射回 null 保持响应键一致）
  const byType = new Map()
  for (const r of (byTypeH && byTypeH.results) || []) byType.set(r.type, (byType.get(r.type) || 0) + Number(r.count))
  for (const r of edges) byType.set(r.type, (byType.get(r.type) || 0) + Number(r.cnt))
  const behavior = new Map()
  for (const r of (behaviorH && behaviorH.results) || []) { const k = r.name || null; behavior.set(k, (behavior.get(k) || 0) + Number(r.count)) }
  for (const r of edges) if (r.type === 'behavior' || r.type === 'track') { const k = r.name || null; behavior.set(k, (behavior.get(k) || 0) + Number(r.cnt)) }
  const perf = new Map()
  for (const r of (perfH && perfH.results) || []) { const k = r.metric || null; const e = perf.get(k) || { count: 0, valueSum: 0 }; e.count += Number(r.count); e.valueSum += Number(r.value_sum || 0); perf.set(k, e) }
  for (const r of edges) { const k = r.metric || null; const e = perf.get(k) || { count: 0, valueSum: 0 }; e.count += Number(r.perf_cnt); e.valueSum += Number(r.value_sum || 0); perf.set(k, e) }
  return {
    byTypeRows: [...byType].map(([type, count]) => ({ type, count })),
    behaviorRows: [...behavior].map(([name, count]) => ({ name, count })),
    perfStats: [...perf].map(([metric, e]) => ({ metric, count: e.count, avg: e.count > 0 ? e.valueSum / e.count : null }))
  }
}

// 性能缓存：summary 是控制台各页首屏聚合（insights 实测 105 次/天，P75 窗口函数 +
// group by 每次读 1.2 万+ 行，日耗约 223 万行读——D1 配额事故第二大项）。
// 同筛选条件 60s 内复用上次结果：前端 30s 轮询下约半数命中（30s TTL 与 30s 轮询踩边
// 缘必 miss，缓存形同虚设——2026-09-11 复盘修正）；遥看板分钟级新鲜度足够。
const _summaryCache = new Map() // searchKey -> { at, text }
// P75 分位数独立缓存（searchKey -> { at, rows }）：TTL 5 分钟，比 summary 整体缓存更长。
const _summaryP75Cache = new Map()
function summaryP75Cache() { return _summaryP75Cache }
async function summary(env,url){
  const cacheKey = url.search
  const hit = _summaryCache.get(cacheKey)
  if (hit && Date.now() - hit.at < 60000) return new Response(hit.text, { headers: { 'content-type': 'application/json; charset=utf-8', 'x-summary-cache': 'hit' } })
  const {where,values}=filters(url),perfFilter=filters(url,'perf'),issueFilter=issueFilters(url),apdexFilter=filters(url,'perf',["metric='lcp'"])
  // P0-6 性能预算优化：原实现拉取 5000 条全列事件 + 50000 条 perf 事件到应用层聚合，
  // 现将 byType/behavior/事件总数/perf 计数与均值下推为 SQL GROUP BY，p75 用窗口函数
  // 在库内仅取每个 metric 的边界行（约 2 行/metric），只有 fetch/xhr/resource 明细
  // （需要 props_json 里的 url/name 做分组）仍拉行，且不再夹带无关 metric。
  const perfGuard="typeof(value) in ('integer','real') and (ifnull(metric,'')<>'page_load' or value>0)"
  // 防御：单个子查询失败（D1 超时/资源受限时 .all() 可能返回缺失 results 的对象）
  // 统一兜底为空数组/null，避免 for...of 抛 "X is not iterable" 把整个接口打 500。
  const all=(s)=>s.all().catch(()=>({results:[]})).then(r=>(r&&r.results)||[])
  const one=(s)=>s.first().catch(()=>null)
  // 预聚合缝合：仅 appId+时间 且窗口 ≤7d 且小时表全覆盖时，byType/behavior/perfStats
  // 改读 events_hourly_stats（体积约为 events 同窗的 1/50）+ 两端 <1h 直扫，免三次全窗扫描。
  const stitchPlan = await hourlyStitchPlan(env, url)
  // P75 独立缓存：窗口函数是 summary 最贵的子查询（窗口内全行编号，7 天窗单次 1.2 万行、
  // 90 天窗 9.7 万行；2026-09-11 实测三变体合计 340 万行读/天，配额事故最大单项）。
  // ① 窗口 >30 天跳过精确 P75（返回空 → 前端该项不展示；大窗口分位数对排障价值低）；
  // ② ≤30 天结果独立缓存 5 分钟（分位数变化极慢，可比 summary 整体 60s 缓存更长）。
  const _p75Cache = summaryP75Cache()
  const p75WindowSkip = (() => { const p = url.searchParams, n = Date.now(); const f = Number(p.get('startTime')) || n - 90 * 86400000, t = Number(p.get('endTime')) || n; return t - f > 30 * 86400000 })()
  const [eventStats,p75Rows,apiRows,issueResult,issueStats,browserRows, directAgg, apdexRow] = await Promise.all([
    one(env.DB.prepare(`select count(*) total,max(ts) last_seen from events ${where}`).bind(...values)),
    (async () => {
      if (p75WindowSkip) return []
      const hit = _p75Cache.get(cacheKey)
      if (hit && Date.now() - hit.at < 300000) return hit.rows
      const rows = await all(env.DB.prepare(`select metric,value,n,rn from (select metric,value,count(*) over (partition by metric) n,row_number() over (partition by metric order by value) rn from events ${perfFilter.where} and ${perfGuard}) where rn between cast((n-1)*0.75 as integer)+1 and cast((n-1)*0.75 as integer)+2`).bind(...perfFilter.values))
      if (_p75Cache.size > 32) _p75Cache.clear()
      _p75Cache.set(cacheKey, { at: Date.now(), rows })
      return rows
    })(),
    all(env.DB.prepare(`select metric,value,name,props_json from events ${perfFilter.where} and ${perfGuard} and metric in ('fetch','xhr','resource') order by ts desc limit 1000`).bind(...perfFilter.values)),
    all(env.DB.prepare(`select *,(select count(distinct coalesce(nullif(e.user_id,''),nullif(e.device_id,''),nullif(e.session_id,''))) from events e where e.type='error' and e.app_id=issues.app_id and e.name=issues.name and e.message=issues.message) affected_users from issues ${issueFilter.where} order by last_seen desc limit 100`).bind(...issueFilter.values)),
    one(env.DB.prepare(`select sum(case when status<>'resolved' then 1 else 0 end) issue_count,sum(case when status='regression' then 1 else 0 end) regression_count from issues ${issueFilter.where}`).bind(...issueFilter.values)),
    all(env.DB.prepare(`select coalesce(nullif(browser,''),'Unknown') browser, count(*) count from events ${where} group by 1 order by 2 desc`).bind(...values)),
    // 非缝合路径的三项聚合（缝合时该 Promise 结果被忽略，直扫代价与原实现一致）
    stitchPlan ? Promise.resolve(null) : Promise.all([
      all(env.DB.prepare(`select type,count(*) count from events ${where} group by type`).bind(...values)),
      all(env.DB.prepare(`select name,count(*) count from events ${where}${where?' and':' where'} type in ('behavior','track') group by name`).bind(...values)),
      all(env.DB.prepare(`select metric,count(*) count,avg(value) avg from events ${perfFilter.where} and ${perfGuard} group by metric`).bind(...perfFilter.values))
    ]),
    // Apdex 体验分：基于 LCP 样本，satisfied ≤2500ms / tolerating ≤4000ms（与 scorePerf 的 LCP 阈值同口径）
    one(env.DB.prepare(`select sum(case when value<=2500 then 1 else 0 end) satisfied,sum(case when value>2500 and value<=4000 then 1 else 0 end) tolerating,count(*) total from events ${apdexFilter.where} and ${perfGuard}`).bind(...apdexFilter.values))
  ])
  let byTypeRows, behaviorRows, perfStats
  if (stitchPlan) {
    const stitched = await summaryStitchedAggregates(env, stitchPlan)
    byTypeRows = stitched.byTypeRows; behaviorRows = stitched.behaviorRows; perfStats = stitched.perfStats
  } else {
    [byTypeRows, behaviorRows, perfStats] = directAgg
  }
  const issues=issueResult,byType={},behavior={},perf={},perfCounts={},byBrowser={}
  for(const row of byTypeRows)byType[row.type]=Number(row.count)
  for(const row of behaviorRows)behavior[row.name ?? 'null']=Number(row.count)
  for(const row of perfStats)perfCounts[row.metric ?? 'null']=Number(row.count)
  for(const row of (browserRows||[]))byBrowser[row.browser]=(byBrowser[row.browser]||0)+Number(row.count)
  const p75ByMetric=new Map()
  for(const row of p75Rows){const list=p75ByMetric.get(row.metric)||[];list.push(row);p75ByMetric.set(row.metric,list)}
  const statByMetric=new Map(perfStats.map(row=>[row.metric,row]))
  for(const metric of ['lcp','inp','fid','cls','fcp','fp','ttfb','longtask','white_screen','blank_screen_rate','first_screen','route_render','data_ready','dom_ready','page_load','js_boot','tbt','resource_failure_rate','slow_api_rate','dns','tcp','tls','request','download','cache_hit_rate','redirect','redirect_count','memory']){
    let value=null
    if(metric.endsWith('_rate')){const stat=statByMetric.get(metric);value=stat&&Number(stat.count)>0?Number(stat.avg):null}
    else{const rows=p75ByMetric.get(metric);if(rows&&rows.length){const n=Number(rows[0].n),index=(n-1)*.75,lower=Math.floor(index),upper=Math.ceil(index),lo=rows.find(r=>Number(r.rn)===lower+1)?.value,hi=rows.find(r=>Number(r.rn)===upper+1)?.value;if(lo!=null&&hi!=null)value=lower===upper?Number(lo):Number(lo)+(Number(hi)-Number(lo))*(index-lower)}}
    if(value!==null)perf[metric]=Number(value.toFixed(metric==='cls'?4:0))
  }
  const perfRows=apiRows.map(row=>({metric:row.metric,value:Number(row.value),name:row.name,props:parse(row.props_json,{})}))
  // Apdex = (satisfied + tolerating/2) / total；无 LCP 样本时为 null（前端显示 '-'）
  const apdexTotal=Number(apdexRow?.total||0)
  const apdex=apdexTotal>0?Number(((Number(apdexRow?.satisfied||0)+Number(apdexRow?.tolerating||0)/2)/apdexTotal).toFixed(2)):null
  const summaryBody=JSON.stringify({totalEvents:Number(eventStats?.total||0),issueCount:Number(issueStats?.issue_count||0),regressionCount:Number(issueStats?.regression_count||0),lastSeen:eventStats?.last_seen||null,perf,perfCounts,byType,behavior,byBrowser,apdex,api:aggregatePerf(perfRows.filter(row=>row.metric==='fetch'||row.metric==='xhr'),row=>row.props?.url||row.name||'unknown'),resources:aggregatePerf(perfRows.filter(row=>row.metric==='resource'),row=>row.props?.name||row.name||'unknown'),replays:[],alerts:[],issues:issues.map(mapIssue)})
  if (_summaryCache.size > 32) _summaryCache.clear() // 防泄漏：筛选组合有限，保守上限
  _summaryCache.set(cacheKey, { at: Date.now(), text: summaryBody })
  // 缝合可观测性：与 x-summary-cache 同思路，凭响应头即可确认命中小时表预聚合路径（排障/验证用）
  return new Response(summaryBody, { headers: { 'content-type': 'application/json; charset=utf-8', ...(stitchPlan ? { 'x-summary-stitch': 'hourly' } : {}) } })
}

function percentile75(values){if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b),index=(sorted.length-1)*.75,lower=Math.floor(index),upper=Math.ceil(index);return lower===upper?sorted[lower]:sorted[lower]+(sorted[upper]-sorted[lower])*(index-lower)}
function aggregatePerf(rows,keyFn){const grouped=new Map();for(const row of rows){const key=keyFn(row),item=grouped.get(key)||{name:key,count:0,total:0,values:[]},value=Number(row.value)||0;item.count++;item.total+=value;item.values.push(value);grouped.set(key,item)}return[...grouped.values()].map(item=>({name:item.name,count:item.count,avg:Math.round(item.total/item.count),p75:percentile75(item.values)})).sort((a,b)=>b.p75-a.p75).slice(0,10)}

function percentileAt(values,p){if(!values||!values.length)return null;const sorted=[...values].sort((a,b)=>a-b),index=(sorted.length-1)*p,lower=Math.floor(index),upper=Math.ceil(index);return lower===upper?sorted[lower]:sorted[lower]+(sorted[upper]-sorted[lower])*(index-lower)}
// Next Horizon E2：API 健康视图——复用 fetch/xhr 性能事件聚合端点健康度
// （props_json 为文本列，需 parse 解析；与 summary.api 同口径只取最近 5000 条，避免全表扫描）
async function apiHealth(env,url){
  const {where,values}=filters(url,'perf',["metric in ('fetch','xhr')"])
  const endpoint=url.searchParams.get('endpoint')
  const rows=((await env.DB.prepare(`select metric,value,name,ts,props_json from events ${where} order by ts desc limit 5000`).bind(...values).all().catch(()=>({results:[]}))).results||[])
  const read=row=>{const props=parse(row.props_json,{});return{method:String(props.method||'GET').toUpperCase(),url:String(props.url||row.name||'unknown'),status:Number(props.status)||0,value:Number(row.value)||0,ts:Number(row.ts)||0}}
  if(endpoint){
    const [method,...rest]=String(endpoint).split(' ')
    const targetMethod=(method||'GET').toUpperCase(),targetUrl=rest.join(' ').trim()
    const buckets=new Map()
    for(const row of rows){
      const item=read(row)
      if(item.method!==targetMethod||item.url!==targetUrl)continue
      const key=Math.floor(item.ts/3600000)*3600000
      const bucket=buckets.get(key)||{bucket:key,count:0,errorCount:0,total:0,values:[]}
      bucket.count++;bucket.total+=item.value;bucket.values.push(item.value)
      if(item.status>=400)bucket.errorCount++
      buckets.set(key,bucket)
    }
    const series=[...buckets.values()].sort((a,b)=>a.bucket-b.bucket).map(b=>({bucket:b.bucket,count:b.count,errorCount:b.errorCount,errorRate:b.count?b.errorCount/b.count:0,avgDuration:Math.round(b.total/Math.max(1,b.count)),p95:Math.round(percentileAt(b.values,0.95)||0)}))
    return json({endpoint:String(endpoint),series})
  }
  const grouped=new Map()
  for(const row of rows){
    const item=read(row)
    const key=`${item.method} ${item.url}`
    const entry=grouped.get(key)||{method:item.method,url:item.url,endpoint:key,count:0,total:0,values:[],status:{}}
    entry.count++;entry.total+=item.value;entry.values.push(item.value)
    entry.status[item.status]=(entry.status[item.status]||0)+1
    grouped.set(key,entry)
  }
  const endpoints=[...grouped.values()].map(entry=>{
    const sorted=[...entry.values].sort((a,b)=>a-b)
    const errorCount=Object.entries(entry.status).filter(([status])=>Number(status)>=400).reduce((sum,[,count])=>sum+count,0)
    return{method:entry.method,url:entry.url,endpoint:entry.endpoint,count:entry.count,errorCount,errorRate:entry.count?errorCount/entry.count:0,avgDuration:Math.round(entry.total/Math.max(1,entry.count)),p50:Math.round(percentileAt(sorted,0.5)||0),p95:Math.round(percentileAt(sorted,0.95)||0),maxDuration:Math.round(sorted[sorted.length-1]||0),statusCodes:entry.status}
  }).sort((a,b)=>b.count-a.count).slice(0,200)
  return json({endpoints,total:endpoints.length})
}
async function replayList(env,url){const page=Math.max(1,Number(url.searchParams.get('page')||1)),size=Math.min(100,Math.max(1,Number(url.searchParams.get('pageSize')||10))),{where,values}=replayFilters(url);const rows=await env.DB.prepare(`select session_id replayId,session_id,max(user_id) userId,max(user_name) userName,max(user_phone) userPhone,min(created_at) firstSeen,max(created_at) lastSeen,max(url) url,max(release_name) release,max(end_reason) endReason,max(user_agent) userAgent,count(*) eventCount from replays ${where} group by app_id,session_id order by lastSeen desc limit ? offset ?`).bind(...values,size,(page-1)*size).all();const total=await env.DB.prepare(`select count(*) count from (select 1 from replays ${where} group by app_id,session_id)`).bind(...values).first();return json({items:rows.results,total:Number(total.count),page,pageSize:size})}
async function alertList(env,url){
  const page=Math.max(1,Number(url.searchParams.get('page')||1)),pageSize=Math.max(1,Math.min(100,Number(url.searchParams.get('pageSize')||10)))
  const rows=await env.DB.prepare(`select a.*,
    (select count(*) from alert_deliveries d where d.alert_id=a.id) delivery_total,
    (select count(*) from alert_deliveries d where d.alert_id=a.id and d.status='sent') delivery_sent,
    (select count(*) from alert_deliveries d where d.alert_id=a.id and d.status in ('failed','dead')) delivery_failed,
    (select count(*) from alert_deliveries d where d.alert_id=a.id and d.status in ('pending','sending')) delivery_pending
    from alert_history a order by created_at desc limit ? offset ?`).bind(pageSize,(page-1)*pageSize).all()
  const total=await env.DB.prepare('select count(*) count from alert_history').first()
  return json({items:rows.results.map(mapAlert),total:Number(total.count),page,pageSize})
}
async function alertPatch(env,id,input){
  const now=Date.now(),sets=['status=?'],vals=[clip(input.status||'acknowledged',32)]
  if(input.status==='resolved'){sets.push('resolved_at=?');vals.push(now)}
  await env.DB.prepare(`update alert_history set ${sets.join(',')} where id=?`).bind(...vals,id).run()
  return json({ok:true})
}
// D2 FR-7：登录态（via=session 且有 teamId）时按团队过滤应用（team_id 为 null 的存量应用全员可见）；
// api_key/system 与匿名（accounts=false）看全部，对齐 Node governance.listApplications 语义。
async function applicationList(env,url,auth){const teamScoped=auth?.via==='session'&&auth.teamId,teamWhere=teamScoped?'where (a.team_id is null or a.team_id=?)':'',teamVals=teamScoped?[auth.teamId]:[];const select=`select a.app_id,a.name,a.platform,a.owner,a.enabled,a.sample_rate,a.replay_sample_rate,a.rules_json,a.team_id,a.created_at,a.updated_at,(a.collect_key_hash is not null) collect_key_enabled,coalesce(rc.release_count,0) release_count from applications a left join (select app_id,count(*) release_count from releases group by app_id) rc on rc.app_id=a.app_id ${teamWhere} order by a.updated_at desc`;if(!url.searchParams.has('page')&&!url.searchParams.has('pageSize'))return json((await env.DB.prepare(select).bind(...teamVals).all()).results.map(mapApplication));const page=Math.max(1,Number(url.searchParams.get('page')||1)),pageSize=Math.min(100,Math.max(1,Number(url.searchParams.get('pageSize')||10))),[rows,total]=await Promise.all([env.DB.prepare(`${select} limit ? offset ?`).bind(...teamVals,pageSize,(page-1)*pageSize).all(),env.DB.prepare(`select count(*) count from applications a ${teamWhere}`).bind(...teamVals).first()]);return json({items:rows.results.map(mapApplication),total:Number(total.count),page,pageSize})}
async function releaseList(env,appId,url){const page=Math.max(1,Number(url.searchParams.get('page')||1)),pageSize=Math.min(100,Math.max(1,Number(url.searchParams.get('pageSize')||10))),[rows,total]=await Promise.all([env.DB.prepare('select * from releases where app_id=? order by created_at desc limit ? offset ?').bind(appId,pageSize,(page-1)*pageSize).all(),env.DB.prepare('select count(*) count from releases where app_id=?').bind(appId).first()]);return json({items:rows.results,total:Number(total.count),page,pageSize})}
async function replayEvents(env,id){
  if(!id?.trim())return json({events:[]});
  // 回放按会话分段存储，仅首段含全量快照；若只按点击的分段 session_id 读取，缺全量快照
  // 会导致 rrweb 渲染空白 iframe。故先用传入 id 定位该段并取其 base_session_id，再按
  // base_session_id 拉取整段会话的所有分段（首段全量快照在前），保证可正常重建页面。
  // 传入 id 既可能是分段 session_id（列表点击），也可能是事件会话 UUID（总览/分析页跳转）。
  const hit=await env.DB.prepare('select session_id,base_session_id from replays where session_id=? limit 1').bind(id).first();
  const baseId=hit?.base_session_id||id;
  let rows=(await env.DB.prepare('select session_id,events_json from replays where base_session_id=? order by created_at,id').bind(baseId).all()).results;
  if(!rows.length)rows=(await env.DB.prepare('select session_id,events_json from replays where session_id=? order by created_at,id').bind(id).all()).results;
  // 闲置切分兼容：SDK 无交互超时会轮换 base 会话键（`{sessionId}_r{n}`），事件会话 UUID
  // 深链时精确匹配不到——以前缀匹配兑底。护栏 limit 5000 防退化数据打爆单查询。
  if(!rows.length)rows=(await env.DB.prepare('select session_id,events_json from replays where base_session_id like ? order by created_at,id limit 5000').bind(baseId+'_%').all()).results;
  // 合并规则改为「按录制实例锚定」，根治长会话播放中途空白：
  // 同一 base_session_id 下可能混有多个 rrweb 录制实例（多次页面加载 / 多次 startReplay），
  // 而 rrweb 的 node id 空间是按录制实例独立的。若像旧实现那样把「上一段的全量快照」借用
  // 塞进另一实例的增量流，rrweb 重建镜像树时 node id 对不上，整条时间线崩坏 → 播放窗口空白。
  // 新规则：
  //   ① 按插入顺序（created_at,id，即录制顺序）逐行扫描；段号变化视为切换录制实例，重置锚点；
  //   ② 每个实例只从「它自己的」首个全量快照（type:2）开始输出，快照之前的增量一律丢弃；
  //   ③ 实例若完全没有自己的全量快照，整段丢弃——不借用他段快照（借用只会让画面更糟）；
  //   ④ 同实例的后续批次原样续接（含 rrweb checkout 周期快照），保持 node id 连续。
  // 传入 id 既可能是分段 session_id（列表点击），也可能是事件会话 UUID（总览/分析页跳转）。
  const merged=[];
  let segId=null,anchored=false;
  for(const row of rows){
    const evs=parse(row.events_json,[]);
    if(!Array.isArray(evs)||!evs.length)continue;
    if(row.session_id!==segId){segId=row.session_id;anchored=false}
    const snapIdx=evs.findIndex(e=>e&&e.type===2);
    if(!anchored){
      if(snapIdx<0)continue;                       // 该实例尚无自身全量快照：丢弃，等待同实例后续批次
      // 保留紧邻全量快照之前的 Meta（type:4）——它携带 viewport 尺寸 / href，属同一实例，
      // 是 rrweb 事件流的规范开头（Meta → FullSnapshot）。只裁掉快照之前的增量（type:3）。
      let start=snapIdx;
      if(start>0&&evs[start-1]&&evs[start-1].type===4)start--;
      for(let i=start;i<evs.length;i++)merged.push(evs[i]);
      anchored=true;
    }else{
      for(const e of evs)merged.push(e);           // 同实例续接
    }
  }
  // 无任何可用全量快照 → 返回空事件，让前端「缺少全量快照」提示生效，而不是静默黑屏。
  if(!merged.length||!merged.some(e=>e&&e.type===2))return json({events:[],truncated:false});
  // 回放时长截断（线上实测踩坑）：标签页常开 + 无闲置切分的旧 SDK 会把十几个小时的
  // 分段串成一个 base 会话（1044 分钟里 883 分钟纯空白），播放器时间轴全部浪费在空转上。
  // 超过 30 分钟跨度时截取最近 30 分钟：截断点后移到首个全量快照（含其紧邻 Meta），
  // 保证输出流仍以可重建的快照开头；窗口内找不到快照则不截断（宁可超长也不黑屏）。
  const REPLAY_SPAN_LIMIT_MS=30*60*1000;
  const originalSpanMs=merged[merged.length-1].timestamp-merged[0].timestamp;
  let out=merged,truncated=false;
  if(originalSpanMs>REPLAY_SPAN_LIMIT_MS){
    const cutoff=merged[merged.length-1].timestamp-REPLAY_SPAN_LIMIT_MS;
    let start=merged.findIndex(e=>e.timestamp>=cutoff);
    if(start<0)start=0;
    let snapIdx=-1;
    for(let i=start;i<merged.length;i++){if(merged[i]&&merged[i].type===2){snapIdx=i;break}}
    if(snapIdx>start||(snapIdx===start&&start>0)){
      if(snapIdx>0&&merged[snapIdx-1]&&merged[snapIdx-1].type===4)snapIdx--;
      out=merged.slice(snapIdx);truncated=true;
    }
  }
  return json({events:out,truncated,originalSpanMs,spanMs:out[out.length-1].timestamp-out[0].timestamp})
}
async function traces(env,url){const page=Math.max(1,Number(url.searchParams.get('page')||1)),pageSize=Math.min(100,Math.max(1,Number(url.searchParams.get('pageSize')||10))),{where,values}=filters(url,null,["trace_id<>''"]);
  // BUG-006 修复：快照类 perf 指标（memory 字节 / *_rate 比率 / redirect_count 次数）是周期监控采样，
  // 不是链路节点。此前页面挂机数小时时每 60s 一条 memory 事件把「总耗时」拖到 328 分钟、span 数虚高，
  // 掩盖真实调用耗时；现在起止时间与 span 计数均排除快照类（与 buildDistributedTrace 口径一致）。
  const spanEv="not(type='perf' and(metric='memory' or substr(metric,-5)='_rate' or metric='redirect_count'))";
  const[rows,total]=await Promise.all([env.DB.prepare(`select trace_id,min(case when ${spanEv} then ts end) started_at,max(case when ${spanEv} then ts end) ended_at,sum(case when ${spanEv} then 1 else 0 end) span_count,sum(case when type='error' or json_extract(props_json,'$.status')>=400 then 1 else 0 end) error_count,max(app_id) app_id,max(release_name) release_name,max(url) url from events ${where} group by trace_id order by started_at desc limit ? offset ?`).bind(...values,pageSize,(page-1)*pageSize).all(),env.DB.prepare(`select count(*) count from (select 1 from events ${where} group by trace_id)`).bind(...values).first()]);return json({items:rows.results.map(r=>({...r,duration:r.ended_at-r.started_at})),total:Number(total.count),page,pageSize})}
async function traceEvents(env,id,url){const page=Math.max(1,Number(url.searchParams.get('page')||1)),pageSize=Math.min(100,Math.max(1,Number(url.searchParams.get('pageSize')||10)));if(!id?.trim())return json({items:[],total:0,page,pageSize});const[rows,total]=await Promise.all([env.DB.prepare('select * from events where trace_id=? order by ts limit ? offset ?').bind(id,pageSize,(page-1)*pageSize).all(),env.DB.prepare('select count(*) count from events where trace_id=?').bind(id).first()]);return json({items:rows.results.map(mapEvent),total:Number(total.count),page,pageSize})}
async function distributedTrace(env,id){if(!id?.trim())return json({root:null,nodes:[],edges:[],criticalPath:[],errorSpans:[]});const[events,backendSpans]=await Promise.all([env.DB.prepare('select * from events where trace_id=? order by ts').bind(id).all(),env.DB.prepare('select * from spans where trace_id=? order by start_ts').bind(id).all().catch(()=>({results:[]}))]);return json(buildDistributedTrace(events.results||[],backendSpans.results||[]))}

// BUG-013 修复：topology-plan F1 —— GET /api/traces/:traceId/topology（调用拓扑，页面节点 → API 节点）。
// 归并逻辑对齐文档 §4.1：① 根节点取 trace 的 url/path（page:<path>）；② fetch/xhr 按
// method + host + 归一化 path（去 query）归并为 api:<METHOD host/path>；③ 边 page → api 聚合
// calls / avgDuration（均值 value）/ errors（status≥400 或 network_error 或 failed）。
// 产出与前端 buildTopologyFromDistributed 兜底路径同构的 {nodes, edges}。
async function traceTopology(env,id){
  if(!id?.trim())return json({nodes:[],edges:[]})
  const events=await env.DB.prepare('select * from events where trace_id=? order by ts limit 5000').bind(id).all().catch(()=>({results:[]}))
  const evRows=events.results||[]
  if(!evRows.length)return json({nodes:[],edges:[]})
  const pageEvent=evRows.find(e=>e.path||e.url)
  const pagePath=String((pageEvent?.path||pageEvent?.url||'unknown')).split('?')[0]
  const pageId=`page:${pagePath}`
  const nodes=new Map([[pageId,{id:pageId,label:pagePath,type:'page',value:1,p95:0,errors:0}]])
  const edges=new Map()
  const normalizeApiPath=raw=>{
    const url=String(raw||'')
    if(!url)return ''
    if(url.startsWith('/'))return url.split('?')[0]
    try{const u=new URL(url);return `${u.host}${u.pathname}`}catch{return url.split('?')[0]}
  }
  for(const row of evRows){
    if(row.type!=='perf'||!['fetch','xhr'].includes(String(row.metric||'')))continue
    const props=parse(row.props_json,{})
    const url=String(props.url||row.name||'')
    if(!url)continue
    const method=String(props.method||'GET').toUpperCase()
    const label=`${method} ${normalizeApiPath(url)}`
    const apiId=`api:${label}`
    const failed=Number(props.status)>=400||props.failed===true||props.failed==='true'||String(props.statusClass||'').includes('error')
    if(!nodes.has(apiId))nodes.set(apiId,{id:apiId,label,type:'api',value:0,p95:0,errors:0})
    const node=nodes.get(apiId)
    node.value++;node.p95=Math.max(node.p95,Math.round(Number(row.value)||0));if(failed)node.errors++
    const edge=edges.get(apiId)||{source:pageId,target:apiId,calls:0,avgDuration:0,errors:0}
    edge.calls++
    edge.avgDuration=Math.round((edge.avgDuration*(edge.calls-1)+(Number(row.value)||0))/edge.calls)
    if(failed)edge.errors++
    edges.set(apiId,edge)
  }
  return json({nodes:[...nodes.values()],edges:[...edges.values()]})
}
export { buildDistributedTrace }
async function sessions(env,url){const page=Math.max(1,Number(url.searchParams.get('page')||1)),pageSize=Math.min(100,Math.max(1,Number(url.searchParams.get('pageSize')||10))),{where,values}=filters(url,null,["session_id<>''"]),[rows,total]=await Promise.all([env.DB.prepare(`select session_id,max(user_id) user_id,max(user_name) user_name,max(device_id) device_id,min(ts) started_at,max(ts) ended_at,count(*) event_count,sum(case when type='error' then 1 else 0 end) error_count,group_concat(distinct path) paths from events ${where} group by session_id order by ended_at desc limit ? offset ?`).bind(...values,pageSize,(page-1)*pageSize).all(),env.DB.prepare(`select count(*) count from (select 1 from events ${where} group by session_id)`).bind(...values).first()]),replayIds=(await env.DB.prepare('select distinct session_id from replays').all()).results;return json({items:rows.results.map(r=>({...r,duration:r.ended_at-r.started_at,paths:(r.paths||'').split(',').filter(Boolean),replaySessionId:replayIds.find(x=>x.session_id.startsWith(r.session_id))?.session_id})),total:Number(total.count),page,pageSize})}
async function sessionEvents(env,id,url){const page=Math.max(1,Number(url.searchParams.get('page')||1)),pageSize=Math.min(100,Math.max(1,Number(url.searchParams.get('pageSize')||10)));if(!id?.trim())return json({items:[],total:0,page,pageSize});const[rows,total]=await Promise.all([env.DB.prepare('select * from events where session_id=? order by ts limit ? offset ?').bind(id,pageSize,(page-1)*pageSize).all(),env.DB.prepare('select count(*) count from events where session_id=?').bind(id).first()]);return json({items:rows.results.map(mapEvent),total:Number(total.count),page,pageSize})}
async function paths(env,url){const {where,values}=filters(url,'behavior',[`name in ('pv','pushState','replaceState','popstate','hashchange')`]);const rows=(await env.DB.prepare(`select session_id,path,ts,user_id,user_name from events ${where} order by session_id,ts limit 20000`).bind(...values).all()).results;const grouped=group(rows,r=>r.session_id),counts={};for(const events of Object.values(grouped)){const value=events.map(e=>e.path).filter((v,i,a)=>v&&v!==a[i-1]).slice(0,8).join(' → ');if(value){const existing=counts[value]||{path:value,count:0,users:[]};existing.count++;const userId=events[0]?.user_id?.trim(),userName=events[0]?.user_name?.trim();if(userId&&!existing.users.find(u=>u.id===userId))existing.users.push({id:userId,name:userName||userId});counts[value]=existing}}return json(Object.entries(counts).map(([,v])=>({path:v.path,count:v.count,users:v.users})).sort((a,b)=>b.count-a.count).slice(0,50))}
async function clickPaths(env,url){const {where,values}=filters(url,'behavior',["name='click'"]);const rows=(await env.DB.prepare(`select session_id,ts,path,props_json from events ${where} order by session_id,ts limit 20000`).bind(...values).all()).results;const grouped=group(rows,r=>r.session_id||'');const nodeMap=new Map(),edgeMap=new Map();for(const events of Object.values(grouped)){const clicks=events.map(e=>{const props=parse(e.props_json,{});const label=props.elementLabel||props.label||props.text||props.ariaLabel||props.title||props.tag||'';return{id:`${label||props.tag||'node'}@${e.path||props.path||''}`,label:label||props.tag||'unknown',path:e.path||props.path||''}}).filter(c=>c.label&&c.label!=='unknown');for(const c of clicks){if(!nodeMap.has(c.id))nodeMap.set(c.id,{id:c.id,label:c.label,type:'click',value:0});nodeMap.get(c.id).value++}const seen=new Set();for(let i=1;i<clicks.length;i++){const from=clicks[i-1],to=clicks[i];if(!from||!to)continue;const key=`${from.id}|${to.id}`;if(!edgeMap.has(key))edgeMap.set(key,{source:from.id,target:to.id,calls:0,sessions:0});const edge=edgeMap.get(key);edge.calls++;if(!seen.has(key)){edge.sessions++;seen.add(key)}}}return json({nodes:[...nodeMap.values()],edges:[...edgeMap.values()]})}
async function live(env,url){const since=Date.now()-300000,{where,values}=filters(url,null,['ts>=?'],[since]);const row=await env.DB.prepare(`select count(distinct session_id) sessions,count(distinct coalesce(nullif(user_id,''),device_id)) users,count(*) events from events ${where}`).bind(...values).first();return json({since,...row})}
async function heatmap(env,url){const{where,values}=filters(url,null,["type='behavior'","name in ('click','scroll')"]);const rows=(await env.DB.prepare(`select ts,name,props_json,path,url from events ${where} order by ts desc limit 50000`).bind(...values).all()).results;const clickPoints=[],scrollAggregate=new Map();for(const row of rows){const props=parse(row.props_json,{});if(row.name==='click'){const x=Number(props.x),y=Number(props.y);if(Number.isFinite(x)&&Number.isFinite(y)&&x>=0&&y>=0)clickPoints.push({x,y,viewportWidth:Number(props.viewportWidth)||0,viewportHeight:Number(props.viewportHeight)||0,elementType:props.elementType||'',elementLabel:props.elementLabel||'',ts:row.ts,path:row.path||'',url:row.url||''})}if(row.name==='scroll'&&Number.isFinite(Number(props.depth))){const key=row.path||row.url||'';if(key){const existing=scrollAggregate.get(key)||{path:key,count:0,totalDepth:0,maxDepth:0,scrollEvents:0};existing.count++;existing.totalDepth+=Number(props.depth)||0;existing.maxDepth=Math.max(existing.maxDepth,Number(props.maxDepth)||0);existing.scrollEvents++;scrollAggregate.set(key,existing)}}}return json({clickPoints:clickPoints.slice(0,10000),scrollData:[],scrollAggregate:[...scrollAggregate.values()].sort((a,b)=>b.count-a.count).slice(0,50)})}
async function releasesReport(env,url){const appId=url.searchParams.get('appId'),release=url.searchParams.get('release'),startTime=url.searchParams.get('startTime'),endTime=url.searchParams.get('endTime');let sql='select r.app_id,r.release_name release,r.status,r.created_at,count(e.id) events,sum(case when e.type=\'error\' then 1 else 0 end) errors,count(distinct coalesce(nullif(e.user_id,\'\'),e.device_id)) users,round(avg(case when e.type=\'perf\' and e.metric=\'lcp\' then e.value end),2) lcp from releases r left join events e on e.app_id=r.app_id and e.release_name=r.release_name';const params=[];if(startTime){sql+=' and e.ts>=?';params.push(Number(startTime))}if(endTime){sql+=' and e.ts<=?';params.push(Number(endTime))}const where=[];if(appId){where.push('r.app_id=?');params.push(appId)}if(release){where.push('r.release_name=?');params.push(release)}sql+=where.length?` where ${where.join(' and ')}`:' where 1=1';sql+=' group by r.app_id,r.release_name,r.status,r.created_at order by r.created_at desc limit 20';return json((await env.DB.prepare(sql).bind(...params).all()).results)}
async function funnelEventNames(env,url){const scoped=new URL(url);scoped.searchParams.delete('type');scoped.searchParams.delete('name');const{where,values}=filters(scoped,null,["type in ('behavior','track')","name<>''"]);return json((await env.DB.prepare(`select name,count(*) count from events ${where} group by name order by count desc,name limit 100`).bind(...values).all()).results)}
async function funnelList(env,url){const page=Math.max(1,Number(url.searchParams.get('page')||1)),pageSize=Math.min(100,Math.max(1,Number(url.searchParams.get('pageSize')||10))),[rows,total]=await Promise.all([env.DB.prepare('select * from funnel_definitions order by updated_at desc limit ? offset ?').bind(pageSize,(page-1)*pageSize).all(),env.DB.prepare('select count(*) count from funnel_definitions').first()]);return json({items:rows.results.map(row=>({...row,steps_json:parse(row.steps_json,[])})),total:Number(total.count),page,pageSize})}

async function saveApplication(env,id,input){const now=Date.now(),rules={allowedOrigins:strings(input.rules?.allowedOrigins),blockedTypes:strings(input.rules?.blockedTypes),blockedNames:strings(input.rules?.blockedNames)};await env.DB.prepare(`insert into applications(app_id,name,platform,owner,enabled,sample_rate,replay_sample_rate,rules_json,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?) on conflict(app_id) do update set name=excluded.name,platform=excluded.platform,owner=excluded.owner,enabled=excluded.enabled,sample_rate=excluded.sample_rate,replay_sample_rate=excluded.replay_sample_rate,rules_json=excluded.rules_json,updated_at=excluded.updated_at`).bind(id,clip(input.name||id,128),clip(input.platform||'web',32),clip(input.owner||'',128),input.enabled===false?0:1,rate(input.sampleRate),rate(input.replaySampleRate),JSON.stringify(rules),now,now).run();return json({appId:id})}
async function rotateKey(env,id){const key=`eys_${random(24)}`;await env.DB.prepare('update applications set collect_key_hash=?,updated_at=? where app_id=?').bind(await sha256(key),Date.now(),id).run();return json({appId:id,collectKey:key})}
async function saveRelease(env,appId,release,input){await env.DB.prepare(`insert into releases(app_id,release_name,status,created_at) values(?,?,?,?) on conflict(app_id,release_name) do update set status=excluded.status`).bind(appId,release,clip(input.status||'active',32),Date.now()).run();return json({appId,release})}
async function settings(env){const row=await env.DB.prepare('select config_json from settings where id=1').first();return {...defaultSettings,...parse(row?.config_json,{}) ,retention:{...defaultSettings.retention,...parse(row?.config_json,{}).retention},alerts:{...defaultSettings.alerts,...parse(row?.config_json,{}).alerts}}}
async function saveSettings(env,input){const existing=parse((await env.DB.prepare('select config_json from settings where id=1').first())?.config_json,{});const value={...existing,retention:{...defaultSettings.retention,...input.retention},alerts:{...defaultSettings.alerts,...input.alerts}};await env.DB.prepare(`insert into settings(id,config_json,updated_at) values(1,?,?) on conflict(id) do update set config_json=excluded.config_json,updated_at=excluded.updated_at`).bind(JSON.stringify(value),Date.now()).run();return json({retention:value.retention,alerts:value.alerts})}
async function saveSourceMap(env,input){const appId=clip(input.appId||'default',64),release=clip(input.release||'unknown',64),file=String(input.file||input.map?.file||'app.js').split('/').at(-1);await env.DB.prepare(`insert into sourcemaps(app_id,release_name,file_name,map_json,created_at) values(?,?,?,?,?) on conflict(app_id,release_name,file_name) do update set map_json=excluded.map_json,created_at=excluded.created_at`).bind(appId,release,file,JSON.stringify(input.map),Date.now()).run();return json({appId,release,file})}
async function resolveSourceMap(env,event){const match=[...String(event.stack||'').matchAll(/((?:https?:\/\/|\/)[^():\s]+):(\d+):(\d+)/g)].find(item=>!/web-collection-sdk(?:\.[\w-]+)?\.js/i.test(item[1])),source=event.props?.line?event.props.source:match?.[1],line=Number(event.props?.line||match?.[2]),column=Number(event.props?.column||match?.[3]||0);if(!source||!line)return null;const row=await env.DB.prepare('select map_json from sourcemaps where app_id=? and release_name=? and file_name=?').bind(event.appId,event.release,source.split('/').at(-1)).first();if(!row)return null;const consumer=new SourceMapConsumer(parse(row.map_json,{})),pos=consumer.originalPositionFor({line,column});consumer.destroy?.();return pos?.source?{generatedFile:source,generatedLine:line,generatedColumn:column,source:pos.source,line:pos.line,column:pos.column,name:pos.name}:null}
async function saveFunnel(env,input){const steps=strings(input.steps).slice(0,10);if(!input.name||steps.length<2)throw new Error('漏斗名称和至少两个步骤不能为空');const now=Date.now();const windowMs=input.windowMs>0?Math.floor(Number(input.windowMs)):null;const result=await env.DB.prepare('insert into funnel_definitions(name,app_id,steps_json,window_ms,created_at,updated_at) values(?,?,?,?,?,?)').bind(clip(input.name,128),input.appId||null,JSON.stringify(steps),windowMs,now,now).run();return json({id:result.meta.last_row_id})}
async function runFunnel(env,id,url){const def=await env.DB.prepare('select * from funnel_definitions where id=?').bind(id).first();if(!def)throw new Error('漏斗不存在');const scoped=new URL(url);if(def.app_id&&!scoped.searchParams.get('appId'))scoped.searchParams.set('appId',def.app_id);const steps=parse(def.steps_json,[]),windowMs=def.window_ms?Number(def.window_ms):null,{where,values}=filters(scoped);const rows=(await env.DB.prepare(`select session_id,coalesce(nullif(user_id,''),device_id,session_id) actor,name,type,ts,release_name,case when user_agent like '%Edg/%' then 'Edge' when user_agent like '%Chrome/%' then 'Chrome' when user_agent like '%Firefox/%' then 'Firefox' when user_agent like '%Safari/%' then 'Safari' else 'Other' end browser,case when user_agent like '%Mobile%' then 'Mobile' else 'Desktop' end device from events ${where} ${where?'and':'where'} (name in (${steps.map(()=>'?').join(',')}) or type='error') order by ts limit 50000`).bind(...values,...steps).all()).results,actors=Object.values(group(rows,r=>r.actor)),matched=actors.map(a=>matchSteps(a,steps,windowMs)),counts=steps.map((_,i)=>matched.filter(m=>m[i]!=null).length),ttcByStep=steps.map(()=>[]);matched.forEach(m=>{for(let i=1;i<m.length;i++)if(m[i]!=null&&m[i-1]!=null)ttcByStep[i].push(m[i]-m[i-1])});const median=v=>{if(!v.length)return null;const s=[...v].sort((a,b)=>a-b),m=s.length>>1;return s.length%2?s[m]:Math.round((s[m-1]+s[m])/2)};const p90=v=>{if(!v.length)return null;const s=[...v].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.max(0,Math.ceil(0.9*s.length)-1))]};const replayIds=(await env.DB.prepare('select distinct session_id, base_session_id from replays').all()).results;const lostSessions=actors.filter(a=>reaches(a,steps,0,windowMs)&&!reaches(a,steps,steps.length-1,windowMs)).slice(0,100).map(a=>({sessionId:a[0].session_id,actor:a[0].actor,lastEvent:a.filter(x=>x.type!=='error').at(-1)?.name,errors:a.filter(x=>x.type==='error').length,replaySessionId:replayIds.find(x=>x.base_session_id===a[0].session_id)?.session_id}));return json({definition:def,steps:steps.map((step,i)=>({step,count:counts[i],rate:counts[0]?Number((counts[i]/counts[0]*100).toFixed(2)):0,stepRate:i?counts[i-1]?Number((counts[i]/counts[i-1]*100).toFixed(2)):0:100,lost:i?counts[i-1]-counts[i]:0,timeToConvert:i?median(ttcByStep[i]):null,timeToConvertP90:i?p90(ttcByStep[i]):null})),lostSessions,dimensions:['release_name','browser','device'].map(field=>({field,items:dimensions(rows,steps,field,windowMs)})),trend:dimensions(rows,steps,'day',windowMs),windowMs})}
async function saveDashboard(env,input){if(!input.name)throw new Error('仪表盘名称不能为空');const now=Date.now();const widgets=Array.isArray(input.widgets)?input.widgets.slice(0,12).map(item=>{if(typeof item==='string')return item.trim().slice(0,64);const type=item&&item.type==='funnel'?'funnel':item&&item.type==='insight'?'insight':'';const id=Number(item&&item.id);return type&&Number.isInteger(id)&&id>0?{type,id}:null}).filter(Boolean):[];const result=await env.DB.prepare('insert into dashboards(name,widgets_json,created_at,updated_at) values(?,?,?,?)').bind(clip(input.name,128),JSON.stringify(widgets),now,now).run();return json({id:result.meta.last_row_id})}
// A2 · 自定义看板分享：生成唯一分享 token 并标记 shared=1；幂等（重生成令旧链接失效）。
async function shareDashboard(env, id) {
  const token = crypto.randomUUID()
  await env.DB.prepare('update dashboards set shared=1, share_token=? where id=?').bind(token, Number(id)).run()
  const row = await env.DB.prepare('select id, name, widgets_json from dashboards where id=?').bind(Number(id)).first()
  if (!row) return new Response('not found', { status: 404 })
  return json({ id: Number(row.id), shared: true, shareToken: token })
}
// A2 · 自定义看板分享：取消分享，清除 token 使旧链接立即失效。
async function unshareDashboard(env, id) {
  await env.DB.prepare('update dashboards set shared=0, share_token=null where id=?').bind(Number(id)).run()
  return json({ id: Number(id), shared: false })
}
// A2 · 自定义看板分享：公开只读端点（免鉴权，已在 fetch 分发中先于 adminApi 匹配）。
// 命中不到（shared=0 或 token 不匹配）一律 404，不暴露是否存在，防枚举。
async function publicDashboard(request, env, url) {
  const token = decodeURIComponent(url.pathname.split('/').pop())
  const row = await env.DB.prepare('select id, name, widgets_json from dashboards where shared=1 and share_token=?').bind(token).first()
  if (!row) return new Response('not found', { status: 404 })
  return json({ id: Number(row.id), name: row.name, widgets_json: parse(row.widgets_json, []) })
}
// A2 · 嵌入壳：/embed/* 经 worker 取 SPA 资源并补 CORS 头，供跨域宿主 iframe 嵌入与探测。
// 嵌入安全：不设置 X-Frame-Options: DENY；如需限制宿主域，后续在此补 CSP frame-ancestors 白名单。
async function embedShell(request, env) {
  const res = await env.ASSETS.fetch(request)
  const headers = new Headers(res.headers)
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('Vary', 'Origin')
  return new Response(res.body, { status: res.status, headers })
}

// ==================== D2 · 账号/团队/RBAC（镜像 apps/api auth-service / session-service / team-service） ====================
// 行为契约与 Node 参考实现字段/语义一致（错误文案、不变量、审计 action 命名）；差异仅在：
// ① D1 写法 prepare().bind().run()；② 时间戳用 Date.now() 数字；③ 错误以 Response(json,status) 返回而非 throw。
// 共享真相源 packages/auth-crypto.js / packages/rbac.js 直接 import 复用，不复制逻辑。

const ACCESS_TTL_SEC = 2 * 60 * 60                    // 访问令牌 ≤2h（PRD FR-2）
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000         // 邀请 7 天过期（FR-14）
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000        // 刷新令牌/会话 7 天
const REFRESH_COOKIE = 'eys_rt'                       // 与 Node REFRESH_COOKIE 同名同路径

/** 运行时开关（默认 false，存量自托管零破坏；开启需 ACCOUNTS_ENABLED=1） */
function accountsEnabled(env) { return env.ACCOUNTS_ENABLED === '1' || env.ACCOUNTS_ENABLED === 'true' }
/** 严格鉴权开关：true 时未登录访问受控管理接口返回 401 */
function accountsEnforced(env) { return env.ACCOUNTS_ENFORCE === '1' || env.ACCOUNTS_ENFORCE === 'true' }
/** 开放注册开关（默认关闭，邀请制 + 首个 Owner 引导，PRD D1） */
function openRegisterEnabled(env) { return env.ACCOUNTS_OPEN_REGISTER === '1' || env.ACCOUNTS_OPEN_REGISTER === 'true' }

function jwtSecretOf(env) {
  const secret = env.ACCOUNTS_JWT_SECRET
  if (!secret) throw new Error('账号体系已开启但缺少 ACCOUNTS_JWT_SECRET 环境变量')
  return secret
}

/** 免鉴权前缀（采集/健康/公开端点 + D2 公开端点，对齐 Node auth-middleware AUTH_PUBLIC_PREFIXES）
 *  /api/brand：PRD 16 D6 公开端点（登录页未登录也需读取白标，GET only；PUT/reset 在处理器内自行把关）。 */
const AUTH_PUBLIC_PREFIXES = ['/api/collect', '/api/auth/login', '/api/auth/register', '/api/auth/refresh', '/api/dashboards/shared/', '/api/capabilities', '/api/invitations/', '/api/brand']
function requiresAuthPath(path) {
  if (!path.startsWith('/api/')) return false
  return !AUTH_PUBLIC_PREFIXES.some(prefix => path.startsWith(prefix))
}

// 登录失败限流：5 次 / 15 分钟 / 邮箱+IP（FR-16）。Worker 单 isolate 内存实现：
// 冷启动/多实例后计数重置，作为基础暴力破解防护可接受；强一致限流需外置 KV/DO（与 Node 侧进程内实现同语义）。
const loginAttemptsW = new Map()
function checkLoginRateW(key) {
  const now = Date.now(), windowMs = 15 * 60 * 1000, entry = loginAttemptsW.get(key)
  if (!entry || now - entry.start > windowMs) { loginAttemptsW.set(key, { start: now, count: 1 }); return true }
  entry.count += 1
  return entry.count <= 5
}
function recordLoginFailureW(key) { checkLoginRateW(key) }

/** D1 查询助手：单行 / 多行（失败兜底空数组，与 worker 现有容错风格一致） */
async function q1(env, sql, vals = []) { return env.DB.prepare(sql).bind(...vals).first() }
async function qm(env, sql, vals = []) { return ((await env.DB.prepare(sql).bind(...vals).all().catch(() => ({ results: [] }))).results) || [] }

/** 恒时比较（哈希后定长 hex 逐位异或；workerd 无 node:timingSafeEqual 直用限制，哈希比较即可） */
function safeEqualHex(a, b) {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function readBearer(header) {
  const match = /^Bearer\s+(.+)$/i.exec(String(header || '').trim())
  return match ? match[1].trim() : null
}

function readCookie(request, name) {
  const header = request.headers.get('cookie') || ''
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return null
}

/** 输入校验（返回错误文案或 null，避免 throw 丢失状态码） */
function emailIssue(value) {
  const email = String(value || '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '邮箱格式不正确'
  return null
}
function passwordIssue(value) {
  const password = String(value || '')
  if (password.length < 8) return '口令至少 8 位'
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return '口令需同时包含字母与数字'
  return null
}
function slugifyW(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'team'
}

/**
 * 身份解析（对齐 apps/api/src/auth-middleware.js resolveAuth）：
 * ① Bearer JWT → verifyJwt({sub,sid}) → sessions（未撤销/未过期）→ users（active）→
 *    teamId 取 x-team-id 头（校验成员资格），否则取首个 active team_members 行；
 * ② x-api-key 恒时匹配 ADMIN_API_KEY（且 ALLOW_ADMIN_API_KEY≠'false'）→ 虚拟主体 system（owner/L4）；
 * ③ 否则 null。accountsEnabled=false 直接 null（不查库，存量零开销）。
 */
async function resolveAuth(request, env) {
  if (!accountsEnabled(env)) return null
  const bearer = readBearer(request.headers.get('authorization'))
  if (bearer) {
    const payload = verifyJwt(bearer, jwtSecretOf(env))
    if (payload?.sub && payload.sid) {
      const session = await q1(env, 'select * from sessions where id=?', [String(payload.sid).slice(0, 32)])
      if (session && !session.revoked_at && Number(session.expires_at) >= Date.now()) {
        const user = await q1(env, 'select id,email,status from users where id=? and status=?', [payload.sub, 'active'])
        if (user) {
          const requestedTeamId = clip(request.headers.get('x-team-id') || '', 32) || null
          let membership = null
          if (requestedTeamId) {
            membership = await q1(env, `select m.team_id,m.role,m.access_level from team_members m
              where m.team_id=? and m.user_id=? and m.status='active'`, [requestedTeamId, user.id])
          }
          if (!membership) {
            membership = await q1(env, `select m.team_id,m.role,m.access_level from team_members m
              where m.user_id=? and m.status='active' order by m.created_at limit 1`, [user.id])
          }
          return {
            userId: user.id, email: user.email,
            teamId: membership?.team_id || null, role: membership?.role || null,
            level: membership ? normalizeLevel(membership.access_level) : null,
            via: 'session', sessionId: session.id
          }
        }
      }
    }
    return null
  }
  // 兼容期：ADMIN_API_KEY → 虚拟主体 system（owner/L4），M-b 默认关闭（PRD D2）
  const adminKey = request.headers.get('x-api-key') || ''
  const expected = env.ADMIN_API_KEY || ''
  if (expected && adminKey && env.ALLOW_ADMIN_API_KEY !== 'false' && safeEqualHex(sha256Hex(adminKey), sha256Hex(expected))) {
    return { userId: 'system', email: null, teamId: null, role: 'owner', level: 'L4', via: 'api_key', sessionId: null }
  }
  return null
}

/** 团队审计写入（audit_logs；detail_json 存文本 JSON；失败 try/catch 不阻塞业务） */
async function writeTeamAuditW(env, { teamId, actorUserId, actorEmail, action, targetType, targetId, detail, ip, userAgent }) {
  try {
    await env.DB.prepare(`insert into audit_logs (team_id,actor_user_id,actor_email,action,target_type,target_id,detail_json,ip,user_agent,created_at)
      values (?,?,?,?,?,?,?,?,?,?)`)
      .bind(teamId || null, actorUserId || null, actorEmail || null, String(action).slice(0, 32),
        targetType || null, targetId ? String(targetId).slice(0, 64) : null,
        JSON.stringify(detail || {}), clip(ip, 64) || null, clip(userAgent, 255) || null, Date.now()).run()
  } catch { /* 审计失败不阻塞业务响应 */ }
}

/** 会话创建：refreshToken 仅本次可见，库内只存 sha256 哈希（D8 可撤销） */
async function createSessionW(env, userId, { ip, userAgent, ttlMs = SESSION_TTL_MS } = {}) {
  const id = randomToken(12), refreshToken = randomToken(32), now = Date.now()
  await env.DB.prepare(`insert into sessions (id,user_id,token_hash,expires_at,ip,user_agent,created_at) values (?,?,?,?,?,?,?)`)
    .bind(id, userId, sha256Hex(refreshToken), now + ttlMs, clip(ip, 64) || null, clip(userAgent, 255) || null, now).run()
  return { id, refreshToken, expiresAt: now + ttlMs }
}

/** 建用户 + 默认团队（首个用户 slug=default 建队并 owner/L4 引导；已存在则 member/L2 加入，对齐 Node） */
async function createUserWithDefaultTeamW(env, { email, name, password }) {
  const userId = `u_${randomToken(9)}`, now = Date.now()
  await env.DB.prepare(`insert into users (id,email,name,password_hash,status,created_at,updated_at) values (?,?,?,?,'active',?,?)`)
    .bind(userId, email, name, hashPassword(password), now, now).run()
  let teamId = null
  const hasTeam = await q1(env, 'select id from teams where slug=?', ['default'])
  if (!hasTeam) {
    teamId = `t_${randomToken(9)}`
    await env.DB.prepare(`insert into teams (id,name,slug,created_by,created_at,updated_at) values (?,?,'default',?,?,?)`)
      .bind(teamId, name || '默认团队', userId, now, now).run()
    await env.DB.prepare(`insert into team_members (team_id,user_id,role,access_level,status,joined_at,created_at,updated_at)
      values (?,?,'owner','L4','active',?,?,?)`).bind(teamId, userId, now, now, now).run()
    await writeTeamAuditW(env, { teamId, actorUserId: userId, actorEmail: email, action: 'team_update', targetType: 'team', targetId: teamId, detail: { bootstrap: true } })
  } else {
    teamId = hasTeam.id
    await env.DB.prepare(`insert into team_members (team_id,user_id,role,access_level,status,joined_at,created_at,updated_at)
      values (?,?,'member','L2','active',?,?,?)`).bind(teamId, userId, now, now, now).run()
  }
  return { userId, teamId }
}

/** 接受邀请：一次性 token（sha256 查找）、未撤销/未过期/未使用、邮箱一致（对齐 Node acceptInvitationForUser） */
async function acceptInvitationForUserW(env, token, userId, email) {
  const invitation = await q1(env, 'select * from invitations where token_hash=?', [sha256Hex(token)])
  if (!invitation || invitation.revoked_at || invitation.accepted_at || Number(invitation.expires_at) < Date.now()) return { error: '邀请无效或已过期' }
  if (String(invitation.email).toLowerCase() !== String(email).toLowerCase()) return { error: '邀请与当前账号邮箱不一致' }
  const now = Date.now()
  const exists = await q1(env, 'select 1 as ok from team_members where team_id=? and user_id=?', [invitation.team_id, userId])
  if (!exists) {
    await env.DB.prepare(`insert into team_members (team_id,user_id,role,access_level,status,joined_at,created_at,updated_at)
      values (?,?,?,?,'active',?,?,?)`).bind(invitation.team_id, userId, invitation.role, invitation.access_level, now, now, now).run()
  }
  await env.DB.prepare('update invitations set accepted_at=? where id=?').bind(now, invitation.id).run()
  await writeTeamAuditW(env, { teamId: invitation.team_id, actorUserId: userId, actorEmail: email, action: 'member_join', targetType: 'member', targetId: userId })
  return { teamId: invitation.team_id, role: invitation.role, level: invitation.access_level }
}

/** 成员资格守卫：返回成员行或 null（调用方以 memberGuard 响应 401/403） */
async function requireTeamMemberW(env, auth, teamId) {
  if (!auth?.userId) return null
  const row = await q1(env, `select m.role,m.access_level,u.email from team_members m
    left join users u on u.id=m.user_id
    where m.team_id=? and m.user_id=? and m.status='active'`, [teamId, auth.userId])
  return row ? { ...row, email: row.email || auth.email || null } : null
}
function memberGuard(auth) {
  return json({ error: auth?.userId ? '非本团队成员' : '账号体系未开启或未登录' }, auth?.userId ? 403 : 401)
}
async function getMemberRowW(env, teamId, userId) {
  return q1(env, `select m.user_id,m.role,m.access_level,u.email from team_members m
    left join users u on u.id=m.user_id where m.team_id=? and m.user_id=?`, [teamId, String(userId).slice(0, 32)])
}

// ---------- 认证端点 ----------

/** POST /api/auth/register：空库首个注册=引导 Owner（恒允许）；否则需开放注册开关或邀请令牌 */
async function authRegister(request, env) {
  if (!accountsEnabled(env)) return json({ error: '账号体系未开启（需设置 ACCOUNTS_ENABLED=1）' }, 503)
  const input = await request.json().catch(() => ({}))
  const emailIssueMsg = emailIssue(input.email)
  if (emailIssueMsg) return json({ error: emailIssueMsg }, 400)
  const email = String(input.email).trim().toLowerCase().slice(0, 160)
  const passwordIssueMsg = passwordIssue(input.password)
  if (passwordIssueMsg) return json({ error: passwordIssueMsg }, 400)
  const name = String(input.name || email.split('@')[0]).trim().slice(0, 64) || '用户'
  if (await q1(env, 'select 1 as ok from users where email=?', [email])) return json({ error: '该邮箱已注册' }, 400)
  const countRow = await q1(env, 'select count(*) as count from users')
  const userCount = Number(countRow?.count || 0)
  const inviteToken = input.inviteToken ? String(input.inviteToken) : null
  if (userCount > 0 && !openRegisterEnabled(env) && !inviteToken) return json({ error: '开放注册已关闭，请使用邀请链接或联系管理员' }, 403)
  const created = await createUserWithDefaultTeamW(env, { email, name, password: String(input.password) })
  if (inviteToken) {
    const accepted = await acceptInvitationForUserW(env, inviteToken, created.userId, email)
    if (accepted?.error) return json({ error: accepted.error, ...created }, 400)
  }
  return json(created)
}

/** POST /api/auth/login：限流 → verifyPassword → 建会话（存哈希）→ JWT + Set-Cookie 刷新令牌 */
async function authLogin(request, env) {
  if (!accountsEnabled(env)) return json({ error: '账号体系未开启（需设置 ACCOUNTS_ENABLED=1）' }, 503)
  const input = await request.json().catch(() => ({}))
  const emailIssueMsg = emailIssue(input.email)
  if (emailIssueMsg) return json({ error: emailIssueMsg }, 400)
  const email = String(input.email).trim().toLowerCase().slice(0, 160)
  const ip = request.headers.get('cf-connecting-ip') || ''
  const userAgent = request.headers.get('user-agent') || ''
  const rateKey = `${email}:${ip || '-'}`
  if (!checkLoginRateW(rateKey)) return json({ error: '登录尝试过于频繁，请 15 分钟后再试' }, 429)
  const user = await q1(env, 'select * from users where email=? and status=?', [email, 'active'])
  if (!user || !verifyPassword(input.password, user.password_hash)) {
    recordLoginFailureW(rateKey)
    return json({ error: '邮箱或口令不正确' }, 401)
  }
  const now = Date.now()
  await env.DB.prepare('update users set last_login_at=?,updated_at=? where id=?').bind(now, now, user.id).run()
  const session = await createSessionW(env, user.id, { ip, userAgent })
  const accessToken = signJwt({ sub: user.id, sid: session.id }, jwtSecretOf(env), ACCESS_TTL_SEC)
  // Finding-1：login 审计补用户默认团队 teamId，避免孤儿记录在任何团队审计中不可见（无团队保持 null）
  const membership = await q1(env, "select team_id from team_members where user_id=? and status='active' order by created_at limit 1", [user.id])
  await writeTeamAuditW(env, { teamId: membership?.team_id || null, actorUserId: user.id, actorEmail: user.email, action: 'login', targetType: 'user', targetId: user.id, ip, userAgent })
  const res = json({ accessToken, expiresIn: ACCESS_TTL_SEC, user: { id: user.id, email: user.email, name: user.name } })
  // 手动拼 Set-Cookie（对齐 Node REFRESH_COOKIE：HttpOnly/Secure/SameSite=Lax/Path=/api/auth/7d）
  res.headers.append('Set-Cookie', `${REFRESH_COOKIE}=${session.refreshToken}; HttpOnly; Secure; SameSite=Lax; Path=/api/auth; Max-Age=604800`)
  return res
}

/** POST /api/auth/refresh：cookie eys_rt → sha256 查会话（未撤销/未过期）→ 签新 JWT（D8） */
async function authRefresh(request, env) {
  if (!accountsEnabled(env)) return json({ error: '账号体系未开启（需设置 ACCOUNTS_ENABLED=1）' }, 503)
  const token = readCookie(request, REFRESH_COOKIE)
  const session = token ? await q1(env, 'select * from sessions where token_hash=?', [sha256Hex(token)]) : null
  if (!session || session.revoked_at || Number(session.expires_at) < Date.now()) return json({ error: '会话已失效，请重新登录' }, 401)
  const user = await q1(env, 'select * from users where id=? and status=?', [session.user_id, 'active'])
  if (!user) return json({ error: '账号不可用' }, 401)
  return json({ accessToken: signJwt({ sub: user.id, sid: session.id }, jwtSecretOf(env), ACCESS_TTL_SEC), expiresIn: ACCESS_TTL_SEC })
}

/** POST /api/auth/logout：撤销当前会话（revoked_at 置值，登出即刻生效） */
async function authLogout(request, env, auth) {
  if (!accountsEnabled(env)) return json({ error: '账号体系未开启（需设置 ACCOUNTS_ENABLED=1）' }, 503)
  if (auth?.sessionId) {
    await env.DB.prepare('update sessions set revoked_at=? where id=? and revoked_at is null').bind(Date.now(), auth.sessionId).run()
  }
  return json({ ok: true })
}

/** GET /api/me：用户 + 所属团队 + 当前团队 + role/level（对齐 Node auth-service.getMe） */
async function authMe(env, auth) {
  if (!accountsEnabled(env)) return json({ error: '账号体系未开启（需设置 ACCOUNTS_ENABLED=1）' }, 503)
  if (!auth?.userId) return json({ error: '未登录' }, 401)
  const user = await q1(env, 'select id,email,name,status,last_login_at from users where id=?', [auth.userId])
  if (!user) return json({ error: '账号不存在' }, 401)
  const teams = await qm(env, `select t.id,t.name,t.slug,m.role,m.access_level from team_members m
    join teams t on t.id=m.team_id where m.user_id=? and m.status='active' order by t.created_at`, [auth.userId])
  return json({
    user: { id: user.id, email: user.email, name: user.name },
    teams: teams.map(row => ({ id: row.id, name: row.name, slug: row.slug, role: row.role, level: row.access_level })),
    currentTeamId: auth.teamId || teams[0]?.id || null,
    role: auth.role || null,
    level: auth.level || null
  })
}

/** POST /api/me/password：旧口令确认 → 更新哈希 → 撤销全部会话 → 审计（FR-17） */
async function authChangePassword(request, env, auth) {
  if (!accountsEnabled(env)) return json({ error: '账号体系未开启（需设置 ACCOUNTS_ENABLED=1）' }, 503)
  if (!auth?.userId) return json({ error: '未登录' }, 401)
  const input = await request.json().catch(() => ({}))
  const user = await q1(env, 'select * from users where id=?', [String(auth.userId).slice(0, 32)])
  if (!user || !verifyPassword(input.oldPassword, user.password_hash)) return json({ error: '旧口令不正确' }, 401)
  const issue = passwordIssue(input.newPassword)
  if (issue) return json({ error: issue }, 400)
  await env.DB.prepare('update users set password_hash=?,updated_at=? where id=?').bind(hashPassword(String(input.newPassword)), Date.now(), user.id).run()
  await env.DB.prepare('update sessions set revoked_at=? where user_id=? and revoked_at is null').bind(Date.now(), user.id).run()
  // Finding-1：改密审计同样补默认团队 teamId（凡 user 必有默认团队，register 时建/加入）
  const membership = await q1(env, "select team_id from team_members where user_id=? and status='active' order by created_at limit 1", [user.id])
  await writeTeamAuditW(env, { teamId: membership?.team_id || null, actorUserId: user.id, actorEmail: user.email, action: 'password_change', targetType: 'user', targetId: user.id })
  return json({ ok: true })
}

/** GET /api/me/sessions：会话列表（「踢下线」管理视图，FR-16） */
async function authSessionList(env, auth) {
  if (!accountsEnabled(env)) return json({ error: '账号体系未开启（需设置 ACCOUNTS_ENABLED=1）' }, 503)
  if (!auth?.userId) return json({ error: '未登录' }, 401)
  const rows = await qm(env, 'select id,ip,user_agent,expires_at,revoked_at,created_at from sessions where user_id=? order by created_at desc limit 50', [String(auth.userId).slice(0, 32)])
  return json(rows.map(row => ({
    id: row.id, ip: row.ip || '', userAgent: row.user_agent || '',
    expiresAt: Number(row.expires_at), revokedAt: row.revoked_at ? Number(row.revoked_at) : null, createdAt: Number(row.created_at)
  })))
}

/** DELETE /api/me/sessions/:sessionId：撤销单个会话（仅本人） */
async function authSessionRevoke(env, auth, sessionId) {
  if (!accountsEnabled(env)) return json({ error: '账号体系未开启（需设置 ACCOUNTS_ENABLED=1）' }, 503)
  if (!auth?.userId) return json({ error: '未登录' }, 401)
  await env.DB.prepare('update sessions set revoked_at=? where id=? and user_id=? and revoked_at is null')
    .bind(Date.now(), String(sessionId).slice(0, 32), auth.userId).run()
  return json({ ok: true })
}

// ---------- 团队端点 ----------

/** POST /api/teams：创建团队（创建者自动 Owner/派生等级，对齐 Node team-service.createTeam） */
async function teamCreate(request, env, auth) {
  if (!accountsEnabled(env)) return json({ error: '账号体系未开启（需设置 ACCOUNTS_ENABLED=1）' }, 503)
  if (!auth?.userId) return json({ error: '账号体系未开启或未登录' }, 401)
  const input = await request.json().catch(() => ({}))
  const name = String(input.name || '').trim().slice(0, 64)
  if (!name) return json({ error: '团队名称不能为空' }, 400)
  const slug = slugifyW(input.slug || name)
  if (await q1(env, 'select 1 as ok from teams where slug=?', [slug])) return json({ error: 'slug 已存在' }, 400)
  const now = Date.now(), teamId = `t_${randomToken(9)}`
  await env.DB.prepare('insert into teams (id,name,slug,created_by,created_at,updated_at) values (?,?,?,?,?,?)')
    .bind(teamId, name, slug, auth.userId, now, now).run()
  const level = defaultLevelForRole('owner')
  await env.DB.prepare(`insert into team_members (team_id,user_id,role,access_level,status,joined_at,created_at,updated_at)
    values (?,?,'owner',?,'active',?,?,?)`).bind(teamId, auth.userId, level, now, now, now).run()
  await writeTeamAuditW(env, { teamId, actorUserId: auth.userId, actorEmail: auth.email, action: 'team_update', targetType: 'team', targetId: teamId, detail: { name, slug } })
  return json({ id: teamId, name, slug, role: 'owner', level })
}

/** GET /api/teams/:teamId：Member 读 */
async function teamGet(env, auth, teamId) {
  const member = await requireTeamMemberW(env, auth, teamId)
  if (!member) return memberGuard(auth)
  const team = await q1(env, 'select id,name,slug,created_by,created_at,updated_at from teams where id=?', [teamId])
  if (!team) return json({ error: '团队不存在' }, 404)
  return json({ ...team, role: member.role, level: member.access_level })
}

/** PUT /api/teams/:teamId：仅 Owner 可改名/slug（manageTeam） */
async function teamUpdate(request, env, auth, teamId) {
  const member = await requireTeamMemberW(env, auth, teamId)
  if (!member) return memberGuard(auth)
  if (!hasPermission(member.role, 'manageTeam')) return json({ error: '仅 Owner 可修改团队设置' }, 403)
  const input = await request.json().catch(() => ({}))
  const name = String(input.name || '').trim().slice(0, 64)
  if (!name) return json({ error: '团队名称不能为空' }, 400)
  const slug = slugifyW(input.slug || name)
  const conflict = await q1(env, 'select id from teams where slug=? and id<>?', [slug, teamId])
  if (conflict) return json({ error: 'slug 已存在' }, 400)
  await env.DB.prepare('update teams set name=?,slug=?,updated_at=? where id=?').bind(name, slug, Date.now(), teamId).run()
  await writeTeamAuditW(env, { teamId, actorUserId: auth.userId, actorEmail: auth.email, action: 'team_update', targetType: 'team', targetId: teamId, detail: { name, slug } })
  return json({ ok: true })
}

/** GET /api/teams/:teamId/members：成员列表（含待认领占位行） */
async function teamMemberList(env, auth, teamId) {
  const member = await requireTeamMemberW(env, auth, teamId)
  if (!member) return memberGuard(auth)
  const rows = await qm(env, `select m.user_id,m.role,m.access_level,m.status,m.joined_at,u.email,u.name,u.last_login_at
    from team_members m left join users u on u.id=m.user_id where m.team_id=? order by m.created_at`, [teamId])
  return json(rows.map(row => ({
    userId: row.user_id,
    email: row.email || null,
    name: row.name || (row.email ? row.email.split('@')[0] : '待认领'),
    role: row.role,
    level: row.access_level,
    status: row.status,
    lastActiveAt: row.last_login_at ? Number(row.last_login_at) : null,
    joinedAt: row.joined_at ? Number(row.joined_at) : null
  })))
}

/** PUT .../members/:userId/role：Admin+、不可改 Owner、不高于自身（checkRoleChange） */
async function teamMemberRole(request, env, auth, teamId, targetUserId) {
  const actor = await requireTeamMemberW(env, auth, teamId)
  if (!actor) return memberGuard(auth)
  const target = await getMemberRowW(env, teamId, targetUserId)
  if (!target) return json({ error: '成员不存在' }, 404)
  const input = await request.json().catch(() => ({}))
  const nextRole = String(input.role || '')
  const check = checkRoleChange(actor.role, target.role, nextRole)
  if (!check.ok) return json({ error: check.reason }, 403)
  await env.DB.prepare('update team_members set role=?,access_level=?,updated_at=? where team_id=? and user_id=?')
    .bind(nextRole, defaultLevelForRole(nextRole), Date.now(), teamId, targetUserId).run()
  await writeTeamAuditW(env, { teamId, actorUserId: auth.userId, actorEmail: auth.email, action: 'role_change', targetType: 'member', targetId: targetUserId, detail: { from: target.role, to: nextRole } })
  return json({ ok: true, role: nextRole, level: defaultLevelForRole(nextRole) })
}

/** PUT .../members/:userId/access-level：Admin+ 且 ≤ 自身等级（checkLevelChange），写审计 */
async function teamMemberLevel(request, env, auth, teamId, targetUserId) {
  const actor = await requireTeamMemberW(env, auth, teamId)
  if (!actor) return memberGuard(auth)
  const target = await getMemberRowW(env, teamId, targetUserId)
  if (!target) return json({ error: '成员不存在' }, 404)
  const input = await request.json().catch(() => ({}))
  const nextLevel = String(input.level || '')
  const check = checkLevelChange(actor.role, actor.access_level, nextLevel)
  if (!check.ok) return json({ error: check.reason }, 403)
  await env.DB.prepare('update team_members set access_level=?,updated_at=? where team_id=? and user_id=?')
    .bind(nextLevel, Date.now(), teamId, targetUserId).run()
  await writeTeamAuditW(env, { teamId, actorUserId: auth.userId, actorEmail: auth.email, action: 'level_change', targetType: 'member', targetId: targetUserId, detail: { from: target.access_level, to: nextLevel } })
  return json({ ok: true, level: nextLevel })
}

/** DELETE .../members/:userId：Admin+；末位 active Owner 不可移除（≥1 Owner 不变量） */
async function teamMemberRemove(env, auth, teamId, targetUserId) {
  const actor = await requireTeamMemberW(env, auth, teamId)
  if (!actor) return memberGuard(auth)
  if (!hasPermission(actor.role, 'manageMembers')) return json({ error: '需要 Admin 及以上角色' }, 403)
  const target = await getMemberRowW(env, teamId, targetUserId)
  if (!target) return json({ error: '成员不存在' }, 404)
  if (target.role === 'owner') {
    const owners = Number((await q1(env, `select count(*) as count from team_members where team_id=? and role='owner' and status='active'`, [teamId]))?.count || 0)
    if (owners <= 1) return json({ error: '团队须保留至少 1 个 Owner（先转让后再移除）' }, 403)
  }
  await env.DB.prepare('delete from team_members where team_id=? and user_id=?').bind(teamId, targetUserId).run()
  await writeTeamAuditW(env, { teamId, actorUserId: auth.userId, actorEmail: auth.email, action: 'member_remove', targetType: 'member', targetId: targetUserId, detail: { email: target.email } })
  return json({ ok: true })
}

/** POST .../invitations：Admin+；一次性 token（库内只存哈希）、7 天过期；邀请等级 ≤ 自身 */
async function teamInviteCreate(request, env, auth, teamId) {
  const actor = await requireTeamMemberW(env, auth, teamId)
  if (!actor) return memberGuard(auth)
  if (!hasPermission(actor.role, 'manageMembers')) return json({ error: '需要 Admin 及以上角色' }, 403)
  const input = await request.json().catch(() => ({}))
  const email = String(input.email || '').trim().toLowerCase().slice(0, 160)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: '邮箱格式不正确' }, 400)
  const role = isRole(input.role) ? input.role : 'member'
  const level = String(input.accessLevel || defaultLevelForRole(role))
  const check = checkLevelChange(actor.role, actor.access_level, level)
  if (!check.ok) return json({ error: `邀请等级越权：${check.reason}` }, 403)
  const token = randomToken(24), now = Date.now(), id = `i_${randomToken(9)}`
  await env.DB.prepare(`insert into invitations (id,team_id,email,role,access_level,token_hash,expires_at,invited_by,created_at)
    values (?,?,?,?,?,?,?,?,?)`)
    .bind(id, teamId, email, role, level, sha256Hex(token), now + INVITE_TTL_MS, auth.userId, now).run()
  await writeTeamAuditW(env, { teamId, actorUserId: auth.userId, actorEmail: auth.email, action: 'member_invite', targetType: 'invitation', targetId: id, detail: { email, role, level } })
  return json({ id, email, role, level, token, expiresAt: now + INVITE_TTL_MS })
}

/** GET .../invitations：待接受邀请列表（Admin+） */
async function teamInviteList(env, auth, teamId) {
  const actor = await requireTeamMemberW(env, auth, teamId)
  if (!actor) return memberGuard(auth)
  if (!hasPermission(actor.role, 'manageMembers')) return json({ error: '需要 Admin 及以上角色' }, 403)
  const rows = await qm(env, `select id,email,role,access_level,expires_at,accepted_at,revoked_at,created_at
    from invitations where team_id=? order by created_at desc limit 100`, [teamId])
  return json(rows.map(row => ({
    id: row.id, email: row.email, role: row.role, level: row.access_level,
    expiresAt: Number(row.expires_at), acceptedAt: row.accepted_at ? Number(row.accepted_at) : null,
    revokedAt: row.revoked_at ? Number(row.revoked_at) : null, createdAt: Number(row.created_at)
  })))
}

/** DELETE .../invitations/:id：撤销邀请（Admin+） */
async function teamInviteRevoke(env, auth, teamId, invitationId) {
  const actor = await requireTeamMemberW(env, auth, teamId)
  if (!actor) return memberGuard(auth)
  if (!hasPermission(actor.role, 'manageMembers')) return json({ error: '需要 Admin 及以上角色' }, 403)
  const row = await q1(env, 'select * from invitations where id=? and team_id=?', [String(invitationId).slice(0, 32), teamId])
  if (!row) return json({ error: '邀请不存在' }, 404)
  await env.DB.prepare('update invitations set revoked_at=? where id=?').bind(Date.now(), row.id).run()
  await writeTeamAuditW(env, { teamId, actorUserId: auth.userId, actorEmail: auth.email, action: 'member_invite', targetType: 'invitation', targetId: row.id, detail: { revoked: true, email: row.email } })
  return json({ ok: true })
}

/** POST /api/invitations/:token/accept：登录态接受邀请（未注册走 register 携 inviteToken） */
async function invitationAccept(request, env, auth, token) {
  if (!accountsEnabled(env)) return json({ error: '账号体系未开启（需设置 ACCOUNTS_ENABLED=1）' }, 503)
  if (!auth?.userId) return json({ error: '请先登录或注册后再接受邀请' }, 401)
  const result = await acceptInvitationForUserW(env, token, auth.userId, auth.email)
  if (result?.error) return json({ error: result.error }, 400)
  return json(result)
}

/** POST .../applications：把 appId 归入/移动到团队（Admin+；SDK 写入侧零改动，FR-7） */
async function teamAssignApplication(request, env, auth, teamId) {
  const actor = await requireTeamMemberW(env, auth, teamId)
  if (!actor) return memberGuard(auth)
  if (!hasPermission(actor.role, 'manageApplications')) return json({ error: '需要 Admin 及以上角色' }, 403)
  const input = await request.json().catch(() => ({}))
  const appId = String(input.appId || '').trim().slice(0, 64)
  if (!appId) return json({ error: 'appId 不能为空' }, 400)
  const app = await q1(env, 'select app_id,team_id from applications where app_id=?', [appId])
  if (!app) return json({ error: '应用不存在' }, 404)
  await env.DB.prepare('update applications set team_id=? where app_id=?').bind(teamId, appId).run()
  await writeTeamAuditW(env, { teamId, actorUserId: auth.userId, actorEmail: auth.email, action: 'app_move', targetType: 'application', targetId: appId, detail: { from: app.team_id || null, to: teamId } })
  return json({ ok: true, appId, teamId })
}

/** GET .../audit：本团队 audit_logs 倒序 200 条（Admin+ viewAudit） */
async function teamAuditList(env, auth, teamId) {
  const actor = await requireTeamMemberW(env, auth, teamId)
  if (!actor) return memberGuard(auth)
  if (!hasPermission(actor.role, 'viewAudit')) return json({ error: '需要 Admin 及以上角色' }, 403)
  const rows = await qm(env, `select id,actor_user_id,actor_email,action,target_type,target_id,detail_json,ip,created_at
    from audit_logs where team_id=? order by created_at desc limit 200`, [teamId])
  return json(rows.map(row => ({
    id: Number(row.id), actorUserId: row.actor_user_id, actorEmail: row.actor_email,
    action: row.action, targetType: row.target_type, targetId: row.target_id,
    detail: parse(row.detail_json, {}), ip: row.ip || '', createdAt: Number(row.created_at)
  })))
}

/** POST /api/maintenance/migrate-members：members 登记项 → 默认团队（无邮箱以 members.id 占位「待认领」，不自动生成账号） */
async function teamMigrateMembers(env, auth) {
  if (!accountsEnabled(env)) return json({ error: '账号体系未开启（需设置 ACCOUNTS_ENABLED=1）' }, 503)
  if (!auth?.userId) return json({ error: '账号体系未开启或未登录' }, 401)
  const team = await q1(env, 'select id from teams where slug=?', ['default'])
  if (!team) return json({ ok: false, reason: '默认团队尚未创建（首个 Owner 注册后自动建立）' })
  const members = await qm(env, 'select * from members')
  let moved = 0
  for (const member of members) {
    const exists = await q1(env, 'select 1 as ok from team_members where team_id=? and user_id=?', [team.id, member.id])
    if (exists) continue
    const now = Date.now()
    await env.DB.prepare(`insert into team_members (team_id,user_id,role,access_level,status,joined_at,created_at,updated_at)
      values (?,?,?,?,'active',?,?,?)`)
      .bind(team.id, member.id, isRole(member.role) ? member.role : 'member', member.access_level || 'L2', now, now, now).run()
    moved += 1
  }
  return json({ ok: true, teamId: team.id, moved, note: '无邮箱登记项以 members.id 为 user_id 占位（待认领），不自动生成账号' })
}

// ==================== B2 · SLO / 错误预算（镜像 apps/api/src/services/slo-service.js；字段/语义/数学一致，仅 D1 方言差异） ====================
// SLI 映射（与 Node 同口径，已纠正 PRD 误写）：error_rate 分母=type='behavior' and name='pv'；
// availability 分母=type='perf' metric in('fetch','xhr')，坏=json_extract(props_json,'$.status')>=400；
// latency_threshold 样本级：lcp/fcp/cls/inp 各自 value>阈值 计坏。

const sloEnabledW = env => env.SLO_ENABLED === '1'

/** B2 守卫：slo 能力未开启时统一 503（不暴露端点细节），开启后执行处理器。 */
function guardSloW(env, run) {
  if (!sloEnabledW(env)) return json({ error: 'SLO 能力未开启（需设置 SLO_ENABLED=1）' }, 503)
  return run()
}

/** 团队可见性（对齐 Node assertSloVisible）：accounts 会话下跨 team 归属 403；api_key / 未开启看全部。 */
function sloAuthzW(env, slo, auth) {
  if (!accountsEnabled(env)) return null
  if (auth?.via !== 'session' || !auth.teamId) return null
  if (slo.team_id && slo.team_id !== auth.teamId) return json({ error: '无权访问该 SLO（跨团队）' }, 403)
  return null
}

/** D1 行 → API 视图（解析 JSON 文本；对齐 Node publicSlo）。 */
function sloViewW(row) {
  return {
    id: row.id, appId: row.app_id, teamId: row.team_id || null, name: row.name,
    objective: Number(row.objective), windowDays: Number(row.window_days), sliType: row.sli_type,
    sliConfig: parseJson(row.sli_config, {}), alertPolicy: parseJson(row.alert_policy, {}),
    createdBy: row.created_by || null, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at)
  }
}

async function sloCountW(env, where, vals) {
  const r = await env.DB.prepare(`select count(*) count from events ${where}`).bind(...vals).first()
  return Number(r?.count || 0)
}

/** SLI 聚合（D1 方言；返回 {total, bad}）。 */
async function sloSliW(env, slo, startTs, endTs) {
  const cfg = parseJson(slo.sli_config, {})
  const parts = ['app_id=?', 'ts>=?', 'ts<=?']
  const vals = [slo.app_id, startTs, endTs]
  if (cfg.release) { parts.push('release_name=?'); vals.push(String(cfg.release)) }
  const where = `where ${parts.join(' and ')}`
  if (slo.sli_type === 'error_rate') {
    const total = await sloCountW(env, `${where} and type='behavior' and name='pv'`, vals)
    const bad = await sloCountW(env, `${where} and type='error'`, vals)
    return { total, bad }
  }
  if (slo.sli_type === 'availability') {
    const w = `${where} and type='perf' and metric in ('fetch','xhr')`
    const total = await sloCountW(env, w, vals)
    const bad = await sloCountW(env, `${w} and coalesce(json_extract(props_json,'$.status'),0) >= 400`, vals)
    return { total, bad }
  }
  const thr = { lcp: cfg.thresholds?.lcp ?? 2500, fcp: cfg.thresholds?.fcp ?? 1800, cls: cfg.thresholds?.cls ?? 0.1, inp: cfg.thresholds?.inp ?? 200 }
  let total = 0, bad = 0
  for (const m of ['lcp', 'fcp', 'cls', 'inp']) {
    const w = `${where} and type='perf' and metric=?`
    total += await sloCountW(env, w, [...vals, m])
    bad += await sloCountW(env, `${w} and value > ?`, [...vals, m, thr[m]])
  }
  return { total, bad }
}

/** POST/PUT /api/slo：创建或更新（body 带 id 即更新；对齐 Node saveSlo upsert）。 */
async function sloSaveW(request, env, auth) {
  const input = await request.json().catch(() => ({}))
  const appId = String(input.appId || '').trim().slice(0, 64)
  if (!appId) return json({ error: 'appId 不能为空' }, 400)
  const app = await env.DB.prepare('select team_id from applications where app_id=?').bind(appId).first()
  if (!app) return json({ error: '应用不存在' }, 404)
  const name = String(input.name || '').trim().slice(0, 80)
  if (!name) return json({ error: 'SLO 名称不能为空' }, 400)
  const objective = Number(input.objective)
  if (!Number.isFinite(objective) || objective <= 0 || objective >= 1) return json({ error: 'objective 须在 (0,1) 区间' }, 400)
  const windowDays = [28, 30].includes(Number(input.windowDays)) ? Number(input.windowDays) : 30
  const sliType = ['error_rate', 'latency_threshold', 'availability'].includes(input.sliType) ? input.sliType : null
  if (!sliType) return json({ error: 'sliType 必须为 error_rate | latency_threshold | availability' }, 400)
  const id = String(input.id || '').trim().slice(0, 32) || `slo_${randomToken(10)}`
  const existing = await env.DB.prepare('select * from slo_definitions where id=?').bind(id).first()
  const authz = existing ? sloAuthzW(env, existing, auth) : null
  if (authz) return authz
  const now = Date.now()
  const sliConfig = JSON.stringify(parseJson(input.sliConfig, {}))
  const alertPolicy = JSON.stringify(parseJson(input.alertPolicy, {}))
  if (existing) {
    await env.DB.prepare('update slo_definitions set name=?, objective=?, window_days=?, sli_type=?, sli_config=?, alert_policy=?, updated_at=? where id=?')
      .bind(name, objective, windowDays, sliType, sliConfig, alertPolicy, now, id).run()
    return json({ id, updated: true })
  }
  await env.DB.prepare('insert into slo_definitions (id, app_id, team_id, name, objective, window_days, sli_type, sli_config, alert_policy, created_by, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, appId, app.team_id || null, name, objective, windowDays, sliType, sliConfig, alertPolicy, auth?.userId || null, now, now).run()
  return json({ id, created: true })
}

/** GET /api/slo：列表（含最新预算快照；accounts 会话按 teamId 过滤，未归属团队的存量 SLO 全员可见）。 */
async function sloListW(env, auth, url) {
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize')) || 20))
  const parts = [], vals = []
  const appId = url.searchParams.get('appId')
  if (appId) { parts.push('app_id=?'); vals.push(appId) }
  if (accountsEnabled(env) && auth?.via === 'session' && auth.teamId) { parts.push('(team_id is null or team_id=?)'); vals.push(auth.teamId) }
  const where = parts.length ? `where ${parts.join(' and ')}` : ''
  const rows = (await env.DB.prepare(`select * from slo_definitions ${where} order by updated_at desc limit ? offset ?`).bind(...vals, pageSize, (page - 1) * pageSize).all()).results || []
  const totalRow = await env.DB.prepare(`select count(*) count from slo_definitions ${where}`).bind(...vals).first()
  const items = []
  for (const row of rows) {
    const snap = await env.DB.prepare('select * from slo_burn_snapshots where slo_id=? order by snap_at desc limit 1').bind(row.id).first()
    items.push({ ...sloViewW(row), latestBudget: snap ? { goodRatio: Number(snap.good_ratio), budgetUsed: Number(snap.budget_used), burnRate: Number(snap.burn_rate), status: snap.status, snapAt: Number(snap.snap_at) } : null })
  }
  return json({ items, total: Number(totalRow?.count || 0), page, pageSize })
}

/** GET /api/slo/:id：详情（定义 + 最新快照预算）。 */
async function sloGetW(env, auth, id) {
  const slo = await env.DB.prepare('select * from slo_definitions where id=?').bind(id).first()
  if (!slo) return json({ error: 'SLO 不存在' }, 404)
  const authz = sloAuthzW(env, slo, auth); if (authz) return authz
  const snap = await env.DB.prepare('select * from slo_burn_snapshots where slo_id=? order by snap_at desc limit 1').bind(id).first()
  const budget = snap
    ? { goodRatio: Number(snap.good_ratio), budgetUsed: Number(snap.budget_used), burnRate: Number(snap.burn_rate), status: snap.status, snapAt: Number(snap.snap_at), windowStart: Number(snap.window_start), windowEnd: Number(snap.window_end) }
    : { goodRatio: 1, budgetUsed: 0, burnRate: 0, status: 'healthy', noData: true }
  return json({ definition: sloViewW(slo), budget })
}

/** DELETE /api/slo/:id：删除（级联删快照）。 */
async function sloDeleteW(env, auth, id) {
  const slo = await env.DB.prepare('select * from slo_definitions where id=?').bind(id).first()
  if (!slo) return json({ error: 'SLO 不存在' }, 404)
  const authz = sloAuthzW(env, slo, auth); if (authz) return authz
  await env.DB.prepare('delete from slo_burn_snapshots where slo_id=?').bind(id).run()
  await env.DB.prepare('delete from slo_definitions where id=?').bind(id).run()
  return json({ ok: true })
}

// ==================== C2 · 集成市场：Sentry issue 导入（镜像 Node sentry-service） ====================

/** POST /api/integrations/sentry/import：批量导入，指纹走 issueKey+sha256（与原生事件去重对齐）。 */
async function sentryImportW(request, env, auth) {
  const body = await request.json().catch(() => ({}))
  const appId = clip(body.appId, 64).trim()
  if (!appId) return json({ error: 'appId 必填' }, 400)
  const { mapped, skipped, invalid } = mapSentryIssues(body.issues)
  if (invalid) return json({ error: invalid }, 400)
  if (!mapped.length) return json({ appId, imported: 0, merged: 0, skipped, results: [] })
  const appRow = await env.DB.prepare('select app_id from applications where app_id=?').bind(appId).first()
  if (!appRow) return json({ error: '应用不存在' }, 404)
  const results = []
  let imported = 0
  let merged = 0
  for (const m of mapped) {
    // 指纹对齐：复用本栈 issueKey（FetchError 家族 source 参与公式）+ sha256
    const fp = await sha256(issueKey({ appId, name: m.name, message: m.message, stack: m.stack, props: { source: m.source } }))
    const propsJson = JSON.stringify({ source: 'sentry', ...(m.sentryIssueId ? { sentryIssueId: m.sentryIssueId } : {}), ...(m.culprit ? { culprit: m.culprit } : {}) })
    // 新增 open；命中指纹仅累加 count / 推进 last_seen，不覆盖既有状态与 props
    const existing = await env.DB.prepare('select fingerprint from issues where fingerprint=?').bind(fp).first()
    if (existing) {
      await env.DB.prepare('update issues set count=count+?, last_seen=max(last_seen, ?) where fingerprint=?').bind(m.count, m.lastSeen, fp).run()
      merged++
      results.push({ fingerprint: fp, action: 'merged', name: m.name })
    } else {
      await env.DB.prepare(`insert into issues (fingerprint,status,app_id,release_name,name,message,stack,url,props_json,count,first_seen,last_seen) values (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(fp, 'open', appId, clip(m.release, 64), clip(m.name, 150), m.message, m.stack, clip(m.url, 1000), propsJson, m.count, m.firstSeen, m.lastSeen).run()
      imported++
      results.push({ fingerprint: fp, action: 'imported', name: m.name })
    }
  }
  return json({ appId, imported, merged, skipped, results })
}

/** POST /api/integrations/sentry/preview：单条映射预览（不入库）。 */
async function sentryPreviewW(request) {
  const body = await request.json().catch(() => ({}))
  const entry = body?.issue ?? body
  if (!entry || typeof entry !== 'object') return json({ error: 'issue 必填' }, 400)
  return json(mapSentryIssue(entry))
}

/** GET /api/slo/:id/budget：查询时全窗口计算（无快照也可用；对齐 Node computeBudget）。 */
async function sloBudgetW(env, auth, id, url) {
  const slo = await env.DB.prepare('select * from slo_definitions where id=?').bind(id).first()
  if (!slo) return json({ error: 'SLO 不存在' }, 404)
  const authz = sloAuthzW(env, slo, auth); if (authz) return authz
  const windowDays = Number(url.searchParams.get('window')) || Number(slo.window_days)
  const now = Date.now(), windowStart = now - windowDays * 86400000
  const { total, bad } = await sloSliW(env, slo, windowStart, now)
  const goodRatio = computeGoodRatio(bad, total)
  const burnRate = computeBurnRate(bad, total, slo.objective)
  return json({ goodRatio, budgetUsed: burnRate, budgetRemaining: Math.max(0, 1 - burnRate), burnRate, status: sloStatus(goodRatio, burnRate), windowStart, windowEnd: now, total, bad })
}

/** GET /api/slo/:id/trend：按日桶聚合快照（对齐 Node computeTrend；SQLite 整数除法即取整日桶）。 */
async function sloTrendW(env, auth, id, url) {
  const slo = await env.DB.prepare('select * from slo_definitions where id=?').bind(id).first()
  if (!slo) return json({ error: 'SLO 不存在' }, 404)
  const authz = sloAuthzW(env, slo, auth); if (authz) return authz
  const end = Number(url.searchParams.get('end')) || Date.now()
  const start = Number(url.searchParams.get('start')) || (end - 30 * 86400000)
  const rows = (await env.DB.prepare(`select (snap_at/86400000)*86400000 as bucket, avg(good_ratio) gr, avg(budget_used) bu, avg(burn_rate) br, max(case when status='burnt' then 2 when status='warning' then 1 else 0 end) sr from slo_burn_snapshots where slo_id=? and snap_at>=? and snap_at<=? group by 1 order by 1`).bind(id, start, end).all()).results || []
  return json({ points: rows.map(r => ({ bucket: Number(r.bucket), goodRatio: Number(r.gr || 0), budgetUsed: Number(r.bu || 0), burnRate: Number(r.br || 0), status: Number(r.sr) >= 2 ? 'burnt' : Number(r.sr) >= 1 ? 'warning' : 'healthy' })) })
}

/** GET /api/slo/:id/alerts：该 SLO 的燃尽告警列表（D1 无 status 列，用 notified 映射）。 */
async function sloAlertsW(env, id, url) {
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize')) || 20))
  const rows = (await env.DB.prepare(`select * from alert_history where metric='slo_burn' and json_extract(context_json,'$.sloId')=? order by created_at desc limit ? offset ?`).bind(id, pageSize, (page - 1) * pageSize).all()).results || []
  const totalRow = await env.DB.prepare(`select count(*) count from alert_history where metric='slo_burn' and json_extract(context_json,'$.sloId')=?`).bind(id).first()
  return json({
    items: rows.map(r => ({ id: Number(r.id), appId: r.app_id, metric: r.metric, level: r.level, value: r.value, message: r.message, status: r.notified ? 'sent' : 'pending', context: parseJson(r.context_json, {}), createdAt: Number(r.created_at) })),
    total: Number(totalRow?.count || 0), page, pageSize
  })
}

/** POST /api/slo/:id/alert-policy：多窗口阈值覆盖 + 通道绑定（对齐 Node setAlertPolicy）。 */
async function sloPolicyW(request, env, auth, id) {
  const slo = await env.DB.prepare('select * from slo_definitions where id=?').bind(id).first()
  if (!slo) return json({ error: 'SLO 不存在' }, 404)
  const authz = sloAuthzW(env, slo, auth); if (authz) return authz
  const input = await request.json().catch(() => ({}))
  const thresholds = Array.isArray(input.policy) && input.policy.length ? input.policy : null
  const channelIds = Array.isArray(input.channelIds) ? input.channelIds.slice(0, 20).map(String).filter(Boolean) : []
  const merged = parseJson(slo.alert_policy, {})
  const next = {
    ...(merged.thresholds ? { thresholds: merged.thresholds } : {}),
    ...(thresholds ? { thresholds } : {}),
    channels: { critical: channelIds, warning: channelIds }
  }
  await env.DB.prepare('update slo_definitions set alert_policy=?, updated_at=? where id=?').bind(JSON.stringify(next), Date.now(), id).run()
  return json({ ok: true })
}

/** 计算并写入全窗口滚动快照（定时 tick 与手动 compute 共用；对齐 Node computeSnapshot）。 */
async function sloComputeSnapshotW(env, slo, now = Date.now()) {
  const windowMs = Number(slo.window_days) * 86400000
  const { total, bad } = await sloSliW(env, slo, now - windowMs, now)
  const goodRatio = computeGoodRatio(bad, total)
  const burnRate = computeBurnRate(bad, total, slo.objective)
  const status = sloStatus(goodRatio, burnRate)
  const id = `sb_${randomToken(10)}`
  await env.DB.prepare('insert into slo_burn_snapshots (id, slo_id, snap_at, window_start, window_end, total, bad, good_ratio, budget_used, burn_rate, status) values (?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, slo.id, now, now - windowMs, now, total, bad, goodRatio, burnRate, burnRate, status).run()
  return { id, sloId: slo.id, snapAt: now, windowStart: now - windowMs, windowEnd: now, total, bad, goodRatio, budgetUsed: burnRate, burnRate, status }
}

/** 多窗口多燃烧率判定 + 越界写 alert_history(metric='slo_burn') 并复用投递（30min 冷却；对齐 Node evaluateAlerts）。 */
async function sloEvaluateW(env, slo, snapshotInput) {
  const now = Date.now()
  const policy = parseJson(slo.alert_policy, {})
  const thresholds = Array.isArray(policy.thresholds) && policy.thresholds.length ? policy.thresholds : BURN_RATE_THRESHOLDS
  const windows = []
  for (const entry of thresholds) {
    const long = await sloSliW(env, slo, now - entry.longWindowMs, now)
    const longBurn = computeBurnRate(long.bad, long.total, slo.objective)
    let shortBurn = longBurn
    if (entry.shortWindowMs != null) {
      const short = await sloSliW(env, slo, now - entry.shortWindowMs, now)
      shortBurn = computeBurnRate(short.bad, short.total, slo.objective)
    }
    windows.push({ longWindowMs: entry.longWindowMs, shortWindowMs: entry.shortWindowMs, longBurnRate: longBurn, shortBurnRate: shortBurn })
  }
  const breach = evaluateMultiWindowBurnRate({ windows, policy: thresholds })
  if (!breach.breach) return { breach: false }
  const full = await sloSliW(env, slo, now - Number(slo.window_days) * 86400000, now)
  const fullBurn = computeBurnRate(full.bad, full.total, slo.objective)
  const snapshot = snapshotInput || {
    goodRatio: computeGoodRatio(full.bad, full.total), budgetUsed: fullBurn, burn_rate: fullBurn,
    status: sloStatus(computeGoodRatio(full.bad, full.total), fullBurn)
  }
  const alert = buildSloBurnAlert(slo, snapshot, breach)
  const recent = await env.DB.prepare(`select id, created_at from alert_history where metric='slo_burn' and app_id=? and json_extract(context_json,'$.sloId')=? and level=? order by created_at desc limit 1`)
    .bind(slo.app_id, slo.id, alert.level).first()
  if (recent && now - Number(recent.created_at) < 30 * 60 * 1000) return { breach: true, alert: null }
  const result = await env.DB.prepare('insert into alert_history(app_id,metric,fingerprint,level,value,message,threshold,notified,context_json,created_at) values(?,?,?,?,?,?,?,0,?,?)')
    .bind(slo.app_id, 'slo_burn', `slo:${slo.id}`, alert.level, alert.value, alert.message, breach.entry?.longThreshold ?? 0, JSON.stringify(alert.context), now).run()
  await createAlertDeliveries(env, Number(result.meta.last_row_id))
  return { breach: true, alert: { id: Number(result.meta.last_row_id), ...alert } }
}

/** POST /api/slo/:id/compute：立即计算快照 + 燃尽判定。 */
async function sloComputeRouteW(env, auth, id) {
  const slo = await env.DB.prepare('select * from slo_definitions where id=?').bind(id).first()
  if (!slo) return json({ error: 'SLO 不存在' }, 404)
  const authz = sloAuthzW(env, slo, auth); if (authz) return authz
  const snapshot = await sloComputeSnapshotW(env, slo)
  const evaluated = await sloEvaluateW(env, slo, snapshot)
  return json({ snapshot, breach: Boolean(evaluated?.breach), alert: evaluated?.alert || null })
}

/** 定时 tick：全部 SLO 逐个写快照 + 燃尽判定（单 SLO 失败不影响其余，console.error 可 wrangler tail 观测）。 */
async function sloTickW(env) {
  if (!sloEnabledW(env)) return
  const rows = (await env.DB.prepare('select * from slo_definitions').all()).results || []
  for (const slo of rows) {
    try {
      const snapshot = await sloComputeSnapshotW(env, slo)
      await sloEvaluateW(env, slo, snapshot)
    } catch (e) { console.error('[slo-tick] failed', slo?.id, e?.message) }
  }
}

// ==================== B3 · 合成监控（镜像 apps/api/src/services/synthetic-service.js；字段/语义/判定一致，仅 D1 方言差异） ====================
// 判定规则 / SSRF 字面量校验 / 参数收敛全部同源 packages/synthetic.js；
// SSRF 第二层（DNS 解析后私网 IP 校验）Workers 不暴露 DNS，仅保留第一层字面量兜底（架构 §5 待明确 #2）；
// 告警零新增通道：alert_history(metric='synthetic', fingerprint='synthetic:{checkId}') → createAlertDeliveries（30min 冷却）。

/** B3 守卫：synthetic 能力未开启（env.SYNTHETIC_ENABLED≠1）时统一 503（复刻 guardSloW 范式）。 */
function guardSyntheticW(env, run) {
  if (env.SYNTHETIC_ENABLED !== '1') return json({ error: '合成监控能力未启用（需设置 SYNTHETIC_ENABLED=1）' }, 503)
  return run()
}

/** 团队可见性（对齐 Node assertCheckVisible）：accounts 会话下跨 team 归属 403；api_key / 未开启看全部。 */
function syntheticAuthzW(env, check, auth) {
  if (!accountsEnabled(env)) return null
  if (auth?.via !== 'session' || !auth.teamId) return null
  if (check.team_id && check.team_id !== auth.teamId) return json({ error: '无权访问该探针（跨团队）' }, 403)
  return null
}

/** D1 行 → API 视图（对齐 Node publicCheck；enabled 0/1 → boolean）。 */
function syntheticViewW(row) {
  return {
    id: row.id, appId: row.app_id, teamId: row.team_id || null, name: row.name, url: row.url,
    method: row.method || 'GET', intervalSeconds: Number(row.interval_seconds), timeoutMs: Number(row.timeout_ms),
    expectedStatus: Number(row.expected_status), keyword: row.keyword || null,
    latencyThresholdMs: row.latency_threshold_ms == null ? null : Number(row.latency_threshold_ms),
    failThreshold: Number(row.fail_threshold), enabled: Number(row.enabled) === 1,
    lastStatus: row.last_status || 'unknown', lastRunAt: row.last_run_at == null ? null : Number(row.last_run_at),
    consecutiveFailures: Number(row.consecutive_failures || 0),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at)
  }
}

/** POST/PUT /api/synthetic：创建或更新（body 带 id 即更新；对齐 Node saveCheck upsert）。 */
async function syntheticSaveW(request, env, auth) {
  const input = await request.json().catch(() => ({}))
  const appId = String(input.appId || '').trim().slice(0, 64)
  if (!appId) return json({ error: 'appId 不能为空' }, 400)
  const app = await env.DB.prepare('select app_id, team_id from applications where app_id=?').bind(appId).first()
  if (!app) return json({ error: '应用不存在' }, 404)
  const id = String(input.id || '').trim().slice(0, 32) || `sc_${randomToken(10)}`
  const existing = await env.DB.prepare('select * from synthetic_checks where id=?').bind(id).first()
  const authz = existing ? syntheticAuthzW(env, existing, auth) : null
  if (authz) return authz
  // 参数收敛 + SSRF 第一层（仅 https + 字面量黑名单），双端同源
  const normalized = normalizeCheckInput(input)
  if (!normalized.ok) return json({ error: normalized.error }, 400)
  const v = normalized.value
  const now = Date.now()
  const enabledInt = v.enabled ? 1 : 0
  if (existing) {
    await env.DB.prepare('update synthetic_checks set name=?, url=?, method=?, interval_seconds=?, timeout_ms=?, expected_status=?, keyword=?, latency_threshold_ms=?, fail_threshold=?, enabled=?, updated_at=? where id=?')
      .bind(v.name, v.url, v.method, v.intervalSeconds, v.timeoutMs, v.expectedStatus, v.keyword, v.latencyThresholdMs, v.failThreshold, enabledInt, now, id).run()
    return json({ id, updated: true })
  }
  await env.DB.prepare('insert into synthetic_checks (id, app_id, team_id, name, url, method, interval_seconds, timeout_ms, expected_status, keyword, latency_threshold_ms, fail_threshold, enabled, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, appId, app.team_id || null, v.name, v.url, v.method, v.intervalSeconds, v.timeoutMs, v.expectedStatus, v.keyword, v.latencyThresholdMs, v.failThreshold, enabledInt, now, now).run()
  return json({ id, created: true })
}

/** GET /api/synthetic：列表（含近 24h 可用率单值；accounts 会话按 teamId 过滤）。 */
async function syntheticListW(env, auth, url) {
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize')) || 20))
  const parts = [], vals = []
  const appId = url.searchParams.get('appId')
  if (appId) { parts.push('app_id=?'); vals.push(appId) }
  if (accountsEnabled(env) && auth?.via === 'session' && auth.teamId) { parts.push('(team_id is null or team_id=?)'); vals.push(auth.teamId) }
  const where = parts.length ? `where ${parts.join(' and ')}` : ''
  const rows = (await env.DB.prepare(`select * from synthetic_checks ${where} order by updated_at desc limit ? offset ?`).bind(...vals, pageSize, (page - 1) * pageSize).all()).results || []
  const totalRow = await env.DB.prepare(`select count(*) count from synthetic_checks ${where}`).bind(...vals).first()
  // 近 24h 可用率单值（一次 group 聚合，避免逐探针 N 次查询）
  const availability = new Map()
  if (rows.length) {
    const ids = rows.map(r => r.id)
    const avRows = (await env.DB.prepare(`select check_id, avg(case when ok=1 then 1.0 else 0.0 end) rate from synthetic_results where checked_at>=? and check_id in (${ids.map(() => '?').join(',')}) group by check_id`).bind(Date.now() - 86400000, ...ids).all()).results || []
    for (const r of avRows) availability.set(r.check_id, Number(r.rate))
  }
  return json({
    items: rows.map(row => ({ ...syntheticViewW(row), availability24h: availability.has(row.id) ? availability.get(row.id) : null })),
    total: Number(totalRow?.count || 0), page, pageSize
  })
}

/** GET /api/synthetic/:id：详情。 */
async function syntheticGetW(env, auth, id) {
  const check = await env.DB.prepare('select * from synthetic_checks where id=?').bind(id).first()
  if (!check) return json({ error: '探针不存在' }, 404)
  const authz = syntheticAuthzW(env, check, auth); if (authz) return authz
  return json({ check: syntheticViewW(check) })
}

/** DELETE /api/synthetic/:id：删除（级联删 results）。 */
async function syntheticDeleteW(env, auth, id) {
  const check = await env.DB.prepare('select * from synthetic_checks where id=?').bind(id).first()
  if (!check) return json({ error: '探针不存在' }, 404)
  const authz = syntheticAuthzW(env, check, auth); if (authz) return authz
  await env.DB.prepare('delete from synthetic_results where check_id=?').bind(id).run()
  await env.DB.prepare('delete from synthetic_checks where id=?').bind(id).run()
  return json({ ok: true })
}

/** POST /api/synthetic/:id/run：立即探测（同步执行单次并返回结果；run 路由与 tick 共用 runProbeW）。 */
async function syntheticRunW(env, auth, id) {
  const check = await env.DB.prepare('select * from synthetic_checks where id=?').bind(id).first()
  if (!check) return json({ error: '探针不存在' }, 404)
  const authz = syntheticAuthzW(env, check, auth); if (authz) return authz
  const result = await syntheticRunProbeW(env, check)
  return json({ result })
}

/**
 * 执行单次探测并落库（手动 run 与 tick 共用；对齐 Node runProbe，仅方言差异）：
 * SSRF 字面量校验 → fetch（AbortSignal.timeout）→ evaluateProbe 四步判定 → 写 results + 推进计数 → 告警判定。
 */
async function syntheticRunProbeW(env, check) {
  const literal = validateProbeUrl(check.url)
  if (!literal.ok) {
    return persistProbeResultW(env, check, { ok: false, outcome: 'fail', statusCode: null, latencyMs: 0, latencyExceeded: false, error: `SSRF 拒绝：${literal.error}` })
  }
  const timeoutMs = Math.max(1, Number(check.timeout_ms) || 10000)
  const started = Date.now()
  try {
    const response = await fetch(check.url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'WebCollection-Synthetic/1.0', accept: '*/*' } })
    const latencyMs = Date.now() - started
    // keyword 匹配需读响应体：content-length 预判跳过超大响应体，片段上限 64KB（Q3 不落库原文）
    let bodySnippet = ''
    try {
      const contentLength = Number(response.headers.get('content-length') || 0)
      if (!contentLength || contentLength <= BODY_SNIPPET_LIMIT) bodySnippet = String(await response.text()).slice(0, BODY_SNIPPET_LIMIT)
    } catch { /* 响应体读取失败不影响状态码判定 */ }
    const verdict = evaluateProbe({ check, statusCode: response.status, bodySnippet, latencyMs, error: null })
    return persistProbeResultW(env, check, { ...verdict, statusCode: response.status, latencyMs })
  } catch (err) {
    const latencyMs = Date.now() - started
    const verdict = evaluateProbe({ check, statusCode: null, bodySnippet: '', latencyMs, error: err })
    return persistProbeResultW(env, check, { ...verdict, statusCode: null, latencyMs })
  }
}

/** 结果落库 + 计数推进 + 告警判定（对齐 Node persistProbeResult；enabled 列 D1 为 integer 方言点）。 */
async function persistProbeResultW(env, check, verdict) {
  const now = Date.now()
  const id = `sr_${randomToken(10)}`
  await env.DB.prepare('insert into synthetic_results (id, check_id, ok, outcome, status_code, latency_ms, latency_exceeded, error, checked_at) values (?,?,?,?,?,?,?,?,?)')
    .bind(id, check.id, verdict.ok ? 1 : 0, String(verdict.outcome || 'fail'), verdict.statusCode ?? null, verdict.latencyMs ?? null, verdict.latencyExceeded ? 1 : 0, verdict.error || null, now).run()
  const failed = !verdict.ok
  const consecutiveFailures = failed ? Number(check.consecutive_failures || 0) + 1 : 0
  const lastStatus = verdict.outcome === 'timeout' ? 'timeout' : failed ? 'fail' : 'success'
  await env.DB.prepare('update synthetic_checks set last_status=?, last_run_at=?, consecutive_failures=?, updated_at=? where id=?')
    .bind(lastStatus, now, consecutiveFailures, now, check.id).run()
  // 恢复（连续成功）首版仅归零计数，不发恢复通知（Lead 决策）
  if (failed && consecutiveFailures === Number(check.fail_threshold || 3)) {
    await recordSyntheticAlertW(env, check, verdict, consecutiveFailures)
  }
  return { ok: Boolean(verdict.ok), outcome: String(verdict.outcome || 'fail'), status_code: verdict.statusCode ?? null, latency_ms: verdict.latencyMs ?? null, latency_exceeded: Boolean(verdict.latencyExceeded), error: verdict.error || null }
}

/** 写 alert_history(metric='synthetic') + 复用 createAlertDeliveries 投递（30min 冷却；对齐 sloEvaluateW 范式）。 */
async function recordSyntheticAlertW(env, check, verdict, consecutiveFailures) {
  const level = Number(check.fail_threshold) <= 3 ? 'critical' : 'warning'
  const recent = await env.DB.prepare(`select id, created_at from alert_history where metric='synthetic' and app_id=? and json_extract(context_json,'$.checkId')=? and level=? order by created_at desc limit 1`)
    .bind(check.app_id, check.id, level).first()
  if (recent && Date.now() - Number(recent.created_at) < 30 * 60 * 1000) return null
  const now = Date.now()
  const message = `[Web Collection] 合成监控「${check.name}」连续 ${consecutiveFailures} 次探测失败（${verdict.outcome}）：${verdict.error || '-'}`
  const context = JSON.stringify({ checkId: check.id, checkName: check.name, url: check.url, outcome: verdict.outcome, error: verdict.error || null, consecutiveFailures })
  const result = await env.DB.prepare('insert into alert_history(app_id,metric,fingerprint,level,value,message,threshold,notified,context_json,created_at) values(?,?,?,?,?,?,?,0,?,?)')
    .bind(check.app_id, 'synthetic', `synthetic:${check.id}`, level, consecutiveFailures, message, Number(check.fail_threshold || 3), context, now).run()
  await createAlertDeliveries(env, Number(result.meta.last_row_id))
  return { id: Number(result.meta.last_row_id), level, message }
}

/** GET /api/synthetic/:id/timeline：最近 N 次结果时间线（默认 50，max 200）。 */
async function syntheticTimelineW(env, auth, id, url) {
  const check = await env.DB.prepare('select * from synthetic_checks where id=?').bind(id).first()
  if (!check) return json({ error: '探针不存在' }, 404)
  const authz = syntheticAuthzW(env, check, auth); if (authz) return authz
  const limit = Math.max(1, Math.min(200, Math.floor(Number(url.searchParams.get('limit')) || 50)))
  const rows = (await env.DB.prepare('select * from synthetic_results where check_id=? order by checked_at desc limit ?').bind(id, limit).all()).results || []
  return json({
    items: rows.map(r => ({
      checkedAt: Number(r.checked_at), ok: Number(r.ok) === 1, outcome: r.outcome,
      statusCode: r.status_code == null ? null : Number(r.status_code),
      latencyMs: r.latency_ms == null ? null : Number(r.latency_ms),
      latencyExceeded: Number(r.latency_exceeded) === 1, error: r.error || null
    }))
  })
}

/** GET /api/synthetic/:id/stats：可用率 + P50/P95（D1 无 percentile_cont，排序切片近端近似，架构 §4.1 差异点）。 */
async function syntheticStatsW(env, auth, id, url) {
  const check = await env.DB.prepare('select * from synthetic_checks where id=?').bind(id).first()
  if (!check) return json({ error: '探针不存在' }, 404)
  const authz = syntheticAuthzW(env, check, auth); if (authz) return authz
  const windowMsMap = { '1h': 3600000, '24h': 86400000, '7d': 7 * 86400000 }
  const requested = String(url.searchParams.get('window') || '24h')
  const window = windowMsMap[requested] ? requested : '24h'
  const start = Date.now() - windowMsMap[window]
  const countRow = await env.DB.prepare('select count(*) total, sum(case when ok=1 then 1 else 0 end) ok_count, sum(latency_exceeded) exceeded from synthetic_results where check_id=? and checked_at>=?').bind(id, start).first()
  const total = Number(countRow?.total || 0)
  const okCount = Number(countRow?.ok_count || 0)
  const latencyRows = (await env.DB.prepare('select latency_ms from synthetic_results where check_id=? and checked_at>=? and latency_ms is not null order by latency_ms').bind(id, start).all()).results || []
  const latencies = latencyRows.map(r => Number(r.latency_ms)).filter(Number.isFinite)
  const pick = ratio => {
    if (!latencies.length) return null
    const idx = Math.min(latencies.length - 1, Math.max(0, Math.ceil(latencies.length * ratio) - 1))
    return latencies[idx]
  }
  return json({ window, total, okCount, availability: total > 0 ? okCount / total : null, p50: pick(0.5), p95: pick(0.95), latencyExceededCount: Number(countRow?.exceeded || 0) })
}

/** 定时 tick：每分钟取到期探针执行（SYNTHETIC_ENABLED≠1 首行空转零开销；单批 ≤20 条超出顺延；单探针异常不阻断）。 */
async function syntheticTickW(env) {
  if (env.SYNTHETIC_ENABLED !== '1') return
  const now = Date.now()
  const rows = (await env.DB.prepare('select * from synthetic_checks where enabled=1 and (last_run_at is null or last_run_at + interval_seconds * 1000 <= ?) order by last_run_at asc limit ?').bind(now, TICK_BATCH_LIMIT).all()).results || []
  for (const check of rows) {
    try { await syntheticRunProbeW(env, check) } catch (e) { console.error('[synthetic-tick] failed', check?.id, e?.message) }
  }
}

// ==================== D1 · 数据主体权利 DSR（镜像 apps/api/src/services/dsr-service.js；仅 D1 方言差异） ====================
// 命中口径：events/replays 主体列 = 精确匹配；issues 无独立个人列 → props_json/original_json like（D1 TEXT 列）。
// 擦除默认匿名化 '[DSR-ERASED]'（session_id 保留）；分批 ≤10000 行/批（id/rowid 子查询圈定），批间 50ms；计数读 meta.changes。
// Node 侧回放存 replay_events（多段行），D1 侧存 replays（会话段行）——表名方言差异，列语义一致。
// access 导出三表分别拉行 ≤10000（超限截断 + result_json 标注）；完成后 subject_value 清空 '[DSR-CLEARED]'（PRD §8.1）。

const DSR_ERASED_W = '[DSR-ERASED]'
const DSR_CLEARED_W = '[DSR-CLEARED]'
// QA #3 裁决：批大小 10000 → 1000（D1 单语句友好）；单次调用 ≤30 批（30000 行），耗尽返回 partial 并保持
// executing，前端「继续执行」复用 execute 端点幂等重跑（剩余行已擦不再命中，自然收敛）。双端同值。
const DSR_BATCH_W = 1000
const DSR_MAX_BATCHES_W = 30
const DSR_EVENT_COL_W = { user_id: 'user_id', user_name: 'user_name', user_phone: 'user_phone', device_id: 'device_id', session_id: 'session_id' }
const DSR_REPLAY_COL_W = { user_id: 'user_id', user_name: 'user_name', user_phone: 'user_phone', device_id: null, session_id: 'session_id' }
const DSR_TRANSITIONS_W = {
  draft: ['pending_approval', 'cancelled'],
  pending_approval: ['approved', 'rejected', 'cancelled'],
  approved: ['executing'],
  executing: ['completed'],
  completed: [], rejected: [], cancelled: []
}
const DSR_STATUS_ACTION_W = { pending_approval: 'submit', approved: 'approve', rejected: 'reject', cancelled: 'cancel', completed: 'complete' }

/** D1 守卫：DSR 能力未开启（env.DSR_ENABLED≠1）时统一 503（复刻 guardSyntheticW 范式）。 */
function guardDsrW(env, run) {
  if (env.DSR_ENABLED !== '1') return json({ error: 'DSR 能力未开启（需设置 DSR_ENABLED=1）' }, 503)
  return run()
}

/** 操作者断言（返回 Response 或 null）：账号体系开启 + 已登录 + 权限点（全为 admin+）。 */
function dsrActorCheckW(env, auth, permission) {
  if (!accountsEnabled(env) || !auth?.userId) return json({ error: 'DSR 需要开启账号体系并登录（ACCOUNTS_ENABLED=1）' }, 403)
  if (!hasPermission(auth.role, permission)) return json({ error: '无 DSR 操作权限（需要 Admin 及以上角色）' }, 403)
  return null
}

/** 团队可见性断言（返回 Response 或 null，对齐 Node assertRequestVisible / syntheticAuthzW 范式）。 */
function dsrVisibleCheckW(env, row, auth) {
  if (!accountsEnabled(env)) return null
  if (auth?.via !== 'session' || !auth.teamId) return null
  if (row.team_id && row.team_id !== auth.teamId) return json({ error: '无权访问该 DSR 工单（跨团队）' }, 403)
  return null
}

/** 应用范围子句（三表统一；对齐 Node appScope）。 */
async function dsrAppScopeW(env, auth, appId) {
  const appIdNorm = clip(appId || '', 64).trim()
  if (appIdNorm) {
    if (accountsEnabled(env) && auth?.via === 'session' && auth.teamId) {
      const app = await env.DB.prepare('select app_id, team_id from applications where app_id=?').bind(appIdNorm).first()
      if (app && app.team_id && app.team_id !== auth.teamId) return { forbidden: json({ error: '目标应用不属于当前团队' }, 403) }
    }
    return { sql: ' and app_id = ?', vals: [appIdNorm] }
  }
  if (accountsEnabled(env) && auth?.via === 'session' && auth.teamId) {
    const apps = (await env.DB.prepare('select app_id from applications where team_id=?').bind(auth.teamId).all()).results || []
    if (!apps.length) return { sql: ' and 1=0', vals: [] }
    return { sql: ` and app_id in (${apps.map(() => '?').join(',')})`, vals: apps.map(row => row.app_id) }
  }
  return { sql: '', vals: [] }
}

/**
 * issues 保守口径命中片段。
 * D1 方言：issues 表无 users_json 列（D1 聚合未存该字段，主体数据仅在 props/original），
 * 故为 props_json OR original_json 两列 LIKE；PG 侧为三列口径（apps/api/src/services/dsr-service.js issuesHitSql）。
 * 未来 D1 issues 增列 users_json 时需同步恢复三列（QA Round 2 · Lead 裁决方案二）。
 */
const DSR_ISSUES_HIT_W = `(props_json like ? or original_json like ?)`

/** 三表命中量计数（对齐 Node countHits；device_id 主体在回放表无列 → 恒 0）。 */
async function dsrCountHitsW(env, scope, subjectType, subjectValue) {
  const eventCol = DSR_EVENT_COL_W[subjectType], replayCol = DSR_REPLAY_COL_W[subjectType]
  // D1 两列口径（无 users_json 列，见 DSR_ISSUES_HIT_W 注释；PG 侧三列）
  const likeVals = [`%${subjectValue}%`, `%${subjectValue}%`]
  const [eventsRow, replaysRow, issuesRow] = await Promise.all([
    env.DB.prepare(`select count(*) count from events where 1=1${scope.sql} and ${eventCol} = ?`).bind(...scope.vals, subjectValue).first(),
    replayCol
      ? env.DB.prepare(`select count(*) count from replays where 1=1${scope.sql} and ${replayCol} = ?`).bind(...scope.vals, subjectValue).first()
      : Promise.resolve({ count: 0 }),
    env.DB.prepare(`select count(*) count from issues where 1=1${scope.sql} and ${DSR_ISSUES_HIT_W}`).bind(...scope.vals, ...likeVals).first()
  ])
  return { events: Number(eventsRow?.count || 0), issues: Number(issuesRow?.count || 0), replays: Number(replaysRow?.count || 0) }
}

/** append-only 审计写入（失败不阻塞业务，对齐 writeTeamAuditW 容错风格）。 */
async function dsrAuditInsertW(env, requestId, actorId, action, detail = {}) {
  try {
    await env.DB.prepare('insert into dsr_audit_logs (id, request_id, actor_id, action, detail_json, ts) values (?,?,?,?,?,?)')
      .bind(`dal_${randomToken(12)}`, requestId, clip(actorId || 'system', 64), clip(action, 24), JSON.stringify(detail || {}).slice(0, 8000), Date.now()).run()
  } catch { /* 审计失败不阻塞业务响应 */ }
}

/** 状态迁移（对齐 Node transition）：非法迁移 409 + 审计留痕；approve 自批 403。返回 Response 或 null。 */
async function dsrTransitionW(env, row, to, actorId, patch = {}, actionOverride = null) {
  if (!(DSR_TRANSITIONS_W[row.status] || []).includes(to)) {
    await dsrAuditInsertW(env, row.id, actorId, 'illegal_transition', { from: row.status, to })
    return json({ error: `非法状态迁移：${row.status} → ${to}` }, 409)
  }
  if (to === 'approved' && String(actorId) === String(row.requested_by)) {
    // QA #2：自批拦截落审计（action='blocked'），与 Node 端同逻辑，保证审批制衡留痕零缺口
    await dsrAuditInsertW(env, row.id, actorId, 'blocked', { reason: 'self_approve', from: row.status, to })
    return json({ error: '审批人不得为发起人（双人制衡）' }, 403)
  }
  const keys = ['status', ...Object.keys(patch)], vals = [to, ...Object.values(patch)]
  await env.DB.prepare(`update dsr_requests set ${keys.map(key => `${key}=?`).join(', ')} where id=?`).bind(...vals, row.id).run()
  await dsrAuditInsertW(env, row.id, actorId, actionOverride || DSR_STATUS_ACTION_W[to] || to, { from: row.status, to, ...patch })
  return null
}

/** D1 行 → API 视图（对齐 Node publicRequest；双栈同 JSON 形状）。 */
function dsrViewW(row) {
  return {
    id: row.id, teamId: row.team_id || null, appId: row.app_id || '',
    subjectType: row.subject_type, subjectValue: row.subject_value,
    requestType: row.request_type, mode: row.mode || null, exportFormat: row.export_format || null,
    status: row.status,
    hitEvents: Number(row.hit_events || 0), hitIssues: Number(row.hit_issues || 0), hitReplays: Number(row.hit_replays || 0),
    requestedBy: row.requested_by, approvedBy: row.approved_by || null, executedBy: row.executed_by || null,
    rejectReason: row.reject_reason || null,
    rowsAffectedEvents: Number(row.rows_affected_events || 0), rowsAffectedIssues: Number(row.rows_affected_issues || 0), rowsAffectedReplays: Number(row.rows_affected_replays || 0),
    result: parse(row.result_json, null),
    createdAt: Number(row.created_at),
    decidedAt: row.decided_at == null ? null : Number(row.decided_at),
    executedAt: row.executed_at == null ? null : Number(row.executed_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at)
  }
}

function dsrAuditViewW(row) {
  return { id: row.id, requestId: row.request_id, actorId: row.actor_id, action: row.action, detail: parse(row.detail_json, {}), ts: Number(row.ts) }
}

async function dsrRequireW(env, auth, id) {
  const row = await env.DB.prepare('select * from dsr_requests where id=?').bind(clip(id || '', 32)).first()
  if (!row) return { error: json({ error: 'DSR 工单不存在' }, 404) }
  const denied = dsrVisibleCheckW(env, row, auth)
  if (denied) return { error: denied }
  return { row }
}

/** 输入收敛（对齐 Node normalizeCreateInput）。 */
function dsrNormalizeCreateW(input) {
  const subjectType = String(input.subjectType || '').trim()
  if (!Object.keys(DSR_EVENT_COL_W).includes(subjectType)) return { error: `subjectType 必须为 ${Object.keys(DSR_EVENT_COL_W).join(' / ')}` }
  const subjectValue = String(input.subjectValue || '').trim().slice(0, 256)
  if (!subjectValue) return { error: 'subjectValue 不能为空' }
  const requestType = input.requestType === 'erasure' ? 'erasure' : input.requestType === 'access' ? 'access' : null
  if (!requestType) return { error: 'requestType 必须为 access | erasure' }
  let mode = null, exportFormat = null
  if (requestType === 'erasure') {
    mode = input.mode === 'hard_delete' ? 'hard_delete' : 'anonymize'
    if (mode === 'hard_delete' && !String(input.reason || '').trim()) return { error: '硬删除必须填写理由（审批与审计留痕）' }
  } else {
    exportFormat = input.exportFormat === 'json' ? 'json' : 'csv'
  }
  return { value: { subjectType, subjectValue, requestType, mode, exportFormat, reason: clip(input.reason || '', 512).trim() } }
}

/** POST /api/dsr/requests：创建工单（draft）+ 命中量快照 + 审计 create。 */
async function dsrCreateW(request, env, auth) {
  const actorCheck = dsrActorCheckW(env, auth, 'dsrCreate')
  if (actorCheck) return actorCheck
  const input = await request.json().catch(() => ({}))
  const normalized = dsrNormalizeCreateW(input)
  if (normalized.error) return json({ error: normalized.error }, 400)
  const v = normalized.value
  const scope = await dsrAppScopeW(env, auth, input.appId)
  if (scope.forbidden) return scope.forbidden
  const hits = await dsrCountHitsW(env, scope, v.subjectType, v.subjectValue)
  const id = `dsr_${randomToken(12)}`
  const now = Date.now()
  const teamId = accountsEnabled(env) && auth?.teamId ? auth.teamId : null
  await env.DB.prepare(
    `insert into dsr_requests (id, team_id, app_id, subject_type, subject_value, request_type, mode, export_format, status,
      hit_events, hit_issues, hit_replays, requested_by, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`
  ).bind(id, teamId, clip(input.appId || '', 64), v.subjectType, v.subjectValue, v.requestType, v.mode, v.exportFormat, hits.events, hits.issues, hits.replays, auth.userId, now).run()
  await dsrAuditInsertW(env, id, auth.userId, 'create', {
    subjectType: v.subjectType, requestType: v.requestType, mode: v.mode, exportFormat: v.exportFormat,
    appId: clip(input.appId || '', 64), teamId, hits, hardDeleteReason: v.mode === 'hard_delete' ? v.reason : undefined
  })
  const row = await env.DB.prepare('select * from dsr_requests where id=?').bind(id).first()
  return json(dsrViewW(row))
}

/** GET /api/dsr/requests：列表（status/requestType/appId 过滤 + team 会话团队过滤）。 */
async function dsrListW(env, auth, url) {
  const actorCheck = dsrActorCheckW(env, auth, 'dsrView')
  if (actorCheck) return actorCheck
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize')) || 20))
  const parts = [], vals = []
  if (url.searchParams.get('status')) { parts.push('status=?'); vals.push(clip(url.searchParams.get('status'), 24)) }
  if (url.searchParams.get('requestType')) { parts.push('request_type=?'); vals.push(clip(url.searchParams.get('requestType'), 16)) }
  if (url.searchParams.get('appId')) { parts.push('app_id=?'); vals.push(clip(url.searchParams.get('appId'), 64)) }
  if (accountsEnabled(env) && auth?.via === 'session' && auth.teamId) { parts.push('(team_id is null or team_id=?)'); vals.push(auth.teamId) }
  const where = parts.length ? `where ${parts.join(' and ')}` : ''
  const [rows, totalRow] = await Promise.all([
    env.DB.prepare(`select * from dsr_requests ${where} order by created_at desc limit ? offset ?`).bind(...vals, pageSize, (page - 1) * pageSize).all(),
    env.DB.prepare(`select count(*) count from dsr_requests ${where}`).bind(...vals).first()
  ])
  return json({ items: ((rows.results || [])).map(dsrViewW), total: Number(totalRow?.count || 0), page, pageSize })
}

/** GET /api/dsr/requests/:id：详情（工单 + 审计时间线一次带出，对齐 Node getDsrRequest）。 */
async function dsrDetailW(env, auth, id) {
  const actorCheck = dsrActorCheckW(env, auth, 'dsrView')
  if (actorCheck) return actorCheck
  const required = await dsrRequireW(env, auth, id)
  if (required.error) return required.error
  const auditRows = (await env.DB.prepare('select * from dsr_audit_logs where request_id=? order by ts asc limit 500').bind(required.row.id).all()).results || []
  return json({ request: dsrViewW(required.row), audit: auditRows.map(dsrAuditViewW) })
}

/** POST /:id/submit：draft → pending_approval。 */
async function dsrSubmitW(env, auth, id) {
  const actorCheck = dsrActorCheckW(env, auth, 'dsrCreate')
  if (actorCheck) return actorCheck
  const required = await dsrRequireW(env, auth, id)
  if (required.error) return required.error
  const denied = await dsrTransitionW(env, required.row, 'pending_approval', auth.userId)
  if (denied) return denied
  const row = await env.DB.prepare('select * from dsr_requests where id=?').bind(required.row.id).first()
  return json(dsrViewW(row))
}

/** POST /:id/approve：{decision, reason?}；approve 写 approved_by/decided_at，reject 写 reject_reason。 */
async function dsrApproveW(request, env, auth, id) {
  const actorCheck = dsrActorCheckW(env, auth, 'dsrApprove')
  if (actorCheck) return actorCheck
  const required = await dsrRequireW(env, auth, id)
  if (required.error) return required.error
  const input = await request.json().catch(() => ({}))
  const decision = input.decision === 'reject' ? 'reject' : input.decision === 'approve' ? 'approve' : null
  if (!decision) return json({ error: 'decision 必须为 approve | reject' }, 400)
  const now = Date.now(), row = required.row
  if (decision === 'approve') {
    const denied = await dsrTransitionW(env, row, 'approved', auth.userId, { approved_by: auth.userId, decided_at: now })
    if (denied) return denied
  } else {
    const reason = clip(input.reason || '', 512).trim() || null
    const denied = await dsrTransitionW(env, row, 'rejected', auth.userId, { reject_reason: reason, decided_at: now })
    if (denied) return denied
  }
  const next = await env.DB.prepare('select * from dsr_requests where id=?').bind(row.id).first()
  return json(dsrViewW(next))
}

/** POST /:id/cancel：仅发起人本人，draft/pending_approval 可取消。 */
async function dsrCancelW(env, auth, id) {
  const actorCheck = dsrActorCheckW(env, auth, 'dsrCreate')
  if (actorCheck) return actorCheck
  const required = await dsrRequireW(env, auth, id)
  if (required.error) return required.error
  if (String(auth.userId) !== String(required.row.requested_by)) return json({ error: '仅发起人本人可取消工单' }, 403)
  const denied = await dsrTransitionW(env, required.row, 'cancelled', auth.userId)
  if (denied) return denied
  const row = await env.DB.prepare('select * from dsr_requests where id=?').bind(required.row.id).first()
  return json(dsrViewW(row))
}

/**
 * events / replays 分批匿名化或硬删（D1 方言）：
 * events 按 uuid 主键 id 子查询圈定；replays 无主键列 → 用 SQLite rowid 圈定。
 * 计数读 r.meta.changes；已擦除行不再命中主体条件 → 分批自然收敛。
 * QA #3：budget 为跨表共享预算对象 {left}，单次调用 ≤DSR_MAX_BATCHES_W(30) 批，耗尽返回 {partial:true}。
 */
async function dsrEraseRowsW(env, table, pkCol, hitWhere, hitVals, mode, withDeviceId, budget) {
  let changed = 0
  for (let i = 0; i < DSR_MAX_BATCHES_W; i++) {
    if (budget.left <= 0) return { changed, partial: true }
    budget.left--
    let result
    if (mode === 'hard_delete') {
      result = await env.DB.prepare(`delete from ${table} where ${pkCol} in (select ${pkCol} from ${table} where ${hitWhere} limit ${DSR_BATCH_W})`).bind(...hitVals).run()
    } else {
      const sets = withDeviceId ? 'user_id=?, user_name=?, user_phone=?, device_id=?' : 'user_id=?, user_name=?, user_phone=?'
      result = await env.DB.prepare(`update ${table} set ${sets} where ${pkCol} in (select ${pkCol} from ${table} where ${hitWhere} limit ${DSR_BATCH_W})`)
        .bind(...(withDeviceId ? [DSR_ERASED_W, DSR_ERASED_W, DSR_ERASED_W, DSR_ERASED_W] : [DSR_ERASED_W, DSR_ERASED_W, DSR_ERASED_W]), ...hitVals).run()
    }
    const affected = Number(result?.meta?.changes || 0)
    changed += affected
    if (affected < DSR_BATCH_W) return { changed, partial: false }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return { changed, partial: true }
}

/** issues 聚合表匿名化（Lead 裁决②保守口径；D1 两列口径：无 users_json 列，见 DSR_ISSUES_HIT_W 注释）：like 命中原文整段替换占位符；affected_users 口径不减。 */
async function dsrEraseIssuesW(env, scope, subjectValue) {
  const result = await env.DB.prepare(
    `update issues set props_json=replace(props_json, ?, ?), original_json=replace(original_json, ?, ?)
     where 1=1${scope.sql} and ${DSR_ISSUES_HIT_W}`
  ).bind(subjectValue, DSR_ERASED_W, subjectValue, DSR_ERASED_W, ...scope.vals, `%${subjectValue}%`, `%${subjectValue}%`).run()
  return Number(result?.meta?.changes || 0)
}

/** 擦除执行主流程（对齐 Node executeErasure；replays 表用 rowid 圈定；跨表共享预算，耗尽即 partial）。 */
async function dsrExecuteErasureW(env, row, scope) {
  const subjectValue = row.subject_value
  const eventCol = DSR_EVENT_COL_W[row.subject_type], replayCol = DSR_REPLAY_COL_W[row.subject_type]
  const batches = []
  // 跨表共享批次预算（QA #3：单次调用 ≤30 批 = 30000 行，耗尽即 partial，工单保持 executing）
  const budget = { left: DSR_MAX_BATCHES_W }
  const eventRes = await dsrEraseRowsW(env, 'events', 'id', `1=1${scope.sql} and ${eventCol} = ?`, [...scope.vals, subjectValue], row.mode, true, budget)
  batches.push({ table: 'events', changed: eventRes.changed })
  let replayChanged = 0
  if (replayCol && budget.left > 0) {
    const replayRes = await dsrEraseRowsW(env, 'replays', 'rowid', `1=1${scope.sql} and ${replayCol} = ?`, [...scope.vals, subjectValue], row.mode, false, budget)
    replayChanged = replayRes.changed
  }
  batches.push({ table: 'replays', changed: replayChanged })
  let issueChanged = 0
  if (budget.left > 0) {
    issueChanged = await dsrEraseIssuesW(env, scope, subjectValue)
  }
  batches.push({ table: 'issues', changed: issueChanged })
  const rowsAffected = { events: eventRes.changed, issues: issueChanged, replays: replayChanged }
  const processed = eventRes.changed + issueChanged + replayChanged
  const partial = eventRes.partial || budget.left <= 0
  return { rowsAffected, batches, partial, processed }
}

/** CSV 序列化（对齐 worker exportCsv 内联 cell 助手）。 */
function dsrCsvOfW(rows) {
  if (!rows.length) return ''
  const keys = Object.keys(rows[0])
  const cell = v => `"${String(v ?? '').replaceAll('"', '""')}"`
  return [keys.map(cell).join(','), ...rows.map(r => keys.map(k => cell(r[k])).join(','))].join('\r\n')
}

/** access 导出（对齐 Node buildExport；replays 导出排除 events_json 录屏大字段）。 */
async function dsrBuildExportW(env, row, scope) {
  const subjectValue = row.subject_value
  // D1 两列口径（无 users_json 列，见 DSR_ISSUES_HIT_W 注释；PG 侧三列）
  const likeVals = [`%${subjectValue}%`, `%${subjectValue}%`]
  const eventCol = DSR_EVENT_COL_W[row.subject_type], replayCol = DSR_REPLAY_COL_W[row.subject_type]
  const limit = DSR_BATCH_W
  const [eventRows, issueRows, replayRows] = await Promise.all([
    env.DB.prepare(`select * from events where 1=1${scope.sql} and ${eventCol} = ? order by ts desc limit ${limit}`).bind(...scope.vals, subjectValue).all(),
    env.DB.prepare(`select * from issues where 1=1${scope.sql} and ${DSR_ISSUES_HIT_W} order by last_seen desc limit ${limit}`).bind(...scope.vals, ...likeVals).all(),
    replayCol
      ? env.DB.prepare(`select session_id, app_id, user_id, user_name, user_phone, created_at, url, release_name, end_reason, base_session_id, user_agent
                        from replays where 1=1${scope.sql} and ${replayCol} = ? order by created_at desc limit ${limit}`).bind(...scope.vals, subjectValue).all()
      : Promise.resolve({ results: [] })
  ])
  const datasets = { events: eventRows.results || [], issues: issueRows.results || [], replays: replayRows.results || [] }
  const files = []
  const rowsAffected = { events: 0, issues: 0, replays: 0 }
  for (const kind of ['events', 'issues', 'replays']) {
    const rows = datasets[kind]
    rowsAffected[kind] = rows.length
    const name = `dsr-${row.id}-${kind}.${row.export_format === 'json' ? 'json' : 'csv'}`
    const content = row.export_format === 'json'
      ? JSON.stringify({ kind, requestId: row.id, subjectType: row.subject_type, count: rows.length, rows }, null, 2)
      : '\ufeff' + dsrCsvOfW(rows)
    files.push({ kind, name, content })
  }
  const truncated = rowsAffected.events >= limit || rowsAffected.issues >= limit || rowsAffected.replays >= limit
  const result = {
    format: row.export_format || 'csv',
    truncated,
    note: truncated ? '命中超过单表 10000 行上限，导出已截断，全量走 JSON 分页导出（P1-3 规划中）' : null,
    replayExported: rowsAffected.replays > 0
  }
  return { files, rowsAffected, result }
}

/** POST /:id/execute：approved → executing（占位防并发）→ 执行 → completed（对齐 Node executeDsrRequest）。 */
async function dsrExecuteW(request, env, auth, id) {
  const actorCheck = dsrActorCheckW(env, auth, 'dsrExecute')
  if (actorCheck) return actorCheck
  const required = await dsrRequireW(env, auth, id)
  if (required.error) return required.error
  const row = required.row
  const body = await request.json().catch(() => ({}))
  const scope = await dsrAppScopeW(env, auth, row.app_id)
  if (scope.forbidden) return scope.forbidden
  const isErasure = row.request_type === 'erasure'
  if (isErasure && row.mode === 'hard_delete' && body?.hardDeleteConfirmed !== true) {
    return json({ error: '硬删除需显式确认（hardDeleteConfirmed=true，不可逆操作）' }, 400)
  }
  if (!isErasure && Number(row.hit_replays || 0) > 0 && body?.replaysConfirm !== true) {
    return json({ error: '导出包含会话回放（录屏敏感数据），需勾选确认（replaysConfirm=true）' }, 400)
  }
  const now = Date.now()
  // 占位迁移：approved → executing（防并发重复执行）。
  // QA #3 续跑语义：partial 后工单保持 executing，本端点幂等重跑（跳过迁移）；其余非 approved 状态仍走状态机 409 兜底
  if (row.status !== 'executing') {
    const denied = await dsrTransitionW(env, row, 'executing', auth.userId, { executed_by: auth.userId, executed_at: now }, isErasure ? 'execute_erasure' : 'execute_export')
    if (denied) return denied
  }
  try {
    const outcome = isErasure
      ? await dsrExecuteErasureW(env, row, scope)
      : await dsrBuildExportW(env, row, scope)
    // QA #3 partial 语义：单次调用预算耗尽（>30 批）→ 工单保持 executing 不回滚、不 completed；
    // rows_affected_* 累加（多调用累计），前端「继续执行」幂等重跑
    if (isErasure && outcome.partial) {
      await env.DB.prepare(
        `update dsr_requests set rows_affected_events=rows_affected_events+?, rows_affected_issues=rows_affected_issues+?, rows_affected_replays=rows_affected_replays+?
         where id=? and status='executing'`
      ).bind(outcome.rowsAffected.events, outcome.rowsAffected.issues, outcome.rowsAffected.replays, row.id).run()
      await dsrAuditInsertW(env, row.id, auth.userId, 'execute_erasure', {
        stage: 'partial', mode: row.mode, processed: outcome.processed,
        rowsAffected: outcome.rowsAffected, batches: outcome.batches,
        note: `单次调用处理上限 ${DSR_MAX_BATCHES_W} 批（${DSR_MAX_BATCHES_W * DSR_BATCH_W} 行），可再次执行继续`
      })
      const current = await env.DB.prepare('select * from dsr_requests where id=?').bind(row.id).first()
      return json({ request: dsrViewW(current), rowsAffected: outcome.rowsAffected, batches: outcome.batches, partial: true, processed: outcome.processed })
    }
    const resultNote = isErasure ? { mode: row.mode } : outcome.result
    await env.DB.prepare(
      `update dsr_requests set status='completed', rows_affected_events=rows_affected_events+?, rows_affected_issues=rows_affected_issues+?, rows_affected_replays=rows_affected_replays+?,
        executed_by=?, executed_at=?, completed_at=?, subject_value=?, result_json=? where id=? and status='executing'`
    ).bind(outcome.rowsAffected.events, outcome.rowsAffected.issues, outcome.rowsAffected.replays, auth.userId, now, now, DSR_CLEARED_W, JSON.stringify(resultNote), row.id).run()
    await dsrAuditInsertW(env, row.id, auth.userId, isErasure ? 'execute_erasure' : 'execute_export', {
      stage: 'done', mode: row.mode, rowsAffected: outcome.rowsAffected,
      batches: isErasure ? outcome.batches : undefined,
      files: isErasure ? undefined : outcome.files.map(f => ({ kind: f.kind, name: f.name })),
      result: resultNote
    })
    await dsrAuditInsertW(env, row.id, auth.userId, 'complete', { rowsAffected: outcome.rowsAffected, subjectValueCleared: true })
    const done = await env.DB.prepare('select * from dsr_requests where id=?').bind(row.id).first()
    return isErasure
      ? json({ request: dsrViewW(done), rowsAffected: outcome.rowsAffected, batches: outcome.batches })
      : json({ request: dsrViewW(done), files: outcome.files, rowsAffected: outcome.rowsAffected, result: outcome.result })
  } catch (err) {
    // 执行失败：executing 回滚 approved（可重试）；审计留痕
    await env.DB.prepare(`update dsr_requests set status='approved' where id=? and status='executing'`).bind(row.id).run()
    await dsrAuditInsertW(env, row.id, auth.userId, 'illegal_transition', { from: 'executing', to: 'approved', reason: clip(err?.message || err, 300) })
    throw err
  }
}

/** GET /:id/audit：审计时间线（ts 升序，PRD §9 举证口径零缺口）。 */
async function dsrAuditW(env, auth, id) {
  const actorCheck = dsrActorCheckW(env, auth, 'dsrView')
  if (actorCheck) return actorCheck
  const required = await dsrRequireW(env, auth, id)
  if (required.error) return required.error
  const rows = (await env.DB.prepare('select * from dsr_audit_logs where request_id=? order by ts asc limit 500').bind(required.row.id).all()).results || []
  return json({ items: rows.map(dsrAuditViewW) })
}


async function alert(env,event,issue,ctx){
  const config=(await settings(env)).alerts
  if(!config.enabled)return
  const metric=event.type==='log'?'log_error':event.type==='error'&&issue?.status==='regression'?'regression':event.type==='error'?'error':String(event.metric||'').toLowerCase(),threshold=Number(config[metric])
  if(event.type==='perf'&&(!Number.isFinite(threshold)||event.value<=threshold))return
  if(event.type==='log'&&!config.logError||metric==='regression'&&!config.regression||metric==='error'&&(!config.error||Number(issue?.count||1)<Number(config.errorCount||1)))return
  const since=Date.now()-config.cooldownMinutes*60000
  const fingerprint=issue?.fingerprint||await sha256(event.type==='error'?issueKey(event):`${event.metric||event.name||event.type}:${event.url||event.path||''}`)
  const recent=await env.DB.prepare('select id from alert_history where app_id=? and metric=? and fingerprint=? and created_at>=?').bind(event.appId,metric,fingerprint,since).first()
  if(recent)return
  const now=Date.now(),level=metric==='regression'?'critical':event.type==='perf'?'warning':'error'
  const result=await env.DB.prepare('insert into alert_history(app_id,metric,fingerprint,level,value,message,threshold,notified,context_json,created_at) values(?,?,?,?,?,?,?,0,?,?)').bind(event.appId,metric,fingerprint,level,event.value||1,alertMessage(event,metric,threshold),threshold,JSON.stringify(alertContext(event,event.type==='perf'?threshold:undefined)),now).run()
  await createAlertDeliveries(env,Number(result.meta.last_row_id))
  // M5：告警触发自动诊断（error/regression 时异步补充分析，写回 alert_history.context_json.diagnosis；静默降级不影响告警主流程）
  if((metric==='error'||metric==='regression')&&ctx)ctx.waitUntil(maybeAutoDiagnose({
    env,
    db:{ prepare: sql => env.DB.prepare(sql) },
    alertId:Number(result.meta.last_row_id),
    appId:event.appId,
    issueId:issue?.fingerprint,
    traceId:event.traceId
  }))
}
export function alertMessage(event,metric,threshold){const page=event.path||event.url||'-';if(event.type==='perf'){const unit=metric==='cls'?'':'ms';return`[Web Collection] ${event.appId} ${metric.toUpperCase()} ${event.value}${unit}，超过阈值 ${threshold}${unit}，页面 ${page}`}return`[Web Collection] ${event.appId} ${event.name||metric}: ${event.message||'未知错误'}，页面 ${page}，版本 ${event.release||'-'}，Trace ${event.traceId||'-'}`}

async function alertChannelList(env,url){
  const page=Math.max(1,Number(url.searchParams.get('page')||1)),pageSize=Math.max(1,Math.min(100,Number(url.searchParams.get('pageSize')||10)))
  const [rows,total]=await Promise.all([
    env.DB.prepare('select * from alert_channels order by updated_at desc limit ? offset ?').bind(pageSize,(page-1)*pageSize).all(),
    env.DB.prepare('select count(*) count from alert_channels').first()
  ])
  return json({items:rows.results.map(publicChannel),total:Number(total.count),page,pageSize})
}

async function saveAlertChannel(env,id,input){
  const value=normalizeChannel(input),now=Date.now(),existing=id?await env.DB.prepare('select * from alert_channels where id=?').bind(id).first():null
  if(id&&!existing)throw new Error('告警渠道不存在')
  const secrets=Object.keys(value.secrets).length?await encryptSecrets({...await decryptSecrets(existing?.secret_ciphertext,env.ALERT_SECRET_MASTER_KEY),...value.secrets},env.ALERT_SECRET_MASTER_KEY):existing?.secret_ciphertext||null
  const values=[value.name,value.type,value.enabled?1:0,JSON.stringify(value.config),secrets,JSON.stringify(value.appIds),JSON.stringify(value.levels),JSON.stringify(value.metrics),now]
  if(id)await env.DB.prepare('update alert_channels set name=?,type=?,enabled=?,config_json=?,secret_ciphertext=?,app_ids_json=?,levels_json=?,metrics_json=?,updated_at=? where id=?').bind(...values,id).run()
  else{
    const result=await env.DB.prepare('insert into alert_channels(name,type,enabled,config_json,secret_ciphertext,app_ids_json,levels_json,metrics_json,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?)').bind(...values,now).run()
    id=Number(result.meta.last_row_id)
  }
  return json(publicChannel(await env.DB.prepare('select * from alert_channels where id=?').bind(id).first()))
}

async function removeAlertChannel(env,id){
  const now=Date.now()
  await env.DB.prepare(`update alert_deliveries set status='cancelled',last_error='渠道已删除',updated_at=? where channel_id=? and status in ('pending','sending','failed')`).bind(now,id).run()
  await env.DB.prepare('delete from alert_channels where id=?').bind(id).run()
  return json({ok:true})
}

async function testAlertChannel(env,id){
  const channel=await env.DB.prepare('select * from alert_channels where id=?').bind(id).first()
  if(!channel)throw new Error('告警渠道不存在')
  const now=Date.now()
  try{
    await sendChannel(channel,await decryptSecrets(channel.secret_ciphertext,env.ALERT_SECRET_MASTER_KEY),{
      id:'test',appId:'test-app',metric:'error',level:'error',value:1,
      message:'[测试告警] Web Collection 告警渠道配置验证',page:'/governance',release:'test',traceId:'test',createdAt:now
    })
    await env.DB.prepare(`update alert_channels set last_test_status='sent',last_test_error=null,last_test_at=?,updated_at=? where id=?`).bind(now,now,id).run()
    return json({ok:true})
  }catch(error){
    const message=alertError(error)
    await env.DB.prepare(`update alert_channels set last_test_status='failed',last_test_error=?,last_test_at=?,updated_at=? where id=?`).bind(message,now,now,id).run()
    throw new Error(message)
  }
}

async function alertDeliveryList(env,url){
  const page=Math.max(1,Number(url.searchParams.get('page')||1)),pageSize=Math.max(1,Math.min(100,Number(url.searchParams.get('pageSize')||10))),parts=[],values=[]
  if(url.searchParams.get('alertId')){parts.push('alert_id=?');values.push(Number(url.searchParams.get('alertId')))}
  if(url.searchParams.get('status')){parts.push('status=?');values.push(url.searchParams.get('status'))}
  const where=parts.length?`where ${parts.join(' and ')}`:''
  const [rows,total]=await Promise.all([
    env.DB.prepare(`select * from alert_deliveries ${where} order by created_at desc limit ? offset ?`).bind(...values,pageSize,(page-1)*pageSize).all(),
    env.DB.prepare(`select count(*) count from alert_deliveries ${where}`).bind(...values).first()
  ])
  return json({items:rows.results,total:Number(total.count),page,pageSize})
}

async function createAlertDeliveries(env,alertId){
  const alertRow=await env.DB.prepare('select * from alert_history where id=?').bind(alertId).first()
  if(!alertRow)return
  const alertValue=workerAlert(alertRow),channels=(await env.DB.prepare('select * from alert_channels where enabled=1').all()).results
  const matched=channels.filter(channel=>channelMatches(channel,alertValue))
  if(!channels.length&&env.FEISHU_WEBHOOK_URL){
    try{
      await sendChannel({type:'feishu',config_json:'{}'},{url:env.FEISHU_WEBHOOK_URL},alertValue)
      await env.DB.prepare('update alert_history set notified=1,notify_error=null where id=?').bind(alertId).run()
    }catch(error){
      await env.DB.prepare('update alert_history set notified=0,notify_error=? where id=?').bind(alertError(error),alertId).run()
    }
    return
  }
  for(const channel of matched){
    const now=Date.now(),result=await env.DB.prepare(`insert into alert_deliveries(alert_id,channel_id,channel_name,channel_type,status,created_at,updated_at) values(?,?,?,?, 'pending', ?, ?)`).bind(alertId,channel.id,channel.name,channel.type,now,now).run()
    await queueOrDeliverAlert(env,Number(result.meta.last_row_id))
  }
  await updateWorkerAlertStatus(env,alertId)
}

async function retryAlertDelivery(env,id){
  const row=await env.DB.prepare('select alert_id from alert_deliveries where id=?').bind(id).first()
  if(!row)throw new Error('投递记录不存在')
  await env.DB.prepare(`update alert_deliveries set status='pending',last_error=null,queue_message_id=null,updated_at=? where id=?`).bind(Date.now(),id).run()
  await queueOrDeliverAlert(env,id)
  return json(await env.DB.prepare('select * from alert_deliveries where id=?').bind(id).first())
}

async function consumeAlertDelivery(request,env){
  const body=await request.text(),valid=await verifyQStash({
    body,signature:request.headers.get('upstash-signature'),url:request.url,
    currentSigningKey:env.QSTASH_CURRENT_SIGNING_KEY,nextSigningKey:env.QSTASH_NEXT_SIGNING_KEY
  })
  if(!valid)return json({error:'invalid QStash signature'},401)
  const retried=Number(request.headers.get('upstash-retried')||0),deliveryId=Number(parse(body,{}).deliveryId)
  try{
    await deliverWorkerAlert(env,deliveryId,retried)
    return json({ok:true})
  }catch(error){
    const dead=retried>=5
    return json({error:alertError(error)},dead?489:500,dead?{'Upstash-NonRetryable-Error':'true'}:{})
  }
}

async function retryPendingAlertDeliveries(env){
  const rows=(await env.DB.prepare(`select id from alert_deliveries where status='pending' and queue_message_id is null and updated_at<? order by updated_at limit 100`).bind(Date.now()-60000).all()).results
  for(const row of rows)await queueOrDeliverAlert(env,Number(row.id))
  return rows.length
}

async function queueOrDeliverAlert(env,id){
  if(!env.QSTASH_TOKEN||!env.ALERT_PUBLIC_BASE_URL){
    try{await deliverWorkerAlert(env,id)}catch{}
    return
  }
  try{
    const messageId=await publishDelivery({token:env.QSTASH_TOKEN,baseUrl:env.ALERT_PUBLIC_BASE_URL,deliveryId:id})
    await env.DB.prepare('update alert_deliveries set queue_message_id=?,last_error=null,updated_at=? where id=?').bind(messageId,Date.now(),id).run()
  }catch(error){
    await env.DB.prepare('update alert_deliveries set last_error=?,updated_at=? where id=?').bind(alertError(error),Date.now(),id).run()
  }
}

async function deliverWorkerAlert(env,id,retried=0){
  const row=await env.DB.prepare(`select d.*,c.config_json,c.secret_ciphertext,a.app_id,a.metric,a.level,a.value,a.message,a.context_json,a.created_at alert_created_at
    from alert_deliveries d left join alert_channels c on c.id=d.channel_id join alert_history a on a.id=d.alert_id where d.id=?`).bind(id).first()
  if(!row||['sent','cancelled'].includes(row.status))return
  if(!row.channel_id){
    await env.DB.prepare(`update alert_deliveries set status='cancelled',last_error='渠道不存在',updated_at=? where id=?`).bind(Date.now(),id).run()
    return
  }
  const now=Date.now(),claimed=await env.DB.prepare(`update alert_deliveries set status='sending',attempts=attempts+1,updated_at=? where id=? and (status in ('pending','failed','dead') or (status='sending' and updated_at<?))`).bind(now,id,now-10000).run()
  if(!claimed.meta.changes){
    if(row.status==='sending')throw new Error('投递正在处理中')
    return
  }
  try{
    const result=await sendChannel({type:row.channel_type,config_json:row.config_json},await decryptSecrets(row.secret_ciphertext,env.ALERT_SECRET_MASTER_KEY),workerAlert(row))
    const now=Date.now()
    await env.DB.prepare(`update alert_deliveries set status='sent',provider_message_id=?,last_error=null,sent_at=?,updated_at=? where id=?`).bind(result.providerMessageId,now,now,id).run()
  }catch(error){
    await env.DB.prepare('update alert_deliveries set status=?,last_error=?,updated_at=? where id=?').bind(retried>=5?'dead':'failed',alertError(error),Date.now(),id).run()
    await updateWorkerAlertStatus(env,row.alert_id)
    throw error
  }
  await updateWorkerAlertStatus(env,row.alert_id)
}

async function updateWorkerAlertStatus(env,alertId){
  const stats=await env.DB.prepare(`select count(*) total,sum(case when status='sent' then 1 else 0 end) sent,sum(case when status in ('failed','dead') then 1 else 0 end) failed from alert_deliveries where alert_id=?`).bind(alertId).first()
  await env.DB.prepare('update alert_history set notified=?,notify_error=? where id=?').bind(Number(stats.sent)>0,Number(stats.failed)?`${Number(stats.failed)}/${Number(stats.total)} 个渠道发送失败`:null,alertId).run()
}

function workerAlert(row){
  return{id:Number(row.alert_id||row.id),appId:row.app_id,metric:row.metric,level:row.level,value:row.value,message:row.message,createdAt:Number(row.alert_created_at||row.created_at),...parse(row.context_json,{})}
}

function alertError(error){return String(error?.message||error).slice(0,1000)}

async function cleanup(env){const config=(await settings(env)).retention,now=Date.now(),deleted={};for(const [name,sql,days] of [['logs',`delete from events where type='log' and ts<?`,config.logsDays],['events',`delete from events where type<>'log' and ts<?`,config.eventsDays],['hourlyStats',`delete from events_hourly_stats where hour_ts<?`,config.eventsDays],['replays','delete from replays where created_at<?',config.replaysDays],['alerts','delete from alert_history where created_at<?',config.alertsDays],['sourcemaps','delete from sourcemaps where created_at<?',config.sourcemapsDays],['syntheticResults','delete from synthetic_results where checked_at<?',config.syntheticResultsDays||30],['experimentExposures','delete from experiment_exposures where exposed_at<?',config.eventsDays||30]])deleted[name]=(await env.DB.prepare(sql).bind(now-days*86400000).run()).meta.changes;return deleted}
async function exportCsv(env,kind,url){const filter=kind==='issues'?issueFilters(url):kind==='replays'?replayFilters(url):filters(url),select=kind==='replays'?'select app_id,session_id,max(user_id) user_id,max(user_name) user_name,max(user_phone) user_phone,min(created_at) first_seen,max(created_at) last_seen,max(url) url,max(release_name) release_name,max(end_reason) end_reason,count(*) event_count from replays':`select * from ${kind}`,group=kind==='replays'?' group by app_id,session_id':'',order=kind==='issues'?'last_seen':kind==='replays'?'last_seen':'ts',rows=(await env.DB.prepare(`${select} ${filter.where}${group} order by ${order} desc limit 10000`).bind(...filter.values).all()).results,keys=rows.length?Object.keys(rows[0]):[],cell=v=>`"${String(v??'').replaceAll('"','""')}"`,csv=rows.length?'\ufeff'+[keys.map(cell).join(','),...rows.map(r=>keys.map(k=>cell(r[k])).join(','))].join('\r\n'):'';return new Response(csv,{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':`attachment; filename="web-collection-${kind}.csv"`}})}

export function filters(url,forcedType,fixed=[],fixedValues=[]){const p=url.searchParams,parts=[...fixed],values=[...fixedValues];const _hasTs=fixed.some(f=>/\bts\s*[<>]=?\s*\?/.test(f))||p.has('startTime')||p.has('endTime');if(!_hasTs){parts.push('ts>=?');values.push(Date.now()-90*86400000)}for(const [field,key,value] of [['app_id','appId'],['release_name','release'],['type','type',forcedType],['name','name'],['user_id','userId'],['session_id','sessionId']]){const v=value||p.get(key);if(v){const items=field==='type'?String(v).split(',').filter(Boolean):[v];parts.push(items.length>1?`${field} in (${items.map(()=>'?').join(',')})`:`${field}=?`);values.push(...items)}}if(p.get('traceId')){parts.push('trace_id like ?');values.push(`%${p.get('traceId')}%`)}if(p.get('path')){parts.push('(path like ? or url like ?)');values.push(...Array(2).fill(`%${p.get('path')}%`))}if(p.get('startTime')){parts.push('ts>=?');values.push(Number(p.get('startTime')))}if(p.get('endTime')){parts.push('ts<=?');values.push(Number(p.get('endTime')))}if(p.get('keyword')){parts.push('(name like ? or message like ? or props_json like ? or trace_id like ?)');values.push(...Array(4).fill(`%${p.get('keyword')}%`))}return{where:parts.length?`where ${parts.join(' and ')}`:'',values}}
export function issueFilters(url){const p=url.searchParams,parts=[],values=[];if(!p.has('startTime')&&!p.has('endTime')){parts.push('last_seen>=?');values.push(Date.now()-90*86400000)}for(const[field,key]of[['app_id','appId'],['release_name','release'],['status','status']]){if(p.get(key)){parts.push(`${field}=?`);values.push(p.get(key))}}if(p.get('path')){parts.push('url like ?');values.push(`%${p.get('path')}%`)}if(p.get('startTime')){parts.push('last_seen>=?');values.push(Number(p.get('startTime')))}if(p.get('endTime')){parts.push('last_seen<=?');values.push(Number(p.get('endTime')))}if(p.get('keyword')){parts.push('(name like ? or message like ? or stack like ? or props_json like ?)');values.push(...Array(4).fill(`%${p.get('keyword')}%`))}return{where:parts.length?`where ${parts.join(' and ')}`:'',values}}
export function replayFilters(url){const p=url.searchParams,parts=[],values=[];if(!p.has('startTime')&&!p.has('endTime')){parts.push('created_at>=?');values.push(Date.now()-90*86400000)}for(const[field,key]of[['app_id','appId'],['release_name','release'],['user_id','userId']]){if(p.get(key)){parts.push(`${field}=?`);values.push(p.get(key))}}for(const[field,key]of[['user_name','userName'],['user_phone','userPhone'],['url','path']]){if(p.get(key)){parts.push(`${field} like ?`);values.push(`%${p.get(key)}%`)}}if(p.get('startTime')){parts.push('created_at>=?');values.push(Number(p.get('startTime')))}if(p.get('endTime')){parts.push('created_at<=?');values.push(Number(p.get('endTime')))}if(p.get('keyword')){parts.push('(session_id like ? or url like ? or events_json like ?)');values.push(...Array(3).fill(`%${p.get('keyword')}%`))}return{where:parts.length?`where ${parts.join(' and ')}`:'',values}}
function sanitize(event){const type=event.type==='performance'?'perf':String(event.type||'');if(!['track','perf','behavior','error','replay','log','trace'].includes(type))throw new Error('bad event type');const base={type,appId:clip(event.appId||'default',64),release:clip(event.release||'unknown',64),userId:clip(event.userId||'',128),userName:clip(event.userName||'',128),userPhone:clip(event.userPhone||'',32),sessionId:clip(event.sessionId||'',128)||null,deviceId:clip(event.deviceId||'',128),traceId:clip(event.traceId||'',64)||null,spanId:clip(event.spanId||'',32)||null,parentSpanId:clip(event.parentSpanId||'',32)||null,url:cleanUrl(event.url),path:clip(event.path||'',512),title:clip(event.title||'',256),referrer:cleanUrl(event.referrer),userAgent:clip(event.userAgent||'',512),sdkVersion:clip(event.sdkVersion||'',32),environment:clip(event.environment||'',64),source:clip(event.source||'',32),context:cleanObject(event.context),ts:Number(event.ts)||Date.now(),name:clip(event.name||'',160),metric:clip(event.metric||'',32),value:Number.isFinite(Number(event.value))?Number(event.value):null,message:redact(clip(event.message||'',500)),stack:clip(event.stack||'',4000),props:cleanObject(event.props),breadcrumbs:Array.isArray(event.breadcrumbs)?event.breadcrumbs.slice(0,20).map(cleanObject):null};if(type==='replay')return{...base,baseSessionId:clip(event.baseSessionId||'',128)||null,events:event.events,compression:clip(event.compression||'gzip',16),segmentEndReason:clip(event.segmentEndReason||'',32)};return base}
export function mapEvent(r){return{id:r.id,ts:r.ts,type:r.type,appId:r.app_id,release:r.release_name,userId:r.user_id,userName:r.user_name,userPhone:maskPhone(r.user_phone),sessionId:r.session_id,deviceId:r.device_id,traceId:r.trace_id,spanId:r.span_id,sdkVersion:r.sdk_version,environment:r.environment,source:r.source,context:parse(r.context_json,null),url:r.url,path:r.path,title:r.title,referrer:r.referrer,userAgent:r.user_agent,name:r.name,metric:r.metric,value:r.value,message:r.message,stack:r.stack,props:parse(r.props_json,null),breadcrumbs:parse(r.breadcrumbs_json,null),appVersion:r.app_version??null,productId:r.product_id??null,eventId:r.event_id??null,requestId:r.request_id??null,occurredAt:r.occurred_at==null?null:Number(r.occurred_at),receivedAt:r.received_at==null?null:Number(r.received_at),schemaVersion:r.schema_version??null,batchId:r.batch_id??null,retryCount:r.retry_count==null?null:Number(r.retry_count),contractStatus:r.contract_status??null,contractErrors:parse(r.contract_errors_json,null)??null}}
function mapIssue(r){return{fingerprint:r.fingerprint,status:r.status,appId:r.app_id,release:r.release_name,name:r.name,message:r.message,stack:r.stack,url:r.url,props:parse(r.props_json,null),breadcrumbs:parse(r.breadcrumbs_json,null),original:parse(r.original_json,null),count:r.count,firstSeen:r.first_seen,lastSeen:r.last_seen,resolvedAt:r.resolved_at,affectedUsers:Number(r.affected_users||0)}}
function mapAlert(r){return{id:r.id,appId:r.app_id,metric:r.metric,level:r.level,value:r.value,message:r.message,threshold:r.threshold,status:r.status||'pending',fingerprint:r.fingerprint,traceId:r.trace_id,url:r.url,releaseName:r.release_name,userId:r.user_id,deviceId:r.device_id,sessionId:r.session_id,path:r.path,context:parse(r.context_json,null),notified:!!r.notified,resolvedAt:r.resolved_at,created_at:r.created_at,deliveryTotal:r.delivery_total,deliverySent:r.delivery_sent,deliveryFailed:r.delivery_failed,deliveryPending:r.delivery_pending}}
function mapApplication(row){return{...row,enabled:Boolean(row.enabled),rules_json:parse(row.rules_json,{})}}
function matchSteps(events,steps,windowMs){const ts=new Array(steps.length).fill(null);let cursor=0,lastTs=null;for(const event of events){if(cursor>=steps.length)break;if(event.name===steps[cursor]){const t=Number(event.ts);if(windowMs==null||lastTs==null||t-lastTs<=windowMs){ts[cursor]=t;lastTs=t;cursor++;}}}return ts}
function reaches(events,steps,target,windowMs){return matchSteps(events,steps,windowMs)[target]!=null}
function dimensions(rows,steps,field,windowMs){const keyed=group(rows,r=>field==='day'?new Date(r.ts).toISOString().slice(0,10):r[field]||'未知');return Object.entries(keyed).map(([name,items])=>{const actorsInGroup=Object.values(group(items,r=>r.actor));const entered=new Set(actorsInGroup.filter(a=>reaches(a,steps,0,windowMs)).map(a=>a[0].actor)).size;const converted=new Set(actorsInGroup.filter(a=>reaches(a,steps,steps.length-1,windowMs)).map(a=>a[0].actor)).size;return field==='day'?{date:name,entered,converted}:{name,entered,converted}})}
function group(items,key){return items.reduce((out,item)=>((out[key(item)]||=[]).push(item),out),{})}
function cleanObject(value){if(!value||typeof value!=='object')return null;return Object.fromEntries(Object.entries(value).slice(0,50).map(([k,v])=>[clip(k,80),redact(clip(typeof v==='object'?JSON.stringify(v):v,1000))]))}
function cleanUrl(value){try{const u=new URL(String(value));for(const key of ['token','password','key','secret','authorization'])u.searchParams.delete(key);return clip(u.toString(),2048)}catch{return clip(value||'',2048)}}
function redact(v){return String(v).replace(/(authorization|password|token|secret|cookie)(["'\s:=]+)[^\s,;}]+/gi,'$1$2[REDACTED]').replace(/\b1\d{2}\d{4}(\d{4})\b/g,'***$1')}
function cors(response,request){const r=new Response(response.body,response),origin=request.headers.get('origin');r.headers.set('access-control-allow-origin',origin||'*');if(origin){r.headers.set('access-control-allow-credentials','true');r.headers.append('vary','Origin')}r.headers.set('access-control-allow-methods','GET,POST,PUT,DELETE,OPTIONS');r.headers.set('access-control-allow-headers','content-type,x-app-key,x-ai-key,traceparent,if-none-match,if-match,if-modified-since,if-unmodified-since');return r}
function parse(value,fallback){try{return typeof value==='string'?JSON.parse(value):value??fallback}catch{return fallback}}
function strings(v){return Array.isArray(v)?v.map(String).map(s=>s.trim()).filter(Boolean):[]}
function clip(v,n){return String(v??'').slice(0,n)} function rate(v){return Math.max(0,Math.min(1,Number(v??1)))} function origin(v){try{return new URL(v).origin}catch{return''}} function maskPhone(v=''){return String(v).replace(/^(\d{3})\d{4}(\d{4})$/,'$1****$2')} function random(n){const a=new Uint8Array(n);crypto.getRandomValues(a);return btoa(String.fromCharCode(...a)).replace(/[+/=]/g,'').slice(0,n*2)} async function sha256(v){return[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v)))].map(x=>x.toString(16).padStart(2,'0')).join('')}
const defaultSettings={retention:{eventsDays:30,logsDays:14,replaysDays:7,resolvedIssuesDays:90,sourcemapsDays:180,alertsDays:90,syntheticResultsDays:30},alerts:{enabled:true,cooldownMinutes:10,errorCount:1,error:true,logError:true,regression:true,lcp:4000,inp:500,cls:.25,longtask:200}}

// ==================== A3 · 实验分析（镜像 apps/api services/experiment-service.js；同路径同契约，仅 D1 方言差异） ====================
// SQL 红线：D1 禁 LIKE/GLOB，全部 `=?` 精确匹配；JSON 均在 JS 端 parse（variants_json/goal_metric_json 为 text）。

const experimentsEnabledW = env => env.EXPERIMENTS_ENABLED === '1'
/** A3 守卫：experiments 能力未开启（env.EXPERIMENTS_ENABLED≠1）时统一 503（复刻 guardDsrW 范式）。 */
function guardExperimentsW(env, run) {
  if (!experimentsEnabledW(env)) return json({ error: '实验分析能力未启用（需设置 EXPERIMENTS_ENABLED=1）' }, 503)
  return run()
}

/** 操作者断言（返回 Response 或 null）：accounts=false 单租户放行（PRD P0-9）；开启后登录 + 权限点（owner 恒允许）。 */
function expActorCheckW(env, auth, permission) {
  if (!accountsEnabled(env)) return null
  if (!auth?.userId) return json({ error: '实验管理需要开启账号体系并登录（ACCOUNTS_ENABLED=1）' }, 403)
  if (!hasPermission(auth.role, permission)) return json({ error: `无实验操作权限（${permission}）` }, 403)
  return null
}

/** 团队可见性断言（返回 Response 或 null，对齐 dsrVisibleCheckW 范式）。 */
function expVisibleCheckW(env, row, auth) {
  if (!accountsEnabled(env)) return null
  if (auth?.via !== 'session' || !auth.teamId) return null
  if (row.team_id && row.team_id !== auth.teamId) return json({ error: '无权访问该实验（跨团队）' }, 403)
  return null
}

/** 按 id 取实验行 + team 可见性；不存在返回 404 Response。 */
async function expRequireRow(env, auth, id) {
  const row = await env.DB.prepare('select * from experiments where id=?').bind(clip(id || '', 32)).first()
  if (!row) return { error: json({ error: '实验不存在' }, 404) }
  const visible = expVisibleCheckW(env, row, auth)
  if (visible) return { error: visible }
  return { row }
}

/** DB 行 → API 视图（camelCase；对齐 Node publicExperiment，保证双栈 JSON 同形状）。 */
function expView(row) {
  return {
    id: row.id, appId: row.app_id, teamId: row.team_id || null, key: row.key, name: row.name,
    description: row.description || null, status: row.status || 'draft', salt: row.salt,
    trafficPct: Number(row.traffic_pct), variants: expVariantsOf(row.variants_json), goalMetric: expGoalOf(row.goal_metric_json),
    startedAt: row.started_at == null ? null : Number(row.started_at), endedAt: row.ended_at == null ? null : Number(row.ended_at),
    createdBy: row.created_by || null, updatedBy: row.updated_by || null,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at)
  }
}

/** 解析 variants_json + 排序（weight 降序、control 优先——分桶累积顺序，三端一致）。 */
function expVariantsOf(text) {
  let list = []
  try { list = parse(text, []) } catch { list = [] }
  if (!Array.isArray(list)) list = []
  return list
    .map(item => ({ name: String(item?.name || '').trim().slice(0, 32), weight: Math.max(0, Math.floor(Number(item?.weight) || 0)) }))
    .filter(item => item.name)
    .sort((a, b) => (b.weight - a.weight) || (a.name === 'control' ? -1 : b.name === 'control' ? 1 : 0))
}

/** 解析 goal_metric_json（缺省 session_duration 兜底，对齐 Node parseGoalMetric）。 */
function expGoalOf(text) {
  const value = parse(text, null)
  if (!value || typeof value !== 'object' || !['conversion_event', 'error_rate', 'session_duration'].includes(value.type)) {
    return { type: 'session_duration', event_name: null, window_days: 7 }
  }
  const windowDays = Number.isFinite(Number(value.window_days)) && Number(value.window_days) > 0 ? Math.floor(Number(value.window_days)) : 7
  return { type: value.type, event_name: value.event_name ? String(value.event_name).slice(0, 160) : null, window_days: windowDays }
}

/** 变体入参校验：必含 control 且 name 唯一、weight 合计 >0（对齐 Node validateVariants）。失败返回错误文案。 */
function expValidateVariants(input) {
  if (!Array.isArray(input) || input.length < 2 || input.length > 4) return '变体数量须在 2~4 个之间'
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

/** 创建/更新实验（body 带 id 即更新；对齐 Node saveExperiment：running 409 / key 冲突 409）。 */
async function expSaveW(request, env, auth) {
  const denied = expActorCheckW(env, auth, 'expCreate')
  if (denied) return denied
  const input = await request.json().catch(() => ({}))
  const appId = clip(input.appId || '', 64).trim()
  if (!appId) return json({ error: 'appId 不能为空' }, 400)
  const app = await env.DB.prepare('select app_id, team_id from applications where app_id=?').bind(appId).first()
  if (!app) return json({ error: '应用不存在' }, 404)
  if (accountsEnabled(env) && auth?.via === 'session' && auth.teamId && app.team_id && app.team_id !== auth.teamId) {
    return json({ error: '目标应用不属于当前团队' }, 403)
  }
  const key = clip(input.key || '', 64).trim()
  if (!/^[a-z0-9_-]{2,64}$/.test(key)) return json({ error: 'key 非法：须匹配 ^[a-z0-9_-]{2,64}$' }, 400)
  const name = clip(input.name || '', 80).trim()
  if (!name) return json({ error: '实验名称不能为空' }, 400)
  const description = input.description == null ? null : clip(input.description, 512)
  const variantsError = expValidateVariants(input.variants)
  if (variantsError) return json({ error: variantsError }, 400)
  const variants = input.variants
    .map(item => ({ name: String(item.name).trim().slice(0, 32), weight: Math.floor(Number(item.weight)) }))
    .sort((a, b) => (b.weight - a.weight) || (a.name === 'control' ? -1 : b.name === 'control' ? 1 : 0))
  const trafficPct = Math.max(0, Math.min(100, Math.floor(Number(input.trafficPct ?? input.traffic_pct ?? 100))))
  const goalRaw = input.goalMetric ?? input.goal_metric ?? {}
  const goalType = ['conversion_event', 'error_rate', 'session_duration'].includes(goalRaw?.type) ? goalRaw.type : 'session_duration'
  const goalEvent = goalRaw?.event_name ? clip(goalRaw.event_name, 160) : (goalRaw?.eventName ? clip(goalRaw.eventName, 160) : null)
  const goalWindow = Number.isFinite(Number(goalRaw?.window_days ?? goalRaw?.windowDays)) && Number(goalRaw?.window_days ?? goalRaw?.windowDays) > 0 ? Math.min(365, Math.floor(Number(goalRaw?.window_days ?? goalRaw?.windowDays))) : 7
  if (goalType === 'conversion_event' && !goalEvent) return json({ error: 'goal_metric=conversion_event 时 event_name 必填' }, 400)
  const goalMetric = { type: goalType, event_name: goalType === 'conversion_event' ? goalEvent : null, window_days: goalWindow }

  const now = Date.now()
  const id = clip(input.id || '', 32).trim() || `exp_${random(12)}`
  const operator = clip(auth?.userId || 'system', 64)
  const existing = await env.DB.prepare('select * from experiments where id=?').bind(id).first()
  if (existing) {
    const visible = expVisibleCheckW(env, existing, auth)
    if (visible) return visible
    if (existing.status === 'running') return json({ error: 'running 状态的实验不可修改定义（需先暂停），请通过状态迁移接口操作' }, 409)
    const keyClash = await env.DB.prepare('select id, name from experiments where app_id=? and key=? and id<>?').bind(appId, key, id).first()
    if (keyClash) return json({ error: `实验 key「${key}」已被实验「${keyClash.name}」（${keyClash.id}）占用` }, 409)
    await env.DB.prepare('update experiments set app_id=?, key=?, name=?, description=?, traffic_pct=?, variants_json=?, goal_metric_json=?, updated_by=?, updated_at=? where id=?')
      .bind(appId, key, name, description, trafficPct, JSON.stringify(variants), JSON.stringify(goalMetric), operator, now, id).run()
    return json({ id, updated: true })
  }
  const keyClash = await env.DB.prepare('select id, name from experiments where app_id=? and key=?').bind(appId, key).first()
  if (keyClash) return json({ error: `实验 key「${key}」已被实验「${keyClash.name}」（${keyClash.id}）占用` }, 409)
  await env.DB.prepare("insert into experiments (id, app_id, team_id, key, name, description, status, salt, traffic_pct, variants_json, goal_metric_json, created_by, updated_by, created_at, updated_at) values (?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?)")
    .bind(id, appId, app.team_id || null, key, name, description, random(12), trafficPct, JSON.stringify(variants), JSON.stringify(goalMetric), operator, operator, now, now).run()
  return json({ id, created: true })
}

/** 实验列表（appId 必填 + 可选 status 等值过滤 + team 边界校验 + 曝光摘要，对齐 Node listExperiments）。 */
async function expListW(env, auth, url) {
  const denied = expActorCheckW(env, auth, 'expView')
  if (denied) return denied
  const appId = clip(url.searchParams.get('appId') || '', 64).trim()
  if (!appId) return json({ error: 'appId 不能为空' }, 400)
  if (accountsEnabled(env) && auth?.via === 'session' && auth.teamId) {
    const app = await env.DB.prepare('select team_id from applications where app_id=?').bind(appId).first()
    if (app && app.team_id && app.team_id !== auth.teamId) return json({ error: '目标应用不属于当前团队' }, 403)
  }
  // 分页钳位对齐 Node（Math.floor(Number(x)||fallback)）：Number('abc') 为 NaN，Math.max(1, NaN) 仍是 NaN，
  // 直接 bind 会打 D1 500；pageSize 上限 100 与 Node pageOf 取齐。
  const page = Math.max(1, Math.floor(Number(url.searchParams.get('page')) || 1))
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get('pageSize')) || 20)))
  // status 等值过滤（=? 精确匹配，对齐 Node listExperiments 的可选 status 参数，双栈同契约）
  const conditions = ['app_id=?']
  const values = [appId]
  const status = clip(url.searchParams.get('status') || '', 16).trim()
  if (status) { conditions.push('status=?'); values.push(status) }
  const where = `where ${conditions.join(' and ')}`
  const rows = (await env.DB.prepare(`select * from experiments ${where} order by updated_at desc limit ? offset ?`).bind(...values, pageSize, (page - 1) * pageSize).all()).results || []
  const total = await env.DB.prepare(`select count(*) count from experiments ${where}`).bind(...values).first()
  const summary = new Map()
  if (rows.length) {
    const ids = rows.map(row => row.id)
    const summaryRows = (await env.DB.prepare(`select experiment_id, count(*) exposures, count(case when exposed_at>=? then 1 end) exposures7d from experiment_exposures where experiment_id in (${ids.map(() => '?').join(',')}) group by experiment_id`).bind(Date.now() - 7 * 86400000, ...ids).all()).results || []
    for (const row of summaryRows) summary.set(row.experiment_id, { exposures: Number(row.exposures), exposures7d: Number(row.exposures7d) })
  }
  const items = rows.map(row => {
    const item = summary.get(row.id) || { exposures: 0, exposures7d: 0 }
    return { ...expView(row), exposureCount: item.exposures, exposureCount7d: item.exposures7d }
  })
  return json({ items, total: Number(total?.count || 0), page, pageSize })
}

/** 实验详情。 */
async function expGetW(env, auth, id) {
  const denied = expActorCheckW(env, auth, 'expView')
  if (denied) return denied
  const { row, error } = await expRequireRow(env, auth, id)
  if (error) return error
  return json(expView(row))
}

/** 删除（仅 archived，级联删曝光）。 */
async function expDeleteW(env, auth, id) {
  const denied = expActorCheckW(env, auth, 'expArchive')
  if (denied) return denied
  const { row, error } = await expRequireRow(env, auth, id)
  if (error) return error
  if (row.status !== 'archived') return json({ error: '仅 archived 状态的实验可删除（需先完成并归档）' }, 409)
  await env.DB.prepare('delete from experiment_exposures where experiment_id=?').bind(row.id).run()
  await env.DB.prepare('delete from experiments where id=?').bind(row.id).run()
  return json({ ok: true })
}

/** 状态迁移（状态机校验 400 + 防打架 409 返回冲突实验，对齐 Node changeExperimentStatus）。 */
const EXP_STATUS_TRANSITIONS = { draft: ['running'], running: ['paused', 'completed'], paused: ['running', 'completed'], completed: ['archived'], archived: [] }
async function expStatusW(request, env, auth, id) {
  const denied = expActorCheckW(env, auth, 'expUpdate')
  if (denied) return denied
  const input = await request.json().catch(() => ({}))
  const target = clip(input?.status || '', 16).trim()
  if (!['draft', 'running', 'paused', 'completed', 'archived'].includes(target)) return json({ error: `非法状态：${target}` }, 400)
  const { row, error } = await expRequireRow(env, auth, id)
  if (error) return error
  const current = row.status || 'draft'
  if (!(EXP_STATUS_TRANSITIONS[current] || []).includes(target)) {
    return json({ error: `非法状态迁移：${current} → ${target}（合法迁移：${(EXP_STATUS_TRANSITIONS[current] || []).join(' / ') || '无'}）` }, 400)
  }
  const now = Date.now()
  const operator = clip(auth?.userId || 'system', 64)
  if (target === 'running') {
    const clash = await env.DB.prepare("select id, name, key from experiments where app_id=? and key=? and status='running' and id<>?").bind(row.app_id, row.key, row.id).first()
    if (clash) return json({ error: `实验 key「${row.key}」已存在运行中的实验「${clash.name}」（${clash.id}），同一时刻仅允许一个 running` }, 409)
    const startedAt = row.started_at == null ? now : Number(row.started_at)
    await env.DB.prepare("update experiments set status='running', started_at=?, ended_at=null, updated_by=?, updated_at=? where id=?").bind(startedAt, operator, now, row.id).run()
  } else if (target === 'completed' || target === 'archived') {
    await env.DB.prepare('update experiments set status=?, ended_at=?, updated_by=?, updated_at=? where id=?').bind(target, now, operator, now, row.id).run()
  } else {
    await env.DB.prepare('update experiments set status=?, updated_by=?, updated_at=? where id=?').bind(target, operator, now, row.id).run()
  }
  return json({ id: row.id, status: target, previousStatus: current })
}

/**
 * 实验分析报告（对齐 Node getExperimentReport；cohort=experiment_exposures，visitor 关联 events 用 device_id）。
 * 指标：曝光/访客/会话基数 + 错误率 + 目标转化率（conversion_event）或会话时长（session_duration）；
 * 附配置比 vs 实际比（漂移 >5pp 标黄）与样本量提示（<100/变体）。
 */
const EXP_MIN_SAMPLE = 100
const EXP_DRIFT_THRESHOLD_PP = 5
async function expReportW(env, auth, id) {
  const denied = expActorCheckW(env, auth, 'expView')
  if (denied) return denied
  const { row, error } = await expRequireRow(env, auth, id)
  if (error) return error
  const experiment = expView(row)
  const goal = experiment.goalMetric
  const windowMs = goal.window_days * 86400000
  const variants = experiment.variants
  const totalWeight = variants.reduce((sum, item) => sum + item.weight, 0)
  const guarded = promise => promise.all().catch(() => ({ results: [] })).then(r => (r && r.results) || [])
  const [baseRows, errorRows, conversionRows, durationRows, dailyRows] = await Promise.all([
    guarded(env.DB.prepare('select variant, count(*) as exposures, count(distinct visitor_id) as visitors, count(distinct session_id) as sessions from experiment_exposures where experiment_id=? group by variant').bind(row.id)),
    guarded(env.DB.prepare(`select x.variant, count(distinct x.session_id) as total_sessions, count(distinct case when ev.type='error' then x.session_id end) as err_sessions from experiment_exposures x left join events ev on ev.session_id=x.session_id and ev.app_id=x.app_id and ev.type='error' where x.experiment_id=? group by x.variant`).bind(row.id)),
    goal.type === 'conversion_event'
      ? guarded(env.DB.prepare('select x.variant, count(distinct x.visitor_id) as cohort_visitors, count(distinct case when ev.id is not null then x.visitor_id end) as converted from experiment_exposures x left join events ev on ev.device_id=x.visitor_id and ev.app_id=x.app_id and ev.name=? and ev.ts>=x.exposed_at and ev.ts<=x.exposed_at+? where x.experiment_id=? group by x.variant').bind(goal.event_name, windowMs, row.id))
      : Promise.resolve([]),
    goal.type === 'session_duration'
      ? guarded(env.DB.prepare('select x.variant, avg(d.dur) as avg_duration from experiment_exposures x join (select session_id, max(ts) - min(ts) as dur from events where app_id=? and session_id in (select session_id from experiment_exposures where experiment_id=? and session_id is not null) group by session_id) d on d.session_id=x.session_id where x.experiment_id=? group by x.variant').bind(row.app_id, row.id, row.id))
      : Promise.resolve([]),
    guarded(env.DB.prepare('select variant, (exposed_at / 86400000) as day, count(*) as exposures from experiment_exposures where experiment_id=? group by variant, day order by day').bind(row.id))
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
    const totalSessions = Number(errorStat?.total_sessions || 0)
    const errSessions = Number(errorStat?.err_sessions || 0)
    const cohortVisitors = Number(conversionStat?.cohort_visitors || 0)
    const converted = Number(conversionStat?.converted || 0)
    return {
      name: item.name,
      weight: item.weight,
      configPct: totalWeight > 0 ? Number(((item.weight / totalWeight) * experiment.trafficPct).toFixed(2)) : 0,
      exposures: Number(base?.exposures || 0),
      visitors: Number(base?.visitors || 0),
      sessions: Number(base?.sessions || 0),
      errorRate: totalSessions > 0 ? Number((errSessions / totalSessions).toFixed(4)) : null,
      conversionRate: goal.type === 'conversion_event' && cohortVisitors > 0 ? Number((converted / cohortVisitors).toFixed(4)) : null,
      converted,
      avgDuration: goal.type === 'session_duration' && durationStat?.avg_duration != null ? Math.round(Number(durationStat.avg_duration)) : null
    }
  })
  const control = metricRows.find(item => item.name === 'control') || metricRows[0] || null
  const metricOf = item => (goal.type === 'conversion_event' ? item.conversionRate : goal.type === 'error_rate' ? item.errorRate : item.avgDuration)
  const controlValue = control ? metricOf(control) : null
  const metricRowsWithDiff = metricRows.map(item => {
    const value = metricOf(item)
    return {
      ...item,
      diffVsControl: item.name === 'control' || controlValue == null || value == null || controlValue === 0 ? null : Number(((value - controlValue) / controlValue).toFixed(4))
    }
  })
  const actual = metricRowsWithDiff.map(item => {
    const actualPct = totalExposures > 0 ? Number(((item.exposures / totalExposures) * 100).toFixed(2)) : 0
    return { variant: item.name, configPct: item.configPct, actualPct, drift: Math.abs(actualPct - item.configPct) > EXP_DRIFT_THRESHOLD_PP }
  })
  const insufficient = metricRowsWithDiff.filter(item => item.exposures < EXP_MIN_SAMPLE).map(item => item.name)
  return json({
    experiment,
    goal: { type: goal.type, eventName: goal.event_name, windowDays: goal.window_days },
    minSample: EXP_MIN_SAMPLE,
    totalExposures,
    variants: metricRowsWithDiff,
    actual,
    insufficient,
    daily: dailyRows.map(item => ({ day: Math.floor(Number(item.day) || 0), variant: item.variant, exposures: Number(item.exposures) }))
  })
}

/** 曝光入库（record() 注入点调用；running 才落行，唯一索引 on conflict do nothing 去重，变体永不改写）。 */
async function recordExperimentExposure(env, event) {
  const experimentKey = clip(event.props?.experiment_key || '', 64)
  const visitorId = clip(event.deviceId || '', 64)
  if (!experimentKey || !visitorId) return
  const experiment = await env.DB.prepare("select id, team_id from experiments where app_id=? and key=? and status='running'").bind(event.appId, experimentKey).first()
  if (!experiment) return
  await env.DB.prepare('insert into experiment_exposures (id,experiment_id,app_id,team_id,visitor_id,session_id,variant,exposed_at) values (?,?,?,?,?,?,?,?) on conflict(experiment_id, visitor_id) do nothing')
    .bind(`expv_${random(12)}`, experiment.id, event.appId, experiment.team_id || null, visitorId, event.sessionId ? clip(event.sessionId, 64) : null, clip(event.props?.variant || '', 32), Number(event.ts) || Date.now()).run()
}

// ==================== PRD 集合：洞察/治理层 ====================
function globalLevel(env){return normalizeLevel(env.DATA_ACCESS_LEVEL)}

// D2 FR-9：等级裁剪按请求者——已登录取 auth.level（team_members.access_level），未登录/匿名回落全局环境变量。
function lvl(env,data,auth){return applyAccessLevel(data, auth?.level || globalLevel(env))}

// PRD 04：SDK 端公开下发（ETag 304 + 每 IP 令牌桶限流）
const sdkConfigBuckets=new Map()
async function sdkConfig(request,env,url){
  const ip=request.headers.get('cf-connecting-ip')||'unknown',now=Date.now(),bucket=sdkConfigBuckets.get(ip)||{tokens:30,updatedAt:now}
  bucket.tokens=Math.min(30,bucket.tokens+(now-bucket.updatedAt)/10000*30);bucket.updatedAt=now;sdkConfigBuckets.set(ip,bucket)
  if(bucket.tokens<1){if(sdkConfigBuckets.size>10000)sdkConfigBuckets.clear();return new Response('too many requests',{status:429})}
  bucket.tokens-=1
  const rows=(await env.DB.prepare('select scope_json,config_json,config_version from collect_configs order by created_at desc,id desc limit 200').all().catch(()=>({results:[]}))).results
  // 版本维度：新 SDK（>= 拆分版本之后）分别携带 sdk_version（SDK 版本）与 release（应用版本）；
  // 旧 SDK 只发 sdk_version 且其中装的是应用版本 → 以「是否存在 release 参数」判定新旧：
  // 新 SDK → release 用自身参数；旧 SDK → 回退取 sdk_version，维持旧语义，避免存量配置灰度错乱。
  const hasRelease=url.searchParams.has('release')
  const legacyVersion=clip(url.searchParams.get('sdk_version')||'',32)
  const resolved=resolveCollectConfig(rows,{
    appId:clip(url.searchParams.get('app_id')||'',64),
    platform:clip(url.searchParams.get('platform')||'',32),
    sdkVersion:hasRelease?legacyVersion:'',
    release:hasRelease?clip(url.searchParams.get('release')||'',32):legacyVersion
  })
  const config=resolved?.config||DEFAULT_COLLECT_CONFIG,payload={config_version:resolved?.configVersion||0,ttl_ms:300000,master_switch:config.master_switch,sampling:config.sampling,blocked_events:config.blocked_events,plugins:config.plugins,rate_limits:config.rate_limits,otlp:config.otlp}
  // A3 · 实验定义搭车下发（PRD 14 §6.1）：running 实验合并进 experiments 块（EXPERIMENTS_ENABLED=1 才输出，
  // 关闭 → 字段缺省，旧 SDK 天然兼容）；ETag 追加实验签名 expSig = `${running 数}-${max(updated_at)}`（无 running 为 0），
  // 实验定义稳定时 expSig 恒定 → 共享 304 缓存不受损；状态/定义变更 → 304 失效。
  let expSig='0'
  if(env.EXPERIMENTS_ENABLED==='1'){
    const expRows=((await env.DB.prepare("select key,salt,traffic_pct,variants_json,updated_at from experiments where app_id=? and status='running' order by updated_at desc limit 20").bind(clip(url.searchParams.get('app_id')||'',64)).all().catch(()=>({results:[]}))).results||[])
    if(expRows.length){
      payload.experiments={items:expRows.map(row=>({key:row.key,salt:row.salt,traffic_pct:Number(row.traffic_pct),variants:parse(row.variants_json,[]).map(item=>({name:String(item?.name||'').slice(0,32),weight:Math.max(0,Math.floor(Number(item?.weight)||0))})).filter(item=>item.name).sort((a,b)=>(b.weight-a.weight)||(a.name==='control'?-1:b.name==='control'?1:0))}))}
      expSig=`${expRows.length}-${Math.max(...expRows.map(row=>Number(row.updated_at)||0))}`
    }
  }
  const etag=`"cfg-${payload.config_version}-${expSig}"`
  if(request.headers.get('if-none-match')===etag&&payload.config_version>0)return new Response(null,{status:304})
  return json(payload,200,{etag,'cache-control':'public, max-age=60'})
}
function collectConfigPreview(env,url){
  return env.DB.prepare('select scope_json,config_json,config_version from collect_configs order by created_at desc,id desc limit 200').all().then(({results})=>{
    // 管理端预览按显式入参模拟：sdkVersion=SDK 版本、appVersion=应用 release 版本，二者独立匹配。
    const resolved=resolveCollectConfig(results,{appId:url.searchParams.get('appId')||'',platform:url.searchParams.get('platform')||'',sdkVersion:url.searchParams.get('sdkVersion')||'',release:url.searchParams.get('appVersion')||''})
    return resolved?json({...resolved,matched:true}):json({scope:{},config:DEFAULT_COLLECT_CONFIG,configVersion:0,matched:false})
  })
}
async function collectConfigSave(env,input){
  const scope={},now=Date.now(),raw=input.scope||{}
  if(raw.appId)scope.appId=clip(raw.appId,64)
  if(raw.platform)scope.platform=clip(raw.platform,32)
  if(raw.sdkVersionMax)scope.sdkVersionMax=clip(raw.sdkVersionMax,32)
  if(raw.appVersionMax)scope.appVersionMax=clip(raw.appVersionMax,32)
  const config=sanitizeCollectConfigInput(input.config||{}),operator=clip(input.operator||'admin',64)
  const prevRows=(await env.DB.prepare('select scope_json,config_json,config_version from collect_configs order by created_at desc,id desc limit 200').all()).results
  const before=resolveCollectConfig(prevRows,{appId:scope.appId||'',platform:scope.platform||'',sdkVersion:scope.sdkVersionMax||'',release:scope.appVersionMax||''})
  const auditResult=await env.DB.prepare('insert into collect_config_audit(action,scope_json,config_snapshot,diff_json,operator,created_at) values(?,?,?,?,?,?)').bind(before?'update':'create',JSON.stringify(scope),JSON.stringify(config),JSON.stringify({text:diffConfigs(before?.config||DEFAULT_COLLECT_CONFIG,config)}),operator,now).run()
  const configVersion=Number(auditResult.meta.last_row_id)
  await env.DB.prepare('insert into collect_configs(scope_json,config_json,config_version,created_by,created_at) values(?,?,?,?,?)').bind(JSON.stringify(scope),JSON.stringify(config),configVersion,operator,now).run()
  return json({ok:true,configVersion})
}
async function collectConfigRollback(env,input){
  const row=await env.DB.prepare('select * from collect_config_audit where id=?').bind(Number(input.historyId)).first()
  if(!row)return json({error:'历史记录不存在'},404)
  const now=Date.now(),audit=await env.DB.prepare('insert into collect_config_audit(action,scope_json,config_snapshot,diff_json,operator,created_at) values(\'rollback\',?,?,?,?,?)').bind(row.scope_json,row.config_snapshot,JSON.stringify({text:`回滚到历史 #${row.id}`}),clip(input.operator||'admin',64),now).run()
  const configVersion=Number(audit.meta.last_row_id)
  await env.DB.prepare('insert into collect_configs(scope_json,config_json,config_version,created_by,created_at) values(?,?,?,?,?)').bind(row.scope_json,row.config_snapshot,configVersion,clip(input.operator||'admin',64),now).run()
  return json({ok:true,configVersion})
}
function collectConfigStats(env){
  return Promise.all([
    env.DB.prepare(`select coalesce(json_extract(props_json,'$.configVersion'),json_extract(props_json,'$.config_version'),json_extract(context_json,'$.configVersion'),json_extract(context_json,'$.config_version'),'未上报') version,count(distinct session_id) sessions from events where ts>=? and ifnull(session_id,'')<>'' group by version order by sessions desc limit 20`).bind(Date.now()-86400000).all().catch(()=>({results:[]})),
    env.DB.prepare('select max(id) latest from collect_config_audit').first().catch(()=>null),
    env.DB.prepare(`select count(*) count from (select distinct scope_json from collect_configs where scope_json is not null and scope_json<>'{}')`).first().catch(()=>null)
  ]).then(([dist,latest,custom])=>json({currentVersion:Number(latest?.latest||0),customScopeCount:Number(custom?.count||0),distribution:(dist.results||[]).map(row=>({version:row.version,sessions:Number(row.sessions)}))}))
}

// PRD 01 用户链路（spans 无 session_id，API 类别主要来自 perf/fetch|xhr 事件；后端 span 经 trace_id 补充）
function journeySessions(env,url,auth){
  const fieldMap={user:'user_id',device:'device_id',session:'session_id',trace:'trace_id'},column=fieldMap[url.searchParams.get('type')]||'session_id'
  const value=url.searchParams.get('value')
  const parts=[`ifnull(e.session_id,'')<>''`],values=[]
  // value 为空时进入「浏览最近会话」模式，进入页面即有数据（无需先输入标识）。
  if(value){parts.push(`e.${column}=?`);values.push(value)}
  if(url.searchParams.get('appId')){parts.push('e.app_id=?');values.push(url.searchParams.get('appId'))}
  if(url.searchParams.get('startTime')){parts.push('e.ts>=?');values.push(Number(url.searchParams.get('startTime')))}
  if(url.searchParams.get('endTime')){parts.push('e.ts<=?');values.push(Number(url.searchParams.get('endTime')))}
  const where=`where ${parts.join(' and ')} and ifnull(e.session_id,'')<>''`
  const page=Math.max(1,Number(url.searchParams.get('page')||1)),size=Math.min(100,Math.max(1,Number(url.searchParams.get('pageSize')||30)))
  return Promise.all([
    env.DB.prepare(`select e.session_id,max(e.user_id) user_id,max(e.user_name) user_name,max(e.device_id) device_id,min(e.ts) started_at,max(e.ts) last_at,count(*) event_count,sum(case when e.type='error' then 1 else 0 end) error_count,max(e.app_id) app_id,max(e.sdk_version) sdk_version,max(e.device) device,max(e.browser) browser from events e ${where} group by e.session_id order by last_at desc limit ? offset ?`).bind(...values,size,(page-1)*size).all(),
    env.DB.prepare(`select count(*) count from (select 1 from events e ${where} group by e.session_id)`).bind(...values).first(),
    env.DB.prepare(`select distinct base_session_id base from replay_events where base_session_id is not null limit 2000`).all().catch(()=>({results:[]}))
  ]).then(([rows,total,replays])=>{
    const replaySet=new Set((replays.results||[]).map(r=>r.base))
    return json(lvl(env,{total:Number(total?.count||0),sessions:(rows.results||[]).map(r=>({sessionId:r.session_id,userId:r.user_id||'',userName:r.user_name||'',anonymousId:r.device_id||'',eventCount:Number(r.event_count||0),errorCount:Number(r.error_count||0),startedAt:r.started_at,lastAt:r.last_at,appId:r.app_id||'',sdkVersion:r.sdk_version||'',device:r.device||'',browser:r.browser||'',hasReplay:replaySet.has(r.session_id)}))},auth))
  })
}
async function journeyTimeline(env,url,auth){
  const sessionId=url.searchParams.get('sessionId')
  if(!sessionId)return json({error:'会话 ID 不能为空'},400)
  const segments=(await env.DB.prepare('select session_id sid from replay_events where base_session_id=? limit 20').bind(sessionId).all().catch(()=>({results:[]}))).results.map(r=>r.sid)
  const ids=[sessionId,...segments.filter(sid=>sid!==sessionId)]
  const parts=[`session_id in (${ids.map(()=>'?').join(',')})`],values=[...ids]
  if(url.searchParams.get('appId')){parts.push('app_id=?');values.push(url.searchParams.get('appId'))}
  if(url.searchParams.get('startTime')){parts.push('ts>=?');values.push(Number(url.searchParams.get('startTime')))}
  if(url.searchParams.get('endTime')){parts.push('ts<=?');values.push(Number(url.searchParams.get('endTime')))}
  const where=`where ${parts.join(' and ')}`
  const limit=Math.min(500,Math.max(50,Number(url.searchParams.get('limit')||500)))
  const [eventRows,summaryRow]=await Promise.all([
    env.DB.prepare(`select * from events ${where} order by ts asc limit ?`).bind(...values,limit+1).all(),
    env.DB.prepare(`select min(ts) started_at,max(ts) last_at,count(*) event_count,sum(case when type='error' then 1 else 0 end) error_count,max(user_id) user_id,max(user_name) user_name,max(device_id) device_id,max(app_id) app_id,max(sdk_version) sdk_version,max(release_name) release_name,max(device) device,max(os) os,max(browser) browser,max(user_agent) user_agent from events ${where}`).bind(...values).first()
  ])
  const rows=eventRows.results||[],truncated=rows.length>limit;if(truncated)rows.length=limit
  const traceIds=[...new Set(rows.map(r=>r.trace_id).filter(Boolean))].slice(0,20)
  let spanRows=[]
  if(traceIds.length)spanRows=(await env.DB.prepare(`select id,trace_id,operation_name,kind,start_ts,duration,status_code,service_name from spans where trace_id in (${traceIds.map(()=>'?').join(',')}) order by start_ts asc limit ?`).bind(...traceIds,limit).all().catch(()=>({results:[]}))).results
  const startedAt=summaryRow?.started_at??0,lastAt=summaryRow?.last_at??0
  const identityChain=[];summaryRow?.device_id&&identityChain.push(`${summaryRow.device_id}(匿名)`)
  ;(summaryRow?.user_name||summaryRow?.user_id)&&identityChain.push(`${summaryRow.user_name||summaryRow.user_id}(登录)`)
  const mapSpan=r=>({id:`span-${r.id}`,ts:Number(r.start_ts),category:'api',name:r.operation_name||'span',summary:`${r.service_name||'backend'} · ${Math.round(Number(r.duration||0))}ms`,level:String(r.status_code||'').toUpperCase()==='ERROR'||Number(r.status_code)>=400?'error':'info',batchId:null,source:'span',detail:{traceId:r.trace_id,kind:r.kind,service:r.service_name,duration:Number(r.duration||0)},refs:{traceId:r.trace_id}})
  return json(lvl(env,{
    session:{sessionId:ids[0],relatedSessionIds:ids.slice(1),identityChain,startedAt,lastAt,durationMs:Math.max(0,lastAt-startedAt),eventCount:Number(summaryRow?.event_count||0),errorCount:Number(summaryRow?.error_count||0),appId:summaryRow?.app_id||'',sdkVersion:summaryRow?.sdk_version||'',release:summaryRow?.release_name||'',device:summaryRow?.device||'',os:summaryRow?.os||'',browser:summaryRow?.browser||''},
    events:[...rows.map(r=>lvlEventToTimeline(r)),...spanRows.map(mapSpan)].sort((a,b)=>a.ts-b.ts),
    truncated
  },auth))
}
function lvlEventToTimeline(r){
  const props=parse(r.props_json,null),context=parse(r.context_json,null)
  let category='behavior';if(r.type==='behavior'&&r.name==='pv')category='pv';else if(r.type==='track')category='behavior';else if(r.type==='error')category='error';else if(r.type==='log')category='log';else if(r.type==='perf')category=['fetch','xhr'].includes(r.metric)?'api':'perf'
  let name=r.name||r.metric||r.type,summary=''
  if(category==='pv'){name='页面浏览';summary=`${r.path||r.url||'/'}${r.title?` · ${r.title}`:''}`}
  else if(category==='api'){const method=String(props?.method||'GET').toUpperCase();let shortUrl=String(props?.url||r.url||'');try{const u=new URL(shortUrl);shortUrl=u.pathname+u.search}catch{}name=`${method} ${shortUrl}`;const bits=[];props?.status&&bits.push(`${props.status}`);Number(props?.duration)>0&&bits.push(`耗时 ${Math.round(Number(props.duration))}ms`);summary=bits.join(' · ')}
  else if(category==='error'){summary=String(r.message||'').slice(0,60)}
  else if(category==='log'){summary=String(r.message||'').slice(0,60)}
  else if(name==='page_leave'){summary=`停留 ${Math.round(Number(props?.stayTime||0)/1000)}s`}
  return {id:`evt-${r.id}`,ts:Number(r.ts),category,name,summary,level:r.type==='error'?'error':Number(props?.status)>=400?'warn':'info',batchId:r.batch_id||null,source:'event',detail:{id:r.id,type:r.type,appId:r.app_id,release:r.release_name,sdkVersion:r.sdk_version,sessionId:r.session_id,deviceId:r.device_id,userId:r.user_id,path:r.path,url:r.url,message:r.message,stack:r.stack,metric:r.metric,value:r.value,traceId:r.trace_id,occurredAt:r.occurred_at==null?null:Number(r.occurred_at),receivedAt:r.received_at==null?null:Number(r.received_at),props,context},refs:{traceId:r.trace_id}}
}

// PRD 02 事件字典（D1 版本：完整率为有界采样统计）
function dictionaryList(env,url){
  const since7=Date.now()-7*86400000,since24=Date.now()-86400000
  const parts=['ts>=?',`ifnull(name,'')<>''`,`type in ('behavior','track','error','perf')`],values=[since7]
  if(url.searchParams.get('q')){parts.push('name like ?');values.push(`%${url.searchParams.get('q')}%`)}
  const where=`where ${parts.join(' and ')}`
  return Promise.all([
    env.DB.prepare(`select name,type,count(*) count7d,sum(case when ts>=? then 1 else 0 end) count24h,min(ts) first_seen_7d,max(ts) last_seen_at from events ${where} group by name,type order by count7d desc limit 500`).bind(since24,...values).all(),
    env.DB.prepare(`select distinct name from events where ts<? and name in (select name from events ${where}) limit 1000`).bind(since7,...values).all().catch(()=>({results:[]})),
    env.DB.prepare(`select * from event_dictionary limit 1000`).all().catch(()=>({results:[]})),
    env.DB.prepare(`select name,url,referrer,path,props_json,context_json from events ${where.replace('ts>=?','ts>=?')} order by ts desc limit 5000`).bind(...values).all().catch(()=>({results:[]}))
  ]).then(([rows,historic,registered,sampleRows])=>{
    const historicSet=new Set((historic.results||[]).map(r=>r.name)),regMap=new Map((registered.results||[]).map(r=>[r.name,r]))
    const completeness=d1Completeness(sampleRows.results||[])
    const items=(rows.results||[]).map(r=>{
      const count7d=Number(r.count7d||0),count24h=Number(r.count24h||0),comp=completeness.get(r.name)||null
      const health=judgeHealth(count7d,count24h,Number(r.last_seen_at||0),historicSet.has(r.name),comp?.worst?.rate)
      const registeredRow=regMap.get(r.name)
      return {name:r.name,type:r.type,source:['pv','page_leave','click'].includes(r.name)?'auto':['behavior','perf'].includes(r.type)?'auto':'manual',platform:'',count7d,count24h,lastSeenAt:Number(r.last_seen_at||0),fieldCompleteness:comp,health:health.status,verdict:health.verdict,registered:!!registeredRow,owner:registeredRow?.owner||''}
    })
    const filtered=url.searchParams.get('health')?items.filter(item=>item.health===url.searchParams.get('health')):items
    const page=Math.max(1,Number(url.searchParams.get('page')||1)),size=Math.min(100,Math.max(1,Number(url.searchParams.get('pageSize')||50)))
    return json({total:filtered.length,unregisteredCount:filtered.filter(item=>!item.registered&&item.count7d>0).length,items:filtered.slice((page-1)*size,page*size)})
  })
}
function d1Completeness(rows){
  const byName=new Map()
  for(const row of rows){
    const list=byName.get(row.name)||[]
    if(list.length<200)list.push(row),byName.set(row.name,list)
  }
  const out=new Map()
  for(const [name,list] of byName){
    // 完整率只按该事件类别的关键字段（packages/event-keyfields.js）计算，
    // 与 Node 端口径一致；未配置关键字段的事件不参与 🟠 判定。
    const keyFields=keyFieldsOf(name)
    if(!keyFields.length)continue
    const counts=new Map(),total=list.length
    for(const row of list){
      const props=parse(row.props_json,{}),context=parse(row.context_json,{})
      for(const key of keyFields){
        const v=(props&&key in props)?props[key]:(context&&key in context)?context[key]:(row[key])
        const present=v!==undefined&&v!==null&&v!==''
        counts.set(key,(counts.get(key)||0)+(present?1:0))
      }
    }
    const rates=[...counts.entries()].map(([field,c])=>({field,rate:Number((c/total).toFixed(3))})).sort((a,b)=>a.rate-b.rate)
    if(rates.length)out.set(name,{overall:Number((rates.reduce((s,i)=>s+i.rate,0)/rates.length).toFixed(3)),worst:rates[0],fields:rates.slice(0,10),sampleSize:total})
  }
  return out
}
function judgeHealth(count7d,count24h,lastSeenAt,hasHistory,worstRate){
  if(count7d===0&&hasHistory)return{status:'stalled',verdict:`${Math.max(0,Math.floor((Date.now()-lastSeenAt)/86400000))} 天无上报`}
  if(worstRate!=null&&worstRate<0.95)return{status:'incomplete',verdict:`关键字段完整率 ${(worstRate*100).toFixed(0)}% < 95%`}
  if(count7d>0){const dailyAvg=(count7d-count24h)/6
    if(dailyAvg>0&&Math.abs(count24h-dailyAvg)/dailyAvg>0.5){const delta=Math.round((count24h-dailyAvg)/dailyAvg*100);return{status:'fluctuating',verdict:`近24h较前6日日均 ${delta>0?'+':''}${delta}%，偏离基线`}}}
  if(count7d===0)return{status:'stalled',verdict:'从未上报'}
  return{status:'healthy',verdict:`近24h上报 ${count24h.toLocaleString()}，正常`}
}
function dictionaryNames(env,url){
  return dictionaryListRaw(env,url).then(items=>json(items.map(item=>({name:item.name,health:item.health,count7d:item.count7d,verdict:item.verdict}))))
}
function dictionaryListRaw(env,url){return dictionaryListInner(env,new URLSearchParams({...Object.fromEntries(url.searchParams),pageSize:'100'}))}
async function dictionaryListInner(env,params){
  const fakeUrl=new URL(`http://x/?${params.toString()}`)
  const response=await dictionaryList(env,fakeUrl),data=await response.json()
  return data.items||[]
}
async function dictionaryDetail(env,name,url,auth){
  const eventName=String(name||'').slice(0,160),since30=Date.now()-30*86400000
  const appId=url.searchParams.get('appId')||''
  const [trend,firstRow,samples,registered]=await Promise.all([
    env.DB.prepare(`select cast(ts/86400000 as integer) day_key,count(*) count from events where name=? ${appId?'and app_id=?':''} and ts>=? group by day_key order by day_key asc`).bind(...(appId?[eventName,appId]:[eventName]),since30).all().catch(()=>({results:[]})),
    env.DB.prepare(`select min(ts) first_seen from events where name=? ${appId?'and app_id=?':''}`).bind(...(appId?[eventName,appId]:[eventName])).first().catch(()=>null),
    env.DB.prepare(`select * from events where name=? ${appId?'and app_id=?':''} order by ts desc limit 3`).bind(...(appId?[eventName,appId]:[eventName])).all().catch(()=>({results:[]})),
    env.DB.prepare('select * from event_dictionary where name=?').bind(eventName).first().catch(()=>null)
  ])
  const trendMap=new Map((trend.results||[]).map(r=>[Number(r.day_key),Number(r.count)])),startDay=Math.floor(since30/86400000),trendOut=[]
  for(let i=0;i<30;i++){const key=startDay+i;trendOut.push({day:new Date(key*86400000).toISOString().slice(0,10),count:trendMap.get(key)||0})}
  return json(lvl(env,{name:eventName,registered:!!registered,description:registered?.description||'',owner:registered?.owner||'',tags:parse(registered?.tags_json,[])||[],firstSeenAt:Number(firstRow?.first_seen||0),trend:trendOut,errors:[],samples:(samples.results||[]).map(r=>({ts:Number(r.ts),name:r.name,path:r.path,props:parse(r.props_json,null),context:parse(r.context_json,null)}))},auth))
}
async function dictionaryRegister(env,name,input){
  const eventName=String(name||'').slice(0,160)
  if(!eventName)return json({error:'事件名不能为空'},400)
  await env.DB.prepare(`insert into event_dictionary(name,description,owner,tags_json,registered_at,updated_at) values(?,?,?,?,?,?)
    on conflict(name) do update set description=excluded.description,owner=excluded.owner,tags_json=excluded.tags_json,updated_at=excluded.updated_at`)
    .bind(eventName,String(input.description||'').trim()||null,String(input.owner||'').slice(0,64)||null,JSON.stringify(Array.isArray(input.tags)?input.tags.slice(0,10):[]),Date.now(),Date.now()).run()
  return json({ok:true,name:eventName})
}

// PRD 03 版本质量（P75 用窗口函数近似，与 summary 同法）
function releaseQuality(env,url,auth){
  const dim=url.searchParams.get('dim')==='sdk'?'sdk_version':'release_name'
  const appId=url.searchParams.get('appId')
  if(!appId)return json({error:'appId 不能为空'},400)
  const start=Number(url.searchParams.get('start'))||Date.now()-7*86400000,end=Number(url.searchParams.get('end'))||Date.now()
  return Promise.all([
    env.DB.prepare(`select ${dim} version,count(distinct coalesce(nullif(user_id,''),device_id)) users,count(distinct case when ifnull(session_id,'')<>'' then session_id end) sessions,
      sum(case when type='error' then 1 else 0 end) errors,count(distinct case when type='error' then session_id end) abnormal_sessions,
      min(ts) first_seen_at,max(ts) last_seen_at,avg(case when received_at is not null and received_at>=ts and received_at-ts<3600000 then received_at-ts end) latency_avg
      from events where app_id=? and ts>=? and ts<=? and ifnull(${dim},'')<>'' group by ${dim} order by users desc`).bind(appId,start,end).all(),
    p75ByDim(env,appId,dim,start,end,'lcp'),p75ByDim(env,appId,dim,start,end,'inp'),
    env.DB.prepare(`select ${dim} v,value from (select ${dim} v2,value,count(*) over (partition by ${dim}) n,row_number() over (partition by ${dim} order by value) rn from events where app_id=? and ts>=? and ts<=? and received_at is not null and received_at>=ts and received_at-ts<3600000 and ifnull(${dim},'')<>'') where rn between cast((n-1)*0.75 as integer)+1 and cast((n-1)*0.75 as integer)+2`).bind(appId,start,end).all().catch(()=>({results:[]}))
  ]).then(([rows,lcpRows,inpRows,latencyRows])=>{
    const lcpMap=p75Interpolate(lcpRows.results||[],'v2'),inpMap=p75Interpolate(inpRows.results||[],'v2'),latencyMap=p75Interpolate(latencyRows.results||[],'v')
    const now=Date.now()
    const items=(rows.results||[]).map(r=>{
      const sessions=Number(r.sessions||0),users_=Number(r.users||0),errors=Number(r.errors||0)
      return {version:r.version,users:users_,sessions,errors,errorsPerKSession:sessions>0?Number((errors*1000/sessions).toFixed(2)):null,
        abnormalSessionRate:sessions>0?Number((Number(r.abnormal_sessions||0)/sessions).toFixed(4)):null,
        reportLatencyP75:latencyMap.get(r.version)!=null?Math.round(latencyMap.get(r.version)):null,
        perf:{lcpP75:lcpMap.get(r.version)!=null?Math.round(lcpMap.get(r.version)):null,inpP75:inpMap.get(r.version)!=null?Math.round(inpMap.get(r.version)):null},
        firstSeenAt:Number(r.first_seen_at||0),lastSeenAt:Number(r.last_seen_at||0)}
    })
    const pool=items.filter(item=>item.sessions>=10&&item.errorsPerKSession!=null)
    const totalPool=pool.reduce((sum,item)=>sum+item.sessions,0),grand=items.reduce((sum,item)=>sum+item.sessions,0)
    const baselineValue=totalPool>0?pool.reduce((sum,item)=>sum+item.errorsPerKSession*item.sessions,0)/totalPool:null
    for(const item of items){
      item.status=item.sessions<10?'insufficient':judgeStatusW(item,{baselineValue,grand,now})
      item.statusLabel=({rollback:'建议回滚',watch:'观察',converge:'建议收敛',healthy:'健康',insufficient:'数据不足'})[item.status]
    }
    return json(lvl(env,{baseline:{errorsPerKSession:baselineValue!=null?Number(baselineValue.toFixed(2)):null},
      summary:{versions:items.length,watching:items.filter(i=>i.status==='watch'||i.status==='rollback').length,rollback:items.filter(i=>i.status==='rollback').length,converge:items.filter(i=>i.status==='converge').length},items},auth))
  })
}
function judgeStatusW(item,{baselineValue,grand,now}){
  const inObservation=now-item.firstSeenAt<48*3600000
  if(inObservation&&baselineValue!=null&&item.errorsPerKSession!=null&&item.errorsPerKSession>baselineValue*2)return'rollback'
  if(item.lastSeenAt<now-14*86400000&&grand>0&&item.sessions/grand<0.05)return'converge'
  if(inObservation)return'watch'
  if(baselineValue!=null&&item.errorsPerKSession!=null&&item.errorsPerKSession>baselineValue*1.2)return'watch'
  return'healthy'
}
function p75ByDim(env,appId,dim,start,end,metric){
  return env.DB.prepare(`select ${dim} v,value from (select ${dim} v2,value,count(*) over (partition by ${dim}) n,row_number() over (partition by ${dim} order by value) rn from events where app_id=? and ts>=? and ts<=? and type='perf' and metric=? and ifnull(${dim},'')<>'') where rn between cast((n-1)*0.75 as integer)+1 and cast((n-1)*0.75 as integer)+2`).bind(appId,start,end,metric).all().catch(()=>({results:[]}))
}
function p75Interpolate(rows,keyName){
  const grouped=new Map()
  for(const row of rows){const list=grouped.get(row[keyName])||[];list.push(Number(row.value));grouped.set(row[keyName],list)}
  const out=new Map()
  for(const [key,values] of grouped){const sorted=values.sort((a,b)=>a-b),index=(sorted.length-1)*.75,lo=Math.floor(index),hi=Math.ceil(index);out.set(key,lo===hi?sorted[lo]:sorted[lo]+(sorted[hi]-sorted[lo])*(index-lo))}
  return out
}
function releaseQualityCompare(env,url,auth){
  const appId=url.searchParams.get('appId'),a=url.searchParams.get('a'),b=url.searchParams.get('b'),since14=Date.now()-14*86400000
  if(!appId||!a||!b)return json({error:'appId 与 A/B 版本不能为空'},400)
  return Promise.all([
    env.DB.prepare(`select name,count(*) count from events where app_id=? and release_name=? and type='error' group by name order by count desc limit 50`).bind(appId,a).all().catch(()=>({results:[]})),
    env.DB.prepare(`select name,count(*) count from events where app_id=? and release_name=? and type='error' group by name order by count desc limit 50`).bind(appId,b).all().catch(()=>({results:[]})),
    p75ByDimRelease(env,appId,[a,b],since14,['lcp','inp','fcp']),
    env.DB.prepare(`select release_name,dim_day day_key,count(distinct coalesce(nullif(user_id,''),device_id)) users from (select release_name,cast(ts/86400000 as integer) dim_day,user_id,device_id,ts from events where app_id=? and release_name in (?,?) and ts>=?) group by release_name,dim_day,coalesce(nullif(user_id,''),device_id)`).bind(appId,a,b,since14).all().catch(()=>({results:[]}))
  ]).then(([errA,errB,perfRows,trendRows])=>{
    const mapA=Object.fromEntries((errA.results||[]).map(r=>[r.name,Number(r.count)])),mapB=Object.fromEntries((errB.results||[]).map(r=>[r.name,Number(r.count)]))
    const names=[...new Set([...Object.keys(mapA),...Object.keys(mapB)])]
    const perfAgg=new Map()
    for(const row of perfRows.results||[]){const k=`${row.release}|${row.metric}`,list=perfAgg.get(k)||[];list.push(Number(row.value));perfAgg.set(k,list)}
    const perfOf=release=>Object.fromEntries(['lcp','inp','fcp'].map(metric=>{const vals=perfAgg.get(`${release}|${metric}`)||[];return[metric,vals.length?Math.round(p75of(vals)):null]}))
    const trendAggA=new Map(),trendAggB=new Map()
    for(const row of trendRows.results||[]){
      const target=row.release_name===a?trendAggA:trendAggB
      target.set(Number(row.day_key),(target.get(Number(row.day_key))||0)+Number(row.users))
    }
    const days=[...new Set([...trendAggA.keys(),...trendAggB.keys()])].sort((x,y)=>x-y)
    return json(lvl(env,{errors:names.map(name=>({name,aCount:mapA[name]||0,bCount:mapB[name]||0,delta:(mapA[name]||0)>0&&(mapB[name]||0)===0?'new':(mapA[name]||0)===0&&(mapB[name]||0)>0?'gone':'flat'})).sort((x,y)=>y.aCount-x.aCount).slice(0,10),
      perf:{a:perfOf(a),b:perfOf(b)},
      trend:days.map(day=>({day:new Date(day*86400000).toISOString().slice(0,10),a:trendAggA.get(day)||0,b:trendAggB.get(day)||0}))},auth))
  })
}
function p75ByDimRelease(env,appId,releases,since14,metrics){
  return env.DB.prepare(`select release_name,metric,value from (select release_name,metric,value,count(*) over (partition by release_name,metric) n,row_number() over (partition by release_name,metric order by value) rn from events where app_id=? and release_name in (${releases.map(()=>'?').join(',')}) and ts>=? and type='perf' and metric in (${metrics.map(()=>'?').join(',')})) where rn between cast((n-1)*0.75 as integer)+1 and cast((n-1)*0.75 as integer)+2`).bind(appId,...releases,since14,...metrics).all().catch(()=>({results:[]}))
}
function p75of(values){const sorted=[...values].sort((x,y)=>x-y),index=(sorted.length-1)*.75,lo=Math.floor(index),hi=Math.ceil(index);return lo===hi?sorted[lo]:sorted[lo]+(sorted[hi]-sorted[lo])*(index-lo)}

// PRD 05 漏斗报告整形（复用 runFunnel 输出）
async function funnelReport(env,id,url){
  const responseText=await runFunnel(env,id,url),result=typeof responseText.json==='function'?await responseText.clone().json():responseText
  const steps=result.steps||[],lost=result.lostSessions||[],users=steps[0]?.count??0,converted=steps.at(-1)?.count??0
  const withError=lost.filter(item=>Number(item.errors)>0).length
  return json({meta:{id,name:result.definition?.name,windowMs:result.windowMs??null,users,converted,overallRate:users>0?Number((converted/users).toFixed(4)):0},
    steps:steps.map((step,index)=>({idx:index+1,event:step.step,users:step.count,rate:index===0?1:Number((step.rate/100).toFixed(4)),lost:step.lost})),
    trend:(result.trend||[]).map(row=>({day:new Date(new Date(row.date).getTime()).toISOString().slice(0,10),rate:row.entered>0?Number((row.converted/row.entered).toFixed(4)):0})),
    segments:(result.dimensions||[]).map(dimension=>({field:dimension.field,items:(dimension.items||[]).map(item=>({name:item.name,overallRate:item.entered>0?Number((item.converted/item.entered).toFixed(4)):0,entered:item.entered,converted:item.converted}))})),
    lossInsight:{lostUsers:lost.length,withErrorRate:lost.length?Number((withError/lost.length).toFixed(3)):null,topError:lost.find(item=>Number(item.errors)>0)?.lastEvent||null,sampleSessionIds:lost.slice(0,20).map(item=>item.sessionId)},
    lostSessions:lost.slice(0,20)})
}

// PRD 06 页面参与度（D1 版本：拉取 page_leave 行后在 JS 聚合）
function fetchLeaveRows(env,appId,start,end){
  const parts=["type='behavior'","name='page_leave'",'ts>=?','ts<=?'],values=[start,end]
  if(appId){parts.push('app_id=?');values.push(appId)}
  return env.DB.prepare(`select id,session_id,path,url,user_id,device_id,props_json,context_json from events where ${parts.join(' and ')} order by ts desc limit 20000`).bind(...values).all().catch(()=>({results:[]}))
}
function engageOf(row){
  const context=parse(row.context_json,{}),props=parse(row.props_json,{})
  return {dwellMs:numOrNull(context.dwell_ms??context.dwellMs??(props.stayTime!=null?Number(props.stayTime):null)),scrollMax:clamp01(numOrNull(context.scroll_max??context.scrollMax)),shared:!!(context.shared??props.shared),interacted:!!(context.interacted??props.interacted)}
}
function numOrNull(value){const number=Number(value);return Number.isFinite(number)?number:null}
function clamp01(value){return value==null?null:Math.max(0,Math.min(1,value))}
function aggEngage(rows){
  const sessions=new Set(rows.filter(r=>r.session_id).map(r=>r.session_id)),dwells=[],scrolls=[]
  let bounce=0,shares=0
  for(const row of rows){
    const eng=engageOf(row)
    if(eng.dwellMs!=null&&eng.dwellMs>0&&eng.dwellMs<7200000)dwells.push(eng.dwellMs)
    if(eng.scrollMax!=null)scrolls.push(eng.scrollMax)
    if(eng.dwellMs!=null&&eng.dwellMs<3000&&!eng.interacted)bounce++
    if(eng.shared)shares++
  }
  const avg=list=>list.length?list.reduce((s,v)=>s+v,0)/list.length:null
  return {sampleSize:dwells.length,avgDwellMs:dwells.length?Math.round(avg(dwells)):null,p90DwellMs:dwells.length?Math.round(dwells.slice().sort((a,b)=>a-b)[Math.min(dwells.length-1,Math.max(0,Math.ceil(0.9*dwells.length)-1))]):null,
    avgScroll:scrolls.length?Number(avg(scrolls).toFixed(3)):null,reach75Rate:scrolls.length?Number((scrolls.filter(v=>v>=0.75).length/scrolls.length).toFixed(4)):null,
    bounceRate:rows.length?Number((bounce/rows.length).toFixed(4)):null,shareSessionRate:sessions.size?Number((shares/sessions.size).toFixed(4)):null}
}
function engagementList(env,url){
  const start=Number(url.searchParams.get('startTime'))||Date.now()-7*86400000,end=Number(url.searchParams.get('endTime'))||Date.now(),appId=url.searchParams.get('appId')||''
  return Promise.all([fetchLeaveRows(env,appId,start,end),
    env.DB.prepare(`select path,count(*) pv,count(distinct coalesce(nullif(user_id,''),nullif(device_id,''),session_id)) uv from events where type='behavior' and name='pv' and ts>=? and ts<=? ${appId?'and app_id=?':''} group by path`).bind(...(appId?[start,end,appId]:[start,end])).all().catch(()=>({results:[]}))
  ]).then(([leaves,pvs])=>{
    const pvMap=new Map((pvs.results||[]).map(r=>[r.path,{pv:Number(r.pv),uv:Number(r.uv)}]))
    const grouped=new Map()
    for(const row of leaves.results||[]){const key=row.path||'/';(grouped.get(key)||grouped.set(key,[]).get(key)).push(row)}
    let items=[...grouped.entries()].map(([path,rows])=>{const m=aggEngage(rows),traffic=pvMap.get(path)||{pv:rows.length,uv:m.sampleSize};return {path,pv:traffic.pv,uv:traffic.uv,...m,sampleNote:m.sampleSize<30?'样本量不足，仅供参考':''}})
    if(url.searchParams.get('q'))items=items.filter(item=>item.path.includes(url.searchParams.get('q')))
    items.sort((a,b)=>b.pv-a.pv)
    const page=Math.max(1,Number(url.searchParams.get('page')||1)),size=Math.min(100,Math.max(1,Number(url.searchParams.get('pageSize')||20)))
    return json({total:items.length,items:items.slice((page-1)*size,page*size)})
  })
}
async function engagementDetail(env,url,auth){
  const path=url.searchParams.get('path')
  if(!path)return json({error:'path 不能为空'},400)
  const start=Number(url.searchParams.get('start'))||Date.now()-7*86400000,end=Number(url.searchParams.get('end'))||Date.now()
  const rows=(await fetchLeaveRows(env,url.searchParams.get('appId')||'',start,end)).results.filter(r=>(r.path||'/')===path)
  const dwells=rows.map(r=>engageOf(r).dwellMs).filter(v=>v!=null&&v>0&&v<7200000)
  const buckets=[[0,3000],[3000,10000],[10000,30000],[30000,120000],[120000,Infinity]]
  const distribution=buckets.map(([min,max])=>({label:max===Infinity?'2m+':min===0?'0-3s':max===10000?'3-10s':max===30000?'10-30s':'30s-2m',count:dwells.filter(v=>v>=min&&v<max).length}))
  for(const bucket of distribution)bucket.rate=Number((bucket.count/(dwells.length||1)).toFixed(4))
  const scrolls=rows.map(r=>engageOf(r).scrollMax).filter(v=>v!=null)
  const scrollFunnel=[0.25,0.5,0.75,1].map(threshold=>({threshold,rate:scrolls.length?Number((scrolls.filter(v=>v>=threshold).length/scrolls.length).toFixed(4)):null}))
  let compare=null
  if(url.searchParams.get('compareStart')&&url.searchParams.get('compareEnd')){
    compare={a:aggEngage(((await fetchLeaveRows(env,url.searchParams.get('appId')||'',Number(url.searchParams.get('compareStart')),Number(url.searchParams.get('compareEnd')))).results).filter(r=>(r.path||'/')===path)),b:aggEngage(rows)}
  }
  return json(lvl(env,{path,sampleSize:rows.length,sufficientSample:rows.length>=30,distribution,scrollFunnel,summary:aggEngage(rows),compare},auth))
}

// Next Horizon A1 · 留存 / 同期群分析（D1 版本）
// 与 Node/PostgreSQL 端语义一致（同口径、同响应结构），差异仅两处：
//   1. 日切表达式：PG 的 (ts / 86400000)::integer → D1 的 cast(ts / 86400000 as integer)
//      （SQLite 整数除法对非负 ts 等价于 floor，与 PG integer 除法同结果）。
//   2. (uid, day) 去重下推到 SQL group by：把「每次 PV 一行」压成「每用户每日一行」，
//      显著减少 D1 返回行数；buildRetentionReport 对重复行幂等，聚合结果不变。
// 聚合本身不在此处实现，统一走 packages/retention.js，保证两端数字零漂移。
function fetchRetentionRows(env,appId,start,end){
  const parts=["type='behavior'","name='pv'",'ts>=?','ts<=?'],values=[start,end]
  if(appId){parts.push('app_id=?');values.push(appId)}
  return env.DB.prepare(`select coalesce(nullif(user_id,''), nullif(device_id,''), session_id) as uid,
    cast(ts / ${RETENTION_DAY_MS} as integer) as day
    from events where ${parts.join(' and ')} group by uid, day`).bind(...values).all()
}
function retentionList(env,url){
  const p=url.searchParams,now=Date.now()
  // 参数语义对齐 Node filters()：非法/缺省回落最近 30 天
  const start=Number(p.get('startTime'))||now-30*RETENTION_DAY_MS,end=Number(p.get('endTime'))||now
  const appId=clip(p.get('appId')||'',64)
  // 分页默认值对齐 Node filters()（page=1、pageSize=10；上限同为 100）
  return fetchRetentionRows(env,appId,start,end).then(res=>json(buildRetentionReport(res.results||[],{
    startTime:start,endTime:end,appId,offsets:p.get('offsets')||'',page:p.get('page')||1,pageSize:p.get('pageSize')||10
  })))
}

// PRD 07 成员管理
async function memberSave(env,input){
  const name=String(input.name||'').trim().slice(0,64)
  if(!name)return json({error:'成员名称不能为空'},400)
  const level=normalizeLevel(input.level),id=clip(input.id||`m_${name.replace(/\s+/g,'_').slice(0,24)}`,32),now=Date.now()
  await env.DB.prepare(`insert into members(id,name,role,access_level,created_at,updated_at) values(?,?,?,?,?,?)
    on conflict(id) do update set name=excluded.name,role=excluded.role,access_level=excluded.access_level,updated_at=excluded.updated_at`)
    .bind(id,name,clip(input.role||'',64),level,now,now).run()
  await writeAuditDb(env,id,'level_change',`${name}:${level}`)
  return json({ok:true,id})
}
async function memberLevel(env,id,input){
  const level=normalizeLevel(input?.level),member=await env.DB.prepare('select * from members where id=?').bind(String(id).slice(0,32)).first()
  if(!member)return json({error:'成员不存在'},404)
  await env.DB.prepare('update members set access_level=?,updated_at=? where id=?').bind(level,Date.now(),member.id).run()
  await writeAuditDb(env,member.id,'level_change',`${member.name}: ${member.access_level} → ${level}`)
  return json({ok:true,level})
}
async function writeAuditDb(env,memberId,action,target){
  try{await env.DB.prepare('insert into data_access_audit(member_id,action,target,detail_json,created_at) values(?,?,?,?,?)').bind(String(memberId).slice(0,32),action,String(target||'').slice(0,128),'{}',Date.now()).run()}catch{}
}