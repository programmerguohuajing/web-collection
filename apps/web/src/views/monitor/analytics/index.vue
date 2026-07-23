<script setup>
import { ElMessageBox } from 'element-plus'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, queryFromFilters, refreshVersion } from '../../../dashboard.js'
import AnalyticsChart from '../../../components/AnalyticsChart.vue'
import EventInsightPanel from '../../../components/EventInsightPanel.vue'
import PathInsightPanel from '../../../components/PathInsightPanel.vue'
import SearchPanel from '../../../components/SearchPanel.vue'

const router = useRouter()
const route = useRoute()
const filterQueryNames = ['appId', 'release', 'startTime', 'endTime', 'path', 'userId', 'userName', 'userPhone', 'keyword', 'type', 'status']
const tab = ref('sessions')
const loading = ref(false)
const sessions = ref([])
const sessionEvents = ref([])
const activeSession = ref(null)
const paths = ref([])
const live = ref({})
const releases = ref([])
const funnels = ref([])
const funnelEventNames = ref([])
const funnelResult = ref(null)
const dashboards = ref([])
const insights = ref([])
const capabilities = ref({ productAnalyticsV2: false })
const dashboardResults = ref({})
const selectedDashboardId = ref(null)
const sessionPager = reactive({ page: 1, pageSize: 10, total: 0 })
const sessionEventPager = reactive({ page: 1, pageSize: 10, total: 0 })
const funnelPager = reactive({ page: 1, pageSize: 10, total: 0 })
const funnelForm = reactive({ name: '', appId: '', steps: [emptyFunnelStep(), emptyFunnelStep()] })
const dashboardForm = reactive({ name: '', widgets: ['live', 'sessions', 'errors', 'releases'] })
let timer = 0

const activeDashboard = computed(() => dashboards.value.find(item => item.id === selectedDashboardId.value) || dashboards.value[0])
const insightOptions = computed(() => insights.value.map(item => ({ label: item.name, value: `insight:${item.id}` })))
const funnelOptions = computed(() => funnels.value.map(item => ({ label: item.name, value: `funnel:${item.id}` })))
const filterKey = computed(() => JSON.stringify(filterQueryNames.map(name => route.query[name] || '')))

function setPaged(target, pager, data) {
  target.value = data.items
  Object.assign(pager, { page: data.page, pageSize: data.pageSize, total: data.total })
}
async function loadSessions() {
  setPaged(sessions, sessionPager, await api(`/api/analytics/sessions?${queryFromFilters({ page: sessionPager.page, pageSize: sessionPager.pageSize })}`))
}
async function loadFunnels() {
  setPaged(funnels, funnelPager, await api(`/api/funnels?page=${funnelPager.page}&pageSize=${funnelPager.pageSize}`))
}
async function loadInsights() {
  insights.value = capabilities.value.productAnalyticsV2 ? await api('/api/analytics/insights') : []
}
async function refreshInsights() {
  await Promise.all([loadInsights(), api('/api/dashboards').then(data => { dashboards.value = data })])
  await loadDashboardResults()
}
async function load() {
  loading.value = true
  try {
    capabilities.value = await api('/api/capabilities').catch(() => ({ productAnalyticsV2: false }))
    const query = queryFromFilters()
    const [, pathData, liveData, releaseData, eventNameData, , dashboardData, insightData] = await Promise.all([
      loadSessions(), api(`/api/analytics/paths?${query}`), api(`/api/analytics/live?${query}`), api(`/api/analytics/releases?${query}`), api(`/api/analytics/event-names?${queryFromFilters({}, ['appId', 'release', 'range'])}`), loadFunnels(), api('/api/dashboards')
      , capabilities.value.productAnalyticsV2 ? api('/api/analytics/insights') : []
    ])
    paths.value = pathData
    live.value = liveData
    releases.value = releaseData
    funnelEventNames.value = eventNameData
    dashboards.value = dashboardData
    insights.value = insightData
    if (!selectedDashboardId.value && dashboardData[0]) selectedDashboardId.value = dashboardData[0].id
    await loadDashboardResults()
  } finally { loading.value = false }
}

