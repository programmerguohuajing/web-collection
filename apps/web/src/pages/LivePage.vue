<script setup>
import { computed, onMounted, ref } from 'vue'
import EventTable from '../components/EventTable.vue'
import SearchPanel from '../components/SearchPanel.vue'
import KpiGrid from '../components/KpiGrid.vue'
import { api, normalizePageResponse, queryFromFilters, pageLoading } from '../dashboard.js'

const events = ref([])
const initialLoading = ref(false)
const liveError = ref('')
const detailRow = ref(null)
const detailOpen = ref(false)

function openDetail(row) {
  detailRow.value = row || null
  detailOpen.value = true
}
const total = ref(0)
const totalEstimated = ref(false)
const page = ref(1)
const pageSize = ref(10)
const liveKpis = computed(() => [
  { label: '近 5 分钟会话', value: events.value.filter(item => item.sessionId || item.session_id).length.toLocaleString(), delta: '实时', valueClass: 'value-primary' },
  { label: '近 5 分钟事件', value: `${totalEstimated.value ? '约 ' : ''}${Number(total.value || events.value.length).toLocaleString()}`, delta: totalEstimated.value ? '大窗口估计值' : '实时事件流', valueClass: 'value-purple' },
  { label: '实时在线', value: events.value.filter(item => item.userId || item.user_id).length.toLocaleString(), delta: '实时', valueClass: 'value-success' },
  { label: '实时错误率', value: events.value.length ? `${Math.round(events.value.filter(item => item.type === 'error').length / events.value.length * 10000) / 100}%` : '-', delta: '当前窗口', valueClass: 'value-danger' }
])
let pollInFlight = false

async function pollLive() {
  if (pollInFlight) return
  pollInFlight = true
  initialLoading.value = true
  liveError.value = ''
  pageLoading.value = true
  try {
    // 筛选条件来自全局 filters（SearchPanel 写入）；此处只传分页参数。
    // 2026-10-14 深度测试 P1-1 修复：此前本地 query（全空字符串）在 spread 中
    // 后覆盖全局 filters，导致 URL/用户/关键字筛选点查询毫无效果。
    const suffix = queryFromFilters({ page: page.value, pageSize: pageSize.value })
    const data = await api(`/api/events?${suffix}&type=error,perf,behavior&_t=${Date.now()}`, { requestKey: 'live:events' })
    const normalized = normalizePageResponse(data, { page: page.value, pageSize: pageSize.value })
    events.value = normalized.items.filter(item => item && (item.type || item.name || item.ts))
    total.value = normalized.total
    totalEstimated.value = normalized.totalEstimated
    pageSize.value = normalized.pageSize
    page.value = normalized.page
  } catch (error) {
    if (error?.code !== 'ABORT_ERR') {
      liveError.value = error.message || '实时事件加载失败'
      if (!events.value.length) total.value = 0
    }
  } finally {
    pollInFlight = false
    initialLoading.value = false
    pageLoading.value = false
  }
}

function onSearch() { page.value = 1; void pollLive() }

// 按需求取消定时轮询：数据仅在进入页面、搜索/翻页或点击「立即刷新」时拉取，
// 不再每 10 秒自动请求，减少对采集接口与 D1 的持续压力。
onMounted(() => { void pollLive() })
</script>

<template>
  <KpiGrid :items="liveKpis" />
  <SearchPanel :fields="['path', 'userId', 'keyword']" @search="onSearch" />
  <div class="live-toolbar">
    <span class="live-hint">已取消自动轮询，点击「立即刷新」获取最新事件</span>
    <el-button :loading="initialLoading" size="small" type="primary" plain @click="pollLive">立即刷新</el-button>
  </div>
  <el-alert v-if="liveError" class="table-error" type="error" :title="liveError" show-icon :closable="false"><template #default><el-button link type="primary" @click="pollLive">重试</el-button></template></el-alert>
  <EventTable title="实时事件" :rows="events" :loading="initialLoading" :total="total" :page="page" :page-size="pageSize" stream clickable @page-change="page = $event; pollLive()" @size-change="pageSize = $event; page = 1; pollLive()" @row-click="openDetail" />
  <!-- 事件详情（2026-10-14 深度测试 P1-5）：此前点击行无任何反应 -->
  <el-dialog v-model="detailOpen" title="事件详情" width="640px" append-to-body>
    <el-descriptions v-if="detailRow" :column="1" border size="small">
      <el-descriptions-item label="时间">{{ detailRow.ts ? new Date(detailRow.ts).toLocaleString() : '-' }}</el-descriptions-item>
      <el-descriptions-item label="类型">{{ detailRow.type || '-' }}</el-descriptions-item>
      <el-descriptions-item label="名称">{{ detailRow.name || detailRow.message || detailRow.metric || '-' }}</el-descriptions-item>
      <el-descriptions-item label="页面">{{ detailRow.path || detailRow.url || '-' }}</el-descriptions-item>
      <el-descriptions-item label="用户">{{ detailRow.userName || detailRow.userId || detailRow.userPhone || '-' }}</el-descriptions-item>
      <el-descriptions-item label="会话">{{ detailRow.sessionId || detailRow.session_id || '-' }}</el-descriptions-item>
      <el-descriptions-item label="版本">{{ detailRow.release || '-' }}</el-descriptions-item>
      <el-descriptions-item label="消息">{{ detailRow.message || '-' }}</el-descriptions-item>
    </el-descriptions>
    <pre v-if="detailRow" class="event-raw">{{ JSON.stringify(detailRow, null, 2) }}</pre>
  </el-dialog>
</template>

<style scoped>
.table-error { margin-bottom: 12px; }
.live-toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.live-hint { font-size: 12px; color: var(--el-text-color-secondary); }
.event-raw { max-height: 320px; margin-top: 16px; padding: 12px; overflow: auto; font-family: var(--font-mono); font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-all; background: var(--c-surface-2); border-radius: 8px; }
</style>
