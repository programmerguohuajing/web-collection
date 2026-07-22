<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, queryFromFilters } from '../../../dashboard.js'
import SearchPanel from '../../../components/SearchPanel.vue'

const router = useRouter()
const route = useRoute()
const tab = ref('sessions')
const loading = ref(false)
const sessions = ref([])
const sessionEvents = ref([])
const activeSession = ref(null)
const paths = ref([])
const live = ref({})
const releases = ref([])
const funnels = ref([])
const funnelResult = ref(null)
const dashboards = ref([])
const selectedDashboardId = ref(null)
const funnelForm = reactive({ name: '', appId: '', stepsText: '' })
const dashboardForm = reactive({ name: '', widgets: ['live', 'sessions', 'errors', 'releases'] })
let timer = 0

const activeDashboard = computed(() => dashboards.value.find(item => item.id === selectedDashboardId.value) || dashboards.value[0])

async function load() {
  loading.value = true
  try {
    const query = queryFromFilters()
    ;[sessions.value, paths.value, live.value, releases.value, funnels.value, dashboards.value] = await Promise.all([
      api(`/api/analytics/sessions?${query}`), api(`/api/analytics/paths?${query}`), api(`/api/analytics/live?${query}`), api(`/api/analytics/releases?${query}`), api('/api/funnels'), api('/api/dashboards')
    ])
  } finally { loading.value = false }
}

async function saveFunnel() {
  await api('/api/funnels', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...funnelForm, steps: funnelForm.stepsText.split(/[,\n]/) }) })
  funnelForm.name = ''; funnelForm.stepsText = ''; await load()
}
async function run(item) { funnelResult.value = await api(`/api/funnels/${item.id}/run?${queryFromFilters()}`) }
async function saveDashboard() { await api('/api/dashboards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(dashboardForm) }); dashboardForm.name = ''; await load() }
function replay(id) { router.push({ path: '/replays', query: { replayId: id } }) }
async function openSession(row) { activeSession.value = row; sessionEvents.value = await api(`/api/analytics/sessions/${encodeURIComponent(row.session_id)}`) }

onMounted(() => { load(); timer = window.setInterval(async () => { live.value = await api(`/api/analytics/live?${queryFromFilters()}`) }, 30000) })
onBeforeUnmount(() => clearInterval(timer))
watch(() => route.query, query => { if (query.tab) tab.value = query.tab; load() }, { immediate: true })
</script>

<template>
  <SearchPanel :fields="['userId']" />
  <div class="metrics section">
    <el-card><span>近 5 分钟会话</span><strong>{{ live.sessions || 0 }}</strong></el-card>
    <el-card><span>近 5 分钟用户</span><strong>{{ live.users || 0 }}</strong></el-card>
    <el-card><span>近 5 分钟事件</span><strong>{{ live.events || 0 }}</strong></el-card>
    <el-card><span>历史会话样本</span><strong>{{ sessions.length }}</strong></el-card>
  </div>
  <el-tabs v-model="tab" v-loading="loading" class="panel section analytics-tabs">
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
    </el-tab-pane>
    <el-tab-pane label="用户路径" name="paths">
      <el-table :data="paths" border><el-table-column prop="path" label="路径" min-width="500" /><el-table-column prop="count" label="会话数" width="120" /></el-table>
    </el-tab-pane>
    <el-tab-pane label="漏斗分析" name="funnels">
      <el-form inline @submit.prevent="saveFunnel"><el-form-item label="名称"><el-input v-model="funnelForm.name" /></el-form-item><el-form-item label="应用"><el-input v-model="funnelForm.appId" /></el-form-item><el-form-item label="步骤"><el-input v-model="funnelForm.stepsText" placeholder="view,add_cart,pay" style="width:320px" /></el-form-item><el-button type="primary" @click="saveFunnel">保存漏斗</el-button></el-form>
      <el-table :data="funnels" border empty-text="暂无漏斗，请填写名称和至少两个步骤后保存"><el-table-column prop="name" label="名称" /><el-table-column prop="app_id" label="应用" /><el-table-column label="步骤"><template #default="{ row }">{{ row.steps_json?.join(' → ') }}</template></el-table-column><el-table-column label="操作" width="100"><template #default="{ row }"><el-button link type="primary" @click="run(row)">分析</el-button></template></el-table-column></el-table>
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
      <el-select v-model="selectedDashboardId" clearable placeholder="选择仪表盘" class="section" style="width:240px"><el-option v-for="item in dashboards" :key="item.id" :label="item.name" :value="item.id" /></el-select>
      <el-form inline><el-form-item label="名称"><el-input v-model="dashboardForm.name" /></el-form-item><el-form-item label="组件"><el-checkbox-group v-model="dashboardForm.widgets"><el-checkbox v-for="item in ['live','sessions','errors','releases']" :key="item" :value="item">{{ item }}</el-checkbox></el-checkbox-group></el-form-item><el-button type="primary" @click="saveDashboard">保存</el-button></el-form>
      <el-alert v-if="activeDashboard" :title="`当前仪表盘：${activeDashboard.name}（${activeDashboard.widgets_json?.join('、')}）`" type="success" :closable="false" />
      <div v-if="activeDashboard" class="metrics section custom-dashboard">
        <el-card v-if="activeDashboard.widgets_json?.includes('live')"><span>在线用户</span><strong>{{ live.users || 0 }}</strong></el-card>
        <el-card v-if="activeDashboard.widgets_json?.includes('sessions')"><span>会话数</span><strong>{{ sessions.length }}</strong></el-card>
        <el-card v-if="activeDashboard.widgets_json?.includes('errors')"><span>会话错误数</span><strong>{{ sessions.reduce((sum, item) => sum + item.error_count, 0) }}</strong></el-card>
        <el-card v-if="activeDashboard.widgets_json?.includes('releases')"><span>活跃版本</span><strong>{{ releases.length }}</strong></el-card>
      </div>
    </el-tab-pane>
  </el-tabs>
  <el-drawer v-model="activeSession" size="65%" title="用户会话详情"><el-table :data="sessionEvents" border><el-table-column label="时间" width="180"><template #default="{ row }">{{ new Date(row.ts).toLocaleString() }}</template></el-table-column><el-table-column prop="type" label="类型" width="100" /><el-table-column label="名称" width="160"><template #default="{ row }">{{ row.name || row.metric }}</template></el-table-column><el-table-column prop="message" label="内容" min-width="240" show-overflow-tooltip /><el-table-column prop="path" label="页面" min-width="220" /></el-table></el-drawer>
</template>
