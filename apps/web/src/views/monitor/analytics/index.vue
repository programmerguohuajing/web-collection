<script setup>
import { ElMessage, ElMessageBox } from 'element-plus'
import { QuestionFilled } from '@element-plus/icons-vue'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, normalizePageResponse, queryFromFilters, refreshVersion, pageLoading, toList } from '../../../dashboard.js'
import KpiGrid from '../../../components/KpiGrid.vue'
import AnalyticsChart from '../../../components/AnalyticsChart.vue'
import FunnelChart from '../../../components/FunnelChart.vue'
import DashboardWidgets from '../../../components/DashboardWidgets.vue'
import EventInsightPanel from '../../../components/EventInsightPanel.vue'
import PathInsightPanel from '../../../components/PathInsightPanel.vue'
import SearchPanel from '../../../components/SearchPanel.vue'
import OverflowTip from '../../../components/OverflowTip.vue'
import { buildReplayQuery } from '../../../utils/replay-link.js'

const router = useRouter()
const route = useRoute()
const tab = ref('insights')
const paths = ref([])
const live = ref({})
const releases = ref([])
const funnels = ref([])
const funnelEventNames = ref([])
const dashboards = ref([])
const insights = ref([])
const capabilities = ref({ insights: false, productAnalyticsV2: false, funnels: true, dashboards: true, paths: true, live: true, releases: true })
const selectedDashboardId = ref(null)
const analyticsError = ref('')
const analyticsLoading = ref(false)
const funnelPager = reactive({ page: 1, pageSize: 10, total: 0 })
const dashboardForm = reactive({ name: '', widgets: ['live', 'sessions', 'errors', 'releases'] })
let timer = 0
let loadRequestId = 0

// 用户会话表「访问页面」列：内联只展示前 N 个路径面包屑，超出部分点击「+N 页」在单元格内展开完整路径
// （行点击打开会话详情抽屉；原左侧 type="expand" 展开列已移除，内联开关自持展开状态，不再依赖表格 expand 机制）
const activeDashboard = computed(() => dashboards.value.find(item => item.id === selectedDashboardId.value) || dashboards.value[0])
const insightOptions = computed(() => insights.value.map(item => ({ label: item.name, value: `insight:${item.id}` })))
// 事件分析能力：优先读规范键 capabilities.insights（P0-4），兼容旧键 productAnalyticsV2。
// Worker 部署无 /api/analytics/insights 端点 → 恒为 false；该 Tab 据此不渲染（见下方模板注释与 resolveTab）。
const insightsSupported = computed(() => Boolean(capabilities.value.insights ?? capabilities.value.productAnalyticsV2))
const analyticsKpis = computed(() => [
  { label: '近 5 分钟会话', value: Number(live.value?.sessions || 0).toLocaleString(), delta: '实时', valueClass: 'value-primary' },
  { label: '近 5 分钟用户', value: Number(live.value?.users || 0).toLocaleString(), delta: '实时', valueClass: 'value-success' },
  { label: '近 5 分钟事件', value: Number(live.value?.events || 0).toLocaleString(), delta: '实时事件流', valueClass: 'value-purple' }
])
const funnelOptions = computed(() => funnels.value.map(item => ({ label: item.name, value: `funnel:${item.id}` })))

