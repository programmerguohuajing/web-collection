import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { DataSource, ListParams } from '../datasource/index.js'

// 通用过滤/分页入参，与后端 filters()/issueFilters()/replayFilters() 的 query 参数一一对应
const filterInput = {
  appId: z.string().optional().describe('应用ID；省略则使用服务端默认应用'),
  release: z.string().optional().describe('版本名 release'),
  type: z.string().optional().describe('事件类型，可逗号分隔多个，如 "error,perf"'),
  name: z.string().optional().describe('事件名'),
  userId: z.string().optional().describe('用户ID'),
  sessionId: z.string().optional().describe('会话ID'),
  traceId: z.string().optional().describe('链路追踪ID'),
  path: z.string().optional().describe('页面路径/URL 模糊匹配'),
  keyword: z.string().optional().describe('关键词模糊匹配（名称/消息/属性等）'),
  status: z.string().optional().describe('仅 issues：unresolved/resolved/regression'),
  startTime: z.number().optional().describe('起始时间戳(ms)'),
  endTime: z.number().optional().describe('结束时间戳(ms)'),
  page: z.number().int().min(1).optional().default(1).describe('页码，从1开始'),
  pageSize: z.number().int().min(1).max(100).optional().default(20).describe('每页条数，最大100'),
}

function toResult(data: unknown) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(data, null, 2) },
    ],
  }
}

export function registerTools(server: McpServer, ds: DataSource): void {
  server.registerTool(
    'list_events',
    { title: '列出采集事件', description: '分页查询 web-collection 采集的原始事件（点击/追踪/性能/错误等）', inputSchema: filterInput },
    async (args) => toResult(await ds.listEvents(args as ListParams)),
  )

  server.registerTool(
    'list_logs',
    { title: '列出日志', description: '分页查询采集的前端日志（type=log）', inputSchema: filterInput },
    async (args) => toResult(await ds.listLogs(args as ListParams)),
  )

  server.registerTool(
    'get_summary',
    { title: '获取概览', description: '返回某应用在某时间范围内的聚合概览：事件总数、错误数、性能 p75、行为分布等', inputSchema: filterInput },
    async (args) => toResult(await ds.getSummary(args as ListParams)),
  )

  server.registerTool(
    'list_issues',
    { title: '列出错误问题', description: '分页查询聚合后的错误问题（issue），含影响用户数、状态等', inputSchema: filterInput },
    async (args) => toResult(await ds.listIssues(args as ListParams)),
  )

  server.registerTool(
    'list_replays',
    { title: '列出会话回放', description: '分页查询会话回放列表（replays），含会话ID、用户、时间、事件数等', inputSchema: filterInput },
    async (args) => toResult(await ds.listReplays(args as ListParams)),
  )

  server.registerTool(
    'list_traces',
    { title: '列出调用链路', description: '按 traceId 查询分布式调用链路拓扑', inputSchema: filterInput },
    async (args) => toResult(await ds.listTraces(args as ListParams)),
  )

  server.registerTool(
    'get_analytics_sessions',
    { title: '会话分析', description: '会话维度分析数据', inputSchema: filterInput },
    async (args) => toResult(await ds.getAnalyticsSessions(args as ListParams)),
  )

  server.registerTool(
    'get_analytics_paths',
    { title: '路径分析', description: '页面路径/漏斗路径分析', inputSchema: filterInput },
    async (args) => toResult(await ds.getAnalyticsPaths(args as ListParams)),
  )

  server.registerTool(
    'get_analytics_click_paths',
    { title: '点击路径分析', description: '用户点击路径分析', inputSchema: filterInput },
    async (args) => toResult(await ds.getAnalyticsClickPaths(args as ListParams)),
  )

  server.registerTool(
    'get_analytics_heatmap',
    { title: '热力图分析', description: '页面点击/曝光热力图数据', inputSchema: filterInput },
    async (args) => toResult(await ds.getAnalyticsHeatmap(args as ListParams)),
  )

  server.registerTool(
    'get_analytics_live',
    { title: '实时概览', description: '近5分钟实时会话/用户/事件概览', inputSchema: filterInput },
    async (args) => toResult(await ds.getAnalyticsLive(args as ListParams)),
  )

  server.registerTool(
    'list_alerts',
    { title: '列出告警', description: '分页查询告警记录', inputSchema: filterInput },
    async (args) => toResult(await ds.listAlerts(args as ListParams)),
  )

  server.registerTool(
    'list_alert_channels',
    { title: '列出告警渠道', description: '查询已配置的告警通知渠道（邮件/短信/飞书/钉钉/企微/webhook 等）', inputSchema: filterInput },
    async (args) => toResult(await ds.listAlertChannels(args as ListParams)),
  )
}
