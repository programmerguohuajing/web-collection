import type { D1Database } from '@cloudflare/workers-types'
import type { DataSource, ListParams, PagedResult } from './datasource.js'

// ============================================================================
// 直连 D1 实现（Plan B 扩展点）。绕过后端 worker，直接查询 web-collection D1。
// 查询逻辑对齐 cloudflare/worker.js 的各 handler；返回结构与 RestDataSource 保持一致
// （驼峰字段 + 脱敏），便于 MCP 工具层无感知切换。
// 只读白名单：所有查询均为 SELECT，无写操作；聚合/分析查询固定使用常量列名（非用户输入）。
// ============================================================================

function safeParse(v: unknown, fallback: unknown = null): unknown {
  if (v == null) return fallback
  if (typeof v !== 'string') return v
  try { return JSON.parse(v) } catch { return fallback }
}

function maskPhone(v?: string): string {
  if (!v) return v ?? ''
  return v.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2')
}

interface FilterResult { where: string; values: unknown[] }

// 对齐 worker.js eventFilters()，但直接用 ListParams 的字段（appId -> app_id 等）。
// appId 为「锁定」的应用（来自采集秘钥鉴权解析），始终注入 app_id=? 过滤，
// 忽略客户端传入的 appId，确保连接只能读取自身应用数据。
function eventFilters(p: ListParams, forcedType?: string, fixed: string[] = [], fixedValues: unknown[] = [], appId?: string): FilterResult {
  const parts = [...fixed]
  const values = [...fixedValues]
  if (appId) { parts.push('app_id=?'); values.push(appId) }
  if (p.release) { parts.push('release_name=?'); values.push(p.release) }
  const type = forcedType ?? p.type
  if (type) {
    const types = String(type).split(',').filter(Boolean)
    if (types.length > 1) { parts.push(`type in (${types.map(() => '?').join(',')})`); values.push(...types) }
    else { parts.push('type=?'); values.push(types[0]) }
  }
  if (p.name) { parts.push('name=?'); values.push(p.name) }
  if (p.userId) { parts.push('user_id=?'); values.push(p.userId) }
  if (p.sessionId) { parts.push('session_id=?'); values.push(p.sessionId) }
  if (p.traceId) { parts.push('trace_id like ?'); values.push(`%${p.traceId}%`) }
  if (p.path) { parts.push('(path like ? or url like ?)'); values.push(`%${p.path}%`, `%${p.path}%`) }
  if (p.keyword) { parts.push('(name like ? or message like ? or props_json like ? or trace_id like ?)'); values.push(...Array(4).fill(`%${p.keyword}%`)) }
  if (p.startTime) { parts.push('ts>=?'); values.push(Number(p.startTime)) }
  if (p.endTime) { parts.push('ts<=?'); values.push(Number(p.endTime)) }
  return { where: parts.length ? `where ${parts.join(' and ')}` : '', values }
}

function issueFilters(p: ListParams, appId?: string): FilterResult {
  const parts: string[] = []
  const values: unknown[] = []
  if (appId) { parts.push('app_id=?'); values.push(appId) }
  if (p.release) { parts.push('release_name=?'); values.push(p.release) }
  if (p.status) { parts.push('status=?'); values.push(p.status) }
  if (p.path) { parts.push('url like ?'); values.push(`%${p.path}%`) }
  if (p.startTime) { parts.push('last_seen>=?'); values.push(Number(p.startTime)) }
  if (p.endTime) { parts.push('last_seen<=?'); values.push(Number(p.endTime)) }
  if (p.keyword) { parts.push('(name like ? or message like ? or stack like ? or props_json like ?)'); values.push(...Array(4).fill(`%${p.keyword}%`)) }
  return { where: parts.length ? `where ${parts.join(' and ')}` : '', values }
}

