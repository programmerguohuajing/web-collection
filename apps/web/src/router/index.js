import { createRouter, createWebHistory } from 'vue-router'
import Layout from '../layout/index.vue'
import { useAuth } from '../composables/useAuth'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    // A2 看板分享：顶层嵌入页（不套 Layout，供第三方 iframe 引用）
    { path: '/embed/dashboard/:token', component: () => import('../views/embed/DashboardEmbed.vue'), meta: { title: '仪表盘分享' } },
    // D2 账号体系：顶层登录页（不套 Layout）
    { path: '/login', component: () => import('../views/login/index.vue'), meta: { title: '登录' } },
    // D2 账号体系：顶层团队管理控制台（不套 Layout）
    { path: '/teams', component: () => import('../views/teams/index.vue'), meta: { title: '团队管理' } },
    {
      path: '/',
      component: Layout,
      redirect: '/overview',
      children: [
        { path: 'overview', component: () => import('../views/monitor/overview/index.vue'), meta: { title: '总览' } },
        { path: 'errors', component: () => import('../views/monitor/errors/index.vue'), meta: { title: '错误监控' } },
        { path: 'performance', component: () => import('../views/monitor/performance/index.vue'), meta: { title: '性能监控' } },
        { path: 'behavior', component: () => import('../views/monitor/behavior/index.vue'), meta: { title: '行为分析' } },
        { path: 'replays', component: () => import('../views/monitor/replays/index.vue'), meta: { title: '会话回放' } },
        { path: 'events', redirect: '/behavior' },
        { path: 'logs', component: () => import('../views/monitor/logs/index.vue'), meta: { title: '日志平台' } },
        { path: 'traces', component: () => import('../views/monitor/traces/index.vue'), meta: { title: '链路追踪' } },
        { path: 'analytics', component: () => import('../views/monitor/analytics/index.vue'), meta: { title: '产品分析' } },
        { path: 'api-health', component: () => import('../views/monitor/api-health/index.vue'), meta: { title: 'API 健康' } },
        { path: 'integrations', component: () => import('../views/monitor/integrations/index.vue'), meta: { title: '集成中心' } },
        { path: 'slo', component: () => import('../views/monitor/slo/index.vue'), meta: { title: 'SLO 错误预算' } },
        { path: 'slo/:id', component: () => import('../views/monitor/slo/detail.vue'), meta: { title: 'SLO 详情' } },
        { path: 'synthetic', component: () => import('../views/monitor/synthetic/index.vue'), meta: { title: '合成监控' } },
        { path: 'synthetic/:id', component: () => import('../views/monitor/synthetic/detail.vue'), meta: { title: '探针详情' } },
        // D1 · 数据主体权利 DSR（PRD 13）：合规工单列表 + 详情
        { path: 'dsr', component: () => import('../views/compliance/dsr/index.vue'), meta: { title: '合规 DSR' } },
        { path: 'dsr/:id', component: () => import('../views/compliance/dsr/detail.vue'), meta: { title: 'DSR 工单详情' } },
        // A3 · 实验分析（PRD 14）：实验列表 + 详情/分析（能力位 false 时页面显式占位，不静默隐藏路由）
        { path: 'experiments', component: () => import('../views/experiment/index.vue'), meta: { title: '实验分析' } },
        { path: 'experiments/:id', component: () => import('../views/experiment/detail.vue'), meta: { title: '实验详情' } },
        { path: 'sdk-health', component: () => import('../views/monitor/sdk-health/index.vue'), meta: { title: 'SDK 健康' } },
        { path: 'sourcemaps', component: () => import('../views/monitor/sourcemaps/index.vue'), meta: { title: 'SourceMap' } },
        { path: 'governance', component: () => import('../views/monitor/governance/index.vue'), meta: { title: '采集治理' } },
        { path: 'settings', component: () => import('../views/monitor/settings/index.vue'), meta: { title: '系统设置' } },
        // D3 · 用量计量 & 套餐（PRD 15）：能力位 false 时页面显式占位，不静默隐藏路由
        { path: 'usage', component: () => import('../views/billing/index.vue'), meta: { title: '用量与套餐' } },
        // D4 · 白标 / 私有化（PRD 16）：能力位 false 时页面显式占位
        { path: 'brand', component: () => import('../views/brand/index.vue'), meta: { title: '品牌白标' } },
        { path: 'ai-settings', component: () => import('../views/monitor/ai-settings/index.vue'), meta: { title: 'AI 诊断' } },
        { path: 'ai-assistant', component: () => import('../views/monitor/ai-assistant/index.vue'), meta: { title: 'AI 助手' } },
        { path: 'ai-insights', component: () => import('../views/insight/ai-insights/index.vue'), meta: { title: 'AI 洞察' } },
        { path: 'knowledge', component: () => import('../views/monitor/knowledge/index.vue'), meta: { title: '知识中枢' } },
        { path: 'help', component: () => import('../views/monitor/knowledge/help.vue'), meta: { title: '帮助中心' } },
      { path: 'alerts', component: () => import('../pages/AlertsPage.vue'), meta: { title: '告警中心' } },
      { path: 'live', component: () => import('../pages/LivePage.vue'), meta: { title: '实时监控' } },
      { path: 'sessions', component: () => import('../pages/SessionsPage.vue'), meta: { title: '用户会话' } },
      { path: 'releases', component: () => import('../pages/ReleasesPage.vue'), meta: { title: '发布管理' } },
      { path: 'paths', component: () => import('../pages/PathsPage.vue'), meta: { title: '用户路径' } },
      { path: 'journey', component: () => import('../views/insight/journey/index.vue'), meta: { title: '用户链路' } },
      { path: 'funnels', component: () => import('../views/insight/funnels/index.vue'), meta: { title: '漏斗分析' } },
      { path: 'retention', component: () => import('../views/insight/retention/index.vue'), meta: { title: '留存分析' } },
      { path: 'dictionary', component: () => import('../views/governance/dictionary/index.vue'), meta: { title: '事件字典' } },
      { path: 'access-levels', component: () => import('../views/settings/access-levels/index.vue'), meta: { title: '成员与数据等级' } }
      ]
    }
  ]
})

