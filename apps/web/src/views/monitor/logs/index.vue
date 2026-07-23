<script setup>
import { onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api, queryFromFilters } from '../../../dashboard.js'
import SearchPanel from '../../../components/SearchPanel.vue'

const rows = ref([])
const route = useRoute()
const total = ref(0)
const loading = ref(false)
const query = reactive({ level: '', page: 1, pageSize: 20 })

async function load() {
  loading.value = true
  try {
    const suffix = queryFromFilters({ name: query.level })
    const data = await api(`/api/logs?${suffix}&page=${query.page}&pageSize=${query.pageSize}`)
    rows.value = data.items
    total.value = data.total
  } finally { loading.value = false }
}

onMounted(load)
watch(() => route.query, load)
</script>

<template>
  <SearchPanel :fields="['userId']" />
  <el-card shadow="never" class="section panel">
    <template #header><div class="panel-head"><b>结构化日志</b><el-space><el-select v-model="query.level" clearable placeholder="全部级别" style="width:130px" @change="load"><el-option v-for="level in ['log','info','warn','error']" :key="level" :label="level" :value="level" /></el-select><el-button @click="load">刷新</el-button></el-space></div></template>
    <el-table v-loading="loading" :data="rows" border>
      <el-table-column label="时间" width="180"><template #default="{ row }">{{ new Date(row.ts).toLocaleString() }}</template></el-table-column>
      <el-table-column prop="name" label="级别" width="90"><template #default="{ row }"><el-tag :type="row.name === 'error' ? 'danger' : row.name === 'warn' ? 'warning' : 'info'">{{ row.name }}</el-tag></template></el-table-column>
      <el-table-column prop="message" label="内容" min-width="320" show-overflow-tooltip />
      <el-table-column prop="appId" label="应用" width="130" />
      <el-table-column prop="release" label="版本" width="110" />
      <el-table-column prop="userId" label="用户" width="130" />
      <el-table-column prop="sessionId" label="会话" min-width="180" show-overflow-tooltip />
      <el-table-column label="Trace" min-width="180" show-overflow-tooltip><template #default="{ row }"><router-link v-if="row.traceId" :to="`/traces?keyword=${encodeURIComponent(row.traceId)}`">{{ row.traceId }}</router-link><span v-else>-</span></template></el-table-column>
    </el-table>
    <el-pagination class="pager" v-model:current-page="query.page" v-model:page-size="query.pageSize" :total="total" layout="total, sizes, prev, pager, next" @change="load" />
  </el-card>
</template>
