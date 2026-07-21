<script setup>
import { onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api, queryFromFilters } from '../../../dashboard.js'
import SearchPanel from '../../../components/SearchPanel.vue'

const traces = ref([])
const route = useRoute()
const spans = ref([])
const active = ref(null)
const loading = ref(false)

async function load() { loading.value = true; try { traces.value = await api(`/api/traces?${queryFromFilters()}`) } finally { loading.value = false } }
async function open(row) { active.value = row; spans.value = await api(`/api/traces/${row.trace_id}`) }
onMounted(load)
watch(() => route.query, load)
</script>

<template>
  <SearchPanel :fields="['range', 'appId', 'release']" />
  <el-card shadow="never" class="section panel">
    <template #header><div class="panel-head"><b>前端链路</b><el-button @click="load">刷新</el-button></div></template>
    <el-table v-loading="loading" :data="traces" border @row-click="open">
      <el-table-column prop="trace_id" label="Trace ID" min-width="260" />
      <el-table-column label="开始时间" width="180"><template #default="{ row }">{{ new Date(row.started_at).toLocaleString() }}</template></el-table-column>
      <el-table-column prop="duration" label="持续时间(ms)" width="130" />
      <el-table-column prop="span_count" label="Span" width="80" />
      <el-table-column prop="error_count" label="错误" width="80" />
      <el-table-column prop="release_name" label="版本" width="120" />
      <el-table-column prop="url" label="页面" min-width="260" show-overflow-tooltip />
    </el-table>
  </el-card>
  <el-drawer v-model="active" size="65%" :title="`链路 ${active?.trace_id || ''}`">
    <el-table :data="spans" border>
      <el-table-column label="时间" width="140"><template #default="{ row }">{{ new Date(row.ts).toLocaleTimeString() }}</template></el-table-column>
      <el-table-column prop="metric" label="Span" width="120" />
      <el-table-column prop="value" label="耗时(ms)" width="110" />
      <el-table-column prop="spanId" label="Span ID" width="150" />
      <el-table-column label="请求" min-width="260"><template #default="{ row }">{{ row.props?.method }} {{ row.props?.url || row.url }}</template></el-table-column>
      <el-table-column label="状态" width="90"><template #default="{ row }">{{ row.props?.status || '-' }}</template></el-table-column>
    </el-table>
  </el-drawer>
</template>