async function saveFunnel() {
  const selectedSteps = funnelForm.steps.filter(step => step.eventName)
  const steps = capabilities.value.productAnalyticsV2 ? selectedSteps.map(step => ({
    eventName: step.eventName,
    filters: step.filterField && (step.filterOperator === 'exists' || step.filterValue)
      ? [{ field: step.filterField.startsWith('props.') ? step.filterField : `props.${step.filterField}`, operator: step.filterOperator, value: step.filterOperator === 'in' ? step.filterValue.split(',').map(value => value.trim()).filter(Boolean) : step.filterValue }]
      : []
  })) : selectedSteps.map(step => step.eventName)
  await api('/api/funnels', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...funnelForm, steps }) })
  funnelForm.name = ''; funnelForm.steps = [emptyFunnelStep(), emptyFunnelStep()]; funnelPager.page = 1; await loadFunnels()
}
async function run(item) { funnelResult.value = await api(`/api/funnels/${item.id}/run?${queryFromFilters()}`) }
async function removeFunnel(item) {
  const confirmed = await ElMessageBox.confirm(`确定删除漏斗“${item.name}”吗？`, '删除漏斗', { type: 'warning' }).then(() => true).catch(() => false)
  if (!confirmed) return
  await api(`/api/funnels/${item.id}`, { method: 'DELETE' })
  if (funnelResult.value?.definition?.id === item.id) funnelResult.value = null
  if (funnels.value.length === 1 && funnelPager.page > 1) funnelPager.page--
  await loadFunnels()
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
function emptyFunnelStep() {
  return { eventName: '', filterField: '', filterOperator: 'eq', filterValue: '' }
}
function stepName(step) { return typeof step === 'string' ? step : step?.eventName || '-' }
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
  await Promise.all(widgets.filter(widget => typeof widget === 'object').map(async widget => {
    const key = widgetKey(widget)
    if (widget.type === 'funnel') results[key] = await api(`/api/funnels/${widget.id}/run?${queryFromFilters()}`)
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
function replay(id) { router.push({ path: '/replays', query: { replayId: id } }) }
async function loadSessionEvents() {
  setPaged(sessionEvents, sessionEventPager, await api(`/api/analytics/sessions/${encodeURIComponent(activeSession.value.session_id)}?page=${sessionEventPager.page}&pageSize=${sessionEventPager.pageSize}`))
}
async function openSession(row) {
  if (!row.session_id?.trim()) return
  activeSession.value = row
  sessionEventPager.page = 1
  await loadSessionEvents()
}
async function changeTab(name) {
  if (route.query.tab === name) return
  await router.replace({ path: route.path, query: { ...route.query, tab: name } })
}

onMounted(() => { timer = window.setInterval(async () => { live.value = await api(`/api/analytics/live?${queryFromFilters()}`) }, 30000) })
onBeforeUnmount(() => clearInterval(timer))
watch(() => route.query.tab, value => { if (value) tab.value = value }, { immediate: true })
watch([filterKey, refreshVersion], () => { sessionPager.page = 1; load() }, { immediate: true })
watch(selectedDashboardId, loadDashboardResults)
</script>

<template>
  <SearchPanel :fields="['userId']" />
  <div class="metrics section">
    <el-card><span>近 5 分钟会话</span><strong>{{ live.sessions || 0 }}</strong></el-card>
    <el-card><span>近 5 分钟用户</span><strong>{{ live.users || 0 }}</strong></el-card>
    <el-card><span>近 5 分钟事件</span><strong>{{ live.events || 0 }}</strong></el-card>
    <el-card><span>历史会话样本</span><strong>{{ sessionPager.total }}</strong></el-card>
  </div>
  <el-tabs v-model="tab" v-loading="loading" class="panel section analytics-tabs" @tab-change="changeTab">
    <el-tab-pane v-if="capabilities.productAnalyticsV2" label="事件分析" name="insights">
      <EventInsightPanel :event-names="funnelEventNames" :insights="insights" @changed="refreshInsights" />
    </el-tab-pane>
    <el-tab-pane label="用户会话" name="sessions">
      <el-table :data="sessions" border @row-click="openSession">
        <el-table-column prop="user_name" label="用户" width="130"><template #default="{ row }">{{ row.user_name || row.user_id || row.device_id }}</template></el-table-column>
        <el-table-column prop="session_id" label="会话" min-width="200" show-overflow-tooltip />
        <el-table-column label="开始时间" width="180"><template #default="{ row }">{{ new Date(row.started_at).toLocaleString() }}</template></el-table-column>
        <el-table-column prop="duration" label="时长(ms)" width="110" />
        <el-table-column prop="event_count" label="事件" width="80" />
        <el-table-column prop="error_count" label="错误" width="80" />
        <el-table-column prop="paths" label="访问页面" min-width="260"><template #default="{ row }">{{ row.paths?.join(' → ') }}</template></el-table-column>
        <el-table-column label="回放" width="80"><template #default="{ row }"><el-button v-if="row.replaySessionId" link type="primary" @click="replay(row.replaySessionId)">播放</el-button></template></el-table-column>
      </el-table>
      <el-pagination class="pager" background layout="sizes, prev, pager, next, total" :current-page="sessionPager.page" :page-size="sessionPager.pageSize" :page-sizes="[10, 20, 50, 100]" :total="sessionPager.total" @current-change="value => { sessionPager.page = value; loadSessions() }" @size-change="value => { sessionPager.page = 1; sessionPager.pageSize = value; loadSessions() }" />
    </el-tab-pane>
    <el-tab-pane label="用户路径" name="paths">
      <PathInsightPanel v-if="capabilities.productAnalyticsV2" :insights="insights" @changed="refreshInsights" />
      <el-table v-else :data="paths" border><el-table-column prop="path" label="路径" min-width="500" /><el-table-column prop="count" label="会话数" width="120" /></el-table>
    </el-tab-pane>
    <el-tab-pane label="漏斗分析" name="funnels">
      <el-form inline @submit.prevent="saveFunnel"><el-form-item label="名称"><el-input v-model="funnelForm.name" /></el-form-item><el-form-item label="应用"><el-input v-model="funnelForm.appId" /></el-form-item><el-button type="primary" @click="saveFunnel">保存漏斗</el-button></el-form>
      <div v-for="(step, index) in funnelForm.steps" :key="index" class="funnel-step">
        <b>步骤 {{ index + 1 }}</b>
        <el-select v-model="step.eventName" filterable placeholder="选择事件"><el-option v-for="item in funnelEventNames" :key="item.name" :label="`${item.name}（${item.count}）`" :value="item.name" /></el-select>
        <el-input v-if="capabilities.productAnalyticsV2" v-model="step.filterField" placeholder="可选属性，如 plan" />
        <el-select v-if="capabilities.productAnalyticsV2" v-model="step.filterOperator"><el-option label="等于" value="eq" /><el-option label="属于集合" value="in" /><el-option label="已设置" value="exists" /></el-select>
        <el-input v-if="capabilities.productAnalyticsV2 && step.filterOperator !== 'exists'" v-model="step.filterValue" placeholder="过滤值" />
        <el-button v-if="funnelForm.steps.length > 2" link type="danger" @click="funnelForm.steps.splice(index,1)">删除</el-button>
      </div>
      <el-button link type="primary" :disabled="funnelForm.steps.length >= 10" @click="funnelForm.steps.push(emptyFunnelStep())">+ 添加步骤</el-button>
      <el-space wrap class="section"><span>可选步骤（{{ funnelEventNames.length }}）：</span><el-tag v-for="item in funnelEventNames" :key="item.name" type="info">{{ item.name }}（{{ item.count }}）</el-tag></el-space>
      <el-table :data="funnels" border empty-text="暂无漏斗，请填写名称和至少两个步骤后保存"><el-table-column prop="name" label="名称" /><el-table-column prop="app_id" label="应用" /><el-table-column label="步骤"><template #default="{ row }">{{ row.steps_json?.map(stepName).join(' → ') }}</template></el-table-column><el-table-column label="操作" width="140"><template #default="{ row }"><el-button link type="primary" @click="run(row)">分析</el-button><el-button link type="danger" @click="removeFunnel(row)">删除</el-button></template></el-table-column></el-table>
      <el-pagination class="pager" background layout="sizes, prev, pager, next, total" :current-page="funnelPager.page" :page-size="funnelPager.pageSize" :page-sizes="[10, 20, 50, 100]" :total="funnelPager.total" @current-change="value => { funnelPager.page = value; loadFunnels() }" @size-change="value => { funnelPager.page = 1; funnelPager.pageSize = value; loadFunnels() }" />
      <template v-if="funnelResult">
        <h2 class="analysis-title">转化与流失</h2>
        <el-table :data="funnelResult.steps" border><el-table-column prop="step" label="步骤" /><el-table-column prop="count" label="用户数" /><el-table-column prop="rate" label="转化率(%)" /><el-table-column prop="lost" label="流失" /></el-table>
        <h2 class="analysis-title">每日趋势</h2>
        <el-table :data="funnelResult.trend" border><el-table-column prop="date" label="日期" /><el-table-column prop="entered" label="进入" /><el-table-column prop="converted" label="完成" /></el-table>
        <h2 class="analysis-title">流失会话</h2>
        <el-table :data="funnelResult.lostSessions" border><el-table-column prop="actor" label="用户" /><el-table-column prop="lastEvent" label="最后步骤" /><el-table-column prop="errors" label="错误" /><el-table-column prop="sessionId" label="会话" /><el-table-column label="回放"><template #default="{ row }"><el-button v-if="row.replaySessionId" link type="primary" @click="replay(row.replaySessionId)">播放</el-button></template></el-table-column></el-table>
        <h2 class="analysis-title">版本 / 浏览器 / 设备维度</h2>
        <el-table v-for="dimension in funnelResult.dimensions" :key="dimension.field" :data="dimension.items" border class="section"><el-table-column :label="dimension.field" prop="name" /><el-table-column prop="entered" label="进入" /><el-table-column prop="converted" label="完成" /></el-table>
      </template>
    </el-tab-pane>
    <el-tab-pane label="版本对比" name="releases">
      <el-table :data="releases" border><el-table-column prop="release" label="版本" /><el-table-column prop="events" label="事件" /><el-table-column prop="users" label="用户" /><el-table-column prop="errors" label="错误" /><el-table-column prop="lcp" label="平均 LCP" /></el-table>
    </el-tab-pane>
    <el-tab-pane label="自定义仪表盘" name="dashboards">
      <el-space class="section"><el-select v-model="selectedDashboardId" clearable placeholder="选择仪表盘" style="width:240px"><el-option v-for="item in dashboards" :key="item.id" :label="item.name" :value="item.id" /></el-select><el-button type="danger" plain :disabled="!selectedDashboardId" @click="removeDashboard">删除仪表盘</el-button></el-space>
      <el-form><el-form-item label="名称"><el-input v-model="dashboardForm.name" style="width:260px" /></el-form-item><el-form-item label="基础组件"><el-checkbox-group v-model="dashboardForm.widgets"><el-checkbox v-for="item in ['live','sessions','errors','releases']" :key="item" :value="item">{{ widgetLabel(item) }}</el-checkbox></el-checkbox-group></el-form-item><el-form-item v-if="insightOptions.length" label="分析组件"><el-checkbox-group v-model="dashboardForm.widgets"><el-checkbox v-for="item in insightOptions" :key="item.value" :value="item.value">{{ item.label }}</el-checkbox></el-checkbox-group></el-form-item><el-form-item v-if="capabilities.productAnalyticsV2 && funnelOptions.length" label="漏斗组件"><el-checkbox-group v-model="dashboardForm.widgets"><el-checkbox v-for="item in funnelOptions" :key="item.value" :value="item.value">{{ item.label }}</el-checkbox></el-checkbox-group></el-form-item><el-button type="primary" @click="saveDashboard">保存仪表盘</el-button></el-form>
      <el-alert v-if="activeDashboard" :title="`当前仪表盘：${activeDashboard.name}（${activeDashboard.widgets_json?.map(widgetLabel).join('、')}）`" type="success" :closable="false" />
      <div v-if="activeDashboard" class="metrics section custom-dashboard">
        <el-card v-if="hasWidget('live')"><span>在线用户</span><strong>{{ live.users || 0 }}</strong></el-card>
        <el-card v-if="hasWidget('sessions')"><span>会话数</span><strong>{{ sessionPager.total }}</strong></el-card>
        <el-card v-if="hasWidget('errors')"><span>当前页会话错误数</span><strong>{{ sessions.reduce((sum, item) => sum + item.error_count, 0) }}</strong></el-card>
        <el-card v-if="hasWidget('releases')"><span>活跃版本</span><strong>{{ releases.length }}</strong></el-card>
      </div>
      <template v-for="widget in activeDashboard?.widgets_json || []" :key="widgetKey(widget)">
        <el-card v-if="typeof widget === 'object' && dashboardResults[widgetKey(widget)]" class="section dashboard-insight" shadow="never">
          <template #header><b>{{ widgetLabel(widget) }}</b></template>
          <AnalyticsChart v-if="widget.type === 'insight'" :kind="insightById(widget.id)?.kind === 'path' ? 'path' : 'trend'" :result="dashboardResults[widgetKey(widget)]" />
          <el-table v-else :data="dashboardResults[widgetKey(widget)].steps" border><el-table-column prop="step" label="步骤" /><el-table-column prop="count" label="用户数" /><el-table-column prop="rate" label="转化率(%)" /><el-table-column prop="lost" label="流失" /></el-table>
        </el-card>
      </template>
    </el-tab-pane>
  </el-tabs>
  <el-drawer v-model="activeSession" size="65%" title="用户会话详情">
    <el-table :data="sessionEvents" border><el-table-column label="时间" width="180"><template #default="{ row }">{{ new Date(row.ts).toLocaleString() }}</template></el-table-column><el-table-column prop="type" label="类型" width="100" /><el-table-column label="名称" width="160"><template #default="{ row }">{{ row.name || row.metric }}</template></el-table-column><el-table-column prop="message" label="内容" min-width="240" show-overflow-tooltip /><el-table-column prop="path" label="页面" min-width="220" /></el-table>
    <el-pagination class="pager" background layout="sizes, prev, pager, next, total" :current-page="sessionEventPager.page" :page-size="sessionEventPager.pageSize" :page-sizes="[10, 20, 50, 100]" :total="sessionEventPager.total" @current-change="value => { sessionEventPager.page = value; loadSessionEvents() }" @size-change="value => { sessionEventPager.page = 1; sessionEventPager.pageSize = value; loadSessionEvents() }" />
  </el-drawer>
</template>

<style scoped>
.funnel-step { display: grid; grid-template-columns: 70px 1.2fr 1fr 130px 1fr 55px; gap: 8px; align-items: center; margin-bottom: 8px; }
.dashboard-insight { margin-top: 14px; }
@media (max-width: 900px) { .funnel-step { grid-template-columns: 70px 1fr; } }
</style>
