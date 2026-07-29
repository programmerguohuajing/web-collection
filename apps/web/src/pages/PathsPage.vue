<script setup>
import { onMounted, reactive, ref } from 'vue'
import { api, queryFromFilters } from '../dashboard.js'
import SearchPanel from '../components/SearchPanel.vue'

const loading = ref(false)
const rows = ref([])

async function load() {
  loading.value = true
  try {
    const suffix = queryFromFilters()
    const data = await api(`/api/analytics/paths?${suffix}`)
    rows.value = Array.isArray(data) ? data : []
  } finally { loading.value = false }
}

function onSearch() { load() }

onMounted(load)
</script>

<template>
  <div class="page-heading"><div><h1>用户路径</h1><p>用户最常见的前后页面流转路径</p></div></div>

  <el-card shadow="never" class="section panel">
    <template #header>
      <div class="panel-head">
        <div><b>访问路径</b><small style="margin-left:8px">共 {{ rows.length }} 条</small></div>
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
      <el-table-column label="用户" min-width="200" show-overflow-tooltip>
        <template #default="{ row }">
          <template v-if="row.users?.length">
            <el-tag v-for="u in row.users.slice(0, 3)" :key="u.id" size="small" style="margin-right:4px;margin-bottom:2px">{{ u.name || u.id }}</el-tag>
            <span v-if="row.users.length > 3" style="color:#999;font-size:12px">+{{ row.users.length - 3 }}</span>
          </template>
          <span v-else class="text-muted">-</span>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<style scoped>
.path-flow { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px; }
</style>
