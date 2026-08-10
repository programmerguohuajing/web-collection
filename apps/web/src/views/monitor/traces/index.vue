<script setup>
import { onMounted, reactive, ref, watch } from 'vue'
import { api, queryFromFilters, refreshVersion, pageLoading } from '../../../dashboard.js'
import SearchPanel from '../../../components/SearchPanel.vue'
import DistributedTraceTree from '../../../components/DistributedTraceTree.vue'

const traces = ref([])
const spans = ref([])
const active = ref(null)
const pager = reactive({ page: 1, pageSize: 10, total: 0 })
const spanPager = reactive({ page: 1, pageSize: 10, total: 0 })
const activeTab = ref('spans')

async function load() {
  pageLoading.value = true
  try {
    const data = await api(`/api/traces?${queryFromFilters({ page: pager.page, pageSize: pager.pageSize })}`)
    traces.value = data.items
    Object.assign(pager, { page: data.page, pageSize: data.pageSize, total: data.total })
  } finally { pageLoading.value = false }
}
function onSearch() {
  pager.page = 1
  load()
}
async function loadSpans() {
  const data = await api(`/api/traces/${encodeURIComponent(active.value.trace_id)}?page=${spanPager.page}&pageSize=${spanPager.pageSize}`)
  spans.value = data.items
  Object.assign(spanPager, { page: data.page, pageSize: data.pageSize, total: data.total })
}
async function open(row) {
  if (!row.trace_id?.trim()) return
  active.value = row
  spanPager.page = 1
  activeTab.value = 'spans'
  await loadSpans()
}
onMounted(load)
watch(refreshVersion, () => { pager.page = 1; load() })
</script>

<template>
  <SearchPanel :fields="['traceId', 'range', 'release', 'path']" @search="onSearch" />
  <el-card shadow="never" class="section panel">
    <template #header><div class="panel-head"><b>前端链路</b><el-button @click="load">刷新</el-button></div></template>
    <el-table :data="traces" border @row-click="open">
      <el-table-column prop="trace_id" label="Trace ID" min-width="260" />
      <el-table-column label="开始时间" width="180"><template #default="{ row }">{{ new Date(row.started_at).toLocaleString() }}</template></el-table-column>
      <el-table-column prop="duration" label="持续时间(ms)" width="130" />
      <el-table-column prop="span_count" label="Span" width="80" />
      <el-table-column prop="error_count" label="错误" width="80" />
      <el-table-column prop="release_name" label="版本" width="120" />
      <el-table-column prop="url" label="页面" min-width="260" show-overflow-tooltip />
    </el-table>
    <el-pagination class="pager" background layout="sizes, prev, pager, next, total" :current-page="pager.page" :page-size="pager.pageSize" :page-sizes="[10, 20, 50, 100]" :total="pager.total" @current-change="value => { pager.page = value; load() }" @size-change="value => { pager.page = 1; pager.pageSize = value; load() }" />
  </el-card>
  <el-drawer v-model="active" size="75%" :title="`链路 ${active?.trace_id || ''}`">
    <el-tabs v-model="activeTab" class="trace-tabs">
      <el-tab-pane label="Span 列表" name="spans">
        <el-table :data="spans" border>
          <el-table-column label="时间" width="140"><template #default="{ row }">{{ new Date(row.ts).toLocaleTimeString() }}</template></el-table-column>
          <el-table-column prop="metric" label="Span" width="120" />
          <el-table-column label="耗时(ms)" width="110"><template #default="{ row }">{{ Number(Number(row.value || 0).toFixed(2)) }}</template></el-table-column>
          <el-table-column prop="span_id" label="Span ID" width="150" />
          <el-table-column label="请求" min-width="260"><template #default="{ row }">{{ row.props?.method }} {{ row.props?.url || row.url }}</template></el-table-column>
          <el-table-column label="状态" width="90"><template #default="{ row }">{{ row.props?.status || '-' }}</template></el-table-column>
        </el-table>
        <el-pagination class="pager" background layout="sizes, prev, pager, next, total" :current-page="spanPager.page" :page-size="spanPager.pageSize" :page-sizes="[10, 20, 50, 100]" :total="spanPager.total" @current-change="value => { spanPager.page = value; loadSpans() }" @size-change="value => { spanPager.page = 1; spanPager.pageSize = value; loadSpans() }" />
      </el-tab-pane>
      <el-tab-pane label="分布式调用树" name="tree" v-if="active?.trace_id">
        <DistributedTraceTree :trace-id="active.trace_id" />
      </el-tab-pane>
    </el-tabs>
  </el-drawer>
</template>

<style scoped>
.trace-tabs { height: 100%; }
.trace-tabs :deep(.el-tabs__content) { max-height: calc(100vh - 200px); overflow-y: auto; }
</style>