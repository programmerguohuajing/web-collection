<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import EventTable from '../components/EventTable.vue'
import SearchPanel from '../components/SearchPanel.vue'
import { api, loading, refreshVersion, resetPageFilters, queryFromFilters } from '../dashboard.js'

const events = ref([])
const liveLoading = ref(false)
const pager = reactive({ page: 1, pageSize: 10, total: 0 })
const connected = ref(false)
const ws = ref(null)
const query = reactive({ userId: '', path: '', keyword: '' })
let reconnectTimer = 0
let pollTimer = 0

function connectWs() {
  try {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${proto}//${location.host}/api/live`
    ws.value = new WebSocket(wsUrl)
    ws.value.onopen = () => { connected.value = true }
    ws.value.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        if (data.type === 'event') {
          events.value.unshift(data.event)
          if (events.value.length > 200) events.value.pop()
        }
      } catch {}
    }
    ws.value.onclose = () => {
      connected.value = false
      reconnectTimer = setTimeout(connectWs, 5000)
    }
    ws.value.onerror = () => { ws.value?.close() }
  } catch {
    connected.value = false
  }
}

async function pollLive() {
  liveLoading.value = true
  try {
    const suffix = queryFromFilters({ ...query, page: pager.page, pageSize: pager.pageSize })
    const data = await api(`/api/events?${suffix}&type=error,perf,behavior&_t=${Date.now()}`)
    const newItems = data.items || []
    const existingIds = new Set(events.value.map(e => `${e.session_id}_${e.ts}_${e.type}_${e.name}`))
    for (const item of newItems) {
      const key = `${item.session_id}_${item.ts}_${item.type}_${item.name}`
      if (!existingIds.has(key)) events.value.unshift(item)
    }
    if (events.value.length > 200) events.value.splice(200)
  } finally { liveLoading.value = false }
}

function onSearch() { pager.page = 1; pollLive() }
function togglePause() { /* handled by user */ }

onMounted(() => {
  resetPageFilters()
  connectWs()
  pollLive()
  pollTimer = setInterval(pollLive, 10000)
})

onBeforeUnmount(() => {
  clearTimeout(reconnectTimer)
  clearInterval(pollTimer)
  ws.value?.close()
})
</script>

<template>
  <div class="page-heading"><div><h1>实时监控</h1><p>最近事件流与系统状态</p></div><div style="display:flex;align-items:center;gap:8px"><el-tag :type="connected ? 'success' : 'danger'" size="small">{{ connected ? '实时连接中' : '轮询模式' }}</el-tag><el-button :loading="liveLoading" @click="pollLive">刷新</el-button></div></div>

  <el-card shadow="never" class="section panel">
    <SearchPanel :fields="['path', 'userId', 'keyword']" @search="onSearch" />
    <EventTable title="实时事件" :rows="events" :loading="liveLoading" :total="events.length" :page="1" :page-size="10" @page-change="pager.page = $event; pollLive()" @size-change="pager.pageSize = $event; pollLive()" />
  </el-card>
</template>
