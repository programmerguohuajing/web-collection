<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import EventTable from '../components/EventTable.vue'
import SearchPanel from '../components/SearchPanel.vue'
import { api, queryFromFilters, resetPageFilters } from '../dashboard.js'

const route = useRoute()
const loading = ref(false)
const rows = ref([])
const total = ref(0)
const pager = reactive({ page: 1, pageSize: 10, total: 0 })
const query = reactive({ userId: '', userName: '', userPhone: '', keyword: '', path: '' })
const activeSession = ref(null)
const drawerOpen = ref(false)
const sessionEvents = ref([])
const sessionPager = reactive({ page: 1, pageSize: 20, total: 0 })
const eventLoading = ref(false)

async function load() {
  loading.value = true
  try {
    const suffix = queryFromFilters({ ...query, page: pager.page, pageSize: pager.pageSize })
    const data = await api(`/api/analytics/sessions?${suffix}`)
    rows.value = data.items
    pager.total = data.total
  } finally { loading.value = false }
}

async function viewSession(row) {
  activeSession.value = row
  drawerOpen.value = true
  sessionPager.page = 1
  await loadSessionEvents(row.session_id)
}

async function loadSessionEvents(sessionId) {
  eventLoading.value = true
  try {
    const suffix = queryFromFilters({}, ['startTime', 'endTime'])
    const data = await api(`/api/analytics/sessions/${encodeURIComponent(sessionId)}?${suffix}&page=${sessionPager.page}&pageSize=${sessionPager.pageSize}`)
    sessionEvents.value = data.items
    sessionPager.total = data.total
  } finally { eventLoading.value = false }
}

function onSearch() { pager.page = 1; load() }
function onSessionPageChange() { if (activeSession.value) loadSessionEvents(activeSession.value.session_id) }

watch(() => route.query.userId, val => { if (val) { query.userId = val; onSearch() } })
watch(() => route.query.sessionId, val => { if (val) { const row = rows.value.find(r => r.session_id === val); if (row) viewSession(row) } })

onMounted(() => { resetPageFilters(); load() })
</script>

<template>
  <div class="page-heading"><div><h1>用户会话</h1><p>单个用户的完整操作轨迹与事件时间线</p></div></div>

  <el-card shadow="never" class="section panel">
    <template #header>
      <div class="panel-head"><div><b>会话列表</b><small style="margin-left:8px">共 {{ total }} 个会话</small></div><el-button @click="load">刷新</el-button></div>
    </template>

    <SearchPanel :fields="['userId', 'userName', 'userPhone']" @search="onSearch" />

    <el-table v-loading="loading" :data="rows" border @row-click="viewSession" style="cursor:pointer">
      <el-table-column label="会话 ID" min-width="200"><template #default="{ row }"><el-tooltip :content="row.session_id" placement="top" :append-to="() => document.body"><span class="table-ellipsis">{{ row.session_id }}</span></el-tooltip></template></el-table-column>
      <el-table-column prop="user_id" label="用户 ID" width="180"><template #default="{ row }"><el-tooltip :content="row.user_id" placement="top" :append-to="() => document.body"><span class="table-ellipsis">{{ row.user_id }}</span></el-tooltip></template></el-table-column>
      <el-table-column prop="user_name" label="用户名" width="120" />
      <el-table-column label="开始时间" width="180"><template #default="{ row }">{{ new Date(Number(row.started_at)).toLocaleString() }}</template></el-table-column>
      <el-table-column label="结束时间" width="180"><template #default="{ row }">{{ new Date(Number(row.ended_at)).toLocaleString() }}</template></el-table-column>
      <el-table-column label="持续时长" width="110"><template #default="{ row }">{{ formatDuration(Number(row.duration)) }}</template></el-table-column>
      <el-table-column label="事件数" width="90" align="center"><template #default="{ row }">{{ row.event_count }}</template></el-table-column>
      <el-table-column label="错误数" width="90" align="center"><template #default="{ row }"><el-tag v-if="row.error_count" type="danger" size="small">{{ row.error_count }}</el-tag><span v-else>-</span></template></el-table-column>
      <el-table-column prop="paths" label="访问页面" min-width="260"><template #default="{ row }"><el-tooltip :content="(row.paths || []).join(' → ')" placement="top" :append-to="() => document.body"><span class="table-ellipsis">{{ (row.paths || []).join(' → ') }}</span></el-tooltip></template></el-table-column>
    </el-table>
    <el-pagination class="pager" v-model:current-page="pager.page" v-model:page-size="pager.pageSize" :total="pager.total" layout="total, sizes, prev, pager, next" @current-change="onSearch" @size-change="onSearch" />
  </el-card>

  <el-drawer v-if="activeSession" v-model="drawerOpen" :title="`会话 ${activeSession.session_id}`" size="60%" :append-to-body="true">
    <template #header>
      <div style="display:flex;align-items:center;gap:12px">
        <span>会话 {{ activeSession.session_id?.slice(0, 16) }}...</span>
        <el-tag v-if="activeSession.user_id" type="info" size="small">{{ activeSession.user_id }}</el-tag>
        <el-tag v-if="activeSession.error_count" type="danger" size="small">{{ activeSession.error_count }} 个错误</el-tag>
      </div>
    </template>

    <div v-if="activeSession.paths?.length" style="margin-bottom:16px">
      <b>访问路径：</b>{{ activeSession.paths.join(' → ') }}
    </div>

    <EventTable title="会话事件" :rows="sessionEvents" :loading="eventLoading" :total="sessionPager.total" :page="sessionPager.page" :page-size="sessionPager.pageSize" stream
      @page-change="sessionPager.page = $event; onSessionPageChange()"
      @size-change="sessionPager.pageSize = $event; sessionPager.page = 1; onSessionPageChange()" />
  </el-drawer>
</template>
