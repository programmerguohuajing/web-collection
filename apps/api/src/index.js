/**
 * @file API 服务入口
 * Express 应用，提供前端监控数据的采集接口和管理接口。
 * - 公开接口：POST /api/collect、GET /api/collect.gif
 * - 管理接口：事件查询、报表汇总、回放查询、SourceMap 上传、Issue 解决
 * - 静态资源托管：构建后的 Web 仪表盘
 */

import express from 'express'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getReplay, getSummary, initDatabase, listEvents, listEventsPage, listIssues, listIssuesPage, listReplays, listReplaysPage, recordEvents, resolveIssue, saveSourceMap } from './store.js'
import { authorizeCollect, cleanupExpiredData, deleteApplication, deleteRelease, getSettings, listAlerts, listApplications, listReleases, rollupMetricDailyStats, rotateCollectKey, saveApplication, saveRelease, saveSettings, updateAlertStatus } from './governance.js'
import { consumeAlertDelivery, deleteAlertChannel, listAlertChannels, listAlertDeliveries, retryAlertDelivery, retryPendingDeliveries, saveAlertChannel, testAlertChannel } from './alerting.js'
import { deleteDashboard, deleteFunnel, deleteInsight, getApiHealth, getClickPaths, getDistributedTrace, getHeatmap, getLive, getPaths, getReleaseComparison, getReleaseDetailComparison, getSessionEvents, getSessions, getTrace, getTraceTopology, listDashboards, listEventProperties, listFunnelEventNames, listFunnels, listInsights, listLogs, listTraces, queryEventInsight, queryPaths, recordSpans, runFunnel, saveDashboard, saveFunnel, saveInsight, getSharedDashboard, shareDashboard, unshareDashboard, SPANS_HARD_LIMIT } from './services/analytics-service.js'
import { getJourneyTimeline, searchJourneySessions } from './services/journey-service.js'
import { getDictionaryDetail, listDictionary, registerEvent } from './services/dictionary-service.js'
import { compareReleases, getReleaseQuality } from './services/quality-service.js'
import { collectConfigStats, listCollectConfigHistory, previewCollectConfig, rollbackCollectConfig, saveCollectConfig } from './services/collect-config-service.js'
import { getEngagementDetail, listEngagement } from './services/engagement-service.js'
import { listRetention } from './services/retention-service.js'
import { listDataAccessAudit, listMembers, resolveAccessLevel, saveMember, saveMemberLevel } from './services/access-service.js'
import { changePassword, getMe, isOpenRegisterEnabled, login, logout, refresh, register, ACCESS_TTL_SEC, REFRESH_COOKIE } from './services/auth-service.js'
import { listSessions, revokeSession } from './services/session-service.js'
import { getSdkMonitoring, getSdkSize, reportSdkMonitoring, reportSdkSize } from './services/sdk-health-service.js'
import { acceptInvitationService, assignApplication, changeMemberLevel, changeMemberRole, createInvitation, createTeam, getTeam, listInvitations, listTeamAudit, listTeamMembers, migrateMembersToDefaultTeam, removeMember, revokeInvitation, updateTeam } from './services/team-service.js'
import { identityMiddleware, isAccountsEnabled } from './auth-middleware.js'
import { resolveCollectConfig } from '../../../packages/collect-config.js'
import { applyAccessLevel } from '../../../packages/access-level.js'
import { createMaskingMiddleware, MASK_SKIP_PREFIXES } from './privacy.js'
import { badRequest } from './utils/http-error.js'
import { buildCapabilities, NODE_CAPABILITIES } from '../../../packages/deployment-capabilities.js'
import { createAiRouter } from './ai-service.js'
import { startSloScheduler } from './slo-scheduler.js'
import { createSlo, updateSloById, deleteSlo, listSlo, getSlo, computeBudget, computeTrend, listSloAlerts, computeSnapshot, evaluateAlerts, setAlertPolicy } from './services/slo-service.js'
import { startSyntheticScheduler } from './synthetic-scheduler.js'
import { saveCheck, listChecks, getCheck, deleteCheck, runProbeById, getTimeline, getStats } from './services/synthetic-service.js'
import { createDsrRequest, listDsrRequests, getDsrRequest, submitDsrRequest, approveDsrRequest, executeDsrRequest, cancelDsrRequest, listDsrAudit } from './services/dsr-service.js'
import { importSentryIssues, previewSentryIssue } from './services/sentry-service.js'
import { saveExperiment, listExperiments, getExperiment, getExperimentReport, changeExperimentStatus, deleteExperiment, listRunningExperimentsForApp } from './services/experiment-service.js'
import { getUsage, getDaily, getByApp, listPlans, getTeamPlan, putTeamPlan, listQuotaEvents } from './services/metering-service.js'
import { getBrand, saveBrand, resetBrand, publicBrand, whiteLabelEnabled } from './services/branding-service.js'

/** 服务监听端口 */
const port = Number(process.env.PORT || 8787)
/** 公开采集接口的 token（未配置时默认放行） */
const publicToken = process.env.COLLECT_TOKEN || ''
/** 前端静态资源目录 */
const currentDir = dirname(fileURLToPath(import.meta.url))
const apiDir = join(currentDir, '..')
const distDir = process.env.WEB_DIST
  ? isAbsolute(process.env.WEB_DIST) ? process.env.WEB_DIST : join(apiDir, process.env.WEB_DIST)
  : join(currentDir, '../../web/dist')
const sdkDir = process.env.SDK_DIST
  ? isAbsolute(process.env.SDK_DIST) ? process.env.SDK_DIST : join(apiDir, process.env.SDK_DIST)
  : join(currentDir, '../../../packages/sdk/dist')

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
}

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '20mb', verify: (req, res, buffer) => { req.rawBody = buffer.toString('utf8') } }))
app.use(corsMiddleware)

// D2 身份中间件：在掩码/等级裁剪之前解析 req.auth（accounts=false 时透传，存量零破坏）。
// 严格模式（ACCOUNTS_ENFORCE=1）下受控管理接口未登录返回 401（PRD FR-10，前端登录页就绪后开启）。
app.use(identityMiddleware)

// 查询侧隐私脱敏（mask-at-query，见 ADR-007）：默认对所有 /api 查询响应递归掩码
// PII（邮箱/手机/身份证/银行卡/JWT）与凭据字段，作为 raw 模式全量采集的下游兜底，
// 对 balanced 档（SDK 采集层已脱敏）则是幂等安全网。
// 授权查看者（请求头 x-eys-raw-access 匹配环境变量 EYS_RAW_ACCESS_TOKEN）可看原文；
// 写入 / 配置 / 静态类路由不掩码，避免破坏采集、治理配置与资源分发。
app.use(createMaskingMiddleware())

// PRD 07 数据访问等级：按全局等级（环境变量 DATA_ACCESS_LEVEL，默认 L2 fail-close）
// 裁剪响应中的 ip / userId / userPhone。明细读取类接口（journey/dictionary/quality/
// engagement/events 等）不感知等级、业务零改动，由本中间件统一裁剪；
// 配置与管理类路由跳过。等级本身经 /api/me/access-level 显式暴露给前端。
const ACCESS_SKIP_PREFIXES = [
  ...MASK_SKIP_PREFIXES,
  '/api/me', '/api/members', '/api/audit', '/api/collect-config'
]
app.use((req, res, next) => {
  const path = req.path
  if (!path.startsWith('/api/') || ACCESS_SKIP_PREFIXES.some(prefix => path.startsWith(prefix))) return next()
  const originalJson = res.json.bind(res)
  // D2 FR-9：已登录取 req.auth.level（团队成员等级），未登录/accounts=false 回落环境变量（fail-close L2）
  const level = resolveAccessLevel(req)
  res.json = (body) => originalJson(applyAccessLevel(body, level))
  next()
})

// 健康检查，给部署平台和监控系统使用。
app.get('/health', (req, res) => {
  res.json({ ok: true })
})
app.get('/api/capabilities', (req, res) => {
  // D2：accounts 为运行时开关（ACCOUNTS_ENABLED），开启才向前端暴露登录态/团队入口
  res.json(buildCapabilities(NODE_CAPABILITIES, { accounts: isAccountsEnabled() }))
})

