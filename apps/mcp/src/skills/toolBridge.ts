import type { DataSource, ListParams } from '../datasource/index.js'
import { TOOL_NAMES, type ToolName } from './toolNames.js'

/**
 * 工具调用桥：把「工具名」映射到对应的 `DataSource` 方法。
 *
 * 技能模板通过该桥执行步骤，保证：
 * 1. 模板只能触达既有 MCP 工具对应的数据源方法，不会引入新的数据出口；
 * 2. 与 `registerTools.ts` 走同一套 `DataSource` 语义（同样的过滤/分页/脱敏），
 *    因此模板的输出等价于「Agent 依次手工调用这些工具」的结果；
 * 3. 无状态：不经过 HTTP/MCP 协议层自调用，Worker 内零额外网络开销。
 */
export type ToolInvoker = (ds: DataSource, params: ListParams) => Promise<unknown>

export const TOOL_INVOKERS: Readonly<Record<ToolName, ToolInvoker>> = {
  list_events: (ds, params) => ds.listEvents(params),
  list_logs: (ds, params) => ds.listLogs(params),
  get_summary: (ds, params) => ds.getSummary(params),
  list_issues: (ds, params) => ds.listIssues(params),
  list_replays: (ds, params) => ds.listReplays(params),
  list_traces: (ds, params) => ds.listTraces(params),
  get_analytics_sessions: (ds, params) => ds.getAnalyticsSessions(params),
  get_analytics_paths: (ds, params) => ds.getAnalyticsPaths(params),
  get_analytics_click_paths: (ds, params) => ds.getAnalyticsClickPaths(params),
  get_analytics_heatmap: (ds, params) => ds.getAnalyticsHeatmap(params),
  get_analytics_live: (ds, params) => ds.getAnalyticsLive(params),
  list_alerts: (ds, params) => ds.listAlerts(params),
  list_alert_channels: (ds, params) => ds.listAlertChannels(params),
}

/** 每个工具的一句话说明，用于 `list_skill_templates` 给第三方 Agent 做能力说明。 */
export const TOOL_DESCRIPTIONS: Readonly<Record<ToolName, string>> = {
  list_events: '分页查询采集的原始事件',
  list_logs: '分页查询前端日志',
  get_summary: '聚合概览：事件总数/错误数/性能 p75/行为分布/接口与资源耗时 Top',
  list_issues: '分页查询聚合后的错误问题（issue）',
  list_replays: '分页查询会话回放列表',
  list_traces: '按 traceId 查询调用链路拓扑',
  get_analytics_sessions: '会话维度分析数据',
  get_analytics_paths: '页面路径/漏斗路径分析',
  get_analytics_click_paths: '用户点击路径分析',
  get_analytics_heatmap: '页面点击/曝光热力图数据',
  get_analytics_live: '近 5 分钟实时会话/用户/事件概览',
  list_alerts: '分页查询告警记录',
  list_alert_channels: '查询已配置的告警通知渠道',
}

/** 断言工具名已全部登记（编译期/启动期兜底）。 */
export const ALL_TOOL_NAMES: readonly ToolName[] = TOOL_NAMES
