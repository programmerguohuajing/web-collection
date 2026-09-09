import { createRouter, createWebHistory } from 'vue-router'
import Layout from '../layout/index.vue'

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
        { path: 'knowledge', component: () => import('../views/monitor/knowledge/index.vue'), meta: { title: '知识库' } },
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
