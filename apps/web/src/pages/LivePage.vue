<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import EventTable from '../components/EventTable.vue'
import SearchPanel from '../components/SearchPanel.vue'
import { api, queryFromFilters } from '../dashboard.js'

const events = ref([])
const initialLoading = ref(false)
const total = ref(0)
const page = ref(1)
const pageSize = ref(10)
const query = reactive({ userId: '', path: '', keyword: '' })
let pollTimer = 0

async function pollLive() {
  initialLoading.value = true
  try {
    const suffix = queryFromFilters({ ...query, page: page.value, pageSize: pageSize.value })
    const data = await api(`/api/events?${suffix}&type=error,perf,behavior&_t=${Date.now()}`)
    const newItems = (data.items || []).filter(item => item && (item.type || item.name || item.ts))
    const existingIds = new Set(events.value.map(e => `${e.session_id}_${e.ts}_${e.type}_${e.name}`))
    for (const item of newItems) {
      const key = `${item.session_id}_${item.ts}_${item.type}_${item.name}`
      if (!existingIds.has(key)) events.value.unshift(item)
    }
    total.value = data.total || 0
    pageSize.value = data.pageSize || pageSize.value
    page.value = data.page || page.value
  } finally {
    initialLoading.value = false
  }
}

function onSearch() { page.value = 1; pollLive() }

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
    <EventTable title="实时事件" :rows="events" :loading="initialLoading" :total="total" :page="page" :page-size="pageSize" stream @page-change="page = $event; pollLive()" @size-change="pageSize = $event; page = 1; pollLive()" />
  </el-card>
</template>
