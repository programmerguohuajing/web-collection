<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import EventTable from '../components/EventTable.vue'
import SearchPanel from '../components/SearchPanel.vue'
import KpiGrid from '../components/KpiGrid.vue'
import { api, normalizePageResponse, queryFromFilters, pageLoading } from '../dashboard.js'

const events = ref([])
const initialLoading = ref(false)
const liveError = ref('')
const total = ref(0)
const page = ref(1)
const pageSize = ref(10)
const query = reactive({ userId: '', path: '', keyword: '' })
const liveKpis = computed(() => [
  { label: '近 5 分钟会话', value: events.value.filter(item => item.sessionId || item.session_id).length.toLocaleString(), delta: '实时', valueClass: 'value-primary' },
  { label: '近 5 分钟事件', value: Number(total.value || events.value.length).toLocaleString(), delta: '实时事件流', valueClass: 'value-purple' },
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
    const suffix = queryFromFilters({ ...query, page: page.value, pageSize: pageSize.value })
    const data = await api(`/api/events?${suffix}&type=error,perf,behavior&_t=${Date.now()}`, { requestKey: 'live:events' })
    const normalized = normalizePageResponse(data, { page: page.value, pageSize: pageSize.value })
    events.value = normalized.items.filter(item => item && (item.type || item.name || item.ts))
    total.value = normalized.total
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
  <EventTable title="实时事件" :rows="events" :loading="initialLoading" :total="total" :page="page" :page-size="pageSize" stream @page-change="page = $event; pollLive()" @size-change="pageSize = $event; page = 1; pollLive()" />
</template>

<style scoped>
.table-error { margin-bottom: 12px; }
.live-toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.live-hint { font-size: 12px; color: var(--el-text-color-secondary); }
</style>
