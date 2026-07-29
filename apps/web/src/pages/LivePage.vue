<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import EventTable from '../components/EventTable.vue'
import SearchPanel from '../components/SearchPanel.vue'
import { api, queryFromFilters } from '../dashboard.js'

const events = ref([])
const initialLoading = ref(false)
const pager = reactive({ page: 1, pageSize: 10, total: 0 })
const query = reactive({ userId: '', path: '', keyword: '' })
let pollTimer = 0

async function pollLive() {
  initialLoading.value = true
  try {
    const suffix = queryFromFilters({ ...query, page: pager.page, pageSize: pager.pageSize })
    const data = await api(`/api/events?${suffix}&type=error,perf,behavior&_t=${Date.now()}`)
    const newItems = (data.items || []).filter(item => item && (item.type || item.name || item.ts))
    const existingIds = new Set(events.value.map(e => `${e.session_id}_${e.ts}_${e.type}_${e.name}`))
    for (const item of newItems) {
      const key = `${item.session_id}_${item.ts}_${item.type}_${item.name}`
      if (!existingIds.has(key)) events.value.unshift(item)
    }
    if (events.value.length > 200) events.value.splice(200)
  } finally {
    initialLoading.value = false
  }
}

function onSearch() { pager.page = 1; pollLive() }
function togglePause() { /* handled by user */ }

onMounted(() => {
  pollLive()
  pollTimer = setInterval(pollLive, 10000)
})

onBeforeUnmount(() => {
  clearInterval(pollTimer)
})
</script>

<template>
  <div class="page-heading"><div><h1>实时监控</h1><p>最近事件流与系统状态</p></div><div><el-button @click="pollLive">刷新</el-button></div></div>

  <el-card shadow="never" class="section panel">
    <SearchPanel :fields="['path', 'userId', 'keyword']" @search="onSearch" />
    <EventTable title="实时事件" :rows="events" :loading="initialLoading" :total="events.length" :page="1" :page-size="10" stream @page-change="pager.page = $event; pollLive()" @size-change="pager.pageSize = $event; pollLive()" />
  </el-card>
</template>
