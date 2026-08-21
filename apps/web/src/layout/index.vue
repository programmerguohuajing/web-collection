<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Aim, Bell, Connection, DataAnalysis, Files, Film, Fold, Grid,
  Histogram, House, Menu, Monitor, Operation, Setting, Stopwatch, User, Warning, MagicStick
} from '@element-plus/icons-vue'
import { api, error, loading, normalizePageResponse, refresh, refreshAll, resetPages, resetPageFilters, applyRoutePrefill, pageLoading, slowRequest } from '../dashboard.js'
import { useFilterStore } from '../stores/filters.js'
import { useDiagnosisStore } from '../stores/diagnosis.js'
import PageLoading from '../components/PageLoading.vue'
import AiDiagnosisDrawer from '../components/AiDiagnosisDrawer.vue'

const route = useRoute()
const router = useRouter()
const store = useFilterStore()
const diagnosisStore = useDiagnosisStore()
const applications = ref([])
const menuOpen = ref(false)
const aiDrawerOpen = ref(false)
const aiDrawerRef = ref(null)

function toggleMenu() { menuOpen.value = !menuOpen.value }
function closeMenu() { menuOpen.value = false }
function navigate(path) { closeMenu(); router.push(path) }

watch(() => route.query, () => {
  resetPageFilters()
  applyRoutePrefill(route.query)
}, { immediate: true })

const groups = [
  { label: '', items: [{ title: '总览看板', path: '/overview', icon: House }] },
  { label: '监控', items: [
    { title: '告警中心', path: '/alerts', icon: Bell },
    { title: '实时监控', path: '/live', icon: Monitor },
    { title: '错误监控', path: '/errors', icon: Warning },
    { title: '性能分析', path: '/performance', icon: Stopwatch },
    { title: '会话回放', path: '/replays', icon: Film }
  ] },
  { label: '可观测', items: [
    { title: '日志平台', path: '/logs', icon: Files },
    { title: '链路追踪', path: '/traces', icon: Connection }
  ] },
  { label: '洞察', items: [
    { title: '行为分析', path: '/behavior', icon: Histogram },
    { title: '产品分析', path: '/analytics', icon: DataAnalysis },
    { title: '用户会话', path: '/sessions', icon: User },
    { title: '用户路径', path: '/paths', icon: Aim },
    { title: '发布管理', path: '/releases', icon: Operation }
  ] },
  { label: '配置', items: [
    { title: 'SourceMap', path: '/sourcemaps', icon: Grid },
    { title: '采集治理', path: '/governance', icon: Operation },
    { title: '系统设置', path: '/settings', icon: Setting }
  ] }
]

const currentTitle = computed(() => {
  for (const group of groups) {
    const item = group.items.find(entry => entry.path === route.path)
    if (item) return item.title
  }
  return 'Web Collection'
})

async function applyGlobal() {
  resetPages()
  await refreshAll()
}

const quickRange = ref('24')

async function applyQuickRange(value) {
  quickRange.value = (value === undefined || value === null) ? quickRange.value : String(value)
  store.range = !quickRange.value ? [] : [Date.now() - Number(quickRange.value) * 3600000, Date.now()]
  await applyGlobal()
}

onMounted(async () => {
  // ADR-006：深链 ?traceId= 写入全局诊断上下文（applyRoutePrefill 已把深链写入 filters.traceId）
  if (route.query.traceId) diagnosisStore.setTrace(route.query.traceId)
  try {
    const [applicationData] = await Promise.all([
      api('/api/applications', { requestKey: 'layout:applications' }),
      refresh()
    ])
    const normalized = normalizePageResponse(applicationData)
    applications.value = normalized.items.map(item => ({
      ...item,
      app_id: item.app_id || item.appId || '',
      name: item.name || item.appName || item.app_id || item.appId || '-'
    }))
  } catch (loadError) {
    if (loadError?.code !== 'ABORT_ERR') error.value = loadError.message || '应用列表加载失败'
  }
})
</script>

