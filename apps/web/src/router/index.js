import { createRouter, createWebHistory } from 'vue-router'
import Layout from '../layout/index.vue'
import Overview from '../views/monitor/overview/index.vue'
import Errors from '../views/monitor/errors/index.vue'
import Performance from '../views/monitor/performance/index.vue'
import Behavior from '../views/monitor/behavior/index.vue'
import Replays from '../views/monitor/replays/index.vue'
import Events from '../views/monitor/events/index.vue'
import SourceMaps from '../views/monitor/sourcemaps/index.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      component: Layout,
      redirect: '/overview',
      children: [
        { path: 'overview', component: Overview, meta: { title: '总览' } },
        { path: 'errors', component: Errors, meta: { title: '错误监控' } },
        { path: 'performance', component: Performance, meta: { title: '性能监控' } },
        { path: 'behavior', component: Behavior, meta: { title: '行为埋点' } },
        { path: 'replays', component: Replays, meta: { title: '会话回放' } },
        { path: 'events', component: Events, meta: { title: '事件流' } },
        { path: 'sourcemaps', component: SourceMaps, meta: { title: 'SourceMap' } }
      ]
    }
  ]
})
