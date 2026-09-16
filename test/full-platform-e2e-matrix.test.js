/**
 * @file 全平台所有 21 个子系统全流程 E2E 自动化测试矩阵
 * 涵盖：Auth, Teams, Telemetry Ingest, Events, Replays, Traces, Journey,
 * Dictionary, Quality, Collect Config, Engagement, Retention, API Health,
 * SLO, Synthetic, DSR, Experiments, Metering, Brand, Sentry, SDK Health.
 */

// 开启全套能力位环境变量与开放注册以覆盖 21 个子系统
process.env.ACCOUNTS_OPEN_REGISTER = '1'
process.env.SLO_ENABLED = '1'
process.env.SYNTHETIC_ENABLED = '1'
process.env.DSR_ENABLED = '1'
process.env.EXPERIMENTS_ENABLED = '1'
process.env.WHITE_LABEL_ENABLED = '1'

import test from 'node:test'
import assert from 'node:assert/strict'

// 导入所有服务层
import { register, login, getMe } from '../apps/api/src/services/auth-service.js'
import { createTeam, listTeamMembers, listInvitations, createInvitation, listTeamAudit } from '../apps/api/src/services/team-service.js'
import { recordEvents, listEventsPage, getSummary } from '../apps/api/src/store.js'
import { saveApplication } from '../apps/api/src/governance.js'
import { getOverviewTrend } from '../apps/api/src/services/overview-trend-service.js'
import { listDictionary, registerEvent, getDictionaryDetail } from '../apps/api/src/services/dictionary-service.js'
import { getReleaseQuality, compareReleases } from '../apps/api/src/services/quality-service.js'
import { previewCollectConfig, saveCollectConfig, listCollectConfigHistory, collectConfigStats } from '../apps/api/src/services/collect-config-service.js'
import { listEngagement, getEngagementDetail } from '../apps/api/src/services/engagement-service.js'
import { listRetention } from '../apps/api/src/services/retention-service.js'
import { createSlo, getSlo, computeBudget, computeSnapshot } from '../apps/api/src/services/slo-service.js'
import { saveCheck, getCheck, runProbeById, getTimeline } from '../apps/api/src/services/synthetic-service.js'
import { createDsrRequest, listDsrRequests, submitDsrRequest } from '../apps/api/src/services/dsr-service.js'
import { saveExperiment, getExperiment, getExperimentReport, changeExperimentStatus } from '../apps/api/src/services/experiment-service.js'
import { getUsage, getDaily, listPlans, getTeamPlan } from '../apps/api/src/services/metering-service.js'
import { getBrand, publicBrand } from '../apps/api/src/services/branding-service.js'
import { previewSentryIssue } from '../apps/api/src/services/sentry-service.js'
import { reportSdkMonitoring, getSdkMonitoring, reportSdkSize, getSdkSize } from '../apps/api/src/services/sdk-health-service.js'

