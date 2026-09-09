import { z } from 'zod'
import { resolveTimeWindow } from '../runner.js'
import type { SkillSynthesizeContext, SkillTemplate, TicketDraft } from '../types.js'
import { asArray, asRecord, clip, formatDate, itemsOf, num, numOrNull, round, str, totalOf } from '../support.js'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

const inputSchema = z.object({
  appId: z.string().optional().describe('应用ID；省略使用服务端默认应用'),
  release: z.string().optional().describe('只看某个版本 release（版本健康度维度）'),
  startTime: z.number().optional().describe('窗口起始时间戳(ms)，默认 7 天前'),
  endTime: z.number().optional().describe('窗口结束时间戳(ms)，默认当前'),
  topIssues: z.number().int().min(1).max(20).optional().default(5).describe('报告中汇总的最大未解决问题数'),
})

type Input = z.infer<typeof inputSchema>

/**
 * 健康周报模板：聚合「错误 / 性能 / 版本健康度」并产出结构化摘要 + 工单草案占位。
 * 仅调用既有 MCP 工具：get_summary / list_issues / list_alerts / get_analytics_live（可选）。
 */
export const healthWeeklyReportTemplate: SkillTemplate = {
  id: 'health_weekly_report',
  title: '周期性健康周报',
  version: '1.0.0',
  description:
    '聚合某应用在指定时间窗口内的错误、性能与版本健康度，输出结构化健康分、Top 问题、告警概览与改进建议，' +
    '并给出可用于回流工单系统的标准化草案（ticketDraft）。适合「每周自动出健康周报 Agent」等第三方编排调用。',
  category: 'report',
  tags: ['health', 'report', 'weekly', 'errors', 'performance'],
  inputSchema: inputSchema.shape,
  outputContract: {
    description: '结构化健康周报：健康分 + 概览 + Top 问题 + 告警 + 性能 + 版本健康度 + 建议 + 工单草案',
    fields: {
      window: '实际生效的时间窗口 {startTime, endTime, durationMs}',
      appId: '报告归属应用（未传为默认应用）',
      healthScore: '健康分 {score 0-100, grade A-D, factors[]}',
      overview: '总量与错误率概览（totalEvents / errorEvents / errorRate / issueCount / regressionCount / lastSeen）',
      topIssues: '未解决问题 TopN 列表（fingerprint/name/message/count/affectedUsers/status/release/url）',
      alerts: '告警概览（total / byLevel）',
      performance: '关键性能指标 p75（lcp/inp/cls/fcp/ttfb/page_load）+ 慢接口 Top3 + 慢资源 Top3',
      versionHealth: '按 release 聚合的未解决问题数与影响用户数',
      highlights: '人类可读的要点文案',
      recommendations: '按优先级排序的改进建议 {priority, title, detail, evidence[]}',
      ticketDraft: '回流工单系统的标准化草案（占位，不实际建单）',
      schedule: '定时调度占位（interval/cron/nextWindow）',
    },
  },
  scheduleHint: {
    interval: '每周',
    cron: '13 9 * * 1',
    defaultWindowMs: SEVEN_DAYS_MS,
  },
  steps: [
    {
      id: 'overview',
      tool: 'get_summary',
      title: '聚合概览',
      params: ({ input, now }) => {
        const w = resolveTimeWindow(input, now, SEVEN_DAYS_MS)
        return pickApp(input, w)
      },
    },
    {
      id: 'top_issues',
      tool: 'list_issues',
      title: '未解决问题 Top N',
      params: ({ input, now }) => {
        const w = resolveTimeWindow(input, now, SEVEN_DAYS_MS)
        return {
          ...pickApp(input, w),
          status: 'unresolved',
          page: 1,
          pageSize: num(input.topIssues, 5),
        }
      },
    },
    {
      id: 'alerts',
      tool: 'list_alerts',
      title: '告警记录',
      params: ({ input, now }) => {
        const w = resolveTimeWindow(input, now, SEVEN_DAYS_MS)
        return { ...pickApp(input, w), page: 1, pageSize: 50 }
      },
    },
    {
      id: 'live',
      tool: 'get_analytics_live',
      title: '实时快照（可选）',
      optional: true,
      params: ({ input }) => ({ appId: input.appId ? str(input.appId) : undefined }),
    },
  ],
  synthesize(ctx: SkillSynthesizeContext): unknown {
    const input = inputSchema.parse(ctx.input)
    const window = resolveTimeWindow(ctx.input, ctx.now, SEVEN_DAYS_MS)
    const summary = asRecord(ctx.steps.overview)

    const totalEvents = num(summary.totalEvents)
    const byType = asRecord(summary.byType)
    const errorEvents = num(byType.error)
    const errorRate = totalEvents > 0 ? errorEvents / totalEvents : 0
    const issueCount = num(summary.issueCount)
    const regressionCount = num(summary.regressionCount)
    const perf = asRecord(summary.perf)

    const issueItems = itemsOf(ctx.steps.top_issues)
      .slice(0, num(input.topIssues, 5))
      .map((item) => asRecord(item))
    const alertItems = itemsOf(ctx.steps.alerts).map((item) => asRecord(item))

    const alertsByLevel = { critical: 0, warning: 0, info: 0, other: 0 }
    for (const alert of alertItems) {
      const level = str(alert.level).toLowerCase()
      if (level === 'critical' || level === 'error') alertsByLevel.critical += 1
      else if (level === 'warning') alertsByLevel.warning += 1
      else if (level === 'info') alertsByLevel.info += 1
      else alertsByLevel.other += 1
    }

    const score = computeHealthScore({ errorRate, issueCount, regressionCount, alertsByLevel, perf })
    const versionHealth = summarizeVersionHealth(issueItems)

    const slowApis = asArray(summary.api).map((row) => asRecord(row)).slice(0, 3).map((row) => ({
      name: str(row.name),
      p75: numOrNull(row.p75),
      avg: numOrNull(row.avg),
      count: num(row.count),
    }))
    const slowResources = asArray(summary.resources).map((row) => asRecord(row)).slice(0, 3).map((row) => ({
      name: clip(str(row.name), 120),
      p75: numOrNull(row.p75),
      count: num(row.count),
    }))

    const highlights = buildHighlights({ errorRate, issueCount, regressionCount, score, alertsByLevel })
    const recommendations = buildRecommendations({
      errorRate,
      issueItems,
      regressionCount,
      perf,
      slowApis,
    })

    const ticketDraft = buildTicketDraft({
      appId: str(input.appId),
      window,
      score,
      issueCount,
      alertsByLevel,
      issueItems,
    })

    return {
      window: { startTime: window.startTime, endTime: window.endTime, durationMs: window.endTime - window.startTime },
      appId: input.appId ? str(input.appId) : 'default',
      healthScore: score,
      overview: {
        totalEvents,
        errorEvents,
        errorRate: round(errorRate, 4),
        issueCount,
        regressionCount,
        lastSeen: numOrNull(summary.lastSeen),
      },
      topIssues: issueItems.map((issue) => ({
        fingerprint: str(issue.fingerprint),
        name: clip(str(issue.name), 120),
        message: clip(str(issue.message), 200),
        count: num(issue.count),
        affectedUsers: num(issue.affectedUsers),
        status: str(issue.status),
        release: str(issue.release),
        url: str(issue.url),
      })),
      alerts: { total: totalOf(ctx.steps.alerts), byLevel: alertsByLevel },
      performance: {
        lcp: numOrNull(perf.lcp),
        inp: numOrNull(perf.inp),
        cls: numOrNull(perf.cls),
        fcp: numOrNull(perf.fcp),
        ttfb: numOrNull(perf.ttfb),
        pageLoad: numOrNull(perf.page_load),
        slowApis,
        slowResources,
      },
      versionHealth,
      highlights,
      recommendations,
      ticketDraft,
      schedule: {
        interval: '每周',
        cron: '13 9 * * 1',
        nextWindow: { startTime: window.endTime, endTime: window.endTime + (window.endTime - window.startTime) },
      },
    }
  },
}