function setPaged(target, pager, data) {
  const normalized = normalizePageResponse(data, pager)
  target.value = normalized.items
  Object.assign(pager, normalized)
}
async function loadFunnels() {
  const data = await api(`/api/funnels?page=${funnelPager.page}&pageSize=${funnelPager.pageSize}`, { requestKey: 'analytics:funnels' })
  setPaged(funnels, funnelPager, data)
}
async function loadInsights() {
  insights.value = insightsSupported.value ? toList(await api('/api/analytics/insights', { requestKey: 'analytics:insights' })) : []
}
async function refreshInsights() {
  await Promise.all([loadInsights(), api('/api/dashboards', { requestKey: 'analytics:dashboards' }).then(data => { dashboards.value = toList(data) })])
}
async function load() {
  const requestId = ++loadRequestId
  analyticsLoading.value = true
  analyticsError.value = ''
  pageLoading.value = true
  try {
    capabilities.value = await api('/api/capabilities').catch(() => ({ insights: false, productAnalyticsV2: false, funnels: true, dashboards: true, paths: true, live: true, releases: true }))
    const query = queryFromFilters()
    const [pathData, liveData, releaseData, eventNameData, , dashboardData, insightData] = await Promise.all([
      api(`/api/analytics/paths?${query}`, { requestKey: 'analytics:paths' }), api(`/api/analytics/live?${query}`, { requestKey: 'analytics:live' }), api(`/api/analytics/releases?${query}`, { requestKey: 'analytics:releases' }), api(`/api/analytics/event-names?${queryFromFilters({}, ['appId', 'release', 'range'])}`, { requestKey: 'analytics:event-names' }), loadFunnels(), api('/api/dashboards', { requestKey: 'analytics:dashboards' })
      , insightsSupported.value ? api('/api/analytics/insights') : []
    ])
    if (requestId !== loadRequestId) return
    paths.value = normalizePageResponse(pathData).items
    live.value = liveData?.data && typeof liveData.data === 'object' ? liveData.data : (liveData || {})
    releases.value = normalizePageResponse(releaseData).items.map(normalizeReleaseRow)
    funnelEventNames.value = toList(eventNameData)
    dashboards.value = toList(dashboardData)
    insights.value = toList(insightData)
    if (!selectedDashboardId.value && dashboards.value[0]) selectedDashboardId.value = dashboards.value[0].id
  } catch (error) {
    if (requestId === loadRequestId && error?.code !== 'ABORT_ERR') analyticsError.value = error.message || '分析数据加载失败'
  } finally {
    if (requestId === loadRequestId) {
      analyticsLoading.value = false
      pageLoading.value = false
    }
  }
}

async function saveDashboard() {
  await api('/api/dashboards', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: dashboardForm.name, widgets: dashboardForm.widgets.map(decodeWidget) })
  })
  dashboardForm.name = ''
  await load()
}
async function removeDashboard() {
  const item = dashboards.value.find(entry => entry.id === selectedDashboardId.value)
  if (!item) return
  const confirmed = await ElMessageBox.confirm(`确定删除仪表盘“${item.name}”吗？`, '删除仪表盘', { type: 'warning' }).then(() => true).catch(() => false)
  if (!confirmed) return
  await api(`/api/dashboards/${item.id}`, { method: 'DELETE' })
  selectedDashboardId.value = null
  await load()
}

// A2 看板分享：生成 shareToken → 公开只读链接 / iframe 嵌入；取消分享后旧链接 404。
const shareDialogVisible = ref(false)
const shareInfo = ref(null)
async function openShare() {
  const id = selectedDashboardId.value
  if (!id) return
  const data = await api(`/api/dashboards/${id}/share`, { method: 'POST' })
  const origin = window.location.origin
  shareInfo.value = {
    token: data.shareToken,
    url: `${origin}/embed/dashboard/${data.shareToken}`,
    iframe: `<iframe src="${origin}/embed/dashboard/${data.shareToken}" width="100%" height="600" frameborder="0"></iframe>`
  }
  shareDialogVisible.value = true
  await load()
}
async function unshareDashboard() {
  const id = selectedDashboardId.value
  if (!id) return
  const confirmed = await ElMessageBox.confirm('取消分享后，已分发的链接与 iframe 将立即失效。确定取消吗？', '取消分享', { type: 'warning' }).then(() => true).catch(() => false)
  if (!confirmed) return
  await api(`/api/dashboards/${id}/share`, { method: 'DELETE' })
  shareInfo.value = null
  shareDialogVisible.value = false
  ElMessage.success('已取消分享')
  await load()
}
function copyText(text) {
  navigator.clipboard?.writeText(text)
  ElMessage.success('已复制到剪贴板')
}
function stepName(step) { return typeof step === 'string' ? step : step?.eventName || '-' }
function presentValue(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '') ?? '-'
}
function normalizeReleaseRow(row = {}) {
  return {
    ...row,
    release: presentValue(row.release, row.release_name, row.releaseName, row.version),
    events: presentValue(row.events, row.event_count, row.eventCount),
    users: presentValue(row.users, row.user_count, row.userCount),
    errors: presentValue(row.errors, row.error_count, row.errorCount),
    lcp: presentValue(row.lcp, row.avg_lcp, row.avgLcp, row.average_lcp, row.averageLcp)
  }
}
function replayId(row = {}) {
  const value = row.replaySessionId ?? row.replay_session_id
  return value === undefined || value === null || value === '' ? '' : value
}
function widgetKey(widget) { return typeof widget === 'string' ? widget : `${widget.type}:${widget.id}` }
function insightById(id) { return insights.value.find(item => item.id === Number(id)) }
function funnelById(id) { return funnels.value.find(item => item.id === Number(id)) }
function widgetLabel(widget) {
  if (typeof widget === 'string') return ({ live: '实时用户', sessions: '会话数', errors: '错误数', releases: '活跃版本' })[widget] || widget
  return widget.type === 'insight' ? insightById(widget.id)?.name || `分析 ${widget.id}` : funnelById(widget.id)?.name || `漏斗 ${widget.id}`
}
function decodeWidget(widget) {
  if (!String(widget).includes(':')) return widget
  const [type, id] = String(widget).split(':')
  return { type, id: Number(id) }
}
function changeTab(name) {
  tab.value = name
}
function replay(id) { router.push({ path: '/replays', query: { replayId: id } }) }