// AI 诊断（M2）：/api/ai/*（Node + PG + pgvector，复用 packages/ai 共享逻辑）
app.use('/api/ai', createAiRouter())

// 公开埋点入口：支持单条、数组、以及 { events: [...] } 批量格式。
app.post('/api/collect', async (req, res, next) => {
  try {
    if (!checkPublicToken(req, res)) return
    const payload = req.body ?? {}
    // replay 事件的 events 字段是 rrweb 录制数据，不能拆开当作批量事件处理
    const isReplay = payload.type === 'replay'
    const inputs = isReplay
      ? [payload]
      : Array.isArray(payload.events) ? payload.events : Array.isArray(payload) ? payload : [payload]
    const appIds = [...new Set(inputs.map(item => clip(item?.appId || 'default', 64)))]
    if (appIds.length !== 1 || !await authorizeCollect(appIds[0], req.get('x-app-key'))) return res.status(401).send('bad app key')
    const recorded = await recordEvents(inputs.slice(0, 100).map(sanitize))
    res.json({ ok: true, count: recorded.length, received: inputs.length })
  } catch (err) {
    next(err)
  }
})

// GIF 埋点兼容接口：适合脚本受限场景，通过 querystring 上报单条事件。
app.get('/api/collect.gif', async (req, res, next) => {
  try {
    if (!checkPublicToken(req, res)) return
    const data = req.query.data
    if (typeof data === 'string' && data) await recordEvents([sanitize(JSON.parse(data))])
    const pixel = Buffer.from('R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64')
    res.status(200).type('gif').set('Cache-Control', 'no-store').send(pixel)
  } catch (err) {
    next(err)
  }
})