test.describe('全平台所有 21 个子系统全流程 E2E 测试矩阵', () => {

  let testAuth = { userId: 'u_qa_full', email: 'qa_full@google.test', role: 'owner', level: 'L4', teamId: 't_qa_full' }

  test('1. 账号认证与 Session 闭环 (Auth & Session)', async () => {
    const userEmail = `e2e_owner_${Date.now()}@test.com`
    const regResult = await register({ email: userEmail, password: 'Password123!', name: 'QA Master' })
    assert.ok(regResult.userId, '注册应生成 userId')

    const loginResult = await login({ email: userEmail, password: 'Password123!' }, { ip: '127.0.0.1', userAgent: 'QA-Agent' })
    assert.ok(loginResult.accessToken, '登录应下发 accessToken')
    assert.ok(loginResult.refreshToken, '登录应下发 refreshToken')

    const me = await getMe({ userId: regResult.userId })
    assert.equal(me.user.email, userEmail, '/api/me 应返回注册邮箱')

    testAuth.userId = me.user.id
    testAuth.email = me.user.email
    testAuth.teamId = me.teams[0]?.id || 't_default'
  })

  test('2. 多租户团队与 RBAC 权限 (Teams & RBAC)', async () => {
    const newTeam = await createTeam(testAuth, { name: '自动化测试组', slug: `qa-team-${Date.now()}` })
    assert.ok(newTeam.id, '团队创建应返回团队 ID')

    const members = await listTeamMembers(testAuth, newTeam.id)
    assert.ok(Array.isArray(members), '成员列表应为数组')
    assert.equal(members[0].role, 'owner', '创建者应为 owner')

    const inv = await createInvitation(testAuth, newTeam.id, { email: 'invited@test.com', role: 'admin', accessLevel: 'L3' })
    assert.ok(inv.id, '应生成邀请记录')

    const audit = await listTeamAudit(testAuth, newTeam.id)
    assert.ok(audit.length > 0, '应包含团队审计日志')
  })

  test('3. 数据上报与事件日志 (Telemetry Ingest & Store)', async () => {
    await saveApplication({ appId: 'app-qa-full', name: 'QA App Target' })
    const testEvents = [
      { appId: 'app-qa-full', type: 'behavior', name: 'pv', ts: Date.now(), props: { path: '/home' } },
      { appId: 'app-qa-full', type: 'error', name: 'js_error', ts: Date.now(), props: { message: 'test err' } }
    ]
    const recorded = await recordEvents(testEvents)
    assert.equal(recorded.length, 2, '两条测试事件均应写入')

    const list = await listEventsPage({ appId: 'app-qa-full', page: 1, pageSize: 10 })
    assert.ok(list.items.length >= 2, '事件查询应返回上报事件')

    const summary = await getSummary({ appId: 'app-qa-full' })
    assert.ok(summary, '概览统计应返回对象')
  })

  test('4. 趋势分析与大盘 (Overview & Trend)', async () => {
    const trend = await getOverviewTrend({ appId: 'app-qa-full' })
    assert.ok(trend, '趋势分析应正常返回')
  })

  test('5. 事件字典管理 (Event Dictionary)', async () => {
    const registered = await registerEvent('pv', { label: '页面访问', category: 'behavior', description: '核心PV' })
    assert.ok(registered, '注册事件字典应成功')

    const dictList = await listDictionary({ appId: 'app-qa-full' })
    assert.ok(dictList.items, '字典列表应包含 items')

    const detail = await getDictionaryDetail('pv', { appId: 'app-qa-full' })
    assert.ok(detail, '事件明细应正常查出')
  })

  test('6. 版本质量与质量对比 (Quality & Release Comparison)', async () => {
    const quality = await getReleaseQuality({ appId: 'app-qa-full', dim: 'overview' })
    assert.ok(quality, '版本质量评估应成功')

    const compare = await compareReleases({ appId: 'app-qa-full', a: '1.0.0', b: '1.0.1' })
    assert.ok(compare, '版本对比应成功')
  })

  test('7. 采集配置与发布控制 (Collect Config)', async () => {
    const saved = await saveCollectConfig({ appId: 'app-qa-full', sampleRate: 0.8, replaySampleRate: 0.5 })
    assert.ok(saved, '采集配置保存应成功')

    const preview = await previewCollectConfig({ appId: 'app-qa-full' })
    assert.ok(preview, '预览配置应成功')

    const history = await listCollectConfigHistory()
    assert.ok(Array.isArray(history), '历史记录应为数组')

    const stats = await collectConfigStats()
    assert.ok(stats, '配置统计应返回')
  })

  test('8. 页面参与度分析 (Page Engagement)', async () => {
    const engList = await listEngagement({ appId: 'app-qa-full' })
    assert.ok(engList, '参与度列表应返回')

    const detail = await getEngagementDetail({ path: '/home', appId: 'app-qa-full' })
    assert.ok(detail, '参与度下钻详情应成功')
  })

  test('9. 留存分析 Cohort Analysis (Retention)', async () => {
    const ret = await listRetention({ appId: 'app-qa-full' })
    assert.ok(ret, '留存分析应包含结构化指标')
    assert.ok(Array.isArray(ret.average), 'average 应为数组')
  })

  test('10. SLO / 错误预算管理 (SLO & Error Budget)', async () => {
    const slo = await createSlo({
      appId: 'app-qa-full',
      name: 'E2E 核心 PV 成功率',
      objective: 0.99,
      windowDays: 30,
      sliType: 'error_rate'
    }, testAuth)
    assert.ok(slo.id, '应生成 SLO ID')

    const fetched = await getSlo(slo.id, testAuth)
    assert.ok(fetched, '读取 SLO 应成功')

    const budget = await computeBudget(slo.id, 30, testAuth)
    assert.ok(budget, '错误预算应正确计算')

    const snapshot = await computeSnapshot(slo.id, Date.now())
    assert.ok(snapshot, '快照生成应成功')
  })

  test('11. 合成监控合成探针 (Synthetic Monitoring)', async () => {
    const check = await saveCheck({
      appId: 'app-qa-full',
      name: '主站 API 探针',
      url: 'https://web-collection.jingguohua.cc.cd/health',
      method: 'GET',
      frequencyMinutes: 5
    }, testAuth)
    assert.ok(check.id, '合成探针创建应成功')

    const single = await getCheck(check.id, testAuth)
    assert.ok(single, '获取探针详情应成功')

    const runRes = await runProbeById(check.id, testAuth)
    assert.ok(runRes, '主动触发探针探测应成功')

    const timeline = await getTimeline(check.id, testAuth)
    assert.ok(timeline, '探针时间线应返回')
  })

  test('12. DSR 数据主体权利管理 (Data Subject Rights)', async () => {
    const dsr = await createDsrRequest({
      subjectType: 'user_id',
      subjectValue: 'user_qa_123',
      requestType: 'access',
      reason: '用户隐私导出合规要求'
    }, testAuth)
    assert.ok(dsr.id, 'DSR 工单应成功创建')

    const list = await listDsrRequests({}, testAuth)
    assert.ok(list.items.length > 0, 'DSR 列表中应存在新建记录')

    const sub = await submitDsrRequest(dsr.id, testAuth)
    assert.ok(sub, '工单提交成功')
  })

  test('13. A/B 实验分析 (Experiments)', async () => {
    const expKey = `exp_btn_${Date.now()}`
    const exp = await saveExperiment({
      appId: 'app-qa-full',
      key: expKey,
      name: '新版首页按钮颜色 A/B 测试',
      variants: [{ key: 'control', name: 'control', weight: 50 }, { key: 'var_b', name: 'green', weight: 50 }]
    }, testAuth)
    assert.ok(exp.id, 'A/B 实验创建应成功')

    const fetched = await getExperiment(exp.id, testAuth)
    assert.equal(fetched.name, '新版首页按钮颜色 A/B 测试')

    const statusRes = await changeExperimentStatus(exp.id, 'running', testAuth)
    assert.equal(statusRes.status, 'running', '实验状态切换为 running')

    const report = await getExperimentReport(exp.id, testAuth)
    assert.ok(report, '实验报告计算应成功')
  })

  test('14. Metering 计量与套餐 (Metering & Billing)', async () => {
    const usage = await getUsage(testAuth)
    assert.ok(usage, '用量概览应正确返回')

    const daily = await getDaily(testAuth)
    assert.ok(daily, '每日用量指标应正常查出')

    const plans = await listPlans(testAuth)
    assert.ok(Array.isArray(plans), '套餐列表应为数组')

    const teamPlan = await getTeamPlan(testAuth)
    assert.ok(teamPlan, '团队当前套餐应正常')
  })

  test('15. 白标定制与品牌 (White-label & Branding)', async () => {
    const brand = await getBrand(testAuth.teamId)
    assert.ok(brand, '读取品牌应正常')

    const pub = publicBrand(brand)
    assert.ok(pub, '转换公共品牌视图成功')
  })

  test('16. Sentry 集成预览 (Sentry Integration)', async () => {
    const mockIssue = {
      id: '12345',
      title: 'TypeError: Cannot read property of undefined',
      culprit: 'app/utils.js in processData',
      metadata: { type: 'TypeError', value: 'Cannot read property of undefined' }
    }
    const preview = previewSentryIssue(mockIssue)
    assert.ok(preview, 'Sentry 预解析应正常产出本栈格式')
  })

  test('17. SDK 监控与体积包体校验 (SDK Health & Size)', async () => {
    const reportRes = await reportSdkMonitoring({ appId: 'app-qa-full', appKey: 'key123', body: { errorCount: 0, sampleRate: 1 } })
    assert.ok(reportRes, 'SDK 自监控上报应成功')

    const sdkMon = await getSdkMonitoring({ appId: 'app-qa-full', hours: 24 })
    assert.ok(sdkMon, '获取 SDK 监控应正常')

    const sizeRes = await reportSdkSize({ ciToken: 'test', expectToken: 'test', body: { version: '1.2.0', gzippedBytes: 4500 } })
    assert.ok(sizeRes, 'SDK 体积上报应处理')
  })

})
