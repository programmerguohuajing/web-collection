<script setup>
import { onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api, normalizePageResponse, pageLoading, queryFromFilters } from '../dashboard.js'

const route = useRoute()
const rows = ref([])
const pager = reactive({ page: 1, pageSize: 20, total: 0 })
const loading = ref(false)
const loadError = ref('')
let requestId = 0

function number(value) {
  return value == null || value === '' || !Number.isFinite(Number(value)) ? '-' : Number(value).toLocaleString()
}

function milliseconds(value) {
  return value == null || value === '' || !Number.isFinite(Number(value)) ? '-' : `${Number(value).toFixed(1)} ms`
}

async function load() {
  const currentRequest = ++requestId
  loading.value = true
  loadError.value = ''
  pageLoading.value = true
  try {
    const appId = route.query.appId || route.query.app_id || ''
    const suffix = queryFromFilters({ appId, page: pager.page, pageSize: pager.pageSize })
    const data = await api(`/api/analytics/releases?${suffix}`, { requestKey: 'releases:list' })
    if (currentRequest !== requestId) return
    const normalized = normalizePageResponse(data, pager)
    rows.value = normalized.items.map(row => ({
      ...row,
      release: row.release || row.release_name || row.releaseName || '-',
      app_id: row.app_id || row.appId || '-',
      events: Number(row.events || 0),
      errors: Number(row.errors || 0),
      users: Number(row.users || 0)
    }))
    pager.total = Array.isArray(data) ? rows.value.length : normalized.total
    pager.page = normalized.page
    pager.pageSize = normalized.pageSize
  } catch (error) {
    if (currentRequest === requestId && error?.code !== 'ABORT_ERR') {
      rows.value = []
      pager.total = 0
      loadError.value = error.message || '发布版本加载失败'
    }
  } finally {
    if (currentRequest === requestId) {
      loading.value = false
      pageLoading.value = false
    }
  }
}

function onSearch() { pager.page = 1; void load() }
watch(() => route.query.appId, () => { pager.page = 1; void load() })
onMounted(load)
</script>

<template>
  <div class="page-heading"><div><h1>发布管理</h1><p>版本对比、影响分析与回滚建议</p></div></div>
  <el-card shadow="never" class="section panel">
    <template #header><div class="panel-head"><div><b>版本列表</b><small style="margin-left:8px">共 {{ pager.total }} 个版本</small></div><el-button :loading="loading" @click="load">刷新</el-button></div></template>
    <el-alert v-if="loadError" class="table-error" type="error" :title="loadError" show-icon :closable="false"><template #default><el-button link type="primary" @click="load">重试</el-button></template></el-alert>
    <el-table :data="rows" border v-loading="loading" empty-text="暂无版本数据">
      <el-table-column prop="release" label="版本" min-width="160" />
      <el-table-column prop="app_id" label="应用" width="180" />
      <el-table-column label="事件数" width="100" align="center"><template #default="{ row }">{{ number(row.events) }}</template></el-table-column>
      <el-table-column label="错误数" width="100" align="center"><template #default="{ row }"><el-tag v-if="row.errors > 0" type="danger" size="small">{{ number(row.errors) }}</el-tag><span v-else>0</span></template></el-table-column>
      <el-table-column label="受影响用户" width="120" align="center"><template #default="{ row }">{{ number(row.users) }}</template></el-table-column>
      <el-table-column label="P95 LCP" width="120" align="center"><template #default="{ row }">{{ milliseconds(row.lcp) }}</template></el-table-column>
    </el-table>
    <el-pagination v-if="pager.total > 0" class="pager" v-model:current-page="pager.page" v-model:page-size="pager.pageSize" :total="pager.total" layout="total, sizes, prev, pager, next" @current-change="onSearch" @size-change="onSearch" />
  </el-card>
</template>

<style scoped>
.table-error { margin-bottom: 12px; }
</style>