function replayFilters(p: ListParams, appId?: string): FilterResult {
  const parts: string[] = []
  const values: unknown[] = []
  if (appId) { parts.push('app_id=?'); values.push(appId) }
  if (p.release) { parts.push('release_name=?'); values.push(p.release) }
  if (p.userId) { parts.push('user_id=?'); values.push(p.userId) }
  if (p.sessionId) { parts.push('session_id=?'); values.push(p.sessionId) }
  if (p.userName) { parts.push('user_name like ?'); values.push(`%${p.userName}%`) }
  if (p.userPhone) { parts.push('user_phone like ?'); values.push(`%${p.userPhone}%`) }
  if (p.path) { parts.push('url like ?'); values.push(`%${p.path}%`) }
  if (p.startTime) { parts.push('created_at>=?'); values.push(Number(p.startTime)) }
  if (p.endTime) { parts.push('created_at<=?'); values.push(Number(p.endTime)) }
  if (p.keyword) { parts.push('(session_id like ? or url like ? or events_json like ?)'); values.push(...Array(3).fill(`%${p.keyword}%`)) }
  return { where: parts.length ? `where ${parts.join(' and ')}` : '', values }
}

function alertFilters(p: ListParams, appId?: string): FilterResult {
  const parts: string[] = []
  const values: unknown[] = []
  if (appId) { parts.push('app_id=?'); values.push(appId) }
  if (p.status) { parts.push('status=?'); values.push(p.status) }
  if (p.startTime) { parts.push('created_at>=?'); values.push(Number(p.startTime)) }
  if (p.endTime) { parts.push('created_at<=?'); values.push(Number(p.endTime)) }
  return { where: parts.length ? `where ${parts.join(' and ')}` : '', values }
}

function paginate(p: ListParams): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, Number(p.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(p.pageSize) || 10))
  return { page, pageSize, offset: (page - 1) * pageSize }
}

// ---- 行映射（对齐 worker.js mapEvent/mapIssue/mapAlert + 脱敏）----
function mapEvent(r: Record<string, unknown>) {
  return {
    id: r.id, ts: r.ts, type: r.type, appId: r.app_id, release: r.release_name,
    userId: r.user_id, userName: r.user_name, userPhone: maskPhone(r.user_phone as string),
    sessionId: r.session_id, deviceId: r.device_id, traceId: r.trace_id,
    spanId: r.span_id, sdkVersion: r.sdk_version, environment: r.environment,
    source: r.source, url: r.url, path: r.path, title: r.title, referrer: r.referrer,
    userAgent: r.user_agent, name: r.name, metric: r.metric, value: r.value,
    message: r.message, stack: r.stack,
    props: safeParse(r.props_json), breadcrumbs: safeParse(r.breadcrumbs_json),
  }
}

function mapIssue(r: Record<string, unknown>) {
  return {
    fingerprint: r.fingerprint, status: r.status, appId: r.app_id, release: r.release_name,
    name: r.name, message: r.message, stack: r.stack, url: r.url,
    props: safeParse(r.props_json), breadcrumbs: safeParse(r.breadcrumbs_json),
    original: safeParse(r.original_json), count: r.count, firstSeen: r.first_seen,
    lastSeen: r.last_seen, resolvedAt: r.resolved_at, affectedUsers: Number(r.affected_users || 0),
  }
}

function mapAlert(r: Record<string, unknown>) {
  return {
    id: r.id, appId: r.app_id, metric: r.metric, level: r.level, value: r.value,
    message: r.message, threshold: r.threshold, status: r.status || 'pending',
    fingerprint: r.fingerprint, traceId: r.trace_id, url: r.url, releaseName: r.release_name,
    userId: r.user_id, deviceId: r.device_id, sessionId: r.session_id, path: r.path,
    context: safeParse(r.context_json), notified: !!r.notified, resolvedAt: r.resolved_at,
    created_at: r.created_at, deliveryTotal: r.delivery_total, deliverySent: r.delivery_sent,
    deliveryFailed: r.delivery_failed, deliveryPending: r.delivery_pending,
  }
}

function publicChannel(r: Record<string, unknown>) {
  return {
    id: r.id, name: r.name, type: r.type, enabled: !!r.enabled,
    config: safeParse(r.config_json), appIds: safeParse(r.app_ids_json),
    levels: safeParse(r.levels_json), metrics: safeParse(r.metrics_json),
    updatedAt: r.updated_at, lastTestStatus: r.last_test_status,
  }
}

export class D1DataSource implements DataSource {
  readonly kind = 'd1'

  constructor(private readonly db: D1Database, private readonly defaultAppId: string) {}