/** BUG-009（PRD 01 FR-5 入口 ③）：会话列表行操作 → 用户链路（按 sessionId 打开会话时间线）。 */
function openJourney(row = {}) {
  if (!row.session_id) return
  router.push({ path: '/journey', query: { type: 'session', value: row.session_id } })
}

/**
 * B4 分析 → 回放：带过滤条件打开回放列表（而非只播单条会话）。
 * 按该会话的 userId / userName 过滤，二者均为回放查询 API 支持的真实参数。
 */
function replayList(row = {}) {
  router.push({ path: '/replays', query: buildReplayQuery({ userId: row.user_id, userName: row.user_name }) })
}

// 自动刷新开关：0 = 暂停（暂为缓解 D1 行读爆量），恢复时改回 30000
const LIVE_REFRESH_MS = 0
onMounted(async () => {
  // 初次加载一次实时数据，之后不再自动轮询
  try { live.value = await api(`/api/analytics/live?${queryFromFilters()}`) } catch {}
  if (LIVE_REFRESH_MS > 0) timer = window.setInterval(async () => {
    live.value = await api(`/api/analytics/live?${queryFromFilters()}`)
  }, LIVE_REFRESH_MS)
})
onBeforeUnmount(() => clearInterval(timer))
/**
 * Tab 深链解析（?tab=xxx）。事件分析在不支持的部署上不渲染，故需在此拦截，
 * 否则 el-tabs 会因 name 无对应面板而出现「无选中 Tab」的空态。
 * 同时监听 insightsSupported：capabilities 是异步加载的，自托管部署要等它到位后才能认这个深链。
 */
const TAB_NAMES = ['insights', 'releases', 'dashboards']
function resolveTab(name) {
  if (name === 'sessions') {
    // 兼容旧深链：用户会话已移至独立页面
    router.replace({ path: '/sessions', query: route.query })
    return ''
  }
  if (!TAB_NAMES.includes(name)) return ''
  return name === 'insights' && !insightsSupported.value ? '' : name
}
watch([() => route.query.tab, insightsSupported], () => {
  const wanted = resolveTab(route.query.tab)
  if (wanted) tab.value = wanted
  else if (tab.value === 'insights' && !insightsSupported.value) tab.value = 'releases'
}, { immediate: true })
watch(refreshVersion, () => { load() }, { immediate: true })
</script>

