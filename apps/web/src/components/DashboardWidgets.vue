<script setup>
/**
 * DashboardWidgets — 自定义仪表盘只读挂件渲染组件（自包含）。
 *
 * 抽出自 apps/web/src/views/monitor/analytics/index.vue 的「按 widgets_json 渲染挂件」逻辑，
 * 使母页（自定义仪表盘 Tab）与嵌入页（/embed/dashboard/:token）共用同一渲染口径，避免视图漂移。
 *
 * 本组件自带数据加载：onMounted 时拉取 live/funnels/insights/基础 KPI，并触发 loadDashboardResults()。
 * 只读语义：不暴露原始事件/PII，仅渲染既有聚合接口结果。
 */
import { computed, onMounted, ref } from 'vue'
import { api, normalizePageResponse, queryFromFilters, toList } from '../dashboard.js'
import KpiGrid from './KpiGrid.vue'
import AnalyticsChart from './AnalyticsChart.vue'
import FunnelChart from './FunnelChart.vue'
import OverflowTip from './OverflowTip.vue'

const props = defineProps({
  // 看板定义，含 name / widgets_json
  dashboard: { type: Object, default: () => ({ name: '', widgets_json: [] }) },
  // 只读模式（当前无编辑入口，默认 true）
  readOnly: { type: Boolean, default: true }
})

const insights = ref([])
const funnels = ref([])
const live = ref({})
const releases = ref([])
const sessions = ref([])
const sessionPager = ref({ page: 1, pageSize: 10, total: 0 })
const dashboardResults = ref({})
const capabilities = ref({ insights: false, productAnalyticsV2: false, funnels: true, dashboards: true, paths: true, live: true, releases: true })
const loading = ref(false)
const error = ref('')

// 事件分析能力：优先读规范键 capabilities.insights，兼容旧键 productAnalyticsV2。
const insightsSupported = computed(() => Boolean(capabilities.value.insights ?? capabilities.value.productAnalyticsV2))

function setPaged(target, pager, data) {
  const normalized = normalizePageResponse(data, pager)
  target.value = normalized.items
  Object.assign(pager, normalized)
}
function widgetKey(widget) { return typeof widget === 'string' ? widget : `${widget.type}:${widget.id}` }
function insightById(id) { return insights.value.find(item => item.id === Number(id)) }
function funnelById(id) { return funnels.value.find(item => item.id === Number(id)) }
function widgetLabel(widget) {
  if (typeof widget === 'string') return ({ live: '实时用户', sessions: '会话数', errors: '错误数', releases: '活跃版本' })[widget] || widget
  return widget.type === 'insight' ? insightById(widget.id)?.name || `分析 ${widget.id}` : funnelById(widget.id)?.name || `漏斗 ${widget.id}`
}
function hasWidget(name) { return (props.dashboard?.widgets_json || []).some(widget => widgetKey(widget) === name) }

// 基础挂件 KPI 网格（live/sessions/errors/releases），与母页一致口径。
const dashboardKpis = computed(() => {
  const items = []
  if (hasWidget('live')) items.push({ label: '在线用户', value: Number(live.value?.users || 0).toLocaleString(), delta: '实时', valueClass: 'value-success' })
  if (hasWidget('sessions')) items.push({ label: '会话数', value: Number(sessionPager.value.total || 0).toLocaleString(), delta: '当前筛选范围', valueClass: 'value-primary' })
  if (hasWidget('errors')) items.push({ label: '当前页会话错误数', value: sessions.value.reduce((sum, item) => sum + (item.error_count || 0), 0).toLocaleString(), delta: '需关注', valueClass: 'value-danger' })
  if (hasWidget('releases')) items.push({ label: '活跃版本', value: Number(releases.value.length || 0).toLocaleString(), delta: '当前筛选范围', valueClass: 'value-purple' })
  return items
})

// 分析挂件（funnel/insight）结果加载，逻辑同母页 loadDashboardResults。
async function loadDashboardResults() {
  const widgets = props.dashboard?.widgets_json || []
  const results = {}
  // 基础组件：live 数据已通过 load() 中 /api/analytics/live 端点加载到 live.value，无需额外请求
  const stringWidgets = new Set(widgets.filter(widget => typeof widget === 'string'))
  if (stringWidgets.size) results._basic = true
  // 分析组件：从 API 加载
  await Promise.all(widgets.filter(widget => typeof widget === 'object').map(async widget => {
    const key = widgetKey(widget)
    if (widget.type === 'funnel') {
      // 统一走 /report 端点（/run 已废弃）
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

async function load() {
  loading.value = true
  error.value = ''
  try {
    capabilities.value = await api('/api/capabilities').catch(() => ({ insights: false, productAnalyticsV2: false, funnels: true, dashboards: true, paths: true, live: true, releases: true }))
    const query = queryFromFilters()
    const sessionData = await api(`/api/analytics/sessions?${queryFromFilters({ page: sessionPager.value.page, pageSize: sessionPager.value.pageSize })}`)
    const [liveData, releaseData, eventNameData, funnelData, dashboardData, insightData] = await Promise.all([
      api(`/api/analytics/live?${query}`),
      api(`/api/analytics/releases?${query}`),
      api(`/api/analytics/event-names?${queryFromFilters({}, ['appId', 'release', 'range'])}`),
      api(`/api/funnels?page=1&pageSize=1000`),
      api('/api/dashboards'),
      insightsSupported.value ? api('/api/analytics/insights') : []
    ])
    // dashboardData 在本组件仅用于对齐母页请求顺序（看板定义已由 props 传入），不另行处理
    void dashboardData
    void eventNameData
    setPaged(sessions, sessionPager, sessionData)
    live.value = liveData?.data && typeof liveData.data === 'object' ? liveData.data : (liveData || {})
    releases.value = normalizePageResponse(releaseData).items.map(normalizeReleaseRow)
    funnels.value = normalizePageResponse(funnelData).items
    insights.value = toList(insightData)
    await loadDashboardResults()
  } catch (e) {
    error.value = e?.message || '看板数据加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="dashboard-widgets">
    <el-alert v-if="error" class="table-error" type="error" :title="error" show-icon :closable="false">
      <template #default><el-button link type="primary" @click="load">重试</el-button></template>
    </el-alert>
    <el-alert v-else-if="loading" class="dashboard-loading" type="info" :closable="false" show-icon title="看板加载中…" />
    <template v-else>
      <KpiGrid v-if="dashboardKpis.length" :items="dashboardKpis" />
      <template v-for="widget in dashboard?.widgets_json || []" :key="widgetKey(widget)">
        <el-card v-if="typeof widget === 'object' && dashboardResults[widgetKey(widget)]" class="section dashboard-insight" shadow="never">
          <template #header><b>{{ widgetLabel(widget) }}</b></template>
          <AnalyticsChart v-if="widget.type === 'insight'" :kind="insightById(widget.id)?.kind === 'path' ? 'path' : 'trend'" :result="dashboardResults[widgetKey(widget)]" />
          <FunnelChart v-else :steps="dashboardResults[widgetKey(widget)].steps" />
        </el-card>
      </template>
    </template>
  </div>
</template>

<style scoped>
.table-error { margin-bottom: 12px; }
.dashboard-loading { margin-bottom: 12px; }
.dashboard-insight { margin-top: 14px; }
</style>