  private async paged(
    query: string, countQuery: string, values: unknown[], p: ListParams,
    map?: (r: Record<string, unknown>) => unknown,
  ): Promise<PagedResult> {
    const { page, pageSize, offset } = paginate(p)
    const rows = await this.db.prepare(`${query} limit ? offset ?`).bind(...values, pageSize, offset).all() as { results?: Record<string, unknown>[] }
    const totalRow = await this.db.prepare(countQuery).bind(...values).first() as { count?: number } | null
    const items = (rows.results || []).map(map ?? ((r) => r))
    return { items: items as PagedResult['items'], total: Number(totalRow?.count || 0), page, pageSize }
  }

  listEvents(p: ListParams): Promise<PagedResult> {
    const { where, values } = eventFilters(p, undefined, undefined, undefined, this.defaultAppId)
    return this.paged(`select * from events ${where} order by ts desc`, `select count(*) count from events ${where}`, values, p, mapEvent)
  }

  listLogs(p: ListParams): Promise<PagedResult> {
    const { where, values } = eventFilters(p, 'log', undefined, undefined, this.defaultAppId)
    return this.paged(`select * from events ${where} order by ts desc`, `select count(*) count from events ${where}`, values, p, mapEvent)
  }

  listIssues(p: ListParams): Promise<PagedResult> {
    const { where, values } = issueFilters(p, this.defaultAppId)
    return this.paged(`select * from issues ${where} order by last_seen desc`, `select count(*) count from issues ${where}`, values, p, mapIssue)
  }

  listReplays(p: ListParams): Promise<PagedResult> {
    const { where, values } = replayFilters(p, this.defaultAppId)
    const q = `select session_id replayId,session_id,max(user_id) userId,max(user_name) userName,max(user_phone) userPhone,min(created_at) firstSeen,max(created_at) lastSeen,max(url) url,max(release_name) release,max(end_reason) endReason,max(user_agent) userAgent,count(*) eventCount from replays ${where} group by app_id,session_id order by lastSeen desc`
    const c = `select count(*) count from (select 1 from replays ${where} group by app_id,session_id)`
    return this.paged(q, c, values, p, (r) => ({ ...r, userPhone: maskPhone(r.userPhone as string) }))
  }

  listAlerts(p: ListParams): Promise<PagedResult> {
    const { where, values } = alertFilters(p, this.defaultAppId)
    return this.paged(`select * from alert_history ${where} order by created_at desc`, `select count(*) count from alert_history ${where}`, values, p, mapAlert)
  }

  async listAlertChannels(p: ListParams): Promise<unknown> {
    const { page, pageSize, offset } = paginate(p)
    const appId = this.defaultAppId
    // 仅返回与本应用绑定（app_ids_json 含本 app_id）或全局（null/空）的告警渠道，避免跨应用暴露。
    const rows = await this.db.prepare(
      `select * from alert_channels where (? = '' or app_ids_json is null or exists (select 1 from json_each(app_ids_json) where json_each.value = ?)) order by updated_at desc limit ? offset ?`,
    ).bind(appId, appId, pageSize, offset).all() as { results?: Record<string, unknown>[] }
    const totalRow = await this.db.prepare(
      `select count(*) count from alert_channels where (? = '' or app_ids_json is null or exists (select 1 from json_each(app_ids_json) where json_each.value = ?))`,
    ).bind(appId, appId).first() as { count?: number } | null
    return { items: (rows.results || []).map(publicChannel), total: Number(totalRow?.count || 0), page, pageSize }
  }

  async listTraces(p: ListParams): Promise<unknown> {
    const { where, values } = eventFilters(p, undefined, ["trace_id<>''"], undefined, this.defaultAppId)
    const { page, pageSize, offset } = paginate(p)
    const rows = await this.db.prepare(`select trace_id,min(ts) started_at,max(ts) ended_at,count(*) span_count,sum(case when type='error' or json_extract(props_json,'$.status')>=400 then 1 else 0 end) error_count,max(app_id) app_id,max(release_name) release_name,max(url) url from events ${where} group by trace_id order by started_at desc limit ? offset ?`).bind(...values, pageSize, offset).all() as { results?: Record<string, unknown>[] }
    const totalRow = await this.db.prepare(`select count(*) count from (select 1 from events ${where} group by trace_id)`).bind(...values).first() as { count?: number } | null
    return { items: (rows.results || []).map((r) => ({ ...r, duration: (r.ended_at as number) - (r.started_at as number) })), total: Number(totalRow?.count || 0), page, pageSize }
  }

