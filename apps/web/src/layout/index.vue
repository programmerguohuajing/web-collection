<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Aim, Bell, Connection, DataAnalysis, Files, Film, Grid,
  Histogram, House, Monitor, Operation, Search, Stopwatch, Warning
} from '@element-plus/icons-vue'
import { api, error, filters, loading, queryFromFilters, refresh, refreshAll, resetPages, setFiltersFromRoute } from '../dashboard.js'

const route = useRoute()
const router = useRouter()
const applications = ref([])
const dataQueryNames = ['appId', 'release', 'startTime', 'endTime', 'path', 'userId', 'userName', 'userPhone', 'keyword', 'type', 'status']
const groups = [
  { label: '', items: [{ title: '总览', path: '/overview', icon: House }] },
  { label: '监控', items: [
    { title: '错误监控', path: '/errors', icon: Warning },
    { title: '性能监控', path: '/performance', icon: Stopwatch },
    { title: '会话回放', path: '/replays', icon: Film }
  ] },
  { label: '可观测', items: [
    { title: '日志平台', path: '/logs', icon: Files },
    { title: '链路追踪', path: '/traces', icon: Connection }
  ] },
  { label: '产品分析', items: [
    { title: '漏斗分析', path: '/analytics?tab=funnels', match: 'funnels', icon: Histogram },
    { title: '用户路径', path: '/analytics?tab=paths', match: 'paths', icon: Aim },
    { title: '行为分析', path: '/behavior', icon: DataAnalysis }
  ] },
  { label: '配置', items: [
    { title: 'SourceMap', path: '/sourcemaps', icon: Grid },
    { title: '采集治理', path: '/governance', icon: Operation }
  ] }
]

const activeMenu = computed(() => route.path === '/analytics' ? `/analytics?tab=${route.query.tab || 'funnels'}` : route.path)
const routeDataKey = computed(() => JSON.stringify([route.path, ...dataQueryNames.map(name => route.query[name] || '')]))

async function applyGlobalFilters() {
  resetPages()
  const query = { ...route.query }
  for (const name of ['appId', 'release', 'startTime', 'endTime']) delete query[name]
  for (const [name, value] of new URLSearchParams(queryFromFilters({}, ['appId', 'release', 'range']))) query[name] = value
  const target = router.resolve({ path: route.path, query })
  if (target.fullPath === route.fullPath) await refreshAll()
  else await router.replace({ path: route.path, query })
}

async function applyQuickRange(value) {
  if (!value) filters.value.range = []
  else filters.value.range = [Date.now() - Number(value) * 3600000, Date.now()]
  await applyGlobalFilters()
}

function globalSearch() {
  router.push({ path: '/behavior', query: Object.fromEntries(new URLSearchParams(queryFromFilters({}, ['appId', 'release', 'range', 'keyword']))) })
}

onMounted(async () => {
  setFiltersFromRoute(route.query)
  ;[applications.value] = await Promise.all([api('/api/applications'), refresh()])
})
watch(routeDataKey, async () => {
  setFiltersFromRoute(route.query, true)
  await refresh()
})
</script>

<template>
  <div class="app-wrapper">
    <aside class="sidebar-container">
      <div class="sidebar-logo-container">
        <Monitor class="brand-mark" />
        <span>统一观测工作台</span>
      </div>
      <el-scrollbar>
        <el-menu :default-active="activeMenu" router>
          <template v-for="group in groups" :key="group.label">
            <div v-if="group.label" class="menu-group">{{ group.label }}</div>
            <el-menu-item v-for="item in group.items" :key="item.path" :index="item.path">
              <el-icon><component :is="item.icon" /></el-icon>
              <span>{{ item.title }}</span>
            </el-menu-item>
          </template>
        </el-menu>
      </el-scrollbar>
    </aside>

    <section class="main-container">
      <header class="navbar">
        <div class="context-selectors">
          <el-select v-model="filters.appId" clearable placeholder="全部应用" @change="applyGlobalFilters"><el-option v-for="item in applications" :key="item.app_id" :label="item.name || item.app_id" :value="item.app_id" /><el-option label="全部应用" value="" /></el-select>
          <el-select model-value="production" disabled><el-option label="● 生产" value="production" /></el-select>
          <el-input v-model="filters.release" placeholder="全部版本" clearable @change="applyGlobalFilters" />
          <el-select placeholder="最近24小时" @change="applyQuickRange"><el-option label="最近1小时" value="1" /><el-option label="最近24小时" value="24" /><el-option label="最近7天" value="168" /><el-option label="全部时间" value="" /></el-select>
        </div>
        <el-input v-model="filters.keyword" class="global-search" placeholder="搜索行为、埋点关键字..." clearable @keyup.enter="globalSearch">
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
        <div class="navbar-actions"><el-button text circle aria-label="通知"><el-icon><Bell /></el-icon></el-button><el-button :loading="loading" @click="refreshAll">刷新</el-button></div>
      </header>

      <main class="app-main">
        <el-alert v-if="error" class="section" type="error" :title="error" show-icon />
        <router-view />
      </main>
    </section>
  </div>
</template>
