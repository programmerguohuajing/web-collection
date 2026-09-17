<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Aim, Bell, ChatDotRound, Collection, Connection, Cpu, CreditCard, DataAnalysis, DataLine, Document, DocumentChecked, EditPen, Files, Film, Filter, Fold, Guide, Lock, MagicStick, MapLocation, Menu, Monitor, Odometer, Operation, PieChart, Postcard, Reading, Setting, SetUp, Share, Stopwatch, Sunny, Switch, Tickets, Upload, User, View, Warning
} from '@element-plus/icons-vue'
import { api, error, insightUnread, loading, loadInsightUnread, markInsightsAsRead, normalizePageResponse, refresh, refreshAll, resetPages, resetPageFilters, applyRoutePrefill, pageLoading, slowRequest } from '../dashboard.js'
import { RANGE_PRESETS, rangeFromPreset, useFilterStore } from '../stores/filters.js'
import { useDiagnosisStore } from '../stores/diagnosis.js'
import PageLoading from '../components/PageLoading.vue'
import AiDiagnosisDrawer from '../components/AiDiagnosisDrawer.vue'
import DashboardHeader from '../components/DashboardHeader.vue'
import { useAuth } from '../composables/useAuth'
import { useBrand } from '../composables/useBrand'

const route = useRoute()
const router = useRouter()
const { accountsEnabled, isLoggedIn, loadCapabilities, loadMe, sloEnabled, syntheticEnabled, dsrEnabled, experimentsEnabled } = useAuth()
const { brandName, brandShortName, brandSubtitle, brandFooterText } = useBrand()
const store = useFilterStore()
const diagnosisStore = useDiagnosisStore()
const applications = ref([])
const menuOpen = ref(false)
const aiDrawerOpen = ref(false)
const aiDrawerRef = ref(null)

function toggleMenu() { menuOpen.value = !menuOpen.value }
function closeMenu() { menuOpen.value = false }
function navigate(path) { closeMenu(); router.push(path) }

/** 点击通知铃铛：标记已读并记录时间戳，避免刷新后再次被旧洞察触发红点 */
function openInsights() {
  markInsightsAsRead()
  navigate('/ai-insights')
}

watch(() => route.query, () => {
  resetPageFilters()
  applyRoutePrefill(route.query)
}, { immediate: true })

const baseGroups = [
  { label: '监测', items: [
    { title: '总览看板', path: '/overview', icon: Odometer },
    { title: '告警中心', path: '/alerts', icon: Bell },
    { title: '实时监控', path: '/live', icon: Monitor },
    { title: '错误监控', path: '/errors', icon: Warning },
    { title: '性能分析', path: '/performance', icon: Stopwatch },
    { title: '会话回放', path: '/replays', icon: Film },
    { title: '日志平台', path: '/logs', icon: Files },
    { title: '链路追踪', path: '/traces', icon: Connection },
    { title: 'API 健康', path: '/api-health', icon: Share },
    { title: '集成中心', path: '/integrations', icon: SetUp },
    { title: 'SLO 预算', path: '/slo', icon: DataLine, cap: 'slo' },
    { title: '合成监控', path: '/synthetic', icon: View, cap: 'synthetic' },
    { title: 'SDK 健康', path: '/sdk-health', icon: Cpu }
  ] },
  { label: '洞察', items: [
    { title: '用户链路', path: '/journey', icon: Guide },
    { title: '行为分析', path: '/behavior', icon: PieChart },
    { title: '产品分析', path: '/analytics', icon: DataAnalysis },
    { title: '用户会话', path: '/sessions', icon: User },
    { title: '用户路径', path: '/paths', icon: Switch },
    { title: '漏斗分析', path: '/funnels', icon: Filter },
    { title: '留存分析', path: '/retention', icon: Tickets },
    { title: '实验分析', path: '/experiments', icon: Aim, cap: 'experiments' },
    { title: '发布管理', path: '/releases', icon: Upload },
    { title: 'AI 洞察', path: '/ai-insights', icon: Sunny }
  ] },
  { label: '治理', items: [
    { title: '事件字典', path: '/dictionary', icon: Document },
    { title: '采集治理', path: '/governance', icon: Operation },
    { title: 'SourceMap', path: '/sourcemaps', icon: MapLocation },
    { title: 'AI 诊断', path: '/ai-settings', icon: MagicStick },
    { title: 'AI 助手', path: '/ai-assistant', icon: ChatDotRound },
    { title: '合规 DSR', path: '/dsr', icon: DocumentChecked, cap: 'dsr' }
  ] },
  { label: '知识中枢', items: [
    { title: '治理台', path: '/knowledge', icon: Collection },
    { title: '帮助中心', path: '/help', icon: Reading }
  ] },
  { label: '系统设置', items: [
    { title: '系统设置', path: '/settings', icon: Setting },
    { title: '团队管理', path: '/teams', icon: Postcard },
    { title: '成员与数据等级', path: '/access-levels', icon: Lock },
    { title: '用量与套餐', path: '/usage', icon: CreditCard, cap: 'metering' },
    { title: '品牌白标', path: '/brand', icon: EditPen, cap: 'whiteLabel' }
  ] }
]

