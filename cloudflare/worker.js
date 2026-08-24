import { SourceMapConsumer } from 'source-map-js'
import { alertContext, channelMatches, decryptSecrets, encryptSecrets, normalizeChannel, publicChannel, publishDelivery, sendChannel, verifyQStash } from '../packages/alerting.js'
import { buildCapabilities, WORKER_CAPABILITIES } from '../packages/deployment-capabilities.js'
import { maybeAutoDiagnose } from '../packages/ai/alert-diagnosis.js'
import { buildDistributedTrace } from '../packages/ai/queries.js'

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } })

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), request)
    try {
      let response
      if (url.pathname === '/health') response = json({ ok: true, runtime: 'cloudflare-workers' })
      else if (url.pathname === '/api/collect' && request.method === 'POST') response = await collect(request, env, ctx)
      else if (url.pathname === '/api/collect.gif') response = await collectGif(url, env)
      else if (url.pathname.startsWith('/api/ai/')) response = await proxyAi(request, env, url)
      else if (url.pathname.startsWith('/api/')) response = await adminApi(request, env, url)
      else if (url.pathname.startsWith('/sdk/')) response = await env.ASSETS.fetch(new Request(new URL(url.pathname, request.url), request))
      else response = await env.ASSETS.fetch(request)
      return cors(response, request)
    } catch (error) {
      return cors(new Response(error?.message || 'server error', { status: 500 }), request)
    }
  },
  async scheduled(controller, env) {
    await retryPendingAlertDeliveries(env)
    if (controller.cron === '17 3 * * *') await cleanup(env)
  }
}

async function collect(request, env, ctx) {
  const payload = await request.json()
  const inputs = payload.type === 'replay' ? [payload] : Array.isArray(payload.events) ? payload.events : Array.isArray(payload) ? payload : [payload]
  const appId = clip(inputs[0]?.appId || 'default', 64)
  if (inputs.some(item => clip(item?.appId || 'default', 64) !== appId)) return new Response('mixed app ids', { status: 400 })
  const app = await env.DB.prepare('select enabled, sample_rate, replay_sample_rate, collect_key_hash, rules_json from applications where app_id=?').bind(appId).first()
  if (app?.collect_key_hash && await sha256(request.headers.get('x-app-key') || '') !== app.collect_key_hash) return new Response('bad app key', { status: 401 })
  const events = inputs.slice(0, 100).map(sanitize)
  // ponytail: acknowledge after validation; add a Queue if guaranteed ingestion is required.
  ctx.waitUntil((async () => { for (const event of events) await record(env, event, app, ctx) })())
  return json({ ok: true, accepted: events.length, received: inputs.length })
}

