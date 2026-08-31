<script setup>
import { ElMessageBox } from 'element-plus'
import { ArrowDown, ArrowRight, ArrowUp } from '@element-plus/icons-vue'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, normalizePageResponse, queryFromFilters, refreshVersion, pageLoading, toList } from '../../../dashboard.js'
import KpiGrid from '../../../components/KpiGrid.vue'
import AnalyticsChart from '../../../components/AnalyticsChart.vue'
import FunnelChart from '../../../components/FunnelChart.vue'
import EventInsightPanel from '../../../components/EventInsightPanel.vue'
import PathInsightPanel from '../../../components/PathInsightPanel.vue'
import SearchPanel from '../../../components/SearchPanel.vue'
import OverflowTip from '../../../components/OverflowTip.vue'

const router = useRouter()
const route = useRoute()
const tab = ref('sessions')
const sessions = ref([])
const sessionEvents = ref([])
const activeSession = ref(null)
const paths = ref([])
const live = ref({})
const releases = ref([])
const funnels = ref([])
const funnelEventNames = ref([])
const dashboards = ref([])
const insights = ref([])
const capabilities = ref({ insights: false, productAnalyticsV2: false, funnels: true, dashboards: true, paths: true, live: true, releases: true })
const dashboardResults = ref({})
const selectedDashboardId = ref(null)
const sessionDrawerOpen = ref(false)
const analyticsError = ref('')
const analyticsLoading = ref(false)
const sessionPager = reactive({ page: 1, pageSize: 10, total: 0 })
const sessionEventPager = reactive({ page: 1, pageSize: 10, total: 0 })
const funnelPager = reactive({ page: 1, pageSize: 10, total: 0 })
const dashboardForm = reactive({ name: '', widgets: ['live', 'sessions', 'errors', 'releases'] })
let timer = 0
let loadRequestId = 0

// 用户会话表「访问页面」列：内联只展示前 N 个路径面包屑，超出部分行内展开查看完整路径。
const PATH_PREVIEW = 3 // 单元格内联展示的页面数
const sessionTableRef = ref(null)
const sessionExpandedKeys = ref(new Set())
function visiblePaths(row) {
  return (row.paths || []).slice(0, PATH_PREVIEW)
}
function rowExpanded(row) {
  return sessionExpandedKeys.value.has(row.session_id)
}
function toggleExpand(row) {
  sessionTableRef.value?.toggleRowExpansion(row)
}
function onSessionExpandChange(row, expandedRows) {
  const next = new Set(sessionExpandedKeys.value)
  if (expandedRows.some(item => item.session_id === row.session_id)) next.add(row.session_id)
  else next.delete(row.session_id)
  sessionExpandedKeys.value = next
}

const activeDashboard = computed(() => dashboards.value.find(item => item.id === selectedDashboardId.value) || dashboards.value[0])
const insightOptions = computed(() => insights.value.map(item => ({ label: item.name, value: `insight:${item.id}` })))
// 事件分析能力：优先读规范键 capabilities.insights（P0-4），兼容旧键 productAnalyticsV2。
// 缺省 false：Worker 部署无 /api/analytics/insights 端点，入口禁用但可见（不静默隐藏）。
const insightsSupported = computed(() => Boolean(capabilities.value.insights ?? capabilities.value.productAnalyticsV2))
const analyticsKpis = computed(() => [
  { label: '近 5 分钟会话', value: Number(live.value?.sessions || 0).toLocaleString(), delta: '实时', valueClass: 'value-primary' },
  { label: '近 5 分钟用户', value: Number(live.value?.users || 0).toLocaleString(), delta: '实时', valueClass: 'value-success' },
  { label: '近 5 分钟事件', value: Number(live.value?.events || 0).toLocaleString(), delta: '实时事件流', valueClass: 'value-purple' },
  { label: '历史会话样本', value: Number(sessionPager.total || 0).toLocaleString(), delta: '当前筛选范围', valueClass: 'value-danger' }
])
const dashboardKpis = computed(() => {
  const items = []
  if (hasWidget('live')) items.push({ label: '在线用户', value: Number(live.value?.users || 0).toLocaleString(), delta: '实时', valueClass: 'value-success' })
  if (hasWidget('sessions')) items.push({ label: '会话数', value: Number(sessionPager.total || 0).toLocaleString(), delta: '当前筛选范围', valueClass: 'value-primary' })
  if (hasWidget('errors')) items.push({ label: '当前页会话错误数', value: sessions.value.reduce((sum, item) => sum + (item.error_count || 0), 0).toLocaleString(), delta: '需关注', valueClass: 'value-danger' })
  if (hasWidget('releases')) items.push({ label: '活跃版本', value: Number(releases.value.length || 0).toLocaleString(), delta: '当前筛选范围', valueClass: 'value-purple' })
  return items
})
const funnelOptions = computed(() => funnels.value.map(item => ({ label: item.name, value: `funnel:${item.id}` })))