<template>
  <div class="app-wrapper">
    <button class="mobile-menu-btn" type="button" aria-label="打开导航" @click="toggleMenu">
      <el-icon><component :is="menuOpen ? Fold : Menu" /></el-icon>
    </button>

    <!-- ADR-006：全局 AI 诊断 FAB，任何页面常驻可见 -->
    <button class="ai-fab" type="button" aria-label="AI 诊断" @click="aiDrawerOpen = true">
      <el-icon><MagicStick /></el-icon>
    </button>

    <div v-if="menuOpen" class="mobile-menu-overlay" @click.self="closeMenu">
      <aside class="mobile-sidebar">
        <div class="sidebar-brand">
          <span class="brand-logo">WC</span>
          <span><strong>Web Collection</strong><small>前端遥测平台</small></span>
        </div>
        <nav class="sidebar-nav" aria-label="主导航">
          <template v-for="group in groups" :key="group.label || 'overview'">
            <div v-if="group.label" class="menu-group">{{ group.label }}</div>
            <button v-for="item in group.items" :key="item.path" type="button" class="nav-item" :class="{ active: route.path === item.path }" @click="navigate(item.path)">
              <el-icon><component :is="item.icon" /></el-icon><span>{{ item.title }}</span>
            </button>
          </template>
        </nav>
      </aside>
    </div>

    <aside class="desktop-only sidebar-container">
      <div class="sidebar-brand">
        <span class="brand-logo">WC</span>
        <span><strong>Web Collection</strong><small>前端遥测平台</small></span>
      </div>
      <el-scrollbar class="sidebar-scroll">
        <nav class="sidebar-nav" aria-label="主导航">
          <template v-for="group in groups" :key="group.label || 'overview'">
            <div v-if="group.label" class="menu-group">{{ group.label }}</div>
            <button v-for="item in group.items" :key="item.path" type="button" class="nav-item" :class="{ active: route.path === item.path }" @click="router.push(item.path)">
              <el-icon><component :is="item.icon" /></el-icon><span>{{ item.title }}</span>
            </button>
          </template>
        </nav>
      </el-scrollbar>
      <div class="sidebar-foot">Web Collection · 前端遥测平台</div>
    </aside>

    <section class="main-container">
      <header class="navbar">
        <div class="topbar-title">
          <h1>{{ currentTitle }}</h1>
          <div class="sub">实时遥测</div>
        </div>
        <div class="topbar-spacer" />
        <div class="context-selectors" aria-label="全局筛选">
          <el-select v-model="store.appId" clearable placeholder="全部应用" @change="applyGlobal">
            <el-option v-for="item in applications" :key="item.app_id" :label="item.name || item.app_id" :value="item.app_id" />
            <el-option label="全部应用" value="" />
          </el-select>
          <el-input v-model="store.release" placeholder="全部版本" clearable @change="applyGlobal" />
          <el-select v-model="quickRange" placeholder="最近24小时" @change="applyQuickRange">
            <el-option label="最近1小时" value="1" />
            <el-option label="最近24小时" value="24" />
            <el-option label="最近7天" value="168" />
            <el-option label="最近30天" value="720" />
            <el-option label="最近90天" value="2160" />
            <el-option label="全部时间" value="" />
          </el-select>
        </div>
        <div class="navbar-actions">
          <el-button text circle aria-label="通知"><el-icon><Bell /></el-icon></el-button>
          <el-button class="refresh-button" :loading="loading" @click="refreshAll">刷新</el-button>
          <span v-if="store.environment" class="environment-pill" :title="`当前采集环境：${store.environment}`"><i />{{ store.environment }}</span>
          <span class="user-avatar" aria-label="当前用户">运</span>
        </div>
      </header>

      <main class="app-main content" tabindex="-1">
        <div class="content-inner">
          <el-alert v-if="slowRequest" class="section slow-request-alert" type="warning" title="接口响应较慢，仍在加载中，请稍候…" :closable="false" show-icon />
          <el-alert v-if="error" class="section" type="error" :title="error" show-icon />
          <div class="router-view-frame"><router-view /><PageLoading :active="pageLoading" /></div>
        </div>
      </main>
    </section>

    <AiDiagnosisDrawer v-model="aiDrawerOpen" />
  </div>
</template>
