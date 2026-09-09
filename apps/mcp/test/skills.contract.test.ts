import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { TOOL_NAMES } from '../src/skills/toolNames.js'
import { TOOL_INVOKERS } from '../src/skills/toolBridge.js'
import { createSkillRegistry, runSkillById, runSkillTemplate } from '../src/skills/index.js'
import type { DataSource, ListParams, PagedResult } from '../src/datasource/index.js'

function paged(items: unknown[], total = items.length): PagedResult {
  return { items: items as Record<string, unknown>[], total, page: 1, pageSize: items.length || 20 }
}

/** 假的 DataSource：记录调用，并返回与真实后端同构的最小结构，用于离线验证编排与合成逻辑。 */
class FakeDataSource implements DataSource {
  readonly kind = 'fake'
  readonly calls: Array<{ tool: string; params: ListParams }> = []

  private rec(tool: string, params: ListParams) {
    this.calls.push({ tool, params })
    return params
  }

  listEvents(p: ListParams) {
    this.rec('list_events', p)
    return Promise.resolve(paged([{ type: 'error', name: 'boom', message: 'm' }], 1))
  }
  listLogs(p: ListParams) {
    this.rec('list_logs', p)
    return Promise.resolve(paged([]))
  }
  getSummary(p: ListParams) {
    this.rec('get_summary', p)
    return Promise.resolve({
      totalEvents: 1000,
      byType: { error: 50 },
      perf: { lcp: 3000, cls: 0.08, fcp: 1200, ttfb: 200, page_load: 1500 },
      issueCount: 3,
      regressionCount: 0,
      lastSeen: 1_700_000_000_000,
      api: [{ name: '/api/x', p75: 1200, avg: 800, count: 10 }],
      resources: [{ name: 'app.js', p75: 500, count: 5 }],
      issues: [],
    })
  }
  listIssues(p: ListParams) {
    this.rec('list_issues', p)
    return Promise.resolve(
      paged([
        { fingerprint: 'f1', name: 'NullPointer', message: 'x', count: 20, affectedUsers: 500, status: 'unresolved', release: '1.0', url: '/a' },
      ]),
    )
  }
  listReplays(p: ListParams) {
    this.rec('list_replays', p)
    return Promise.resolve(paged([]))
  }
  listAlerts(p: ListParams) {
    this.rec('list_alerts', p)
    return Promise.resolve(paged([{ level: 'critical', message: 'a' }]))
  }
  listTraces(p: ListParams) {
    this.rec('list_traces', p)
    return Promise.resolve({})
  }
  getAnalyticsSessions(p: ListParams) {
    this.rec('get_analytics_sessions', p)
    return Promise.resolve({})
  }
  getAnalyticsPaths(p: ListParams) {
    this.rec('get_analytics_paths', p)
    return Promise.resolve({})
  }
  getAnalyticsClickPaths(p: ListParams) {
    this.rec('get_analytics_click_paths', p)
    return Promise.resolve({})
  }
  getAnalyticsHeatmap(p: ListParams) {
    this.rec('get_analytics_heatmap', p)
    return Promise.resolve({})
  }
  getAnalyticsLive(p: ListParams) {
    this.rec('get_analytics_live', p)
    return Promise.resolve({ sessions: 1, users: 1, events: 1 })
  }
  listAlertChannels(p: ListParams) {
    this.rec('list_alert_channels', p)
    return Promise.resolve({})
  }
}

test('TOOL_INVOKERS 覆盖全部 TOOL_NAMES，且与 registerTools 源保持一致', () => {
  assert.equal(Object.keys(TOOL_INVOKERS).length, TOOL_NAMES.length)
  const registerSrc = readFileSync('./src/tools/registerTools.ts', 'utf8')
  for (const name of TOOL_NAMES) {
    assert.ok(registerSrc.includes(`'${name}'`), `registerTools.ts 必须注册既有工具 ${name}`)
  }
})

test('createSkillRegistry 默认注册 health_weekly_report 与 incident_triage', () => {
  const registry = createSkillRegistry()
  const ids = registry.list().map((t) => t.id)
  assert.ok(ids.includes('health_weekly_report'))
  assert.ok(ids.includes('incident_triage'))
})

test('health_weekly_report 编排既有工具并产出结构化健康分 + 工单草案', async () => {
  const ds = new FakeDataSource()
  const registry = createSkillRegistry()
  const result = await runSkillById(registry, ds, 'health_weekly_report', { appId: 'default' })

  assert.equal(result.status, 'ok')
  assert.equal(result.templateId, 'health_weekly_report')
  // 必选步骤全部执行
  const executed = result.steps.filter((s) => s.status === 'ok').map((s) => s.tool)
  assert.ok(executed.includes('get_summary'))
  assert.ok(executed.includes('list_issues'))
  assert.ok(executed.includes('list_alerts'))
  assert.ok(executed.includes('get_analytics_live'))

  const report = result.result as Record<string, any>
  assert.equal(typeof report.healthScore.score, 'number')
  assert.ok(['A', 'B', 'C', 'D'].includes(report.healthScore.grade))
  assert.equal(report.overview.totalEvents, 1000)
  assert.equal(report.topIssues.length, 1)
  assert.ok(report.ticketDraft && report.ticketDraft.dedupeKey.startsWith('health-weekly:'))
  assert.ok(Array.isArray(report.recommendations))
})

test('incident_triage 定位问题、采样证据并产出工单草案', async () => {
  const ds = new FakeDataSource()
  const registry = createSkillRegistry()
  const result = await runSkillById(registry, ds, 'incident_triage', { keyword: 'NullPointer', appId: 'default' })

  assert.equal(result.status, 'ok')
  const triage = result.result as Record<string, any>
  assert.ok(triage.matchedIssue && triage.matchedIssue.fingerprint === 'f1')
  assert.ok(Array.isArray(triage.evidence) && triage.evidence.length >= 1)
  assert.ok(['P0', 'P1', 'P2', 'P3'].includes(triage.ticketDraft.severity))
})

test('可选步骤失败时整体降级为 partial 而非失败', async () => {
  const ds = new FakeDataSource()
  // 让 get_analytics_live 抛错以模拟可选步骤失败
  ds.getAnalyticsLive = () => Promise.reject(new Error('live down'))
  const registry = createSkillRegistry()
  const result = await runSkillById(registry, ds, 'health_weekly_report', {})

  assert.equal(result.status, 'partial')
  const liveStep = result.steps.find((s) => s.tool === 'get_analytics_live')
  assert.equal(liveStep?.status, 'failed')
  assert.ok(result.warnings.length > 0)
  assert.ok((result.result as Record<string, unknown>) !== null)
})

test('未知模板 id 返回结构化失败，不抛异常', async () => {
  const ds = new FakeDataSource()
  const registry = createSkillRegistry()
  const result = await runSkillById(registry, ds, 'no_such_template', {})
  assert.equal(result.status, 'failed')
  assert.ok(result.error && result.error.includes('no_such_template'))
})

test('必选步骤失败则整体失败，不产出半截结论', async () => {
  const ds = new FakeDataSource()
  ds.getSummary = () => Promise.reject(new Error('summary boom'))
  const registry = createSkillRegistry()
  const result = await runSkillTemplate(ds, registry.get('health_weekly_report')!, {})
  assert.equal(result.status, 'failed')
  assert.equal(result.result, null)
})