interface HealthInputs {
  errorRate: number
  issueCount: number
  regressionCount: number
  alertsByLevel: { critical: number; warning: number; info: number; other: number }
  perf: Record<string, unknown>
}

function computeHealthScore(inputs: HealthInputs): { score: number; grade: string; factors: Array<{ name: string; impact: number; detail: string }> } {
  let score = 100
  const factors: Array<{ name: string; impact: number; detail: string }> = []

  const deduct = (name: string, impact: number, detail: string) => {
    if (impact <= 0) return
    score -= impact
    factors.push({ name, impact: -impact, detail })
  }

  if (inputs.errorRate > 0.05) deduct('错误率过高', 30, `错误率 ${(inputs.errorRate * 100).toFixed(2)}% (>5%)`)
  else if (inputs.errorRate > 0.02) deduct('错误率偏高', 20, `错误率 ${(inputs.errorRate * 100).toFixed(2)}% (>2%)`)
  else if (inputs.errorRate > 0.01) deduct('错误率有上升迹象', 10, `错误率 ${(inputs.errorRate * 100).toFixed(2)}% (>1%)`)
  else if (inputs.errorRate > 0.005) deduct('错误率轻微', 5, `错误率 ${(inputs.errorRate * 100).toFixed(2)}% (>0.5%)`)

  if (inputs.issueCount > 20) deduct('未解决问题过多', 20, `未解决 ${inputs.issueCount} 个 (>20)`)
  else if (inputs.issueCount > 10) deduct('未解决问题较多', 12, `未解决 ${inputs.issueCount} 个 (>10)`)
  else if (inputs.issueCount > 5) deduct('存在未解决问题', 6, `未解决 ${inputs.issueCount} 个 (>5)`)
  else if (inputs.issueCount > 0) deduct('有少量未解决问题', 3, `未解决 ${inputs.issueCount} 个`)

  if (inputs.regressionCount > 0) deduct('存在回归问题', 10, `回归 ${inputs.regressionCount} 个`)

  deduct('严重告警', Math.min(20, inputs.alertsByLevel.critical * 5), `critical 告警 ${inputs.alertsByLevel.critical} 条`)
  deduct('警告告警', Math.min(10, inputs.alertsByLevel.warning * 2), `warning 告警 ${inputs.alertsByLevel.warning} 条`)

  const lcp = numOrNull(inputs.perf.lcp)
  if (lcp !== null && lcp > 4000) deduct('LCP 过慢', 10, `LCP p75 ${lcp}ms (>4000)`)
  else if (lcp !== null && lcp > 2500) deduct('LCP 偏慢', 5, `LCP p75 ${lcp}ms (>2500)`)
  const cls = numOrNull(inputs.perf.cls)
  if (cls !== null && cls > 0.25) deduct('CLS 过大', 10, `CLS ${cls} (>0.25)`)
  else if (cls !== null && cls > 0.1) deduct('CLS 略大', 5, `CLS ${cls} (>0.1)`)
  const inp = numOrNull(inputs.perf.inp)
  if (inp !== null && inp > 500) deduct('INP 过高', 10, `INP p75 ${inp}ms (>500)`)
  else if (inp !== null && inp > 200) deduct('INP 偏慢', 5, `INP p75 ${inp}ms (>200)`)

  score = Math.max(0, Math.min(100, Math.round(score)))
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'D'
  return { score, grade, factors }
}