<template>
  <SearchPanel :fields="['userId']" @search="() => { load() }" />
  <el-alert v-if="analyticsError" class="table-error" type="error" :title="analyticsError" show-icon :closable="false"><template #default><el-button link type="primary" @click="load">重试</el-button></template></el-alert>
  <KpiGrid :items="analyticsKpis" />
  <el-tabs v-model="tab" class="panel section analytics-tabs" @tab-change="changeTab">
    <!-- 事件分析：仅当部署真实支持 /api/analytics/insights 时渲染（Cloudflare Worker 无该端点 → 恒不渲染，
         避免出现一个永远点不动的禁用 Tab；自托管 Node 部署 capability 为 true，入口照常可用）。 -->
    <el-tab-pane v-if="insightsSupported" label="事件分析" name="insights">
      <EventInsightPanel :event-names="funnelEventNames" :insights="insights" @changed="refreshInsights" />
    </el-tab-pane>
    <el-tab-pane label="版本对比" name="releases">
      <el-table :data="releases" border><el-table-column label="版本"><template #default="{ row }">{{ presentValue(row.release, row.release_name, row.releaseName, row.version) }}</template></el-table-column><el-table-column label="事件"><template #default="{ row }">{{ presentValue(row.events, row.event_count, row.eventCount) }}</template></el-table-column><el-table-column label="用户"><template #default="{ row }">{{ presentValue(row.users, row.user_count, row.userCount) }}</template></el-table-column><el-table-column label="错误"><template #default="{ row }">{{ presentValue(row.errors, row.error_count, row.errorCount) }}</template></el-table-column><el-table-column label="平均 LCP"><template #default="{ row }">{{ presentValue(row.lcp, row.avg_lcp, row.avgLcp, row.average_lcp, row.averageLcp) }}</template></el-table-column></el-table>
    </el-tab-pane>
    <el-tab-pane label="自定义仪表盘" name="dashboards">
      <el-space class="section"><el-select v-model="selectedDashboardId" clearable placeholder="选择仪表盘" style="width:240px"><el-option v-for="item in dashboards" :key="item.id" :label="item.name" :value="item.id" /></el-select><el-button type="danger" plain :disabled="!selectedDashboardId" @click="removeDashboard">删除仪表盘</el-button><el-button type="primary" plain :disabled="!selectedDashboardId" @click="openShare">分享</el-button></el-space>
      <el-form><el-form-item label="名称"><el-input v-model="dashboardForm.name" style="width:260px" /></el-form-item><el-form-item label="基础组件"><el-checkbox-group v-model="dashboardForm.widgets"><el-checkbox v-for="item in ['live','sessions','errors','releases']" :key="item" :value="item">{{ widgetLabel(item) }}</el-checkbox></el-checkbox-group></el-form-item><el-form-item v-if="insightOptions.length" label="分析组件"><el-checkbox-group v-model="dashboardForm.widgets"><el-checkbox v-for="item in insightOptions" :key="item.value" :value="item.value">{{ item.label }}</el-checkbox></el-checkbox-group></el-form-item><el-form-item v-if="insightsSupported && funnelOptions.length" label="漏斗组件"><el-checkbox-group v-model="dashboardForm.widgets"><el-checkbox v-for="item in funnelOptions" :key="item.value" :value="item.value">{{ item.label }}</el-checkbox></el-checkbox-group></el-form-item><el-button type="primary" @click="saveDashboard">保存仪表盘</el-button></el-form>
      <el-alert v-if="activeDashboard" class="dashboard-current" :title="`当前仪表盘：${activeDashboard.name}（${activeDashboard.widgets_json?.map(widgetLabel).join('、')}）`" type="success" :closable="false" />
      <DashboardWidgets v-if="activeDashboard" :dashboard="activeDashboard" :read-only="true" />
    </el-tab-pane>
  </el-tabs>
  <el-dialog v-model="shareDialogVisible" width="560px">
    <template #title>分享仪表盘<el-tooltip content="任何持有链接者均可只读查看该看板（仅看板定义与聚合数据，不含原始事件）；取消分享后链接立即失效。" placement="top"><el-icon class="help-icon"><QuestionFilled /></el-icon></el-tooltip></template>
    <template v-if="shareInfo">
      <div class="share-row">
        <div class="share-link"><OverflowTip :text="shareInfo.url" /></div>
        <el-button link type="primary" @click="copyText(shareInfo.url)">复制链接</el-button>
      </div>
      <div class="share-iframe-label">嵌入第三方页面（iframe）：</div>
      <el-input :model-value="shareInfo.iframe" type="textarea" :rows="3" readonly />
      <div class="share-actions">
        <el-button link type="primary" @click="copyText(shareInfo.iframe)">复制 iframe 代码</el-button>
        <el-button link type="danger" @click="unshareDashboard">取消分享</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.table-error { margin-bottom: 12px; }
:deep(.el-table .cell.no-ellipsis) { overflow: visible; text-overflow: clip; white-space: normal; }
.path-cell { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px; max-width: 100%; }
.path-crumb { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--el-text-color-primary); }
.path-crumb-arrow { flex: none; color: var(--el-text-color-placeholder); font-size: 12px; }
.path-toggle { display: inline-flex; align-items: center; gap: 2px; flex: none; margin-left: 2px; color: var(--el-color-primary); cursor: pointer; font-size: 12px; user-select: none; }
.path-toggle:hover { color: var(--el-color-primary-light-3); }
.path-toggle-arrow { font-size: 12px; }
.dashboard-current { margin-top: 14px; }
.dashboard-insight { margin-top: 14px; }
.share-note { margin-bottom: 14px; }
.share-row { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.share-link { flex: 1; min-width: 0; padding: 6px 10px; background: var(--el-fill-color-light); border-radius: 4px; }
.share-iframe-label { margin: 12px 0 6px; font-size: 13px; color: var(--el-text-color-secondary); }
.share-actions { margin-top: 10px; display: flex; justify-content: space-between; }
</style>