// 事件与报表查询接口。
app.get('/api/events', async (req, res, next) => {
  try {
    res.json(await listEventsPage(filters(req.query)))
  } catch (err) {
    next(err)
  }
})
app.get('/api/summary', async (req, res, next) => {
  try {
    res.json(await getSummary(filters(req.query)))
  } catch (err) {
    next(err)
  }
})
app.get('/api/issues', async (req, res, next) => {
  try {
    res.json(await listIssuesPage(filters(req.query)))
  } catch (err) {
    next(err)
  }
})
app.get('/api/replays', async (req, res, next) => {
  try {
    res.json(await listReplaysPage(filters(req.query)))
  } catch (err) {
    next(err)
  }
})
app.get('/api/replays/:sessionId', async (req, res, next) => {
  try {
    res.json(await getReplay(req.params.sessionId))
  } catch (err) {
    next(err)
  }
})
app.post('/api/sourcemaps', async (req, res, next) => {
  try {
    res.json(await saveSourceMap(req.body || {}))
  } catch (err) {
    next(err)
  }
})
app.post('/api/issues/:id/resolve', async (req, res, next) => {
  try {
    res.json(await resolveIssue(req.params.id, req.body?.resolutionNotes))
  } catch (err) {
    next(err)
  }
})
app.get('/api/applications', async (req, res, next) => {
  try {
    // D2 FR-7：登录态按当前团队过滤（未归属应用全员可见便于认领；api_key/system 看全部）
    const query = { ...req.query }
    if (isAccountsEnabled() && req.auth?.via === 'session' && req.auth.teamId) {
      query.teamId = req.auth.teamId
      query.teamScope = 'member'
    }
    res.json(await listApplications(query))
  } catch (err) { next(err) }
})
app.post('/api/applications', async (req, res, next) => {
  try { res.json(await saveApplication(req.body || {})) } catch (err) { next(err) }
})
app.get('/api/applications/:appId/releases', async (req, res, next) => {
  try { res.json(await listReleases(req.params.appId, req.query)) } catch (err) { next(err) }
})
app.put('/api/applications/:appId/releases/:release', async (req, res, next) => {
  try { res.json(await saveRelease(req.params.appId, { ...req.body, release: req.params.release })) } catch (err) { next(err) }
})
app.delete('/api/applications/:appId/releases/:release', async (req, res, next) => {
  try { res.json(await deleteRelease(req.params.appId, req.params.release)) } catch (err) { next(err) }
})
app.get('/api/applications/:appId', async (req, res, next) => {
  try { res.json(await listApplications({ appId: req.params.appId, page: 1, pageSize: 1 })) } catch (err) { next(err) }
})
app.put('/api/applications/:appId', async (req, res, next) => {
  try { res.json(await saveApplication({ ...req.body, appId: req.params.appId })) } catch (err) { next(err) }
})
app.delete('/api/applications/:appId', async (req, res, next) => {
  try { res.json(await deleteApplication(req.params.appId)) } catch (err) { next(err) }
})
app.get('/api/settings', async (req, res, next) => {
  try { res.json(await getSettings()) } catch (err) { next(err) }
})
app.put('/api/settings', async (req, res, next) => {
  try { res.json(await saveSettings(req.body || {})) } catch (err) { next(err) }
})
app.get('/api/alerts', async (req, res, next) => {
  try { res.json(await listAlerts(req.query)) } catch (err) { next(err) }
})
app.patch('/api/alerts/:id', async (req, res, next) => {
  try {
    res.json(await updateAlertStatus(req.params.id, req.body?.status))
  } catch (err) {
    const status = Number(err?.statusCode) || 500
    if (status >= 400 && status < 500) return res.status(status).json({ error: err.message })
    next(err)
  }
})
app.get('/api/alert-channels', async (req, res, next) => {
  try { res.json(await listAlertChannels(req.query)) } catch (err) { next(err) }
})
app.post('/api/alert-channels', async (req, res, next) => {
  try { res.json(await saveAlertChannel(null, req.body || {})) } catch (err) { next(err) }
})
app.put('/api/alert-channels/:id', async (req, res, next) => {
  try { res.json(await saveAlertChannel(Number(req.params.id), req.body || {})) } catch (err) { next(err) }
})
app.delete('/api/alert-channels/:id', async (req, res, next) => {
  try { res.json(await deleteAlertChannel(Number(req.params.id))) } catch (err) { next(err) }
})
app.post('/api/alert-channels/:id/test', async (req, res, next) => {
  try { res.json(await testAlertChannel(Number(req.params.id))) } catch (err) { next(err) }
})
// C2 集成市场：Sentry issue 导入（指纹与本栈采集事件对齐，命中即合并计数）
app.post('/api/integrations/sentry/import', async (req, res, next) => {
  try { res.json(await importSentryIssues(req.body || {})) } catch (err) {
    const status = Number(err?.statusCode) || 500
    if (status >= 400 && status < 500) return res.status(status).json({ error: err.message })
    next(err)
  }
})
app.post('/api/integrations/sentry/preview', async (req, res, next) => {
  try {
    const entry = req.body?.issue ?? req.body
    if (!entry || typeof entry !== 'object') throw Object.assign(new Error('issue 必填'), { statusCode: 400 })
    res.json(previewSentryIssue(entry))
  } catch (err) {
    const status = Number(err?.statusCode) || 500
    if (status >= 400 && status < 500) return res.status(status).json({ error: err.message })
    next(err)
  }
})
app.get('/api/alert-deliveries', async (req, res, next) => {
  try { res.json(await listAlertDeliveries(req.query)) } catch (err) { next(err) }
})
app.post('/api/alert-deliveries/:id/retry', async (req, res, next) => {
  try { res.json(await retryAlertDelivery(Number(req.params.id))) } catch (err) { next(err) }
})
app.post('/api/internal/alerts/deliver', async (req, res, next) => {
  try {
    const base = process.env.ALERT_PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`
    const result = await consumeAlertDelivery({
      body: req.rawBody || JSON.stringify(req.body || {}),
      signature: req.get('upstash-signature'),
      url: new URL(req.originalUrl, base).toString(),
      retried: Number(req.get('upstash-retried') || 0)
    })
    res.set(result.headers || {}).status(result.status).json(result.body)
  } catch (err) { next(err) }
})
app.post('/api/applications/:appId/collect-key', async (req, res, next) => {
  try { res.json(await rotateCollectKey(req.params.appId)) } catch (err) { next(err) }
})
app.get('/api/logs', async (req, res, next) => { try { res.json(await listLogs(filters(req.query))) } catch (err) { next(err) } })
app.get('/api/traces', async (req, res, next) => { try { res.json(await listTraces(filters(req.query))) } catch (err) { next(err) } })
app.get('/api/traces/:traceId', async (req, res, next) => { try { res.json(await getTrace(req.params.traceId, filters(req.query))) } catch (err) { next(err) } })
app.get('/api/traces/:traceId/distributed', async (req, res, next) => { try { res.json(await getDistributedTrace(req.params.traceId, filters(req.query))) } catch (err) { next(err) } })
app.get('/api/traces/:traceId/topology', async (req, res, next) => { try { res.json(await getTraceTopology(req.params.traceId, filters(req.query))) } catch (err) { next(err) } })
// 链路追踪 span 接收端点
// 兼容两种契约（v1/v2 双读）：
//   - v1：直接是 Span 数组（或单个 Span 对象），历史 SDK / 手动调用
//   - v2：Span Envelope `{ schemaVersion: 2, resource, spans: [...] }`，SDK Processor/Exporter 默认发送
app.post('/api/spans', async (req, res, next) => {
  try {
    const body = req.body
    let spans
    if (Array.isArray(body)) {
      spans = body
    } else if (body && typeof body === 'object') {
      if (Array.isArray(body.spans)) {
        // v2 信封：校验 schemaVersion（仅支持 2；未携带则按 2 处理）
        if (body.schemaVersion !== undefined && Number(body.schemaVersion) !== 2) {
          return res.status(400).json({ error: 'unsupported_schema_version', schemaVersion: body.schemaVersion })
        }
        spans = body.spans
      } else {
        // 单个 Span 对象（v1 松散写法）
        spans = [body]
      }
    } else {
      return res.status(400).json({ error: 'invalid_payload', message: 'expected array of spans or { schemaVersion, resource, spans }' })
    }

    if (!Array.isArray(spans) || spans.length === 0) {
      return res.status(400).json({ error: 'empty_payload' })
    }
    if (spans.length > SPANS_HARD_LIMIT) {
      return res.status(413).json({ error: 'too_many_spans', max: SPANS_HARD_LIMIT, received: spans.length })
    }

    res.json(await recordSpans(spans))
  } catch (err) { next(err) }
})
app.get('/api/analytics/sessions', async (req, res, next) => { try { res.json(await getSessions(filters(req.query))) } catch (err) { next(err) } })
app.get('/api/analytics/sessions/:sessionId', async (req, res, next) => { try { res.json(await getSessionEvents(req.params.sessionId, filters(req.query))) } catch (err) { next(err) } })
app.get('/api/analytics/paths', async (req, res, next) => { try { res.json(await getPaths(filters(req.query))) } catch (err) { next(err) } })
app.get('/api/analytics/click-paths', async (req, res, next) => { try { res.json(await getClickPaths(filters(req.query))) } catch (err) { next(err) } })
app.get('/api/analytics/heatmap', async (req, res, next) => { try { res.json(await getHeatmap(filters(req.query))) } catch (err) { next(err) } })
app.get('/api/analytics/live', async (req, res, next) => { try { res.json(await getLive(filters(req.query))) } catch (err) { next(err) } })
app.get('/api/analytics/releases', async (req, res, next) => { try { res.json(await getReleaseComparison(filters(req.query))) } catch (err) { next(err) } })
app.get('/api/analytics/releases/compare', async (req, res, next) => { try { const { appId } = req.query; res.json(await getReleaseDetailComparison(appId, req.query.from, req.query.to)) } catch (err) { next(err) } })
app.get('/api/analytics/event-names', async (req, res, next) => { try { res.json(await listFunnelEventNames(filters(req.query))) } catch (err) { next(err) } })
app.get('/api/analytics/event-properties', async (req, res, next) => { try { res.json(await listEventProperties({ ...filters(req.query), eventName: req.query.eventName })) } catch (err) { next(err) } })
app.post('/api/analytics/insights/query', async (req, res, next) => { try { res.json(await queryEventInsight(req.body || {})) } catch (err) { next(err) } })
app.post('/api/analytics/paths/query', async (req, res, next) => { try { res.json(await queryPaths(req.body || {})) } catch (err) { next(err) } })
app.get('/api/analytics/insights', async (req, res, next) => { try { res.json(await listInsights()) } catch (err) { next(err) } })
app.post('/api/analytics/insights', async (req, res, next) => { try { res.json(await saveInsight(req.body || {})) } catch (err) { next(err) } })
app.put('/api/analytics/insights/:id', async (req, res, next) => { try { res.json(await saveInsight(req.body || {}, Number(req.params.id))) } catch (err) { next(err) } })
app.delete('/api/analytics/insights/:id', async (req, res, next) => { try { res.json(await deleteInsight(Number(req.params.id))) } catch (err) { next(err) } })
// Next Horizon E2：API 健康视图——复用 fetch/xhr 性能事件聚合端点健康度（列表 / 单端点时序下钻）
app.get('/api/analytics/api-health', async (req, res, next) => { try { res.json(await getApiHealth(filters(req.query), req.query.endpoint)) } catch (err) { next(err) } })
// ==================== B2 · SLO / 错误预算 / 可用性看板 ====================
// 能力位门禁：slo=false（默认 false 兜底 / Worker 未翻）返回 503，前端据此显式「当前部署不支持 SLO」。
app.post('/api/slo', async (req, res, next) => { guardSlo(res, next, async () => { res.json(await createSlo(req.body || {}, req.auth)) }) })
app.get('/api/slo', async (req, res, next) => {
  guardSlo(res, next, async () => {
    const query = { ...req.query }
    if (isAccountsEnabled() && req.auth?.via === 'session' && req.auth.teamId) {
      query.teamId = req.auth.teamId
    }
    res.json(await listSlo(query))
  })
})
app.get('/api/slo/:id/budget', async (req, res, next) => {
  guardSlo(res, next, async () => { res.json(await computeBudget(req.params.id, req.query.window, req.auth)) })
})
app.get('/api/slo/:id/trend', async (req, res, next) => {
  guardSlo(res, next, async () => { res.json(await computeTrend(req.params.id, req.query.start, req.query.end, req.auth)) })
})
app.get('/api/slo/:id/alerts', async (req, res, next) => {
  guardSlo(res, next, async () => { res.json(await listSloAlerts(req.params.id, req.query)) })
})
app.post('/api/slo/:id/alert-policy', async (req, res, next) => {
  guardSlo(res, next, async () => { res.json(await setAlertPolicy(req.params.id, req.body || {}, req.auth)) })
})
app.post('/api/slo/:id/compute', async (req, res, next) => {
  guardSlo(res, next, async () => {
    const now = Date.now()
    const snapshot = await computeSnapshot(req.params.id, now)
    const result = await evaluateAlerts(req.params.id, snapshot)
    res.json({ snapshot, breach: result.breach, alert: result.alert || null })
  })
})
app.get('/api/slo/:id', async (req, res, next) => { guardSlo(res, next, async () => { res.json(await getSlo(req.params.id, req.auth)) }) })
app.delete('/api/slo/:id', async (req, res, next) => { guardSlo(res, next, async () => { res.json(await deleteSlo(req.params.id, req.auth)) }) })

// ==================== B3 · 合成监控（主动探针，双栈同构对齐 Worker /api/synthetic） ====================
// 能力位门禁：synthetic=false 返回 503，前端显式「当前部署不支持合成监控」。
// 注意顺序：/:id/run|timeline|stats 等多段路由先于 /:id 单段注册。
app.post('/api/synthetic', async (req, res, next) => { guardSynthetic(res, next, async () => { res.json(await saveCheck(req.body || {}, req.auth)) }) })
app.get('/api/synthetic', async (req, res, next) => {
  guardSynthetic(res, next, async () => {
    const query = { ...req.query }
    if (isAccountsEnabled() && req.auth?.via === 'session' && req.auth.teamId) {
      query.teamId = req.auth.teamId
    }
    res.json(await listChecks(query))
  })
})
app.post('/api/synthetic/:id/run', async (req, res, next) => {
  guardSynthetic(res, next, async () => { res.json({ result: await runProbeById(req.params.id, req.auth) }) })
})
app.get('/api/synthetic/:id/timeline', async (req, res, next) => {
  guardSynthetic(res, next, async () => { res.json(await getTimeline(req.params.id, req.auth, req.query.limit)) })
})
app.get('/api/synthetic/:id/stats', async (req, res, next) => {
  guardSynthetic(res, next, async () => { res.json(await getStats(req.params.id, req.auth, req.query.window)) })
})
app.get('/api/synthetic/:id', async (req, res, next) => { guardSynthetic(res, next, async () => { res.json(await getCheck(req.params.id, req.auth)) }) })
app.delete('/api/synthetic/:id', async (req, res, next) => { guardSynthetic(res, next, async () => { res.json(await deleteCheck(req.params.id, req.auth)) }) })

// ==================== Next Horizon E4/E1 · SDK 端交付自监控 + SDK 体积开销（与 Worker 同构） ====================
app.post('/api/monitoring/sdk', async (req, res, next) => {
  try {
    const appId = String(req.query.appId || '').slice(0, 64)
    res.json(await reportSdkMonitoring({ appId, appKey: req.headers['x-app-key'] || '', body: req.body }))
  } catch (e) { next(e) }
})
app.get('/api/monitoring/sdk', async (req, res, next) => {
  try {
    const appId = String(req.query.appId || '').slice(0, 64)
    const hours = Number(req.query.hours) || 24
    res.json(await getSdkMonitoring({ appId, hours }))
  } catch (e) { next(e) }
})
app.post('/api/sdk-size', async (req, res, next) => {
  try {
    res.json(await reportSdkSize({ ciToken: req.headers['x-ci-token'] || '', expectToken: process.env.CI_REPORT_TOKEN || '', body: req.body }))
  } catch (e) { next(e) }
})
app.get('/api/sdk-size', async (req, res, next) => {
  try {
    const version = String(req.query.version || '').slice(0, 32)
    res.json(await getSdkSize({ version }))
  } catch (e) { next(e) }
})

// ==================== D1 · 数据主体权利 DSR（查询/导出/擦除，PRD 13） ====================
// 能力位门禁：dsr=false 返回 503（Node 恒 true，Worker 走 DSR_ENABLED=1 env 门禁）；
// 权限：dsr:view/create/approve/execute（packages/rbac.js ROLE_MATRIX，全为 admin+，owner 恒允许）；
// 审批制衡（审批人 ≠ 发起人）由 dsr-service 状态机服务端强制。
// 注意顺序：/:id/submit|approve|execute|cancel|audit 多段路由先于 /:id 单段注册。
app.post('/api/dsr/requests', async (req, res, next) => { guardDsr(res, next, async () => { res.json(await createDsrRequest(req.body || {}, req.auth)) }) })
app.get('/api/dsr/requests', async (req, res, next) => { guardDsr(res, next, async () => { res.json(await listDsrRequests(req.query, req.auth)) }) })
app.post('/api/dsr/requests/:id/submit', async (req, res, next) => { guardDsr(res, next, async () => { res.json(await submitDsrRequest(req.params.id, req.auth)) }) })
app.post('/api/dsr/requests/:id/approve', async (req, res, next) => { guardDsr(res, next, async () => { res.json(await approveDsrRequest(req.params.id, req.body || {}, req.auth)) }) })
app.post('/api/dsr/requests/:id/execute', async (req, res, next) => { guardDsr(res, next, async () => { res.json(await executeDsrRequest(req.params.id, req.body || {}, req.auth)) }) })
app.post('/api/dsr/requests/:id/cancel', async (req, res, next) => { guardDsr(res, next, async () => { res.json(await cancelDsrRequest(req.params.id, req.auth)) }) })
app.get('/api/dsr/requests/:id/audit', async (req, res, next) => { guardDsr(res, next, async () => { res.json(await listDsrAudit(req.params.id, req.auth)) }) })
app.get('/api/dsr/requests/:id', async (req, res, next) => { guardDsr(res, next, async () => { res.json(await getDsrRequest(req.params.id, req.auth)) }) })

// ==================== A3 · 实验分析（PRD 14；查询/创建/更新/状态迁移/删除，Node 与 Worker 同路径同契约） ====================
// 能力位门禁：experiments=false 返回 503（Node 恒 true，Worker 走 EXPERIMENTS_ENABLED=1 env 门禁）；
// 权限点：expView / expCreate / expUpdate / expArchive（packages/rbac.js ROLE_MATRIX，owner 恒允许）；
// accounts=false 时单租户全局可见（PRD P0-9）。注意顺序：/:id/report|status 多段路由先于 /:id 单段注册。
app.post('/api/experiments', async (req, res, next) => {
  guardExperiments(res, next, async () => { res.json(await saveExperiment(req.body || {}, req.auth)) })
})
app.get('/api/experiments', async (req, res, next) => {
  guardExperiments(res, next, async () => {
    const query = { ...req.query }
    if (isAccountsEnabled() && req.auth?.via === 'session' && req.auth.teamId) {
      query.teamId = req.auth.teamId
    }
    res.json(await listExperiments(query, req.auth))
  })
})
app.get('/api/experiments/:id/report', async (req, res, next) => {
  guardExperiments(res, next, async () => { res.json(await getExperimentReport(req.params.id, req.auth)) })
})
app.post('/api/experiments/:id/status', async (req, res, next) => {
  guardExperiments(res, next, async () => { res.json(await changeExperimentStatus(req.params.id, req.body?.status, req.auth)) })
})
app.get('/api/experiments/:id', async (req, res, next) => {
  guardExperiments(res, next, async () => { res.json(await getExperiment(req.params.id, req.auth)) })
})
app.delete('/api/experiments/:id', async (req, res, next) => {
  guardExperiments(res, next, async () => { res.json(await deleteExperiment(req.params.id, req.auth)) })
})

// ==================== D3 · 用量计量 & 套餐/定价（PRD 15） ====================
// 路径严格对齐 apps/web/src/api/metering.js（UI 已按此契约调用）；鉴权由 service 内部
// requirePermission(meterView / meterManage) 强制，未授权抛错经 Express 错误处理返回 403/401。
app.get('/api/metering/usage', async (req, res, next) => {
  try { res.json(await getUsage(req.auth, req.query.period)) } catch (err) { next(err) }
})
app.get('/api/metering/usage/daily', async (req, res, next) => {
  try { res.json(await getDaily(req.auth, req.query)) } catch (err) { next(err) }
})
app.get('/api/metering/usage/by-app', async (req, res, next) => {
  try { res.json(await getByApp(req.auth, req.query.period)) } catch (err) { next(err) }
})
app.get('/api/metering/plans', async (req, res, next) => {
  try { res.json(await listPlans(req.auth)) } catch (err) { next(err) }
})
app.get('/api/metering/plan', async (req, res, next) => {
  try { res.json(await getTeamPlan(req.auth)) } catch (err) { next(err) }
})
app.get('/api/metering/quota-events', async (req, res, next) => {
  try { res.json(await listQuotaEvents(req.auth, req.query.period)) } catch (err) { next(err) }
})
app.put('/api/metering/plan', async (req, res, next) => {
  try { res.json(await putTeamPlan(req.auth, req.body || {})) } catch (err) { next(err) }
})
// 便捷端点：席位维度（service 无独立 seats reader，从当前档位生效配额抽取）。
// 注：前端 getSeats 目前由 /api/metering/usage 的 metrics 派生，此端点为独立/前向兼容入口。
app.get('/api/metering/seats', async (req, res, next) => {
  try {
    const plan = await getTeamPlan(req.auth)
    res.json({ seats: Number(plan?.quota?.seats ?? 0) })
  } catch (err) { next(err) }
})

// ==================== D4 · 白标 / 私有化交付（PRD 16） ====================
// GET /api/brand 为公开端点（登录页未登录也要白标），auth-middleware 的 AUTH_PUBLIC_PREFIXES 已含 '/api/brand'；
// 白标能力位关闭时返回 { enabled:false, brand:null }。PUT / POST 需登录 + whiteLabel 能力位（后端把关）。
app.get('/api/brand', async (req, res, next) => {
  try {
    const brand = await getBrand(req.auth?.teamId || '')
    if (!whiteLabelEnabled()) return res.json({ enabled: false, brand: null })
    res.json({ enabled: true, brand: publicBrand(brand) })
  } catch (err) { next(err) }
})
app.put('/api/brand', async (req, res, next) => {
  try {
    if (!req.auth) return res.status(401).json({ error: '未登录' })
    if (!whiteLabelEnabled()) return res.status(403).json({ error: 'white-label disabled' })
    const saved = await saveBrand(req.body || {}, req.auth?.email || 'admin', req.auth?.teamId || '')
    res.json({ ok: true, brand: publicBrand(saved) })
  } catch (err) { next(err) }
})
app.post('/api/brand/reset', async (req, res, next) => {
  try {
    if (!req.auth) return res.status(401).json({ error: '未登录' })
    if (!whiteLabelEnabled()) return res.status(403).json({ error: 'white-label disabled' })
    await resetBrand(req.auth?.email || 'admin', req.auth?.teamId || '')
    res.json({ ok: true })
  } catch (err) { next(err) }
})

app.get('/api/funnels', async (req, res, next) => { try { res.json(await listFunnels(filters(req.query))) } catch (err) { next(err) } })
app.post('/api/funnels', async (req, res, next) => { try { res.json(await saveFunnel(req.body || {})) } catch (err) { next(err) } })
app.delete('/api/funnels/:id', async (req, res, next) => { try { res.json(await deleteFunnel(req.params.id)) } catch (err) { next(err) } })

// ==================== PRD 集合：洞察/治理层 ====================
// PRD 01 用户链路
app.get('/api/journey/sessions', async (req, res, next) => {
  try { res.json(await searchJourneySessions({ ...filters(req.query), type: req.query.type, value: req.query.value })) } catch (err) { next(err) }
})
app.get('/api/journey/timeline', async (req, res, next) => {
  try {
    res.json(await getJourneyTimeline(req.query.sessionId, {
      appId: req.query.appId,
      startTime: finiteTimestamp(req.query.startTime ?? req.query.start),
      endTime: finiteTimestamp(req.query.endTime ?? req.query.end),
      limit: Number(req.query.limit) || undefined
    }))
  } catch (err) { next(err) }
})
// PRD 02 事件字典
app.get('/api/events/dictionary', async (req, res, next) => {
  try { res.json(await listDictionary({ source: req.query.source, health: req.query.health, platform: req.query.platform, q: req.query.q, appId: req.query.appId, page: req.query.page, pageSize: req.query.pageSize })) } catch (err) { next(err) }
})
// 字典列表（注意：path=空串也命中 :name，需显式拒绝以返回 4xx）
app.get('/api/events/dictionary/names', async (req, res, next) => {
  // 漏斗编辑器下拉数据源：事件名 + 健康状态
  try {
    const data = await listDictionary({ q: req.query.q, pageSize: 100 })
    res.json(data.items.map(item => ({ name: item.name, health: item.health, count7d: item.count7d, verdict: item.verdict })))
  } catch (err) { next(err) }
})
app.get('/api/events/dictionary/:name', async (req, res, next) => {
  if (!req.params.name) return next(badRequest('事件名不能为空', 'MISSING_EVENT_NAME'))
  try { res.json(await getDictionaryDetail(req.params.name, { appId: req.query.appId })) } catch (err) { next(err) }
})
app.put('/api/events/dictionary/:name', async (req, res, next) => {
  try { res.json(await registerEvent(req.params.name, req.body || {})) } catch (err) { next(err) }
})
// PRD 03 版本质量
app.get('/api/releases/quality', async (req, res, next) => {
  try { res.json(await getReleaseQuality({ appId: req.query.appId, dim: req.query.dim, startTime: finiteTimestamp(req.query.start), endTime: finiteTimestamp(req.query.end) })) } catch (err) { next(err) }
})
app.get('/api/releases/quality/compare', async (req, res, next) => {
  try { res.json(await compareReleases({ appId: req.query.appId, a: req.query.a, b: req.query.b })) } catch (err) { next(err) }
})
// PRD 04 远程配置——管理端（同源）
app.get('/api/collect-config', async (req, res, next) => {
  try { res.json(await previewCollectConfig({ appId: req.query.appId, platform: req.query.platform, sdkVersion: req.query.sdkVersion })) } catch (err) { next(err) }
})
app.put('/api/collect-config', async (req, res, next) => {
  try { res.json(await saveCollectConfig(req.body || {})) } catch (err) { next(err) }
})
app.get('/api/collect-config/history', async (req, res, next) => {
  try { res.json(await listCollectConfigHistory()) } catch (err) { next(err) }
})
app.post('/api/collect-config/rollback', async (req, res, next) => {
  try { res.json(await rollbackCollectConfig(Number(req.body?.historyId), req.body || {})) } catch (err) { next(err) }
})
app.get('/api/collect-config/stats', async (req, res, next) => {
  try { res.json(await collectConfigStats()) } catch (err) { next(err) }
})
// PRD 05 漏斗报告（PRD 形状，内部复用 runFunnel 计算引擎）
app.get('/api/funnels/:id/report', async (req, res, next) => {
  try { res.json(buildFunnelReport(await runFunnel(req.params.id, filters(req.query)))) } catch (err) { next(err) }
})
// PRD 06 页面参与度
app.get('/api/analytics/engagement', async (req, res, next) => {
  try { res.json(await listEngagement({ ...filters(req.query), q: req.query.q })) } catch (err) { next(err) }
})
// Next Horizon A1 留存 / 同期群分析
app.get('/api/analytics/retention', async (req, res, next) => {
  try { res.json(await listRetention({ ...filters(req.query), offsets: req.query.offsets })) } catch (err) { next(err) }
})
app.get('/api/analytics/engagement/detail', async (req, res, next) => {
  try {
    res.json(await getEngagementDetail({
      path: req.query.path, appId: req.query.appId || filters(req.query).appId,
      startTime: finiteTimestamp(req.query.start), endTime: finiteTimestamp(req.query.end),
      compareStart: finiteTimestamp(req.query.compareStart), compareEnd: finiteTimestamp(req.query.compareEnd)
    }))
  } catch (err) { next(err) }
})
// PRD 07 数据访问等级
app.get('/api/me/access-level', async (req, res) => {
  // D2：已登录扩展返回 role/teamId/userId（匿名仍返回全局等级，前端不破，PRD §4.2）
  const level = resolveAccessLevel(req)
  const base = { level, label: ({ L1: '只读统计', L2: '业务分析', L3: '运维诊断', L4: '完整数据' })[level] }
  if (req.auth?.userId) Object.assign(base, { role: req.auth.role || null, teamId: req.auth.teamId || null, userId: req.auth.userId })
  res.json(base)
})
// D2 账号/团队/成员/邀请/审计（accounts=false 时除 capabilities 外均返回 503 提示）
/** D2 守卫：账号体系未开启时统一 503（不暴露端点细节）；开启后执行处理器 */
function guardAccounts(res, next, handler) {
  if (!isAccountsEnabled()) {
    res.status(503).json({ error: '账号体系未开启（需设置 ACCOUNTS_ENABLED=1 与 ACCOUNTS_JWT_SECRET）' })
    return
  }
  Promise.resolve().then(handler).catch(err => next(err))
}
/** B2 守卫：SLO 能力未开启（NODE_CAPABILITIES.slo）时统一 503（不暴露端点细节）；开启后执行处理器 */
function guardSlo(res, next, handler) {
  if (!NODE_CAPABILITIES.slo) {
    res.status(503).json({ error: 'SLO 能力未启用' })
    return
  }
  Promise.resolve().then(handler).catch(err => next(err))
}
/** B3 守卫：合成监控能力未开启（NODE_CAPABILITIES.synthetic）时统一 503；开启后执行处理器 */
function guardSynthetic(res, next, handler) {
  if (!NODE_CAPABILITIES.synthetic) {
    res.status(503).json({ error: '合成监控能力未启用' })
    return
  }
  Promise.resolve().then(handler).catch(err => next(err))
}
/** D1 守卫：DSR 能力未开启（NODE_CAPABILITIES.dsr）时统一 503；开启后执行处理器（复刻 guardSlo 范式） */
function guardDsr(res, next, handler) {
  if (!NODE_CAPABILITIES.dsr) {
    res.status(503).json({ error: 'DSR 能力未启用' })
    return
  }
  Promise.resolve().then(handler).catch(err => next(err))
}
/** A3 守卫：实验分析能力未开启（NODE_CAPABILITIES.experiments）时统一 503；开启后执行处理器（复刻 guardDsr 范式） */
function guardExperiments(res, next, handler) {
  if (!NODE_CAPABILITIES.experiments) {
    res.status(503).json({ error: '实验分析能力未启用' })
    return
  }
  Promise.resolve().then(handler).catch(err => next(err))
}
/** 极简 cookie 解析（避免引入 cookie-parser 依赖） */
function readCookie(req, name) {
  const header = req.headers.cookie || ''
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx > 0 && part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim())
  }
  return null
}
app.post('/api/auth/register', async (req, res, next) => { guardAccounts(res, next, async () => {
  const result = await register(req.body || {})
  res.json(result)
}) })
app.post('/api/auth/login', async (req, res, next) => { guardAccounts(res, next, async () => {
  const result = await login(req.body || {}, { ip: req.ip, userAgent: req.get('user-agent') })
  res.cookie(REFRESH_COOKIE, result.refreshToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/api/auth', maxAge: 7 * 24 * 60 * 60 * 1000 })
  res.json({ accessToken: result.accessToken, expiresIn: result.expiresIn, user: result.user })
}) })
app.post('/api/auth/logout', async (req, res, next) => { guardAccounts(res, next, async () => {
  res.json(await logout(req.auth?.sessionId))
}) })
app.post('/api/auth/refresh', async (req, res, next) => { guardAccounts(res, next, async () => {
  const token = readCookie(req, REFRESH_COOKIE)
  res.json(await refresh(token, { ip: req.ip, userAgent: req.get('user-agent') }))
}) })
app.get('/api/me', async (req, res, next) => { guardAccounts(res, next, async () => {
  res.json(await getMe(req.auth))
}) })
app.post('/api/me/password', async (req, res, next) => { guardAccounts(res, next, async () => {
  res.json(await changePassword(req.auth?.userId, req.body || {}))
}) })
app.get('/api/me/sessions', async (req, res, next) => { guardAccounts(res, next, async () => {
  res.json(await listSessions(req.auth?.userId))
}) })
app.delete('/api/me/sessions/:sessionId', async (req, res, next) => { guardAccounts(res, next, async () => {
  await revokeSession(req.params.sessionId)
  res.json({ ok: true })
}) })
app.post('/api/teams', async (req, res, next) => { guardAccounts(res, next, async () => {
  res.json(await createTeam(req.auth, req.body || {}))
}) })
app.get('/api/teams/:teamId', async (req, res, next) => { guardAccounts(res, next, async () => {
  res.json(await getTeam(req.auth, req.params.teamId))
}) })
app.put('/api/teams/:teamId', async (req, res, next) => { guardAccounts(res, next, async () => {
  res.json(await updateTeam(req.auth, req.params.teamId, req.body || {}))
}) })
app.get('/api/teams/:teamId/members', async (req, res, next) => { guardAccounts(res, next, async () => {
  res.json(await listTeamMembers(req.auth, req.params.teamId))
}) })
app.put('/api/teams/:teamId/members/:userId/role', async (req, res, next) => { guardAccounts(res, next, async () => {
  res.json(await changeMemberRole(req.auth, req.params.teamId, req.params.userId, req.body || {}))
}) })
app.put('/api/teams/:teamId/members/:userId/access-level', async (req, res, next) => { guardAccounts(res, next, async () => {
  res.json(await changeMemberLevel(req.auth, req.params.teamId, req.params.userId, req.body || {}))
}) })
app.delete('/api/teams/:teamId/members/:userId', async (req, res, next) => { guardAccounts(res, next, async () => {
  res.json(await removeMember(req.auth, req.params.teamId, req.params.userId))
}) })
app.post('/api/teams/:teamId/invitations', async (req, res, next) => { guardAccounts(res, next, async () => {
  res.json(await createInvitation(req.auth, req.params.teamId, req.body || {}))
}) })
app.get('/api/teams/:teamId/invitations', async (req, res, next) => { guardAccounts(res, next, async () => {
  res.json(await listInvitations(req.auth, req.params.teamId))
}) })
app.delete('/api/teams/:teamId/invitations/:id', async (req, res, next) => { guardAccounts(res, next, async () => {
  res.json(await revokeInvitation(req.auth, req.params.teamId, req.params.id))
}) })
// 接受邀请（登录态；未注册走 register 携带 inviteToken）
app.post('/api/invitations/:token/accept', async (req, res, next) => { guardAccounts(res, next, async () => {
  res.json(await acceptInvitationService(req.auth, req.params.token))
}) })
app.post('/api/teams/:teamId/applications', async (req, res, next) => { guardAccounts(res, next, async () => {
  res.json(await assignApplication(req.auth, req.params.teamId, req.body || {}))
}) })
app.get('/api/teams/:teamId/audit', async (req, res, next) => { guardAccounts(res, next, async () => {
  res.json(await listTeamAudit(req.auth, req.params.teamId))
}) })
app.post('/api/maintenance/migrate-members', async (req, res, next) => { guardAccounts(res, next, async () => {
  // 一次性脚本入口（PRD FR-12 / D6）：members 登记项 → 默认团队，无邮箱标「待认领」
  res.json(await migrateMembersToDefaultTeam())
}) })
app.get('/api/members', async (req, res, next) => {
  // D2 D12：/api/members 标记 deprecated（保留只读兼容，一个大版本后移除）
  res.set('Deprecation', 'true')
  res.set('Sunset', 'accounts')
  try { res.json(await listMembers()) } catch (err) { next(err) }
})
app.post('/api/members', async (req, res, next) => { try { res.json(await saveMember(req.body || {})) } catch (err) { next(err) } })
app.put('/api/members/:id/level', async (req, res, next) => {
  try { res.json(await saveMemberLevel(req.params.id, req.body || {})) } catch (err) { next(err) }
})
app.get('/api/audit/data-access', async (req, res, next) => { try { res.json(await listDataAccessAudit()) } catch (err) { next(err) } })
app.get('/api/dashboards', async (req, res, next) => { try { res.json(await listDashboards()) } catch (err) { next(err) } })
app.post('/api/dashboards', async (req, res, next) => { try { res.json(await saveDashboard(req.body || {})) } catch (err) { next(err) } })
app.delete('/api/dashboards/:id', async (req, res, next) => { try { res.json(await deleteDashboard(req.params.id)) } catch (err) { next(err) } })
// A2 · 自定义看板分享：分享（走现有鉴权通道，与 /api/dashboards 同口径）。
app.post('/api/dashboards/:id/share', async (req, res, next) => { try { res.json(await shareDashboard(Number(req.params.id))) } catch (err) { next(err) } })
app.delete('/api/dashboards/:id/share', async (req, res, next) => { try { await unshareDashboard(Number(req.params.id)); res.json({ ok: true }) } catch (err) { next(err) } })
// A2 · 自定义看板分享：公开只读端点（免鉴权）。命中不到返回 404，不暴露是否存在，防枚举。
app.get('/api/dashboards/shared/:token', async (req, res, next) => { try { const d = await getSharedDashboard(req.params.token); if (!d) return res.status(404).json({ error: 'not found' }); res.json(d) } catch (err) { next(err) } })
app.post('/api/maintenance/cleanup', async (req, res, next) => {
  try { res.json(await cleanupExpiredData()) } catch (err) { next(err) }
})
app.get('/api/export/:kind.csv', async (req, res, next) => {
  try {
    const query = filters(req.query)
    const rows = await exportRows(req.params.kind, query)
    res.type('text/csv; charset=utf-8').set('content-disposition', `attachment; filename="web-collection-${req.params.kind}.csv"`).send('\ufeff' + toCsv(rows))
  } catch (err) { next(err) }
})

// PRD 04 远程配置——SDK 端（公开、只读）：ETag 304 免传输，IP 令牌桶限流。
// 失败安全由 SDK 保证：拉取失败沿用上次配置；从未拉到则内置默认全开。
const sdkConfigHits = new Map()
app.get('/sdk-config', async (req, res, next) => {
  try {
    if (!sdkConfigRateLimit(req.ip)) return res.status(429).type('text/plain; charset=utf-8').send('too many requests')
    // 版本维度：新 SDK 分别携带 sdk_version（SDK 版本）与 release（应用版本）；
    // 旧 SDK 只发 sdk_version 且其中装的是应用版本 → 以「是否存在 release 参数」判定新旧，旧请求维持旧语义。
    const hasRelease = Object.prototype.hasOwnProperty.call(req.query, 'release')
    const legacyVersion = String(req.query.sdk_version || '').slice(0, 32)
    const appId = String(req.query.app_id || '').slice(0, 64)
    const resolved = await previewCollectConfig({
      appId,
      platform: String(req.query.platform || '').slice(0, 32),
      sdkVersion: hasRelease ? legacyVersion : '',
      appVersion: hasRelease ? String(req.query.release || '').slice(0, 32) : legacyVersion
    })
    const payload = {
      config_version: resolved.configVersion,
      ttl_ms: 300000,
      master_switch: resolved.config.master_switch,
      sampling: resolved.config.sampling,
      blocked_events: resolved.config.blocked_events,
      plugins: resolved.config.plugins,
      rate_limits: resolved.config.rate_limits,
      otlp: resolved.config.otlp
    }
    // A3 · 实验定义搭车下发（PRD 14 §6.1）：running 实验合并进 experiments 块（per-app 静态数据）。
    // 能力关闭 → 不输出 experiments 字段（而非空块），旧 SDK 天然兼容；
    // ETag 追加实验签名 expSig = `${running 数}-${max(updated_at)}`（无 running 为 0）：
    // 实验定义稳定时 expSig 恒定 → 共享 304 缓存不受损；状态/定义变更 → 304 失效。
    let expSig = '0'
    if (NODE_CAPABILITIES.experiments) {
      const runningExperiments = await listRunningExperimentsForApp(appId)
      if (runningExperiments.length) {
        payload.experiments = {
          items: runningExperiments.map(item => ({ key: item.key, salt: item.salt, traffic_pct: item.traffic_pct, variants: item.variants }))
        }
        expSig = `${runningExperiments.length}-${Math.max(...runningExperiments.map(item => item.updated_at || 0))}`
      }
    }
    const etag = `"cfg-${resolved.configVersion}-${expSig}"`
    if (req.get('if-none-match') === etag && resolved.configVersion > 0) return res.status(304).end()
    res.set('etag', etag).set('cache-control', 'public, max-age=60').json(payload)
  } catch (err) { next(err) }
})

/** IP 令牌桶：每 IP 每 10 秒最多 30 次（SDK 5 分钟轮询下远够用，防恶意刷） */
function sdkConfigRateLimit(ip) {
  const key = ip || 'unknown'
  const now = Date.now()
  const bucket = sdkConfigHits.get(key) || { tokens: 30, updatedAt: now }
  bucket.tokens = Math.min(30, bucket.tokens + (now - bucket.updatedAt) / 10000 * 30)
  bucket.updatedAt = now
  if (bucket.tokens < 1) { sdkConfigHits.set(key, bucket); return false }
  bucket.tokens -= 1
  sdkConfigHits.set(key, bucket)
  if (sdkConfigHits.size > 10000) sdkConfigHits.clear()
  return true
}

app.get('/sdk/:file', (req, res) => {
  serveFile(sdkDir, req.params.file, res, false)
})
app.get(['/web-collection-sdk.es.js', '/web-collection-sdk.iife.js', '/web-collection-sdk.platform.js', '/web-collection-sdk.platform.cjs'], (req, res) => {
  serveFile(sdkDir, req.path, res, false)
})

// 静态资源优先，其次再回退到 SPA 入口文件。
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return serveStatic(req.path, res)
  next()
})

app.use((req, res) => {
  res.status(404).type('text/plain; charset=utf-8').send('not found')
})

app.use((err, req, res, next) => {
  const code = Number(err?.statusCode)
  const status = Number.isInteger(code) && code >= 400 && code < 600 ? code : 500
  // 5xx 落日志：否则服务端错误完全不可观测
  if (status >= 500) console.error(`[api] ${req.method} ${req.originalUrl} failed:`, err?.stack || err?.message || err)
  res.status(status).type(status >= 500 ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8')
    .send(status >= 500 ? 'server error' : JSON.stringify({ error: err?.message || 'request failed' }))
})

await initDatabase()
startSloScheduler()
startSyntheticScheduler()
app.listen(port, () => {
  console.log(`Web Collection listening on http://127.0.0.1:${port}`)
})
const cleanupTimer = setInterval(() => {
  cleanupExpiredData().catch(error => console.error('data cleanup failed', error))
  // ① 基线日表 EOD 回填（幂等，无缺口时零成本；详见 governance.js rollupMetricDailyStats）
  rollupMetricDailyStats().catch(error => console.error('metric daily rollup failed', error))
}, Number(process.env.CLEANUP_INTERVAL_MS || 3600000))
cleanupTimer.unref()
const alertRetryTimer = setInterval(() => retryPendingDeliveries().catch(error => console.error('alert retry failed', error)), 60000)
alertRetryTimer.unref()

// 公开采集接口的 token 校验；未配置 publicToken 时默认放行。
function checkPublicToken(req, res) {
  if (publicToken && req.query.token !== publicToken) {
    res.status(401).type('text/plain; charset=utf-8').send('bad token')
    return false
  }
  return true
}

// 统一补充跨域头，并在 OPTIONS 预检时直接返回。
function corsMiddleware(req, res, next) {
  res.set({
    'access-control-allow-origin': process.env.CORS_ORIGIN || '*',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-app-key,x-ai-key,traceparent,if-none-match,if-match,if-modified-since,if-unmodified-since'
  })
  if (req.method === 'OPTIONS') return res.status(204).end()
  next()
}

// 托管前端静态资源；如果具体文件不存在，则回退到 index.html 以支持前端路由。
function serveStatic(pathname, res) {
  serveFile(distDir, pathname, res, true)
}

function serveFile(root, pathname, res, fallbackToIndex) {
  const safePath = normalize(decodeURIComponent(pathname))
    .replace(/^[/\\]+/, '')
    .replace(/^(\.\.[/\\])+/, '')
  let file = join(root, safePath || 'index.html')
  if (fallbackToIndex && (!existsSync(file) || statSync(file).isDirectory())) file = join(root, 'index.html')
  if (!existsSync(file)) return res.status(404).type('text/plain; charset=utf-8').send('run npm run build first')
  res.status(200).type(types[extname(file)] || 'application/octet-stream')
  createReadStream(file).pipe(res)
}

// 对客户端事件做白名单校验、字段裁剪和敏感信息清洗。
function sanitize(event) {
  const rawType = String(event.type || '')
  if (!['track', 'perf', 'performance', 'behavior', 'error', 'replay', 'log', 'trace'].includes(rawType)) throw new Error('bad event type')
  const type = rawType === 'performance' ? 'perf' : rawType
  if (type === 'replay') {
    // SDK 默认 gzip 压缩上报：events 是 base64 字符串（而非数组），且携带 compression 标记。
    // 此前白名单只接受数组并把 compression 字段丢弃，导致解压入口拿不到标记 → 静默存空、
    // 不报错（列表/详情均无数据）。此处兼容两种形态并保留标记。
    const rawEvents = event.events
    const events = Array.isArray(rawEvents)
      ? rawEvents.slice(0, 200)
      : typeof rawEvents === 'string' && rawEvents ? rawEvents.slice(0, 8_000_000) : []
    return {
      type,
      appId: clip(event.appId || 'default', 64),
      release: clip(event.release || 'unknown', 64),
      userId: clip(event.userId || '', 128),
      userName: clip(event.userName || '', 128),
      userPhone: clip(event.userPhone || '', 32),
      sessionId: clip(event.sessionId || '', 128),
      baseSessionId: clip(event.baseSessionId || '', 128) || null,
      url: cleanUrl(event.url || ''),
      ts: Number.isFinite(Number(event.ts)) ? Number(event.ts) : Date.now(),
      events,
      compression: event.compression === 'gzip' || event.compression === 'none' ? event.compression : undefined,
      segmentEndReason: typeof event.segmentEndReason === 'string' ? clip(event.segmentEndReason, 32) : undefined
    }
  }
  return {
    type,
    appId: clip(event.appId || 'default', 64),
    release: clip(event.release || 'unknown', 64),
    userId: clip(event.userId || '', 128),
    userName: clip(event.userName || '', 128),
    userPhone: clip(event.userPhone || '', 32),
    sessionId: clip(event.sessionId || '', 128),
    deviceId: clip(event.deviceId || '', 128),
    traceId: clip(event.traceId || '', 64),
    spanId: clip(event.spanId || '', 32),
    parentSpanId: clip(event.parentSpanId || '', 32),
    url: cleanUrl(event.url || ''),
    path: clip(event.path || '', 512),
    title: clip(event.title || '', 256),
    referrer: clip(event.referrer || '', 2048),
    userAgent: clip(event.userAgent || '', 512),
    sdkVersion: clip(event.sdkVersion || '', 32),
    environment: clip(event.environment || '', 64),
    source: clip(event.source || '', 32),
    context: cleanObject(event.context, 4000),
    browser: browser(event.userAgent || ''),
    os: os(event.userAgent || ''),
    device: /Mobile|Android|iPhone/i.test(event.userAgent || '') ? 'Mobile' : 'Desktop',
    ts: Number.isFinite(Number(event.ts)) ? Number(event.ts) : Date.now(),
    name: clip(event.name || '', 160),
    metric: clip(event.metric || '', 32),
    value: Number.isFinite(Number(event.value)) ? Number(event.value) : undefined,
    message: redact(clip(event.message || '', 500)),
    stack: clip(event.stack || '', 4000),
    // props/breadcrumbs 这两项可能包含嵌套对象或较长内容，先统一裁剪和压平后再入库。
    // 这样可以避免日志体积失控，也能减少把原始敏感对象直接写进存储的风险。
    props: cleanObject(event.props, 8000),
    breadcrumbs: Array.isArray(event.breadcrumbs) ? event.breadcrumbs.slice(-20).map(item => cleanObject(item, 1000)) : undefined
  }
}

function filters(query) {
  const page = positiveInt(query.page, 1, 1, 1000000)
  const pageSize = positiveInt(query.pageSize || query.limit, 10, 1, 100)
  return {
    limit: positiveInt(query.limit, 100, 1, 100),
    startTime: finiteTimestamp(query.startTime),
    endTime: finiteTimestamp(query.endTime),
    appId: clip(query.appId || '', 64),
    release: clip(query.release || '', 64),
    traceId: clip(query.traceId || '', 64),
    type: clip(query.type || '', 32),
    name: clip(query.name || '', 160),
    status: clip(query.status || '', 32),
    path: clip(query.path || '', 512),
    url: clip(query.url || '', 2048),
    userId: clip(query.userId || '', 128),
    userName: clip(query.userName || '', 128),
    userPhone: clip(query.userPhone || '', 32),
    keyword: clip(query.keyword || '', 200),
    page,
    pageSize
  }
}

// 查询参数来自 URL，不能把 NaN/Infinity 直接传给 PostgreSQL。
// 无效或越界值回退到安全默认值，避免列表接口返回 500 或执行无界查询。
function positiveInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.floor(number)))
}

