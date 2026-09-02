export interface ListParams {
  appId?: string
  release?: string
  type?: string
  name?: string
  userId?: string
  sessionId?: string
  traceId?: string
  path?: string
  keyword?: string
  status?: string
  userName?: string
  userPhone?: string
  startTime?: number
  endTime?: number
  page?: number
  pageSize?: number
}

export interface PagedResult<T = Record<string, unknown>> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

/**
 * 数据供给抽象层。
 * Plan A 由 RestDataSource 包装现有 /api/*；
 * 未来可新增 D1DataSource / PostgresDataSource 直连实现（见 wrangler.jsonc 中预留的 DB 绑定），
 * MCP 工具代码无需改动，仅切换 createDataSource 的 kind 即可。
 */
export interface DataSource {
  readonly kind: string
  listEvents(params: ListParams): Promise<PagedResult>
  listLogs(params: ListParams): Promise<PagedResult>
  getSummary(params: ListParams): Promise<unknown>
  listIssues(params: ListParams): Promise<PagedResult>
  listReplays(params: ListParams): Promise<PagedResult>
  listAlerts(params: ListParams): Promise<PagedResult>
  listTraces(params: ListParams): Promise<unknown>
  getAnalyticsSessions(params: ListParams): Promise<unknown>
  getAnalyticsPaths(params: ListParams): Promise<unknown>
  getAnalyticsClickPaths(params: ListParams): Promise<unknown>
  getAnalyticsHeatmap(params: ListParams): Promise<unknown>
  getAnalyticsLive(params: ListParams): Promise<unknown>
  listAlertChannels(params: ListParams): Promise<unknown>
}
