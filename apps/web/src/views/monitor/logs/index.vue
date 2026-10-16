<script setup>
import { onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api, normalizePageResponse, queryFromFilters, refreshVersion, pageLoading } from '../../../dashboard.js'
import OverflowTip from '../../../components/OverflowTip.vue'
import SearchPanel from '../../../components/SearchPanel.vue'
import { levelLabel, levelTagType } from '../../../utils/format.js'
import { exportCsv, fetchAllPages } from '../../../utils/csv.js'

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
  if (value == null || value === '') return '-'
  let s = String(value)
  // 清洗 console 样式占位符（2026-10-14 深度测试 P2）：SDK 采集的 console.log 原文含
  // %c 与 color: #FF7D00 这类样式参数原文，展示时应去掉，只留真实日志内容。
  s = s.replace(/%[csdifoO]/g, '')
  s = s.replace(/color\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[a-z]+)/gi, '')
  s = s.replace(/background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[a-z]+)/gi, '')
  return s.replace(/\s{2,}/g, ' ').trim() || '-'
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

const exporting = ref(false)
async function exportLogs() {
  exporting.value = true
  try {
    const rows = await fetchAllPages(async (page, pageSize) => {
      const suffix = queryFromFilters({ name: query.level })
      const data = await api(`/api/logs?${suffix}&page=${page}&pageSize=${pageSize}`, { requestKey: 'logs:export' })
      const normalized = normalizePageResponse(data)
      return { items: normalized.items, total: normalized.total }
    })
    const count = exportCsv('结构化日志', [
      { key: 'ts', label: '时间' },
      { key: 'name', label: '级别' },
      { key: 'message', label: '内容' },
      { key: 'app_id', label: '应用' },
      { key: 'release', label: '版本' },
      { key: 'user_id', label: '用户' },
      { key: 'session_id', label: '会话' },
      { key: 'trace_id', label: 'Trace' }
    ], rows.map(r => ({
      ts: r.ts ? formatDate(r.ts) : '',
      name: levelLabel(r.name),
      message: text(r.message),
      app_id: r.appId ?? r.app_id ?? '',
      release: r.release ?? r.release_name ?? '',
      user_id: r.userId ?? r.user_id ?? '',
      session_id: r.sessionId ?? r.session_id ?? '',
      trace_id: r.traceId ?? r.trace_id ?? ''
    })))
    ElMessage.success(`已导出 ${count} 条`)
  } catch (error) {
    ElMessage.error(error.message || '导出失败')
  } finally {
    exporting.value = false
  }
}

onMounted(load)
watch(refreshVersion, load)
</script>

<template>
  <div class="page-heading"><div><h1>日志平台</h1><p>集中检索应用日志，支持级别筛选与关键字搜索</p></div></div>
  <SearchPanel :fields="['userId']" @search="onSearch" />
  <el-card shadow="never" class="section panel">
    <template #header><div class="panel-head"><b>结构化日志</b><el-space><el-select v-model="query.level" clearable placeholder="全部级别" style="width:130px" @change="changeLevel"><el-option v-for="level in LOG_LEVELS" :key="level" :label="levelLabel(level)" :value="level" /></el-select>
      <el-button size="small" :loading="exporting" @click="exportLogs">导出 CSV</el-button>
      <el-button :loading="loading" @click="load">刷新</el-button></el-space></div></template>
    <el-alert v-if="loadError" class="table-error" type="error" :title="loadError" show-icon :closable="false"><template #default><el-button link type="primary" @click="load">重试</el-button></template></el-alert>
    <el-table :data="rows" border v-loading="loading" empty-text="暂无日志数据">
      <el-table-column label="时间" width="200" cell-class-name="time-cell"><template #default="{ row }">{{ formatDate(row.ts) }}</template></el-table-column>
      <el-table-column prop="name" label="级别" width="90"><template #default="{ row }"><el-tag :type="levelTagType(row.name)" size="small">{{ levelLabel(row.name) }}</el-tag></template></el-table-column>
      <el-table-column label="内容" min-width="320"><template #default="{ row }"><OverflowTip :text="text(row.message)" /></template></el-table-column>
      <el-table-column label="应用" min-width="140"><template #default="{ row }"><OverflowTip :text="text(row.appId ?? row.app_id)" /></template></el-table-column>
      <el-table-column label="版本" width="110"><template #default="{ row }">{{ text(row.release ?? row.release_name) }}</template></el-table-column>
      <el-table-column label="用户" width="130"><template #default="{ row }">{{ text(row.userId ?? row.user_id) }}</template></el-table-column>
      <el-table-column label="会话" min-width="180"><template #default="{ row }"><OverflowTip :text="text(row.sessionId ?? row.session_id)" /></template></el-table-column>
      <el-table-column label="Trace" min-width="180"><template #default="{ row }"><OverflowTip :text="text(row.traceId ?? row.trace_id)" /></template></el-table-column>
    </el-table>
    <el-pagination v-if="total > 0" class="pager" v-model:current-page="query.page" v-model:page-size="query.pageSize" :total="total" layout="total, sizes, prev, pager, next" @change="load" />
  </el-card>
</template>

<style scoped>
.table-error { margin-bottom: 12px; }
</style>
