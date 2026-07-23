<script setup>
import { onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api, queryFromFilters, refreshVersion } from '../../../dashboard.js'

const traces = ref([])
const route = useRoute()
const spans = ref([])
const active = ref(null)
const loading = ref(false)
const pager = reactive({ page: 1, pageSize: 10, total: 0 })
const spanPager = reactive({ page: 1, pageSize: 10, total: 0 })

async function load() {
  loading.value = true
  try {
    const data = await api(`/api/traces?${queryFromFilters({ page: pager.page, pageSize: pager.pageSize })}`)
    traces.value = data.items
    Object.assign(pager, { page: data.page, pageSize: data.pageSize, total: data.total })
  } finally { loading.value = false }
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
  await loadSpans()
}
onMounted(load)
watch([() => route.query, refreshVersion], () => { pager.page = 1; load() })
</script>

<template>
  <el-card shadow="never" class="section panel">
    <template #header><div class="panel-head"><b>前端链路</b><el-button @click="load">刷新</el-button></div></template>
    <el-table v-loading="loading" :data="traces" border @row-click="open">
      <el-table-column prop="trace_id" label="Trace ID" min-width="260" />
      <el-table-column label="开始时间" width="180"><template #default="{ row }">{{ new Date(row.started_at).toLocaleString() }}</template></el-table-column>
      <el-table-column prop="duration" label="持续时间(ms)" width="130" />
      <el-table-column prop="span_count" label="Span" width="80" />
      <el-table-column prop="error_count" label="错误" width="80" />
      <el-table-column prop="release_name" label="版本" width="120" />
      <el-table-column label="页面" min-width="260"><template #default="{ row }"><span class="table-ellipsis" :title="row.url">{{ row.url }}</span></template></el-table-column>
    </el-table>
    <el-pagination class="pager" background layout="sizes, prev, pager, next, total" :current-page="pager.page" :page-size="pager.pageSize" :page-sizes="[10, 20, 50, 100]" :total="pager.total" @current-change="value => { pager.page = value; load() }" @size-change="value => { pager.page = 1; pager.pageSize = value; load() }" />
  </el-card>
  <el-drawer v-model="active" size="65%" :title="`链路 ${active?.trace_id || ''}`">
    <el-table :data="spans" border>
      <el-table-column label="时间" width="140"><template #default="{ row }">{{ new Date(row.ts).toLocaleTimeString() }}</template></el-table-column>
      <el-table-column prop="metric" label="Span" width="120" />
      <el-table-column label="耗时(ms)" width="110"><template #default="{ row }">{{ Number(Number(row.value || 0).toFixed(2)) }}</template></el-table-column>
      <el-table-column prop="spanId" label="Span ID" width="150" />
      <el-table-column label="请求" min-width="260"><template #default="{ row }">{{ row.props?.method }} {{ row.props?.url || row.url }}</template></el-table-column>
      <el-table-column label="状态" width="90"><template #default="{ row }">{{ row.props?.status || '-' }}</template></el-table-column>
    </el-table>
    <el-pagination class="pager" background layout="sizes, prev, pager, next, total" :current-page="spanPager.page" :page-size="spanPager.pageSize" :page-sizes="[10, 20, 50, 100]" :total="spanPager.total" @current-change="value => { spanPager.page = value; loadSpans() }" @size-change="value => { spanPager.page = 1; spanPager.pageSize = value; loadSpans() }" />
  </el-drawer>
</template>