// 按 release 聚合未解决问题数与影响用户数（版本健康度维度）。
function summarizeVersionHealth(issueItems: Array<Record<string, unknown>>): Array<{ release: string; unresolvedIssues: number; affectedUsers: number }> {
  const byRelease = new Map<string, { release: string; unresolved: number; users: number }>()
  for (const issue of issueItems) {
    const release = str(issue.release) || 'unknown'
    const entry = byRelease.get(release) || { release, unresolved: 0, users: 0 }
    entry.unresolved += 1
    entry.users += num(issue.affectedUsers)
    byRelease.set(release, entry)
  }
  return [...byRelease.values()].map((entry) => ({
    release: entry.release,
    unresolvedIssues: entry.unresolved,
    affectedUsers: entry.users,
  }))
}

function buildHighlights(inputs: { errorRate: number; issueCount: number; regressionCount: number; score: { score: number; grade: string }; alertsByLevel: { critical: number; warning: number; info: number; other: number } }): string[] {
  const lines: string[] = []
  lines.push(`健康分 ${inputs.score.score}（等级 ${inputs.score.grade}）`)
  lines.push(`窗口内错误率 ${(inputs.errorRate * 100).toFixed(2)}%，未解决问题 ${inputs.issueCount} 个`)
  if (inputs.regressionCount > 0) lines.push(`存在 ${inputs.regressionCount} 个回归问题，需优先排查`)
  if (inputs.alertsByLevel.critical > 0) lines.push(`有 ${inputs.alertsByLevel.critical} 条 critical 告警未处理`)
  return lines
}

