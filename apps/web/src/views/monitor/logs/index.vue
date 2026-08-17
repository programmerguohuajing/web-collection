<script setup>
import { onMounted, reactive, ref, watch } from 'vue'
import { api, normalizePageResponse, queryFromFilters, refreshVersion, pageLoading } from '../../../dashboard.js'
import SearchPanel from '../../../components/SearchPanel.vue'
import { levelLabel, levelTagType } from '../../../utils/format.js'

const LOG_LEVELS = ['log', 'info', 'warn', 'error']

const rows = ref([])
const total = ref(0)
const query = reactive({ level: '', page: 1, pageSize: 20 })
const loading = ref(false)
const loadError = ref('')
let requestId = 0

function formatDate(value) {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '-'
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString()
}

function text(value) {
  return value == null || value === '' ? '-' : String(value)
}

async function load() {
  const currentRequest = ++requestId
  loading.value = true
  loadError.value = ''
  pageLoading.value = true
  try {
    const suffix = queryFromFilters({ name: query.level })
    const data = await api(`/api/logs?${suffix}&page=${query.page}&pageSize=${query.pageSize}`, { requestKey: 'logs:list' })
    if (currentRequest !== requestId) return
    const normalized = normalizePageResponse(data, query)
    rows.value = normalized.items
    query.page = normalized.page
    query.pageSize = normalized.pageSize
    total.value = normalized.total
  } catch (error) {
    if (currentRequest === requestId && error?.code !== 'ABORT_ERR') {
      rows.value = []
      total.value = 0
      loadError.value = error.message || '日志加载失败'
    }
  } finally {
    if (currentRequest === requestId) {
      loading.value = false
      pageLoading.value = false
    }
  }
}

function changeLevel() {
  query.page = 1
  void load()
}

function onSearch() {
  query.page = 1
  void load()
}

onMounted(load)
watch(refreshVersion, load)
</script>

<template>
  <SearchPanel :fields="['userId']" @search="onSearch" />
  <el-card shadow="never" class="section panel">
    <template #header><div class="panel-head"><b>结构化日志</b><el-space><el-select v-model="query.level" clearable placeholder="全部级别" style="width:130px" @change="changeLevel"><el-option v-for="level in LOG_LEVELS" :key="level" :label="levelLabel(level)" :value="level" /></el-select>
      <el-button :loading="loading" @click="load">刷新</el-button></el-space></div></template>
    <el-alert v-if="loadError" class="table-error" type="error" :title="loadError" show-icon :closable="false"><template #default><el-button link type="primary" @click="load">重试</el-button></template></el-alert>
    <el-table :data="rows" border v-loading="loading" empty-text="暂无日志数据">
      <el-table-column label="时间" width="200" cell-class-name="time-cell"><template #default="{ row }">{{ formatDate(row.ts) }}</template></el-table-column>
      <el-table-column prop="name" label="级别" width="90"><template #default="{ row }"><el-tag :type="levelTagType(row.name)" size="small">{{ levelLabel(row.name) }}</el-tag></template></el-table-column>
      <el-table-column label="内容" min-width="320" show-overflow-tooltip><template #default="{ row }">{{ text(row.message) }}</template></el-table-column>
      <el-table-column label="应用" width="130"><template #default="{ row }">{{ text(row.appId ?? row.app_id) }}</template></el-table-column>
      <el-table-column label="版本" width="110"><template #default="{ row }">{{ text(row.release ?? row.release_name) }}</template></el-table-column>
      <el-table-column label="用户" width="130"><template #default="{ row }">{{ text(row.userId ?? row.user_id) }}</template></el-table-column>
      <el-table-column label="会话" min-width="180" show-overflow-tooltip><template #default="{ row }">{{ text(row.sessionId ?? row.session_id) }}</template></el-table-column>
      <el-table-column label="Trace" min-width="180" show-overflow-tooltip><template #default="{ row }">{{ text(row.traceId ?? row.trace_id) }}</template></el-table-column>
    </el-table>
    <el-pagination v-if="total > 0" class="pager" v-model:current-page="query.page" v-model:page-size="query.pageSize" :total="total" layout="total, sizes, prev, pager, next" @change="load" />
  </el-card>
</template>

<style scoped>
.table-error { margin-bottom: 12px; }
</style>