// 能力位驱动的导航显隐（B3 泛化：cap 键对应 useAuth 同名能力位，false 部署不渲染入口，其余项不受影响）
const capFlags = { slo: sloEnabled, synthetic: syntheticEnabled, dsr: dsrEnabled, experiments: experimentsEnabled }
const groups = computed(() => baseGroups
  .map(group => ({ ...group, items: group.items.filter(item => !item.cap || Boolean(capFlags[item.cap]?.value)) }))
  .filter(group => group.items.length > 0)
)

const currentTitle = computed(() => {
  for (const group of groups.value) {
    const item = group.items.find(entry => entry.path === route.path)
    if (item) return item.title
  }
  return brandName.value
})

async function applyGlobal() {
  resetPages()
  await refreshAll()
}

// 顶部时间范围：预设 / 自定义共用 store.rangePreset + store.range（单一数据源），
// 页内不再各自推算时间窗，避免「顶部显示最近24小时、页面提示近 1 天」这类口径漂移。
const customRange = ref([])

/** 把当前 store.range 同步到自定义选择器的初值（切换到自定义时以现状为起点）。 */
function syncCustomRange() {
  const [start, end] = store.range || []
  customRange.value = (start && end) ? [Number(start), Number(end)] : []
}

async function applyRangePreset(value) {
  const preset = (value === undefined || value === null) ? store.rangePreset : String(value)
  store.rangePreset = preset
  if (preset === 'custom') {
    // 切到自定义：先回填当前窗口，等用户选完区间再触发查询，避免空窗查询。
    syncCustomRange()
    return
  }
  const nextRange = rangeFromPreset(preset)
  if (nextRange !== null) {
    store.range = nextRange
  }
  await applyGlobal()
}

async function applyCustomRange(value) {
  if (!Array.isArray(value) || value.length !== 2 || value[0] == null || value[1] == null) return
  store.rangePreset = 'custom'
  store.range = [Number(value[0]), Number(value[1])]
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
  // P1 主动洞察：拉取未处理洞察数，导航红点提示（共享状态：洞察页可清零/刷新）
  await loadInsightUnread()

  // D2 账号体系：拉取能力位；已登录则加载用户/团队，供导航用户菜单使用（accounts=false 部署自动跳过）
  await loadCapabilities()
  if (isLoggedIn.value) {
    try { await loadMe() } catch { /* 令牌失效不影响监控页 */ }
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
          <span class="brand-logo">{{ brandShortName }}</span>
          <span><strong>{{ brandName }}</strong><small>{{ brandSubtitle }}</small></span>
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
        <span class="brand-logo">{{ brandShortName }}</span>
        <span><strong>{{ brandName }}</strong><small>{{ brandSubtitle }}</small></span>
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
      <div class="sidebar-foot">{{ brandFooterText }}</div>
    </aside>

    <section class="main-container">
      <header class="navbar">
        <div class="topbar-title">
          <h1>{{ currentTitle }}</h1>
          <div class="sub">实时遥测</div>
        </div>
        <div class="topbar-spacer" />
        <div class="context-selectors" aria-label="全局筛选">
          <el-select v-model="store.appId" clearable placeholder="全部应用" class="app-selector" @change="applyGlobal">
            <el-option v-for="item in applications" :key="item.app_id" :label="item.name || item.app_id" :value="item.app_id" />
            <el-option label="全部应用" value="" />
          </el-select>
          <el-input v-model="store.release" placeholder="全部版本" class="release-selector" clearable @change="applyGlobal" />
          <el-select v-model="store.rangePreset" placeholder="最近24小时" class="preset-selector" @change="applyRangePreset">
            <el-option v-for="item in RANGE_PRESETS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-date-picker
            v-if="store.rangePreset === 'custom'"
            v-model="customRange"
            type="datetimerange"
            value-format="x"
            range-separator="至"
            start-placeholder="开始时间"
            end-placeholder="结束时间"
            class="range-custom-picker"
            @change="applyCustomRange"
          />
        </div>
        <div class="navbar-actions">
          <el-badge :value="insightUnread" :hidden="!insightUnread" :max="99">
            <el-button text circle aria-label="通知" @click="openInsights"><el-icon><Bell /></el-icon></el-button>
          </el-badge>
          <el-button class="refresh-button" :loading="loading" @click="refreshAll">刷新</el-button>
          <span v-if="store.environment" class="environment-pill" :title="`当前采集环境：${store.environment}`"><i />{{ store.environment }}</span>
          <DashboardHeader v-if="accountsEnabled && isLoggedIn" />
          <span v-else class="user-avatar" aria-label="当前用户">运</span>
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