async function collectGif(url, env) {
  const data = url.searchParams.get('data')
  if (data) await record(env, sanitize(JSON.parse(data)))
  return new Response(Uint8Array.from(atob('R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw=='), c => c.charCodeAt(0)), { headers: { 'content-type': 'image/gif', 'cache-control': 'no-store' } })
}

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
  await storageWrite(env, `insert into events (id,ts,type,app_id,release_name,user_id,user_name,user_phone,session_id,device_id,trace_id,span_id,url,path,title,referrer,user_agent,sdk_version,environment,source,context_json,name,metric,value,message,stack,props_json,breadcrumbs_json, app_version, product_id, event_id, request_id, occurred_at, received_at, schema_version, batch_id, retry_count, contract_status, contract_errors_json) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id,event.ts,event.type,event.appId,event.release,event.userId,event.userName,event.userPhone,event.sessionId,event.deviceId,event.traceId,event.spanId,event.url,event.path,event.title,event.referrer,event.userAgent,event.sdkVersion,event.environment,event.source,JSON.stringify(event.context||null),event.name,event.metric,event.value,event.message,event.stack,JSON.stringify(storedProps||null),JSON.stringify(event.breadcrumbs||null), event.appVersion || event.release, event.productId || null, event.eventId || id, event.requestId || null, event.occurredAt || event.ts, now, event.schemaVersion || '1', event.batchId || null, event.retryCount || 0, 'accepted', null])
  const issue = event.type === 'error' ? await upsertIssue(env, event) : null
  if (event.type === 'error' || (event.type === 'log' && event.name === 'error') || event.type === 'perf') await alert(env, event, issue, ctx)
  return true
}

async function storageWrite(env, sql, values) {
  const run = () => env.DB.prepare(sql).bind(...values).run()
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
  const original = await resolveSourceMap(env, event)
  await env.DB.prepare(`insert into issues (fingerprint,status,app_id,release_name,name,message,stack,url,props_json,breadcrumbs_json,original_json,count,first_seen,last_seen,resolved_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(fingerprint) do update set status=excluded.status,release_name=excluded.release_name,message=excluded.message,stack=excluded.stack,url=excluded.url,props_json=excluded.props_json,breadcrumbs_json=excluded.breadcrumbs_json,original_json=excluded.original_json,count=issues.count+1,last_seen=excluded.last_seen`).bind(fingerprint,status,event.appId,event.release,event.name,event.message,event.stack,event.url,JSON.stringify(event.props||null),JSON.stringify(event.breadcrumbs||null),JSON.stringify(original),1,previous?.first_seen||event.ts,event.ts,previous?.resolved_at||null).run()
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
  if (path === '/api/capabilities') return json(buildCapabilities(WORKER_CAPABILITIES))
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
  if (/^\/api\/traces\/[^/]+$/.test(path)) return traceEvents(env, decodeURIComponent(path.split('/').at(-1)), url)
  if (path === '/api/analytics/sessions') return sessions(env, url)
  if (/^\/api\/analytics\/sessions\//.test(path)) return sessionEvents(env, decodeURIComponent(path.split('/').at(-1)), url)
  if (path === '/api/analytics/paths') return paths(env, url)
  if (path === '/api/analytics/click-paths') return clickPaths(env, url)
  if (path === '/api/analytics/heatmap') return heatmap(env, url)
  if (path === '/api/analytics/live') return live(env, url)
  if (path === '/api/analytics/releases') return releasesReport(env, url)
  if (path === '/api/analytics/event-names') return funnelEventNames(env, url)
  if (path === '/api/applications' && request.method === 'GET') return applicationList(env, url)
  if (/^\/api\/applications\/[^/]+$/.test(path) && request.method === 'DELETE') { const id=decodeURIComponent(path.split('/').at(-1)); await env.DB.prepare('delete from releases where app_id=?').bind(id).run(); await env.DB.prepare('delete from applications where app_id=?').bind(id).run(); return json({ok:true}) }
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
  if (/\/funnels\/\d+\/run$/.test(path)) return runFunnel(env, Number(path.split('/').at(-2)), url)
  if (path === '/api/dashboards' && request.method === 'GET') return json((await env.DB.prepare('select * from dashboards order by updated_at desc').all()).results.map(row => ({...row,widgets_json:parse(row.widgets_json,[])})))
  if (path === '/api/dashboards' && request.method === 'POST') return saveDashboard(env, await request.json())
  if (/^\/api\/dashboards\/\d+$/.test(path) && request.method === 'DELETE') { await env.DB.prepare('delete from dashboards where id=?').bind(Number(path.split('/').at(-1))).run(); return json({ok:true}) }
  if (path === '/api/maintenance/cleanup' && request.method === 'POST') return json(await cleanup(env))
  if (/^\/api\/export\/(events|issues|replays)\.csv$/.test(path)) return exportCsv(env, RegExp.$1, url)
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

async function summary(env,url){
  const {where,values}=filters(url),perfFilter=filters(url,'perf'),issueFilter=issueFilters(url)
  // P0-6 性能预算优化：原实现拉取 5000 条全列事件 + 50000 条 perf 事件到应用层聚合，
  // 现将 byType/behavior/事件总数/perf 计数与均值下推为 SQL GROUP BY，p75 用窗口函数
  // 在库内仅取每个 metric 的边界行（约 2 行/metric），只有 fetch/xhr/resource 明细
  // （需要 props_json 里的 url/name 做分组）仍拉行，且不再夹带无关 metric。
  const perfGuard="typeof(value) in ('integer','real') and (ifnull(metric,'')<>'page_load' or value>0)"
  // 防御：单个子查询失败（D1 超时/资源受限时 .all() 可能返回缺失 results 的对象）
  // 统一兜底为空数组/null，避免 for...of 抛 "X is not iterable" 把整个接口打 500。
  const all=(s)=>s.all().catch(()=>({results:[]})).then(r=>(r&&r.results)||[])
  const one=(s)=>s.first().catch(()=>null)
  const [byTypeRows,behaviorRows,eventStats,perfStats,p75Rows,apiRows,issueResult,issueStats]=await Promise.all([
    all(env.DB.prepare(`select type,count(*) count from events ${where} group by type`).bind(...values)),
    all(env.DB.prepare(`select name,count(*) count from events ${where}${where?' and':' where'} type in ('behavior','track') group by name`).bind(...values)),
    one(env.DB.prepare(`select count(*) total,max(ts) last_seen from events ${where}`).bind(...values)),
    all(env.DB.prepare(`select metric,count(*) count,avg(value) avg from events ${perfFilter.where} and ${perfGuard} group by metric`).bind(...perfFilter.values)),
    all(env.DB.prepare(`select metric,value,n,rn from (select metric,value,count(*) over (partition by metric) n,row_number() over (partition by metric order by value) rn from events ${perfFilter.where} and ${perfGuard}) where rn between cast((n-1)*0.75 as integer)+1 and cast((n-1)*0.75 as integer)+2`).bind(...perfFilter.values)),
    all(env.DB.prepare(`select metric,value,name,props_json from events ${perfFilter.where} and ${perfGuard} and metric in ('fetch','xhr','resource') order by ts desc limit 1000`).bind(...perfFilter.values)),
    all(env.DB.prepare(`select *,(select count(distinct coalesce(nullif(e.user_id,''),nullif(e.device_id,''),nullif(e.session_id,''))) from events e where e.type='error' and e.app_id=issues.app_id and e.name=issues.name and e.message=issues.message) affected_users from issues ${issueFilter.where} order by last_seen desc limit 100`).bind(...issueFilter.values)),
    one(env.DB.prepare(`select sum(case when status<>'resolved' then 1 else 0 end) issue_count,sum(case when status='regression' then 1 else 0 end) regression_count from issues ${issueFilter.where}`).bind(...issueFilter.values))
  ])
  const issues=issueResult,byType={},behavior={},perf={},perfCounts={}
  for(const row of byTypeRows)byType[row.type]=Number(row.count)
  for(const row of behaviorRows)behavior[row.name ?? 'null']=Number(row.count)
  for(const row of perfStats)perfCounts[row.metric ?? 'null']=Number(row.count)
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
  return json({totalEvents:Number(eventStats?.total||0),issueCount:Number(issueStats?.issue_count||0),regressionCount:Number(issueStats?.regression_count||0),lastSeen:eventStats?.last_seen||null,perf,perfCounts,byType,behavior,api:aggregatePerf(perfRows.filter(row=>row.metric==='fetch'||row.metric==='xhr'),row=>row.props?.url||row.name||'unknown'),resources:aggregatePerf(perfRows.filter(row=>row.metric==='resource'),row=>row.props?.name||row.name||'unknown'),replays:[],alerts:[],issues:issues.map(mapIssue)})
}

function percentile75(values){if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b),index=(sorted.length-1)*.75,lower=Math.floor(index),upper=Math.ceil(index);return lower===upper?sorted[lower]:sorted[lower]+(sorted[upper]-sorted[lower])*(index-lower)}
function aggregatePerf(rows,keyFn){const grouped=new Map();for(const row of rows){const key=keyFn(row),item=grouped.get(key)||{name:key,count:0,total:0,values:[]},value=Number(row.value)||0;item.count++;item.total+=value;item.values.push(value);grouped.set(key,item)}return[...grouped.values()].map(item=>({name:item.name,count:item.count,avg:Math.round(item.total/item.count),p75:percentile75(item.values)})).sort((a,b)=>b.p75-a.p75).slice(0,10)}

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
async function applicationList(env,url){const select=`select a.app_id,a.name,a.platform,a.owner,a.enabled,a.sample_rate,a.replay_sample_rate,a.rules_json,a.created_at,a.updated_at,(a.collect_key_hash is not null) collect_key_enabled,coalesce(rc.release_count,0) release_count from applications a left join (select app_id,count(*) release_count from releases group by app_id) rc on rc.app_id=a.app_id order by a.updated_at desc`;if(!url.searchParams.has('page')&&!url.searchParams.has('pageSize'))return json((await env.DB.prepare(select).all()).results.map(mapApplication));const page=Math.max(1,Number(url.searchParams.get('page')||1)),pageSize=Math.min(100,Math.max(1,Number(url.searchParams.get('pageSize')||10))),[rows,total]=await Promise.all([env.DB.prepare(`${select} limit ? offset ?`).bind(pageSize,(page-1)*pageSize).all(),env.DB.prepare('select count(*) count from applications').first()]);return json({items:rows.results.map(mapApplication),total:Number(total.count),page,pageSize})}
async function releaseList(env,appId,url){const page=Math.max(1,Number(url.searchParams.get('page')||1)),pageSize=Math.min(100,Math.max(1,Number(url.searchParams.get('pageSize')||10))),[rows,total]=await Promise.all([env.DB.prepare('select * from releases where app_id=? order by created_at desc limit ? offset ?').bind(appId,pageSize,(page-1)*pageSize).all(),env.DB.prepare('select count(*) count from releases where app_id=?').bind(appId).first()]);return json({items:rows.results,total:Number(total.count),page,pageSize})}
async function replayEvents(env,id){
  if(!id?.trim())return json([]);
  // 回放按会话分段存储，仅首段含全量快照；若只按点击的分段 session_id 读取，缺全量快照
  // 会导致 rrweb 渲染空白 iframe。故先用传入 id 定位该段并取其 base_session_id，再按
  // base_session_id 拉取整段会话的所有分段（首段全量快照在前），保证可正常重建页面。
  // 传入 id 既可能是分段 session_id（列表点击），也可能是事件会话 UUID（总览/分析页跳转）。
  const hit=await env.DB.prepare('select session_id,base_session_id from replays where session_id=? limit 1').bind(id).first();
  const baseId=hit?.base_session_id||id;
  let rows=(await env.DB.prepare('select events_json from replays where base_session_id=? order by created_at,id').bind(baseId).all()).results;
  if(!rows.length)rows=(await env.DB.prepare('select events_json from replays where session_id=? order by created_at,id').bind(id).all()).results;
  return json(rows.flatMap(row=>parse(row.events_json,[])))
}
async function traces(env,url){const page=Math.max(1,Number(url.searchParams.get('page')||1)),pageSize=Math.min(100,Math.max(1,Number(url.searchParams.get('pageSize')||10))),{where,values}=filters(url,null,["trace_id<>''"]),[rows,total]=await Promise.all([env.DB.prepare(`select trace_id,min(ts) started_at,max(ts) ended_at,count(*) span_count,sum(case when type='error' or json_extract(props_json,'$.status')>=400 then 1 else 0 end) error_count,max(app_id) app_id,max(release_name) release_name,max(url) url from events ${where} group by trace_id order by started_at desc limit ? offset ?`).bind(...values,pageSize,(page-1)*pageSize).all(),env.DB.prepare(`select count(*) count from (select 1 from events ${where} group by trace_id)`).bind(...values).first()]);return json({items:rows.results.map(r=>({...r,duration:r.ended_at-r.started_at})),total:Number(total.count),page,pageSize})}
async function traceEvents(env,id,url){const page=Math.max(1,Number(url.searchParams.get('page')||1)),pageSize=Math.min(100,Math.max(1,Number(url.searchParams.get('pageSize')||10)));if(!id?.trim())return json({items:[],total:0,page,pageSize});const[rows,total]=await Promise.all([env.DB.prepare('select * from events where trace_id=? order by ts limit ? offset ?').bind(id,pageSize,(page-1)*pageSize).all(),env.DB.prepare('select count(*) count from events where trace_id=?').bind(id).first()]);return json({items:rows.results.map(mapEvent),total:Number(total.count),page,pageSize})}
async function distributedTrace(env,id){if(!id?.trim())return json({root:null,nodes:[],edges:[],criticalPath:[],errorSpans:[]});const[events,backendSpans]=await Promise.all([env.DB.prepare('select * from events where trace_id=? order by ts').bind(id).all(),env.DB.prepare('select * from spans where trace_id=? order by start_ts').bind(id).all().catch(()=>({results:[]}))]);return json(buildDistributedTrace(events.results||[],backendSpans.results||[]))}
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
async function saveSettings(env,input){const value={retention:{...defaultSettings.retention,...input.retention},alerts:{...defaultSettings.alerts,...input.alerts}};await env.DB.prepare(`insert into settings(id,config_json,updated_at) values(1,?,?) on conflict(id) do update set config_json=excluded.config_json,updated_at=excluded.updated_at`).bind(JSON.stringify(value),Date.now()).run();return json(value)}
async function saveSourceMap(env,input){const appId=clip(input.appId||'default',64),release=clip(input.release||'unknown',64),file=String(input.file||input.map?.file||'app.js').split('/').at(-1);await env.DB.prepare(`insert into sourcemaps(app_id,release_name,file_name,map_json,created_at) values(?,?,?,?,?) on conflict(app_id,release_name,file_name) do update set map_json=excluded.map_json,created_at=excluded.created_at`).bind(appId,release,file,JSON.stringify(input.map),Date.now()).run();return json({appId,release,file})}
async function resolveSourceMap(env,event){const match=[...String(event.stack||'').matchAll(/((?:https?:\/\/|\/)[^():\s]+):(\d+):(\d+)/g)].find(item=>!/web-collection-sdk(?:\.[\w-]+)?\.js/i.test(item[1])),source=event.props?.line?event.props.source:match?.[1],line=Number(event.props?.line||match?.[2]),column=Number(event.props?.column||match?.[3]||0);if(!source||!line)return null;const row=await env.DB.prepare('select map_json from sourcemaps where app_id=? and release_name=? and file_name=?').bind(event.appId,event.release,source.split('/').at(-1)).first();if(!row)return null;const consumer=new SourceMapConsumer(parse(row.map_json,{})),pos=consumer.originalPositionFor({line,column});consumer.destroy?.();return pos?.source?{generatedFile:source,generatedLine:line,generatedColumn:column,source:pos.source,line:pos.line,column:pos.column,name:pos.name}:null}
async function saveFunnel(env,input){const steps=strings(input.steps).slice(0,10);if(!input.name||steps.length<2)throw new Error('漏斗名称和至少两个步骤不能为空');const now=Date.now();const windowMs=input.windowMs>0?Math.floor(Number(input.windowMs)):null;const result=await env.DB.prepare('insert into funnel_definitions(name,app_id,steps_json,window_ms,created_at,updated_at) values(?,?,?,?,?,?)').bind(clip(input.name,128),input.appId||null,JSON.stringify(steps),windowMs,now,now).run();return json({id:result.meta.last_row_id})}
async function runFunnel(env,id,url){const def=await env.DB.prepare('select * from funnel_definitions where id=?').bind(id).first();if(!def)throw new Error('漏斗不存在');const scoped=new URL(url);if(def.app_id&&!scoped.searchParams.get('appId'))scoped.searchParams.set('appId',def.app_id);const steps=parse(def.steps_json,[]),windowMs=def.window_ms?Number(def.window_ms):null,{where,values}=filters(scoped);const rows=(await env.DB.prepare(`select session_id,coalesce(nullif(user_id,''),device_id,session_id) actor,name,type,ts,release_name,case when user_agent like '%Edg/%' then 'Edge' when user_agent like '%Chrome/%' then 'Chrome' when user_agent like '%Firefox/%' then 'Firefox' when user_agent like '%Safari/%' then 'Safari' else 'Other' end browser,case when user_agent like '%Mobile%' then 'Mobile' else 'Desktop' end device from events ${where} ${where?'and':'where'} (name in (${steps.map(()=>'?').join(',')}) or type='error') order by ts limit 50000`).bind(...values,...steps).all()).results,actors=Object.values(group(rows,r=>r.actor)),matched=actors.map(a=>matchSteps(a,steps,windowMs)),counts=steps.map((_,i)=>matched.filter(m=>m[i]!=null).length),ttcByStep=steps.map(()=>[]);matched.forEach(m=>{for(let i=1;i<m.length;i++)if(m[i]!=null&&m[i-1]!=null)ttcByStep[i].push(m[i]-m[i-1])});const median=v=>{if(!v.length)return null;const s=[...v].sort((a,b)=>a-b),m=s.length>>1;return s.length%2?s[m]:Math.round((s[m-1]+s[m])/2)};const p90=v=>{if(!v.length)return null;const s=[...v].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.max(0,Math.ceil(0.9*s.length)-1))]};const replayIds=(await env.DB.prepare('select distinct session_id, base_session_id from replays').all()).results;const lostSessions=actors.filter(a=>reaches(a,steps,0,windowMs)&&!reaches(a,steps,steps.length-1,windowMs)).slice(0,100).map(a=>({sessionId:a[0].session_id,actor:a[0].actor,lastEvent:a.filter(x=>x.type!=='error').at(-1)?.name,errors:a.filter(x=>x.type==='error').length,replaySessionId:replayIds.find(x=>x.base_session_id===a[0].session_id)?.session_id}));return json({definition:def,steps:steps.map((step,i)=>({step,count:counts[i],rate:counts[0]?Number((counts[i]/counts[0]*100).toFixed(2)):0,stepRate:i?counts[i-1]?Number((counts[i]/counts[i-1]*100).toFixed(2)):0:100,lost:i?counts[i-1]-counts[i]:0,timeToConvert:i?median(ttcByStep[i]):null,timeToConvertP90:i?p90(ttcByStep[i]):null})),lostSessions,dimensions:['release_name','browser','device'].map(field=>({field,items:dimensions(rows,steps,field,windowMs)})),trend:dimensions(rows,steps,'day',windowMs),windowMs})}
async function saveDashboard(env,input){if(!input.name)throw new Error('仪表盘名称不能为空');const now=Date.now();const widgets=Array.isArray(input.widgets)?input.widgets.slice(0,12).map(item=>{if(typeof item==='string')return item.trim().slice(0,64);const type=item&&item.type==='funnel'?'funnel':item&&item.type==='insight'?'insight':'';const id=Number(item&&item.id);return type&&Number.isInteger(id)&&id>0?{type,id}:null}).filter(Boolean):[];const result=await env.DB.prepare('insert into dashboards(name,widgets_json,created_at,updated_at) values(?,?,?,?)').bind(clip(input.name,128),JSON.stringify(widgets),now,now).run();return json({id:result.meta.last_row_id})}
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

async function cleanup(env){const config=(await settings(env)).retention,now=Date.now(),deleted={};for(const [name,sql,days] of [['logs',`delete from events where type='log' and ts<?`,config.logsDays],['events',`delete from events where type<>'log' and ts<?`,config.eventsDays],['replays','delete from replays where created_at<?',config.replaysDays],['alerts','delete from alert_history where created_at<?',config.alertsDays],['sourcemaps','delete from sourcemaps where created_at<?',config.sourcemapsDays]])deleted[name]=(await env.DB.prepare(sql).bind(now-days*86400000).run()).meta.changes;return deleted}
async function exportCsv(env,kind,url){const filter=kind==='issues'?issueFilters(url):kind==='replays'?replayFilters(url):filters(url),select=kind==='replays'?'select app_id,session_id,max(user_id) user_id,max(user_name) user_name,max(user_phone) user_phone,min(created_at) first_seen,max(created_at) last_seen,max(url) url,max(release_name) release_name,max(end_reason) end_reason,count(*) event_count from replays':`select * from ${kind}`,group=kind==='replays'?' group by app_id,session_id':'',order=kind==='issues'?'last_seen':kind==='replays'?'last_seen':'ts',rows=(await env.DB.prepare(`${select} ${filter.where}${group} order by ${order} desc limit 10000`).bind(...filter.values).all()).results,keys=rows.length?Object.keys(rows[0]):[],cell=v=>`"${String(v??'').replaceAll('"','""')}"`,csv=rows.length?'\ufeff'+[keys.map(cell).join(','),...rows.map(r=>keys.map(k=>cell(r[k])).join(','))].join('\r\n'):'';return new Response(csv,{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':`attachment; filename="web-collection-${kind}.csv"`}})}