function buildRecommendations(inputs: { errorRate: number; issueItems: Array<Record<string, unknown>>; regressionCount: number; perf: Record<string, unknown>; slowApis: Array<Record<string, unknown>> }): Array<{ priority: string; title: string; detail: string; evidence: Array<Record<string, unknown>> }> {
  const recs: Array<{ priority: string; title: string; detail: string; evidence: Array<Record<string, unknown>> }> = []
  if (inputs.errorRate > 0.01) {
    recs.push({
      priority: 'P1',
      title: '错误率高于 1%，建议立即排查 Top 问题',
      detail: `窗口内错误率 ${(inputs.errorRate * 100).toFixed(2)}%，优先处理影响用户最多的未解决问题。`,
      evidence: inputs.issueItems.slice(0, 3).map((issue) => ({ name: str(issue.name), message: clip(str(issue.message), 120), affectedUsers: num(issue.affectedUsers), release: str(issue.release) })),
    })
  }
  if (inputs.regressionCount > 0) {
    recs.push({ priority: 'P1', title: '存在回归问题', detail: '回归通常对应近期发布，建议回滚或紧急修复。', evidence: [] })
  }
  const lcp = numOrNull(inputs.perf.lcp)
  if (lcp !== null && lcp > 2500) {
    recs.push({ priority: 'P2', title: 'LCP 性能待优化', detail: `LCP p75 为 ${lcp}ms，目标 < 2500ms。`, evidence: [] })
  }
  const topApi = inputs.slowApis[0]
  if (topApi && numOrNull(topApi.p75) !== null && num(topApi.p75) > 1000) {
    recs.push({ priority: 'P2', title: '慢接口 Top1 需优化', detail: `接口 ${str(topApi.name)} p75 ${num(topApi.p75)}ms。`, evidence: [topApi] })
  }
  if (recs.length === 0) recs.push({ priority: 'P3', title: '指标平稳', detail: '当前窗口内未发现需要优先处理的异常。', evidence: [] })
  return recs
}

function buildTicketDraft(inputs: { appId: string; window: { startTime: number; endTime: number }; score: { score: number; grade: string }; issueCount: number; alertsByLevel: { critical: number }; issueItems: Array<Record<string, unknown>> }): TicketDraft {
  const critical = inputs.alertsByLevel.critical + inputs.issueItems.filter((i) => str(i.status) === 'regression').length
  const severity: TicketDraft['severity'] = critical > 0 || inputs.score.score < 60 ? 'P1' : inputs.score.score < 75 ? 'P2' : 'P3'
  const topIssue = inputs.issueItems[0]
  return {
    title: `[健康周报] ${inputs.appId || 'default'} ${formatDate(inputs.window.startTime)}~${formatDate(inputs.window.endTime)} 健康分 ${inputs.score.score}(${inputs.score.grade})`,
    severity,
    summary: `未解决问题 ${inputs.issueCount} 个，critical 告警 ${inputs.alertsByLevel.critical} 条，健康分 ${inputs.score.score}（${inputs.score.grade}）。`,
    dedupeKey: `health-weekly:${inputs.appId || 'default'}:${inputs.window.startTime}`,
    labels: ['health-report', 'auto'],
    evidence: topIssue
      ? [{ fingerprint: str(topIssue.fingerprint), name: str(topIssue.name), affectedUsers: num(topIssue.affectedUsers), url: str(topIssue.url) }]
      : [],
    suggestedOwner: '前端稳定性',
  }
}

function pickApp(input: Record<string, unknown>, window: { startTime: number; endTime: number }): Record<string, unknown> {
  return {
    appId: input.appId ? str(input.appId) : undefined,
    release: input.release ? str(input.release) : undefined,
    startTime: window.startTime,
    endTime: window.endTime,
  }
}