  async getAnalyticsLive(p: ListParams): Promise<unknown> {
    const since = Date.now() - 300000
    const { where, values } = eventFilters(p, undefined, ['ts>=?'], [since], this.defaultAppId)
    const row = await this.db.prepare(`select count(distinct session_id) sessions,count(distinct coalesce(nullif(user_id,''),device_id)) users,count(*) events from events ${where}`).bind(...values).first() as Record<string, unknown> | null
    return { since, ...(row || {}) }
  }

  async getSummary(p: ListParams): Promise<unknown> {
    const { where, values } = eventFilters(p, undefined, undefined, undefined, this.defaultAppId)
    const [totalRow, byTypeRows, issueRow] = await Promise.all([
      this.db.prepare(`select count(*) total,max(ts) last_seen from events ${where}`).bind(...values).first() as Promise<Record<string, unknown> | null>,
      this.db.prepare(`select type,count(*) count from events ${where} group by type`).bind(...values).all() as Promise<{ results?: Record<string, unknown>[] }>,
      this.db.prepare(`select count(*) issue_count from issues ${issueFilters(p, this.defaultAppId).where || 'where 1=1'}`).bind(...issueFilters(p, this.defaultAppId).values).first() as Promise<Record<string, unknown> | null>,
    ])
    const byType: Record<string, number> = {}
    for (const r of byTypeRows.results || []) byType[String(r.type)] = Number(r.count)
    return {
      totalEvents: Number(totalRow?.total || 0),
      issueCount: Number(issueRow?.issue_count || 0),
      lastSeen: totalRow?.last_seen ?? null,
      byType,
    }
  }

  async getAnalyticsSessions(p: ListParams): Promise<unknown> {
    const { where, values } = eventFilters(p, undefined, ["session_id<>''"], undefined, this.defaultAppId)
    const { page, pageSize, offset } = paginate(p)
    const rows = await this.db.prepare(`select session_id,max(user_id) user_id,max(user_name) user_name,max(device_id) device_id,min(ts) started_at,max(ts) ended_at,count(*) event_count,sum(case when type='error' then 1 else 0 end) error_count,group_concat(distinct path) paths from events ${where} group by session_id order by ended_at desc limit ? offset ?`).bind(...values, pageSize, offset).all() as { results?: Record<string, unknown>[] }
    const totalRow = await this.db.prepare(`select count(*) count from (select 1 from events ${where} group by session_id)`).bind(...values).first() as { count?: number } | null
    return { items: (rows.results || []).map((r) => ({ ...r, duration: (r.ended_at as number) - (r.started_at as number), paths: String(r.paths || '').split(',').filter(Boolean) })), total: Number(totalRow?.count || 0), page, pageSize }
  }

  async getAnalyticsPaths(p: ListParams): Promise<unknown> {
    const { where, values } = eventFilters(p, 'behavior', [`name in ('pv','pushState','replaceState','popstate','hashchange')`], undefined, this.defaultAppId)
    const rows = await this.db.prepare(`select session_id,path,ts,user_id,user_name from events ${where} order by session_id,ts limit 20000`).bind(...values).all() as { results?: Record<string, unknown>[] }
    const grouped = new Map<string, Record<string, unknown>[]>()
    for (const e of rows.results || []) {
      const k = String(e.session_id || '')
      if (!grouped.has(k)) grouped.set(k, [])
      grouped.get(k)!.push(e)
    }
    const counts: Record<string, { path: string; count: number; users: { id: string; name: string }[] }> = {}
    for (const events of grouped.values()) {
      const value = events.map((e) => e.path).filter((v, i, a) => v && v !== a[i - 1]).slice(0, 8).join(' → ')
      if (!value) continue
      const existing = counts[value] || { path: value, count: 0, users: [] }
      existing.count++
      const userId = String(events[0]?.user_id || '').trim()
      const userName = String(events[0]?.user_name || '')
      if (userId && !existing.users.find((u) => u.id === userId)) existing.users.push({ id: userId, name: userName || userId })
      counts[value] = existing
    }
    return Object.values(counts).sort((a, b) => b.count - a.count).slice(0, 50)
  }