export function filters(url,forcedType,fixed=[],fixedValues=[]){const p=url.searchParams,parts=[...fixed],values=[...fixedValues];for(const [field,key,value] of [['app_id','appId'],['release_name','release'],['type','type',forcedType],['name','name'],['user_id','userId'],['session_id','sessionId']]){const v=value||p.get(key);if(v){const items=field==='type'?String(v).split(',').filter(Boolean):[v];parts.push(items.length>1?`${field} in (${items.map(()=>'?').join(',')})`:`${field}=?`);values.push(...items)}}if(p.get('traceId')){parts.push('trace_id like ?');values.push(`%${p.get('traceId')}%`)}if(p.get('path')){parts.push('(path like ? or url like ?)');values.push(...Array(2).fill(`%${p.get('path')}%`))}if(p.get('startTime')){parts.push('ts>=?');values.push(Number(p.get('startTime')))}if(p.get('endTime')){parts.push('ts<=?');values.push(Number(p.get('endTime')))}if(p.get('keyword')){parts.push('(name like ? or message like ? or props_json like ? or trace_id like ?)');values.push(...Array(4).fill(`%${p.get('keyword')}%`))}return{where:parts.length?`where ${parts.join(' and ')}`:'',values}}
export function issueFilters(url){const p=url.searchParams,parts=[],values=[];for(const[field,key]of[['app_id','appId'],['release_name','release'],['status','status']]){if(p.get(key)){parts.push(`${field}=?`);values.push(p.get(key))}}if(p.get('path')){parts.push('url like ?');values.push(`%${p.get('path')}%`)}if(p.get('startTime')){parts.push('last_seen>=?');values.push(Number(p.get('startTime')))}if(p.get('endTime')){parts.push('last_seen<=?');values.push(Number(p.get('endTime')))}if(p.get('keyword')){parts.push('(name like ? or message like ? or stack like ? or props_json like ?)');values.push(...Array(4).fill(`%${p.get('keyword')}%`))}return{where:parts.length?`where ${parts.join(' and ')}`:'',values}}
export function replayFilters(url){const p=url.searchParams,parts=[],values=[];for(const[field,key]of[['app_id','appId'],['release_name','release'],['user_id','userId']]){if(p.get(key)){parts.push(`${field}=?`);values.push(p.get(key))}}for(const[field,key]of[['user_name','userName'],['user_phone','userPhone'],['url','path']]){if(p.get(key)){parts.push(`${field} like ?`);values.push(`%${p.get(key)}%`)}}if(p.get('startTime')){parts.push('created_at>=?');values.push(Number(p.get('startTime')))}if(p.get('endTime')){parts.push('created_at<=?');values.push(Number(p.get('endTime')))}if(p.get('keyword')){parts.push('(session_id like ? or url like ? or events_json like ?)');values.push(...Array(3).fill(`%${p.get('keyword')}%`))}return{where:parts.length?`where ${parts.join(' and ')}`:'',values}}
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
function cors(response,request){const r=new Response(response.body,response),origin=request.headers.get('origin');r.headers.set('access-control-allow-origin',origin||'*');if(origin){r.headers.set('access-control-allow-credentials','true');r.headers.append('vary','Origin')}r.headers.set('access-control-allow-methods','GET,POST,PUT,DELETE,OPTIONS');r.headers.set('access-control-allow-headers','content-type,x-app-key,x-ai-key,traceparent');return r}
function parse(value,fallback){try{return typeof value==='string'?JSON.parse(value):value??fallback}catch{return fallback}}
function strings(v){return Array.isArray(v)?v.map(String).map(s=>s.trim()).filter(Boolean):[]}
function clip(v,n){return String(v??'').slice(0,n)} function rate(v){return Math.max(0,Math.min(1,Number(v??1)))} function origin(v){try{return new URL(v).origin}catch{return''}} function maskPhone(v=''){return String(v).replace(/^(\d{3})\d{4}(\d{4})$/,'$1****$2')} function random(n){const a=new Uint8Array(n);crypto.getRandomValues(a);return btoa(String.fromCharCode(...a)).replace(/[+/=]/g,'').slice(0,n*2)} async function sha256(v){return[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v)))].map(x=>x.toString(16).padStart(2,'0')).join('')}
const defaultSettings={retention:{eventsDays:30,logsDays:14,replaysDays:7,resolvedIssuesDays:90,sourcemapsDays:180,alertsDays:90},alerts:{enabled:true,cooldownMinutes:10,errorCount:1,error:true,logError:true,regression:true,lcp:4000,inp:500,cls:.25,longtask:200}}