/**
 * D2 账号体系：全站登录守卫（此前缺失，导致 accounts 开启后仍可匿名浏览全部页面）。
 *
 * - accounts 能力位关闭（存量自托管默认）→ 完全放行，行为零变化。
 * - accounts 开启 → 除公开路由（登录页 / 看板分享嵌入页）外，
 *   未登录一律跳转 /login 并携带 ?redirect= 原目标（登录页 goAway 消费，登录后回跳）。
 *
 * 能力位来自 GET /api/capabilities（公开端点；loadCapabilities 模块级 Promise 缓存，
 * 仅首次导航发一次请求，后续导航零开销）。能力位拉取失败按未开启处理，避免把用户锁在门外。
 */
const PUBLIC_PATHS = new Set(['/login'])
const PUBLIC_PREFIXES = ['/embed/']

router.beforeEach(async (to) => {
  const { loadCapabilities, accountsEnabled, isLoggedIn, loadMe, me } = useAuth()
  try {
    await loadCapabilities()
  } catch {
    /* 能力位拉取失败：按未开启处理，避免误锁 */
  }
  if (!accountsEnabled.value) return true
  if (PUBLIC_PATHS.has(to.path) || PUBLIC_PREFIXES.some(prefix => to.path.startsWith(prefix))) return true

  const toLogin = to.fullPath && to.fullPath !== '/'
    ? { path: '/login', query: { redirect: to.fullPath } }
    : { path: '/login' }
  if (!isLoggedIn.value) return toLogin
  // 有令牌但用户信息未加载：校验一次；仅当令牌确定失效（401）才回登录页，瞬时错误放行避免误踢
  if (!me.value) {
    try {
      await loadMe()
    } catch (err) {
      if (err?.status === 401) return toLogin
    }
  }
  return true
})