function finiteTimestamp(value) {
  if (value == null || value === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

// 字符串裁剪，统一控制字段长度。
function clip(value, size) {
  return String(value).slice(0, size)
}

// 将对象型字段压平并裁剪，避免把复杂大对象直接写入存储。
function cleanObject(value, size) {
  if (!value || typeof value !== 'object') return undefined
  const out = {}
  for (const [key, item] of Object.entries(value)) out[clip(key, 80)] = redact(typeof item === 'object' ? clip(JSON.stringify(item), 1000) : clip(item, 1000))
  return JSON.stringify(out).length > size ? { truncated: true } : out
}

function redact(value) {
  return String(value)
    .replace(/(authorization|password|token|secret|cookie)(["'\s:=]+)[^\s,;}]+/gi, '$1$2[REDACTED]')
    .replace(/\b1\d{2}\d{4}(\d{4})\b/g, '***$1')
}

// 删除 URL 中的敏感查询参数，再把结果裁剪到可控长度。
function cleanUrl(value) {
  try {
    const url = new URL(String(value))
    ;['token', 'password', 'key', 'secret', 'authorization'].forEach(key => url.searchParams.delete(key))
    return clip(url.toString(), 2048)
  } catch {
    return clip(value, 2048)
  }
}

// 简单浏览器识别，用于报表分组和问题排查。
function browser(ua) {
  if (/Edg/i.test(ua)) return 'Edge'
  if (/Chrome/i.test(ua)) return 'Chrome'
  if (/Safari/i.test(ua)) return 'Safari'
  if (/Firefox/i.test(ua)) return 'Firefox'
  return 'Unknown'
}

// 简单操作系统识别，用于聚合统计。
function os(ua) {
  if (/Windows/i.test(ua)) return 'Windows'
  if (/Mac OS/i.test(ua)) return 'macOS'
  if (/Android/i.test(ua)) return 'Android'
  if (/iPhone|iPad/i.test(ua)) return 'iOS'
  if (/Linux/i.test(ua)) return 'Linux'
  return 'Unknown'
}

/** PRD 05：把 runFunnel 引擎输出整形为报告契约（meta/steps/trend/segments/lossInsight） */
function buildFunnelReport(result) {
  const definition = result?.definition || {}
  const steps = result?.steps || []
  const lostSessions = result?.lostSessions || []
  const users = steps[0]?.count ?? 0
  const converted = steps.at(-1)?.count ?? 0
  const withErrorCount = lostSessions.filter(item => Number(item.errors) > 0).length
  return {
    meta: {
      id: definition.id,
      name: definition.name,
      windowMs: result?.windowMs ?? definition.window_ms ?? null,
      users,
      converted,
      overallRate: users > 0 ? Number((converted / users).toFixed(4)) : 0
    },
    steps: steps.map((step, index) => ({
      idx: index + 1,
      event: step.step,
      filters: step.filters || [],
      users: step.count,
      rate: index === 0 ? 1 : Number((step.rate / 100).toFixed(4)),
      lost: step.lost
    })),
    trend: (result?.trend || []).map(row => ({
      day: row.date,
      rate: row.entered > 0 ? Number((row.converted / row.entered).toFixed(4)) : 0
    })),
    segments: (result?.dimensions || []).map(dimension => ({
      field: dimension.field,
      items: (dimension.items || []).map(item => ({
        name: item.name,
        overallRate: item.entered > 0 ? Number((item.converted / item.entered).toFixed(4)) : 0,
        entered: item.entered,
        converted: item.converted
      }))
    })),
    lossInsight: {
      lostUsers: lostSessions.length,
      withErrorRate: lostSessions.length ? Number((withErrorCount / lostSessions.length).toFixed(3)) : null,
      topError: lostSessions.find(item => Number(item.errors) > 0)?.lastEvent || null,
      sampleSessionIds: lostSessions.slice(0, 20).map(item => item.sessionId)
    },
    lostSessions: lostSessions.slice(0, 20)
  }
}

async function exportRows(kind, query) {
  if (kind === 'events') return listEvents(10000, query)
  if (kind === 'issues') return listIssues({ ...query, limit: 10000 })
  if (kind === 'replays') return listReplays({ ...query, limit: 10000 })
  throw new Error('unsupported export kind')
}

export function toCsv(rows) {
  if (!rows.length) return ''
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))]
  const cell = value => `"${String(value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : value).replaceAll('"', '""')}"`
  return [columns.map(cell).join(','), ...rows.map(row => columns.map(column => cell(row[column])).join(','))].join('\r\n')
}