function setPaged(target, pager, data) {
  const normalized = normalizePageResponse(data, pager)
  target.value = normalized.items
  Object.assign(pager, normalized)
}
async function loadSessions() {
  const data = await api(`/api/analytics/sessions?${queryFromFilters({ page: sessionPager.page, pageSize: sessionPager.pageSize })}`, { requestKey: 'analytics:sessions' })
  setPaged(sessions, sessionPager, data)
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
  await loadDashboardResults()
}
async function load() {
  const requestId = ++loadRequestId
  analyticsLoading.value = true
  analyticsError.value = ''
  pageLoading.value = true
  try {
    capabilities.value = await api('/api/capabilities').catch(() => ({ insights: false, productAnalyticsV2: false, funnels: true, dashboards: true, paths: true, live: true, releases: true }))
    const query = queryFromFilters()
    const [, pathData, liveData, releaseData, eventNameData, , dashboardData, insightData] = await Promise.all([
      loadSessions(), api(`/api/analytics/paths?${query}`, { requestKey: 'analytics:paths' }), api(`/api/analytics/live?${query}`, { requestKey: 'analytics:live' }), api(`/api/analytics/releases?${query}`, { requestKey: 'analytics:releases' }), api(`/api/analytics/event-names?${queryFromFilters({}, ['appId', 'release', 'range'])}`, { requestKey: 'analytics:event-names' }), loadFunnels(), api('/api/dashboards', { requestKey: 'analytics:dashboards' })
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
    await loadDashboardResults()
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
function hasWidget(name) { return (activeDashboard.value?.widgets_json || []).some(widget => widgetKey(widget) === name) }
async function loadDashboardResults() {
  const widgets = activeDashboard.value?.widgets_json || []
  const results = {}
  // 基础组件：live 数据已通过 load() 中 /api/analytics/live 端点加载到 live.value，无需额外请求
  const stringWidgets = new Set(widgets.filter(widget => typeof widget === 'string'))
  if (stringWidgets.size) results._basic = true
  // 分析组件：从 API 加载
  await Promise.all(widgets.filter(widget => typeof widget === 'object').map(async widget => {
    const key = widgetKey(widget)
    if (widget.type === 'funnel') {
      // 方案 B：统一走 /report 端点（/run 已废弃）
      const r = await api(`/api/funnels/${widget.id}/report?${queryFromFilters()}`)
      results[key] = { steps: (r.steps || []).map((s, i, arr) => ({
        step: s.event,
        count: s.users,
        rate: Math.round((s.rate || 0) * 100),
        stepRate: i === 0 ? 100 : Math.round((s.users / (arr[i - 1].users || s.users)) * 100),
        lost: s.lost
      })) }
    }
    if (widget.type === 'insight') {
      const insight = insights.value.find(item => item.id === widget.id)
      if (insight) results[key] = await api(insight.kind === 'path' ? '/api/analytics/paths/query' : '/api/analytics/insights/query', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...insight.definition, ...Object.fromEntries(new URLSearchParams(queryFromFilters({}, ['appId', 'release', 'range']))) })
      })
    }
  }))
  dashboardResults.value = results
}
async function loadSessionEvents() {
  if (!activeSession.value?.session_id) return
  setPaged(sessionEvents, sessionEventPager, await api(`/api/analytics/sessions/${encodeURIComponent(activeSession.value.session_id)}?page=${sessionEventPager.page}&pageSize=${sessionEventPager.pageSize}`, { requestKey: `analytics:session-events:${activeSession.value.session_id}` }))
}
async function openSession(row) {
  if (!row.session_id?.trim()) return
  activeSession.value = row
  sessionDrawerOpen.value = true
  sessionEventPager.page = 1
  await loadSessionEvents()
}
function changeTab(name) {
  tab.value = name
}
function replay(id) { router.push({ path: '/replays', query: { replayId: id } }) }

onMounted(() => { timer = window.setInterval(async () => { live.value = await api(`/api/analytics/live?${queryFromFilters()}`) }, 30000) })
onBeforeUnmount(() => clearInterval(timer))
watch(() => route.query.tab, value => { if (value) tab.value = value }, { immediate: true })
watch(refreshVersion, () => { sessionPager.page = 1; load() }, { immediate: true })
watch(selectedDashboardId, loadDashboardResults)
</script>

<template>
  <SearchPanel :fields="['userId']" @search="() => { sessionPager.page = 1; load() }" />
  <el-alert v-if="analyticsError" class="table-error" type="error" :title="analyticsError" show-icon :closable="false"><template #default><el-button link type="primary" @click="load">重试</el-button></template></el-alert>
  <KpiGrid :items="analyticsKpis" />
  <el-tabs v-model="tab" class="panel section analytics-tabs" @tab-change="changeTab">
    <el-tab-pane :disabled="!insightsSupported" label="事件分析" name="insights">
      <EventInsightPanel v-if="insightsSupported" :event-names="funnelEventNames" :insights="insights" @changed="refreshInsights" />
      <el-alert v-else type="info" :closable="false" show-icon title="当前部署暂不支持事件分析">
        <template #default>当前部署（Cloudflare Worker）未实现事件分析能力，已切换到 Node API 部署或等待后续版本后将自动开放，不会静默隐藏此入口。</template>
      </el-alert>
    </el-tab-pane>
    <el-tab-pane label="用户会话" name="sessions">
      <el-table ref="sessionTableRef" :data="sessions" border v-loading="analyticsLoading" empty-text="暂无会话数据" @row-click="openSession" @expand-change="onSessionExpandChange" style="cursor:pointer">
        <el-table-column type="expand" width="24">
          <template #default="{ row }">
            <div class="path-expand">
              <div class="path-expand-title">完整访问路径（共 {{ (row.paths || []).length }} 页）</div>
              <div class="path-expand-body">
                <template v-for="(p, i) in row.paths || []" :key="i">
                  <span class="path-crumb">{{ p }}</span>
                  <el-icon v-if="i < (row.paths || []).length - 1" class="path-crumb-arrow"><ArrowRight /></el-icon>
                </template>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="user_name" label="用户" width="130"><template #default="{ row }">{{ row.user_name || row.user_id || row.device_id }}</template></el-table-column>
        <el-table-column label="会话" min-width="200"><template #default="{ row }"><OverflowTip :text="row.session_id" /></template></el-table-column>
        <el-table-column label="开始时间" width="200" cell-class-name="time-cell"><template #default="{ row }">{{ new Date(row.started_at).toLocaleString() }}</template></el-table-column>
        <el-table-column prop="duration" label="时长(ms)" width="110" />
        <el-table-column prop="event_count" label="事件" width="80" />
        <el-table-column prop="error_count" label="错误" width="80" />
        <el-table-column label="访问页面" min-width="240" cell-class-name="no-ellipsis">
          <template #default="{ row }">
            <span v-if="(row.paths || []).length" class="path-cell">
              <template v-for="(p, i) in visiblePaths(row)" :key="i">
                <span class="path-crumb" :title="p">{{ p }}</span>
                <el-icon v-if="i < visiblePaths(row).length - 1" class="path-crumb-arrow"><ArrowRight /></el-icon>
              </template>
              <span v-if="(row.paths || []).length > PATH_PREVIEW" class="path-toggle" :class="{ 'is-expanded': rowExpanded(row) }" @click.stop="toggleExpand(row)">
                +{{ row.paths.length - PATH_PREVIEW }} 页
                <el-icon class="path-toggle-arrow"><ArrowDown v-if="!rowExpanded(row)" /><ArrowUp v-else /></el-icon>
              </span>
            </span>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="回放" width="80"><template #default="{ row }"><el-button v-if="replayId(row)" link type="primary" @click="replay(replayId(row))">播放</el-button><span v-else>-</span></template></el-table-column>
      </el-table>
      <el-pagination v-if="sessionPager.total > 0" class="pager" background layout="sizes, prev, pager, next, total" :current-page="sessionPager.page" :page-size="sessionPager.pageSize" :page-sizes="[10, 20, 50, 100]" :total="sessionPager.total" @current-change="value => { sessionPager.page = value; loadSessions() }" @size-change="value => { sessionPager.page = 1; sessionPager.pageSize = value; loadSessions() }" />
    </el-tab-pane>
    <el-tab-pane label="版本对比" name="releases">
      <el-table :data="releases" border><el-table-column label="版本"><template #default="{ row }">{{ presentValue(row.release, row.release_name, row.releaseName, row.version) }}</template></el-table-column><el-table-column label="事件"><template #default="{ row }">{{ presentValue(row.events, row.event_count, row.eventCount) }}</template></el-table-column><el-table-column label="用户"><template #default="{ row }">{{ presentValue(row.users, row.user_count, row.userCount) }}</template></el-table-column><el-table-column label="错误"><template #default="{ row }">{{ presentValue(row.errors, row.error_count, row.errorCount) }}</template></el-table-column><el-table-column label="平均 LCP"><template #default="{ row }">{{ presentValue(row.lcp, row.avg_lcp, row.avgLcp, row.average_lcp, row.averageLcp) }}</template></el-table-column></el-table>
    </el-tab-pane>
    <el-tab-pane label="自定义仪表盘" name="dashboards">
      <el-space class="section"><el-select v-model="selectedDashboardId" clearable placeholder="选择仪表盘" style="width:240px"><el-option v-for="item in dashboards" :key="item.id" :label="item.name" :value="item.id" /></el-select><el-button type="danger" plain :disabled="!selectedDashboardId" @click="removeDashboard">删除仪表盘</el-button></el-space>
      <el-form><el-form-item label="名称"><el-input v-model="dashboardForm.name" style="width:260px" /></el-form-item><el-form-item label="基础组件"><el-checkbox-group v-model="dashboardForm.widgets"><el-checkbox v-for="item in ['live','sessions','errors','releases']" :key="item" :value="item">{{ widgetLabel(item) }}</el-checkbox></el-checkbox-group></el-form-item><el-form-item v-if="insightOptions.length" label="分析组件"><el-checkbox-group v-model="dashboardForm.widgets"><el-checkbox v-for="item in insightOptions" :key="item.value" :value="item.value">{{ item.label }}</el-checkbox></el-checkbox-group></el-form-item><el-form-item v-if="insightsSupported && funnelOptions.length" label="漏斗组件"><el-checkbox-group v-model="dashboardForm.widgets"><el-checkbox v-for="item in funnelOptions" :key="item.value" :value="item.value">{{ item.label }}</el-checkbox></el-checkbox-group></el-form-item><el-button type="primary" @click="saveDashboard">保存仪表盘</el-button></el-form>
      <el-alert v-if="activeDashboard" class="dashboard-current" :title="`当前仪表盘：${activeDashboard.name}（${activeDashboard.widgets_json?.map(widgetLabel).join('、')}）`" type="success" :closable="false" />
      <KpiGrid v-if="activeDashboard" :items="dashboardKpis" />
      <template v-for="widget in activeDashboard?.widgets_json || []" :key="widgetKey(widget)">
        <el-card v-if="typeof widget === 'object' && dashboardResults[widgetKey(widget)]" class="section dashboard-insight" shadow="never">
          <template #header><b>{{ widgetLabel(widget) }}</b></template>
          <AnalyticsChart v-if="widget.type === 'insight'" :kind="insightById(widget.id)?.kind === 'path' ? 'path' : 'trend'" :result="dashboardResults[widgetKey(widget)]" />
          <FunnelChart v-else :steps="dashboardResults[widgetKey(widget)].steps" />
        </el-card>
      </template>
    </el-tab-pane>
  </el-tabs>
  <el-drawer v-model="activeSession" size="65%" title="用户会话详情">
    <el-table :data="sessionEvents" border><el-table-column label="时间" width="200" cell-class-name="time-cell"><template #default="{ row }">{{ new Date(row.ts).toLocaleString() }}</template></el-table-column><el-table-column prop="type" label="类型" width="100" /><el-table-column label="名称" width="160"><template #default="{ row }">{{ row.name || row.metric }}</template></el-table-column><el-table-column label="内容" min-width="240"><template #default="{ row }"><OverflowTip :text="row.message" /></template></el-table-column><el-table-column prop="path" label="页面" min-width="220" /></el-table>
    <el-pagination class="pager" background layout="sizes, prev, pager, next, total" :current-page="sessionEventPager.page" :page-size="sessionEventPager.pageSize" :page-sizes="[10, 20, 50, 100]" :total="sessionEventPager.total" @current-change="value => { sessionEventPager.page = value; loadSessionEvents() }" @size-change="value => { sessionEventPager.page = 1; sessionEventPager.pageSize = value; loadSessionEvents() }" />
  </el-drawer>
</template>

<style scoped>
.table-error { margin-bottom: 12px; }
:deep(.el-table .cell.no-ellipsis) { overflow: visible; text-overflow: clip; white-space: normal; }
.path-cell { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px; max-width: 100%; }
.path-crumb { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--el-text-color-primary); }
.path-crumb-arrow { flex: none; color: var(--el-text-color-placeholder); font-size: 12px; }
.path-toggle { display: inline-flex; align-items: center; gap: 2px; flex: none; margin-left: 2px; color: var(--el-color-primary); cursor: pointer; font-size: 12px; user-select: none; }
.path-toggle:hover { color: var(--el-color-primary-light-3); }
.path-toggle-arrow { font-size: 12px; transition: transform .2s; }
.path-toggle.is-expanded .path-toggle-arrow { transform: rotate(180deg); }
.path-expand { padding: 4px 8px; }
.path-expand-title { font-size: 12px; color: var(--el-text-color-secondary); margin-bottom: 8px; }
.path-expand-body { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.dashboard-current { margin-top: 14px; }
.dashboard-insight { margin-top: 14px; }
</style>
