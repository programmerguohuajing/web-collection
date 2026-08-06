<script setup>
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Aim, Bell, Connection, DataAnalysis, Files, Film, Fold, Grid,
  Histogram, House, Menu, Monitor, Operation, Stopwatch, User, Warning
} from '@element-plus/icons-vue'
import { api, error, loading, refresh, refreshAll, resetPages, resetPageFilters, applyRoutePrefill, pageLoading } from '../dashboard.js'
import { useFilterStore } from '../stores/filters.js'

const route = useRoute()
const router = useRouter()
const store = useFilterStore()
const applications = ref([])
const menuOpen = ref(false)

function toggleMenu() { menuOpen.value = !menuOpen.value }
function closeMenu() { menuOpen.value = false }
function navigate(path) { closeMenu(); router.push(path) }
/** 监听路由变化，将 URL query 参数（如 traceId）预填到页面搜索条件中 */
watch(() => route.query, () => {
  resetPageFilters()
  applyRoutePrefill(route.query)
}, { immediate: true })
const groups = [
  { label: '', items: [{ title: '总览', path: '/overview', icon: House }] },
  { label: '监控', items: [
    { title: '告警中心', path: '/alerts', icon: Bell },
    { title: '实时监控', path: '/live', icon: Monitor },
    { title: '错误监控', path: '/errors', icon: Warning },
    { title: '性能监控', path: '/performance', icon: Stopwatch },
    { title: '会话回放', path: '/replays', icon: Film }
  ] },
  { label: '可观测', items: [
    { title: '日志平台', path: '/logs', icon: Files },
    { title: '链路追踪', path: '/traces', icon: Connection }
  ] },
  { label: '洞察', items: [
    { title: '用户会话', path: '/sessions', icon: User },
    { title: '用户路径', path: '/paths', icon: Aim },
    { title: '发布管理', path: '/releases', icon: Operation }
  ] },
  { label: '配置', items: [
    { title: 'SourceMap', path: '/sourcemaps', icon: Grid },
    { title: '采集治理', path: '/governance', icon: Operation }
  ]}
]

// 顶部条件切换（应用 / 版本 / 时间范围）统一走 Pinia store，不再写入地址栏。
async function applyGlobal() {
  resetPages()
  await refreshAll()
}

async function applyQuickRange(value) {
  store.range = !value ? [] : [Date.now() - Number(value) * 3600000, Date.now()]
  await applyGlobal()
}

onMounted(async () => {
  ;[applications.value] = await Promise.all([api('/api/applications'), refresh()])
})
</script>

<template>
  <div class="app-wrapper">
    <!-- 移动端菜单入口按钮 -->
    <button class="mobile-menu-btn" @click="toggleMenu">
      <el-icon><component :is="menuOpen ? Fold : Menu" /></el-icon>
    </button>

    <!-- 移动端遮罩菜单 -->
    <div v-if="menuOpen" class="mobile-menu-overlay" @click.self="closeMenu">
      <aside class="mobile-sidebar">
        <div class="sidebar-logo-container">
          <Monitor class="brand-mark" />
          <span class="logo-text">统一观测工作台</span>
        </div>
        <nav class="sidebar-nav">
          <template v-for="group in groups" :key="group.label">
            <div v-if="group.label" class="menu-group">{{ group.label }}</div>
            <div v-for="item in group.items" :key="item.path"
                 class="nav-item" :class="{ active: route.path === item.path }"
                 @click.prevent="navigate(item.path)">
              <el-icon v-if="item.icon"><component :is="item.icon" /></el-icon>
              <span>{{ item.title }}</span>
            </div>
          </template>
        </nav>
      </aside>
    </div>

    <!-- 桌面端侧边栏 -->
    <aside class="desktop-only sidebar-container">
      <div class="sidebar-logo-container">
        <Monitor class="brand-mark" />
        <span class="logo-text">统一观测工作台</span>
      </div>
      <el-scrollbar>
        <nav class="sidebar-nav">
          <template v-for="group in groups" :key="group.label">
            <div v-if="group.label" class="menu-group">{{ group.label }}</div>
            <div v-for="item in group.items" :key="item.path"
                 class="nav-item" :class="{ active: route.path === item.path }"
                 @click.prevent="router.push(item.path)">
              <el-icon v-if="item.icon"><component :is="item.icon" /></el-icon>
              <span>{{ item.title }}</span>
            </div>
          </template>
        </nav>
      </el-scrollbar>
    </aside>

    <section class="main-container">
      <header class="navbar">
        <div class="context-selectors">
          <el-select v-model="store.appId" clearable placeholder="全部应用" @change="applyGlobal"><el-option v-for="item in applications" :key="item.app_id" :label="item.name || item.app_id" :value="item.app_id" /><el-option label="全部应用" value="" /></el-select>
          <el-select model-value="production" disabled><el-option label="● 生产" value="production" /></el-select>
          <el-input v-model="store.release" placeholder="全部版本" clearable @change="applyGlobal" />
          <el-select placeholder="最近24小时" @change="applyQuickRange"><el-option label="最近1小时" value="1" /><el-option label="最近24小时" value="24" /><el-option label="最近7天" value="168" /><el-option label="全部时间" value="" /></el-select>
        </div>
        <div class="navbar-actions"><el-button text circle aria-label="通知"><el-icon><Bell /></el-icon></el-button><el-button :loading="loading" @click="refreshAll">刷新</el-button></div>
      </header>

      <main class="app-main">
        <el-alert v-if="error" class="section" type="error" :title="error" show-icon />
        <router-view v-loading="pageLoading" />
      </main>
    </section>
  </div>
</template>

<style scoped>
.sidebar-nav { padding: 8px 0; }
.nav-item {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 20px; cursor: pointer; color: #909399;
  transition: all 0.2s; font-size: 14px; user-select: none;
}
.nav-item:hover { color: #fff; background: rgba(255,255,255,0.04); }
.nav-item.active { color: #409eff; background: rgba(64,158,255,0.1); }
.nav-item .el-icon { font-size: 18px; }
.menu-group {
  padding: 16px 20px 6px; font-size: 12px; color: #606266;
  text-transform: uppercase; letter-spacing: 0.5px;
}
</style>
