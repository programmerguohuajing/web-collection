import { z } from 'zod'
import { resolveTimeWindow } from '../runner.js'
import type { SkillSynthesizeContext, SkillTemplate, TicketDraft } from '../types.js'
import { asArray, asRecord, clip, itemsOf, num, numOrNull, str } from '../support.js'

const ONE_DAY_MS = 24 * 60 * 60 * 1000

const inputSchema = z.object({
  appId: z.string().optional().describe('应用ID；省略使用服务端默认应用'),
  keyword: z.string().optional().describe('问题关键词（匹配 issue 的 name/message/stack 与 error 事件，定位故障）'),
  startTime: z.number().optional().describe('窗口起始时间戳(ms)，默认 24 小时前'),
  endTime: z.number().optional().describe('窗口结束时间戳(ms)，默认当前'),
  severity: z.enum(['P0', 'P1', 'P2', 'P3']).optional().describe('强制指定严重级别；不传则按影响自动判定'),
})

type Input = z.infer<typeof inputSchema>

/**
 * 故障自动建单模板：定位错误问题 + 采样证据事件 + 关联链路，产出可直接回流工单系统的草案。
 * 仅调用既有工具：list_issues / list_events / list_traces（可选，需错误样本的 traceId）。
 */
export const incidentTriageTemplate: SkillTemplate = {
  id: 'incident_triage',
  title: '故障自动定级建单',
  version: '1.0.0',
  description:
    '根据关键词定位未处理/回归错误问题，采样最近的错误事件作为证据，并尝试关联调用链路，' +
    '最终产出带严重级别、去重键与证据清单的工单草案（ticketDraft，占位不实际建单）。' +
    '适合「故障自动建单 Agent」等第三方编排调用。',
  category: 'triage',
  tags: ['incident', 'triage', 'issue', 'ticket'],
  inputSchema: inputSchema.shape,
  outputContract: {
    description: '故障定级结果：匹配问题 + 证据 + 关联链路 + 工单草案',
    fields: {
      matchedIssue: '定位到的首要错误问题（fingerprint/name/message/count/affectedUsers/status/release/url）',
      evidence: '采样的最近错误事件（ts/type/name/message/url/traceId，已截断、不含 PII 新增字段）',
      trace: '若错误样本含 traceId，则附上链路概览；否则为 null',
      ticketDraft: '回流工单系统的标准化草案（severity/title/summary/dedupeKey/labels/evidence）',
    },
  },
  scheduleHint: {
    interval: '按需 / 可配合告警触发',
    defaultWindowMs: ONE_DAY_MS,
  },
  steps: [
    {
      id: 'issues',
      tool: 'list_issues',
      title: '定位错误问题',
      params: ({ input, now }) => {
        const w = resolveTimeWindow(input, now, ONE_DAY_MS)
        return {
          ...pickApp(input, w),
          keyword: input.keyword ? str(input.keyword) : undefined,
          page: 1,
          pageSize: 20,
        }
      },
    },
    {
      id: 'error_samples',
      tool: 'list_events',
      title: '采样错误事件证据',
      params: ({ input, now }) => {
        const w = resolveTimeWindow(input, now, ONE_DAY_MS)
        return {
          ...pickApp(input, w),
          type: 'error',
          keyword: input.keyword ? str(input.keyword) : undefined,
          page: 1,
          pageSize: 10,
        }
      },
    },
    {
      id: 'trace',
      tool: 'list_traces',
      title: '关联调用链路（可选）',
      optional: true,
      params: ({ input, steps, now }) => {
        const w = resolveTimeWindow(input, now, ONE_DAY_MS)
        const traceId = firstTraceId(steps.error_samples)
        if (!traceId) return { appId: input.appId ? str(input.appId) : undefined }
        return { ...pickApp(input, w), traceId }
      },
    },
  ],
  synthesize(ctx: SkillSynthesizeContext): unknown {
    const input = inputSchema.parse(ctx.input)
    const window = resolveTimeWindow(ctx.input, ctx.now, ONE_DAY_MS)

    const issueItems = itemsOf(ctx.steps.issues).map((item) => asRecord(item))
    const sampleEvents = itemsOf(ctx.steps.error_samples).map((item) => asRecord(item))
    const trace = ctx.steps.trace ? asArray(ctx.steps.trace) : null

    const matchedIssue = issueItems[0]
    const severity = deriveSeverity(input.severity, matchedIssue)
    const dedupeKey = matchedIssue
      ? `incident:${str(matchedIssue.fingerprint)}`
      : `incident:kw:${str(input.keyword) || 'unknown'}:${window.startTime}`

    const ticketDraft: TicketDraft = {
      title: matchedIssue
        ? `[故障] ${clip(str(matchedIssue.name), 80)} (${str(matchedIssue.release) || 'unknown'})`
        : `[故障] 关键词「${str(input.keyword) || '未知'}」未定位到明确 issue`,
      severity,
      summary: matchedIssue
        ? `错误问题「${clip(str(matchedIssue.name), 80)}」影响 ${num(matchedIssue.affectedUsers)} 用户，累计 ${num(matchedIssue.count)} 次，状态 ${str(matchedIssue.status)}。`
        : `在窗口内未匹配到确切 issue，请人工确认关键词或范围。`,
      dedupeKey,
      labels: ['incident', 'auto-triage', ...(matchedIssue && str(matchedIssue.status) === 'regression' ? ['regression'] : [])],
      evidence: buildEvidence(sampleEvents),
    }

    return {
      matchedIssue: matchedIssue
        ? {
            fingerprint: str(matchedIssue.fingerprint),
            name: clip(str(matchedIssue.name), 120),
            message: clip(str(matchedIssue.message), 200),
            count: num(matchedIssue.count),
            affectedUsers: num(matchedIssue.affectedUsers),
            status: str(matchedIssue.status),
            release: str(matchedIssue.release),
            url: str(matchedIssue.url),
          }
        : null,
      evidence: buildEvidence(sampleEvents),
      trace: trace
        ? trace.slice(0, 5).map((row) => asRecord(row))
        : null,
      ticketDraft,
    }
  },
}

function deriveSeverity(forced: Input['severity'], issue: Record<string, unknown> | undefined): TicketDraft['severity'] {
  if (forced) return forced
  if (!issue) return 'P3'
  const affectedUsers = num(issue.affectedUsers)
  if (str(issue.status) === 'regression') return 'P1'
  if (affectedUsers >= 1000) return 'P1'
  if (affectedUsers >= 100) return 'P2'
  return 'P3'
}

function buildEvidence(sampleEvents: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return sampleEvents.slice(0, 5).map((event) => ({
    ts: numOrNull(event.ts),
    type: str(event.type),
    name: clip(str(event.name), 120),
    message: clip(str(event.message), 200),
    url: str(event.url),
    traceId: str(event.traceId),
  }))
}

function firstTraceId(samples: unknown): string | null {
  const list = itemsOf(samples).map((item) => asRecord(item))
  for (const event of list) {
    const traceId = str(event.traceId)
    if (traceId) return traceId
  }
  return null
}

function pickApp(input: Record<string, unknown>, window: { startTime: number; endTime: number }): Record<string, unknown> {
  return {
    appId: input.appId ? str(input.appId) : undefined,
    startTime: window.startTime,
    endTime: window.endTime,
  }
}