  async getAnalyticsClickPaths(p: ListParams): Promise<unknown> {
    const { where, values } = eventFilters(p, 'behavior', ["name='click'"], undefined, this.defaultAppId)
    const rows = await this.db.prepare(`select session_id,ts,path,props_json from events ${where} order by session_id,ts limit 20000`).bind(...values).all() as { results?: Record<string, unknown>[] }
    const grouped = new Map<string, Record<string, unknown>[]>()
    for (const e of rows.results || []) {
      const k = String(e.session_id || '')
      if (!grouped.has(k)) grouped.set(k, [])
      grouped.get(k)!.push(e)
    }
    const nodeMap = new Map<string, { id: string; label: string; type: string; value: number }>()
    const edgeMap = new Map<string, { source: string; target: string; calls: number; sessions: number }>()
    for (const events of grouped.values()) {
      const clicks = events.map((e) => {
        const props = safeParse(e.props_json, {}) as Record<string, unknown>
        const label = String(props.elementLabel || props.label || props.text || props.ariaLabel || props.title || props.tag || '')
        return { id: `${label || props.tag || 'node'}@${String(e.path || props.path || '')}`, label: label || String(props.tag || 'unknown'), path: String(e.path || props.path || '') }
      }).filter((c) => c.label && c.label !== 'unknown')
      for (const c of clicks) {
        if (!nodeMap.has(c.id)) nodeMap.set(c.id, { id: c.id, label: c.label, type: 'click', value: 0 })
        nodeMap.get(c.id)!.value++
      }
      const seen = new Set<string>()
      for (let i = 1; i < clicks.length; i++) {
        const from = clicks[i - 1]; const to = clicks[i]
        if (!from || !to) continue
        const key = `${from.id}|${to.id}`
        if (!edgeMap.has(key)) edgeMap.set(key, { source: from.id, target: to.id, calls: 0, sessions: 0 })
        const edge = edgeMap.get(key)!
        edge.calls++
        if (!seen.has(key)) { edge.sessions++; seen.add(key) }
      }
    }
    return { nodes: [...nodeMap.values()], edges: [...edgeMap.values()] }
  }

  async getAnalyticsHeatmap(p: ListParams): Promise<unknown> {
    const { where, values } = eventFilters(p, undefined, ["type='behavior'", "name in ('click','scroll')"], undefined, this.defaultAppId)
    const rows = await this.db.prepare(`select ts,name,props_json,path,url from events ${where} order by ts desc limit 50000`).bind(...values).all() as { results?: Record<string, unknown>[] }
    const clickPoints: Record<string, unknown>[] = []
    const scrollAggregate = new Map<string, { path: string; count: number; totalDepth: number; maxDepth: number; scrollEvents: number }>()
    for (const row of rows.results || []) {
      const props = safeParse(row.props_json, {}) as Record<string, unknown>
      if (row.name === 'click') {
        const x = Number(props.x); const y = Number(props.y)
        if (Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0) {
          clickPoints.push({ x, y, viewportWidth: Number(props.viewportWidth) || 0, viewportHeight: Number(props.viewportHeight) || 0, elementType: String(props.elementType || ''), elementLabel: String(props.elementLabel || ''), ts: row.ts, path: String(row.path || ''), url: String(row.url || '') })
        }
      }
      if (row.name === 'scroll' && Number.isFinite(Number(props.depth))) {
        const key = String(row.path || row.url || '')
        if (key) {
          const existing = scrollAggregate.get(key) || { path: key, count: 0, totalDepth: 0, maxDepth: 0, scrollEvents: 0 }
          existing.count++
          existing.totalDepth += Number(props.depth) || 0
          existing.maxDepth = Math.max(existing.maxDepth, Number(props.maxDepth) || 0)
          existing.scrollEvents++
          scrollAggregate.set(key, existing)
        }
      }
    }
    return { clickPoints: clickPoints.slice(0, 10000), scrollAggregate: [...scrollAggregate.values()].sort((a, b) => b.count - a.count).slice(0, 50) }
  }
}
