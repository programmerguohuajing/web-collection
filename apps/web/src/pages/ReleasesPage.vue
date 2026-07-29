<script setup>
import { onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api, queryFromFilters } from '../dashboard.js'

const route = useRoute()
const loading = ref(false)
const rows = ref([])
const total = ref(0)
const pager = reactive({ page: 1, pageSize: 10, total: 0 })

async function load() {
  loading.value = true
  try {
    const suffix = queryFromFilters({ page: pager.page, pageSize: pager.pageSize })
    const data = await api(`/api/analytics/releases?${suffix}`)
    rows.value = Array.isArray(data) ? data : []
    pager.total = rows.value.length
  } finally { loading.value = false }
}

function onSearch() { pager.page = 1; load() }
function formatNum(v) { return v != null ? Number(v).toLocaleString() : '-' }
function formatMs(v) { return v != null ? Number(v).toFixed(1) + ' ms' : '-' }

watch(() => route.query.appId, () => load())
onMounted(load)
</script>

<template>
  <div class="page-heading"><div><h1>发布管理</h1><p>版本对比、影响分析与回滚建议</p></div></div>

  <el-card shadow="never" class="section panel">
    <template #header>
      <div class="panel-head">
        <div><b>版本列表</b><small style="margin-left:8px">共 {{ total }} 个版本</small></div>
        <el-button @click="load">刷新</el-button>
      </div>
    </template>

    <el-table v-loading="loading" :data="rows" border>
      <el-table-column prop="release" label="版本" min-width="160" />
      <el-table-column prop="app_id" label="应用" width="180" />
      <el-table-column label="事件数" width="100" align="center"><template #default="{ row }">{{ formatNum(row.events) }}</template></el-table-column>
      <el-table-column label="错误数" width="100" align="center">
        <template #default="{ row }">
          <el-tag v-if="row.errors > 0" type="danger" size="small">{{ row.errors }}</el-tag>
          <span v-else class="text-muted">0</span>
        </template>
      </el-table-column>
      <el-table-column label="受影响用户" width="120" align="center"><template #default="{ row }">{{ formatNum(row.users) }}</template></el-table-column>
      <el-table-column label="P95 LCP" width="120" align="center"><template #default="{ row }">{{ formatMs(row.lcp) }}</template></el-table-column>
    </el-table>
    <el-pagination class="pager" v-model:current-page="pager.page" v-model:page-size="pager.pageSize" :total="pager.total" layout="total, sizes, prev, pager, next" @current-change="onSearch" @size-change="onSearch" />
  </el-card>
</template>
