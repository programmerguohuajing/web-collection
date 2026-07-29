<script setup>
import { onMounted, reactive, ref } from 'vue'
import { api, queryFromFilters } from '../dashboard.js'
import SearchPanel from '../components/SearchPanel.vue'

const loading = ref(false)
const rows = ref([])
const total = ref(0)
const pager = reactive({ page: 1, pageSize: 20, total: 0 })
const query = reactive({ path: '', userId: '' })

async function load() {
  loading.value = true
  try {
    const suffix = queryFromFilters({ ...query, page: pager.page, pageSize: pager.pageSize })
    const data = await api(`/api/analytics/paths?${suffix}`)
    rows.value = data.items || []
    pager.total = data.total || 0
  } finally { loading.value = false }
}

function onSearch() { pager.page = 1; load() }

onMounted(load)
</script>

<template>
  <div class="page-heading"><div><h1>用户路径</h1><p>用户最常见的前后页面流转路径</p></div></div>

  <el-card shadow="never" class="section panel">
    <template #header>
      <div class="panel-head">
        <div><b>访问路径</b><small style="margin-left:8px">共 {{ total }} 条</small></div>
        <el-button @click="load">刷新</el-button>
      </div>
    </template>

    <SearchPanel :fields="['path', 'userId']" @search="onSearch" />

    <el-table v-loading="loading" :data="rows" border empty-text="暂无路径数据">
      <el-table-column prop="path" label="路径" min-width="500">
        <template #default="{ row }">
          <span class="path-flow">{{ row.path }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="count" label="会话数" width="120" align="center">
        <template #default="{ row }">{{ row.count }}</template>
      </el-table-column>
    </el-table>
    <el-pagination class="pager" v-model:current-page="pager.page" v-model:page-size="pager.pageSize" :total="pager.total" layout="total, sizes, prev, pager, next" @current-change="onSearch" @size-change="onSearch" />
  </el-card>
</template>

<style scoped>
.path-flow { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px; }
</style>
