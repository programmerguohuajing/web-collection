import { createRouter, createWebHistory } from 'vue-router'
import Layout from '../layout/index.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
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
        { path: 'sourcemaps', component: () => import('../views/monitor/sourcemaps/index.vue'), meta: { title: 'SourceMap' } },
        { path: 'governance', component: () => import('../views/monitor/governance/index.vue'), meta: { title: '采集治理' } }
      ]
    }
  ]
})
