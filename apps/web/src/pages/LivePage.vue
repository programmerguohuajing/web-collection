<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import EventTable from '../components/EventTable.vue'
import SearchPanel from '../components/SearchPanel.vue'
import { api, normalizePageResponse, queryFromFilters, pageLoading } from '../dashboard.js'

const events = ref([])
const initialLoading = ref(false)
const liveError = ref('')
const total = ref(0)
const page = ref(1)
const pageSize = ref(10)
const query = reactive({ userId: '', path: '', keyword: '' })
let pollTimer = 0
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

onMounted(() => {
  void pollLive()
  pollTimer = setInterval(() => { void pollLive() }, 10000)
})

onBeforeUnmount(() => clearInterval(pollTimer))
</script>

<template>
  <div class="page-heading"><div><h1>实时监控</h1><p>最近事件流与系统状态</p></div><div><el-button :loading="initialLoading" @click="pollLive">刷新</el-button></div></div>
  <el-card shadow="never" class="section panel">
    <SearchPanel :fields="['path', 'userId', 'keyword']" @search="onSearch" />
    <el-alert v-if="liveError" class="table-error" type="error" :title="liveError" show-icon :closable="false"><template #default><el-button link type="primary" @click="pollLive">重试</el-button></template></el-alert>
    <EventTable title="实时事件" :rows="events" :loading="initialLoading" :total="total" :page="page" :page-size="pageSize" stream @page-change="page = $event; pollLive()" @size-change="pageSize = $event; page = 1; pollLive()" />
  </el-card>
</template>

<style scoped>
.table-error { margin-bottom: 12px; }
</style>
