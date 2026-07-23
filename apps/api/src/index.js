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
import { authorizeCollect, cleanupExpiredData, deleteApplication, deleteRelease, getSettings, listAlerts, listApplications, listReleases, rotateCollectKey, saveApplication, saveRelease, saveSettings } from './governance.js'
import { consumeAlertDelivery, deleteAlertChannel, listAlertChannels, listAlertDeliveries, retryAlertDelivery, retryPendingDeliveries, saveAlertChannel, testAlertChannel } from './alerting.js'
import { deleteDashboard, deleteFunnel, deleteInsight, getLive, getPaths, getReleaseComparison, getSessionEvents, getSessions, getTrace, listDashboards, listEventProperties, listFunnelEventNames, listFunnels, listInsights, listLogs, listTraces, queryEventInsight, queryPaths, runFunnel, saveDashboard, saveFunnel, saveInsight } from './services/analytics-service.js'

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

// 健康检查，给部署平台和监控系统使用。
app.get('/health', (req, res) => {
  res.json({ ok: true })
})
app.get('/api/capabilities', (req, res) => {
  res.json({ productAnalyticsV2: true })
})

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
    res.json(await resolveIssue(req.params.id))
  } catch (err) {
    next(err)
  }
})
app.get('/api/applications', async (req, res, next) => {
  try { res.json(await listApplications(req.query)) } catch (err) { next(err) }
})
app.put('/api/applications/:appId', async (req, res, next) => {
  try { res.json(await saveApplication({ ...req.body, appId: req.params.appId })) } catch (err) { next(err) }
})
app.delete('/api/applications/:appId', async (req, res, next) => {
  try { res.json(await deleteApplication(req.params.appId)) } catch (err) { next(err) }
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
app.get('/api/settings', async (req, res, next) => {
  try { res.json(await getSettings()) } catch (err) { next(err) }
})
app.put('/api/settings', async (req, res, next) => {
  try { res.json(await saveSettings(req.body || {})) } catch (err) { next(err) }
})
app.get('/api/alerts', async (req, res, next) => {
  try { res.json(await listAlerts(req.query)) } catch (err) { next(err) }
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
app.get('/api/analytics/sessions', async (req, res, next) => { try { res.json(await getSessions(filters(req.query))) } catch (err) { next(err) } })
app.get('/api/analytics/sessions/:sessionId', async (req, res, next) => { try { res.json(await getSessionEvents(req.params.sessionId, filters(req.query))) } catch (err) { next(err) } })
app.get('/api/analytics/paths', async (req, res, next) => { try { res.json(await getPaths(filters(req.query))) } catch (err) { next(err) } })
app.get('/api/analytics/live', async (req, res, next) => { try { res.json(await getLive(filters(req.query))) } catch (err) { next(err) } })
app.get('/api/analytics/releases', async (req, res, next) => { try { res.json(await getReleaseComparison(filters(req.query))) } catch (err) { next(err) } })
app.get('/api/analytics/event-names', async (req, res, next) => { try { res.json(await listFunnelEventNames(filters(req.query))) } catch (err) { next(err) } })
app.get('/api/analytics/event-properties', async (req, res, next) => { try { res.json(await listEventProperties({ ...filters(req.query), eventName: req.query.eventName })) } catch (err) { next(err) } })
app.post('/api/analytics/insights/query', async (req, res, next) => { try { res.json(await queryEventInsight(req.body || {})) } catch (err) { next(err) } })
app.post('/api/analytics/paths/query', async (req, res, next) => { try { res.json(await queryPaths(req.body || {})) } catch (err) { next(err) } })
app.get('/api/analytics/insights', async (req, res, next) => { try { res.json(await listInsights()) } catch (err) { next(err) } })
app.post('/api/analytics/insights', async (req, res, next) => { try { res.json(await saveInsight(req.body || {})) } catch (err) { next(err) } })
app.put('/api/analytics/insights/:id', async (req, res, next) => { try { res.json(await saveInsight(req.body || {}, Number(req.params.id))) } catch (err) { next(err) } })
app.delete('/api/analytics/insights/:id', async (req, res, next) => { try { res.json(await deleteInsight(Number(req.params.id))) } catch (err) { next(err) } })
app.get('/api/funnels', async (req, res, next) => { try { res.json(await listFunnels(filters(req.query))) } catch (err) { next(err) } })
app.post('/api/funnels', async (req, res, next) => { try { res.json(await saveFunnel(req.body || {})) } catch (err) { next(err) } })
app.delete('/api/funnels/:id', async (req, res, next) => { try { res.json(await deleteFunnel(req.params.id)) } catch (err) { next(err) } })
app.get('/api/funnels/:id/run', async (req, res, next) => { try { res.json(await runFunnel(req.params.id, filters(req.query))) } catch (err) { next(err) } })
app.get('/api/dashboards', async (req, res, next) => { try { res.json(await listDashboards()) } catch (err) { next(err) } })
app.post('/api/dashboards', async (req, res, next) => { try { res.json(await saveDashboard(req.body || {})) } catch (err) { next(err) } })
app.delete('/api/dashboards/:id', async (req, res, next) => { try { res.json(await deleteDashboard(req.params.id)) } catch (err) { next(err) } })
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
  res.status(500).type('text/plain; charset=utf-8').send(err?.message || 'server error')
})

await initDatabase()
app.listen(port, () => {
  console.log(`Web Collection listening on http://127.0.0.1:${port}`)
})
const cleanupTimer = setInterval(() => cleanupExpiredData().catch(error => console.error('data cleanup failed', error)), Number(process.env.CLEANUP_INTERVAL_MS || 3600000))
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
    'access-control-allow-headers': 'content-type,x-app-key,traceparent'
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
    return {
      type,
      appId: clip(event.appId || 'default', 64),
      release: clip(event.release || 'unknown', 64),
      userId: clip(event.userId || '', 128),
      userName: clip(event.userName || '', 128),
      userPhone: clip(event.userPhone || '', 32),
      sessionId: clip(event.sessionId || '', 128),
      url: cleanUrl(event.url || ''),
      ts: Number.isFinite(Number(event.ts)) ? Number(event.ts) : Date.now(),
      events: Array.isArray(event.events) ? event.events.slice(0, 200) : [],
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
    url: cleanUrl(event.url || ''),
    path: clip(event.path || '', 512),
    title: clip(event.title || '', 256),
    referrer: clip(event.referrer || '', 2048),
    userAgent: clip(event.userAgent || '', 512),
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
  return {
    limit: Number(query.limit || 100),
    startTime: query.startTime,
    endTime: query.endTime,
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
    page: Number(query.page || 1),
    pageSize: Number(query.pageSize || query.limit || 10)
  }
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
