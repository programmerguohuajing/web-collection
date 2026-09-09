import type { DataSource, ListParams, PagedResult } from './datasource.js'

// query 参数名需与 cloudflare/worker.js 的 filters()/issueFilters()/replayFilters() 对应：
// appId -> app_id, release -> release_name, userId -> user_id, sessionId -> session_id 等。
const QUERY_MAP: Array<[keyof ListParams, string]> = [
  ['release', 'release'],
  ['type', 'type'],
  ['name', 'name'],
  ['userId', 'userId'],
  ['sessionId', 'sessionId'],
  ['traceId', 'traceId'],
  ['path', 'path'],
  ['keyword', 'keyword'],
  ['status', 'status'],
  ['startTime', 'startTime'],
  ['endTime', 'endTime'],
  ['page', 'page'],
  ['pageSize', 'pageSize'],
]

export class RestDataSource implements DataSource {
  readonly kind = 'rest'

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly defaultAppId: string,
  ) {}

  private buildQuery(params: ListParams): string {
    const q = new URLSearchParams()
    // 锁定：忽略客户端传入的 appId，强制使用鉴权解析出的应用（防止跨应用越权读取）。
    const appId = this.defaultAppId
    if (appId) q.set('appId', appId)
    for (const [key, name] of QUERY_MAP) {
      const v = params[key]
      if (v !== undefined && v !== null && v !== '') q.set(name, String(v))
    }
    return q.toString()
  }

  private async get<T>(path: string, params: ListParams): Promise<T> {
    const qs = this.buildQuery(params)
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-app-key': this.apiKey,
        accept: 'application/json',
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`backend ${path} returned ${res.status}: ${body.slice(0, 300)}`)
    }
    return (await res.json()) as T
  }

  listEvents(p: ListParams) { return this.get<PagedResult>('/api/events', p) }
  listLogs(p: ListParams) { return this.get<PagedResult>('/api/logs', p) }
  getSummary(p: ListParams) { return this.get<unknown>('/api/summary', p) }
  listIssues(p: ListParams) { return this.get<PagedResult>('/api/issues', p) }
  listReplays(p: ListParams) { return this.get<PagedResult>('/api/replays', p) }
  listAlerts(p: ListParams) { return this.get<PagedResult>('/api/alerts', p) }
  listTraces(p: ListParams) { return this.get<unknown>('/api/traces', p) }
  getAnalyticsSessions(p: ListParams) { return this.get<unknown>('/api/analytics/sessions', p) }
  getAnalyticsPaths(p: ListParams) { return this.get<unknown>('/api/analytics/paths', p) }
  getAnalyticsClickPaths(p: ListParams) { return this.get<unknown>('/api/analytics/click-paths', p) }
  getAnalyticsHeatmap(p: ListParams) { return this.get<unknown>('/api/analytics/heatmap', p) }
  getAnalyticsLive(p: ListParams) { return this.get<unknown>('/api/analytics/live', p) }
  listAlertChannels(p: ListParams) { return this.get<unknown>('/api/alert-channels', p) }
}
