<script setup>
import { onMounted, reactive, ref, watch } from 'vue'
import { api, normalizePageResponse, queryFromFilters, refreshVersion, pageLoading } from '../../../dashboard.js'
import SearchPanel from '../../../components/SearchPanel.vue'
import DistributedTraceTree from '../../../components/DistributedTraceTree.vue'
import { formatDuration, formatSpanId, formatSpanStatus, spanStatusType } from '../../../utils/format.js'

const traces = ref([])
const spans = ref([])
const active = ref(null)
const drawerOpen = ref(false)
const pager = reactive({ page: 1, pageSize: 10, total: 0 })
const spanPager = reactive({ page: 1, pageSize: 10, total: 0 })
const activeTab = ref('spans')
const listLoading = ref(false)
const spanLoading = ref(false)
const listError = ref('')
const spanError = ref('')
let listRequestId = 0
let spanRequestId = 0

function numberOr(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function formatDate(value, withTime = true) {
  const timestamp = numberOr(value)
  if (!timestamp) return '-'
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? '-' : (withTime ? date.toLocaleString() : date.toLocaleTimeString())
}

function normalizeTrace(row = {}) {
  return {
    ...row,
    trace_id: row.trace_id || row.traceId || '',
    started_at: numberOr(row.started_at ?? row.startedAt ?? row.ts),
    duration: numberOr(row.duration ?? row.duration_ms ?? row.durationMs),
    span_count: numberOr(row.span_count ?? row.spanCount),
    error_count: numberOr(row.error_count ?? row.errorCount),
    release_name: row.release_name || row.releaseName || row.release || '',
    url: row.url || row.path || ''
  }
}

async function load() {
  const requestId = ++listRequestId
  listLoading.value = true
  listError.value = ''
  pageLoading.value = true
  try {
    const data = await api(`/api/traces?${queryFromFilters({ page: pager.page, pageSize: pager.pageSize })}`, { requestKey: 'traces:list' })
    if (requestId !== listRequestId) return
    const normalized = normalizePageResponse(data, pager)
    traces.value = normalized.items.map(normalizeTrace)
    Object.assign(pager, normalized)
  } catch (error) {
    if (requestId === listRequestId && error?.code !== 'ABORT_ERR') listError.value = error.message || '链路列表加载失败'
  } finally {
    if (requestId === listRequestId) {
      listLoading.value = false
      pageLoading.value = false
    }
  }
}

function onSearch() {
  pager.page = 1
  void load()
}

async function loadSpans() {
  if (!active.value?.trace_id) {
    spans.value = []
    Object.assign(spanPager, { total: 0 })
    return
  }
  const requestId = ++spanRequestId
  spanLoading.value = true
  spanError.value = ''
  try {
    const data = await api(`/api/traces/${encodeURIComponent(active.value.trace_id)}?page=${spanPager.page}&pageSize=${spanPager.pageSize}`, { requestKey: `traces:spans:${active.value.trace_id}` })
    if (requestId !== spanRequestId) return
    const normalized = normalizePageResponse(data, spanPager)
    spans.value = normalized.items
    Object.assign(spanPager, normalized)
  } catch (error) {
    if (requestId === spanRequestId && error?.code !== 'ABORT_ERR') spanError.value = error.message || 'Span 列表加载失败'
  } finally {
    if (requestId === spanRequestId) spanLoading.value = false
  }
}

async function open(row) {
  const trace = normalizeTrace(row)
  if (!trace.trace_id.trim()) return
  active.value = trace
  drawerOpen.value = true
  spanPager.page = 1
  activeTab.value = 'spans'
  await loadSpans()
}

function spanDuration(row = {}) {
  const value = row.value ?? row.duration ?? row.duration_ms
  return value == null || value === '' ? '-' : formatDuration(value)
}

function spanName(row = {}) {
  return row.metric || row.metric_name || row.name || row.operationName || row.operation_name || row.type || '-'
}

onMounted(load)
watch(refreshVersion, () => { pager.page = 1; void load() })
</script>

<template>
  <SearchPanel :fields="['traceId', 'range', 'release', 'path']" @search="onSearch" />
  <el-card shadow="never" class="section panel">
    <template #header><div class="panel-head"><b>前端链路</b><el-button :loading="listLoading" @click="load">刷新</el-button></div></template>
    <el-alert v-if="listError" class="table-error" type="error" :title="listError" show-icon :closable="false"><template #default><el-button link type="primary" @click="load">重试</el-button></template></el-alert>
    <el-table :data="traces" border v-loading="listLoading" empty-text="暂无链路数据" @row-click="open">
      <el-table-column prop="trace_id" label="Trace ID" min-width="260" show-overflow-tooltip />
      <el-table-column label="开始时间" width="180"><template #default="{ row }">{{ formatDate(row.started_at) }}</template></el-table-column>
      <el-table-column label="持续时间" width="130"><template #default="{ row }">{{ formatDuration(row.duration) }}</template></el-table-column>
      <el-table-column prop="span_count" label="Span" width="80" />
      <el-table-column prop="error_count" label="错误" width="80" />
      <el-table-column prop="release_name" label="版本" width="120" />
      <el-table-column prop="url" label="页面" min-width="260" show-overflow-tooltip />
    </el-table>
    <el-pagination v-if="pager.total > 0" class="pager" background layout="sizes, prev, pager, next, total" :current-page="pager.page" :page-size="pager.pageSize" :page-sizes="[10, 20, 50, 100]" :total="pager.total" @current-change="value => { pager.page = value; load() }" @size-change="value => { pager.page = 1; pager.pageSize = value; load() }" />
  </el-card>

  <el-drawer v-model="drawerOpen" size="75%" :title="`链路 ${active?.trace_id || ''}`">
    <el-tabs v-if="active" v-model="activeTab" class="trace-tabs">
      <el-tab-pane label="Span 列表" name="spans">
        <el-alert v-if="spanError" class="table-error" type="error" :title="spanError" show-icon :closable="false"><template #default><el-button link type="primary" @click="loadSpans">重试</el-button></template></el-alert>
        <el-table :data="spans" border v-loading="spanLoading" empty-text="暂无 Span 数据">
          <el-table-column label="时间" width="140"><template #default="{ row }">{{ formatDate(row.ts, false) }}</template></el-table-column>
          <el-table-column label="Span" width="120" show-overflow-tooltip><template #default="{ row }">{{ spanName(row) }}</template></el-table-column>
          <el-table-column label="耗时" width="110"><template #default="{ row }">{{ spanDuration(row) }}</template></el-table-column>
          <el-table-column label="Span ID" width="150" show-overflow-tooltip><template #default="{ row }">{{ formatSpanId(row) }}</template></el-table-column>
          <el-table-column label="请求" min-width="260" show-overflow-tooltip><template #default="{ row }">{{ [row.props?.method, row.props?.url || row.url].filter(Boolean).join(' ') || '-' }}</template></el-table-column>
          <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag size="small" :type="spanStatusType(row)">{{ formatSpanStatus(row) }}</el-tag></template></el-table-column>
        </el-table>
        <el-pagination v-if="spanPager.total > 0" class="pager" background layout="sizes, prev, pager, next, total" :current-page="spanPager.page" :page-size="spanPager.pageSize" :page-sizes="[10, 20, 50, 100]" :total="spanPager.total" @current-change="value => { spanPager.page = value; loadSpans() }" @size-change="value => { spanPager.page = 1; spanPager.pageSize = value; loadSpans() }" />
      </el-tab-pane>
      <el-tab-pane label="分布式调用树" name="tree">
        <DistributedTraceTree :trace-id="active.trace_id" />
      </el-tab-pane>
    </el-tabs>
  </el-drawer>
</template>

<style scoped>
.trace-tabs { height: 100%; }
.trace-tabs :deep(.el-tabs__content) { max-height: calc(100vh - 200px); overflow-y: auto; }
.table-error { margin-bottom: 12px; }
</style>
