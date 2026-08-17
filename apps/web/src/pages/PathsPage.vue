<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { api, normalizePageResponse, pageLoading, queryFromFilters } from '../dashboard.js'
import { useFilterStore } from '../stores/filters.js'
import SearchPanel from '../components/SearchPanel.vue'
import TopologyChart from '../components/TopologyChart.vue'
import KpiGrid from '../components/KpiGrid.vue'
import PathFlow from '../components/PathFlow.vue'

const filterStore = useFilterStore()

const rows = ref([])
const pager = reactive({ page: 1, pageSize: 20, total: 0 })
const loading = ref(false)
const loadError = ref('')
let requestId = 0
const viewMode = ref('list')
const clickPaths = ref({ nodes: [], edges: [] })
const clickLoading = ref(false)
const clickError = ref('')
const pathKpis = computed(() => [
  { label: '路径总数', value: Number(pager.total || rows.value.length).toLocaleString(), delta: '近 24h', valueClass: 'value-primary' },
  { label: 'Top 路径占比', value: rows.value.length ? '—' : '-', delta: '等待路径数据', valueClass: 'value-purple' },
  { label: '平均路径深度', value: rows.value.length ? `${(rows.value.reduce((sum, row) => sum + Number(row.depth || row.steps || 0), 0) / rows.value.length).toFixed(1)} 步` : '-', delta: '当前筛选范围', valueClass: 'value-success' },
  { label: '跳出路径', value: rows.value.filter(row => Number(row.depth || row.steps || 0) <= 1).length.toLocaleString(), delta: '当前筛选范围', valueClass: 'value-danger' }
])
let clickRequestId = 0

// 点击视角为空且全局时间范围已生效时，提示用户放宽时间窗——
// 点击事件常跨数十天分布，窄时间窗（如近7天）会将其整体过滤为空。
const clickRangeActive = computed(() => Array.isArray(filterStore.range) && filterStore.range.length === 2)
const clickEmptyWithRange = computed(() =>
  clickRangeActive.value && !clickError.value && !clickLoading.value && clickPaths.value.nodes.length === 0
)

async function load() {
  const currentRequest = ++requestId
  loading.value = true
  loadError.value = ''
  pageLoading.value = true
  try {
    const suffix = queryFromFilters({ page: pager.page, pageSize: pager.pageSize })
    const data = await api(`/api/analytics/paths?${suffix}`, { requestKey: 'paths:list' })
    if (currentRequest !== requestId) return
    const normalized = normalizePageResponse(data, pager)
    let items = normalized.items
    // 防御：若后端未按 pageSize 分页（返回条数超过单页上限，多见于接口旧版本），
    // 在客户端兜底分页，保证表格渲染条数不超过 pageSize，且分页器翻页仍可正常使用。
    if (items.length > normalized.pageSize) {
      const start = (pager.page - 1) * pager.pageSize
      items = items.slice(start, start + pager.pageSize)
    }
    rows.value = items.map(row => ({ ...row, path: row.path || row.label || '-', count: Number(row.count || row.sessions || 0), users: Array.isArray(row.users) ? row.users : [] }))
    Object.assign(pager, normalized)
  } catch (error) {
    if (currentRequest === requestId && error?.code !== 'ABORT_ERR') {
      rows.value = []
      Object.assign(pager, { total: 0 })
      loadError.value = error.message || '用户路径加载失败'
    }
  } finally {
    if (currentRequest === requestId) {
      loading.value = false
      pageLoading.value = false
    }
  }
}

function onSearch() {
  if (viewMode.value === 'click') {
    clickPaths.value = { nodes: [], edges: [] }
    loadClickPaths()
  } else {
    pager.page = 1
    void load()
  }
}

async function loadClickPaths() {
  const currentRequest = ++clickRequestId
  clickLoading.value = true
  clickError.value = ''
  try {
    const suffix = queryFromFilters()
    const data = await api(`/api/analytics/click-paths?${suffix}`, { requestKey: 'paths:click' })
    if (currentRequest !== clickRequestId) return
    clickPaths.value = { nodes: data?.nodes || [], edges: data?.edges || [] }
  } catch (error) {
    if (currentRequest === clickRequestId && error?.code !== 'ABORT_ERR') clickError.value = error.message || '点击路径加载失败'
  } finally {
    if (currentRequest === clickRequestId) clickLoading.value = false
  }
}

function onViewModeChange(name) {
  if (name === 'click') loadClickPaths()
}

onMounted(load)
</script>

<template>
  <KpiGrid :items="pathKpis" />
  <el-card shadow="never" class="section panel">
    <template #header><div class="panel-head"><div><b>访问路径</b><small style="margin-left:8px">共 {{ pager.total }} 条</small></div><el-button :loading="loading || clickLoading" @click="onSearch">刷新</el-button></div></template>
    <el-tabs v-model="viewMode" @tab-change="onViewModeChange">
      <el-tab-pane label="访问路径列表" name="list">
        <SearchPanel :fields="['path', 'userId']" @search="onSearch" />
        <el-alert v-if="loadError" class="table-error" type="error" :title="loadError" show-icon :closable="false"><template #default><el-button link type="primary" @click="load">重试</el-button></template></el-alert>
        <el-table :data="rows" border v-loading="loading" empty-text="暂无路径数据">
          <el-table-column prop="path" label="路径" min-width="500" class-name="path-col">
            <template #default="{ row }">
              <PathFlow :path="row.path" :tooltip="row.path" />
            </template>
          </el-table-column>
          <el-table-column label="会话数" width="120" align="center"><template #default="{ row }">{{ row.count }}</template></el-table-column>
          <el-table-column label="用户" min-width="200" show-overflow-tooltip><template #default="{ row }"><template v-if="row.users.length"><el-tag v-for="u in row.users.slice(0, 3)" :key="u.id || u" size="small" style="margin-right:4px;margin-bottom:2px">{{ u.name || u.id || u }}</el-tag><span v-if="row.users.length > 3" class="text-muted">+{{ row.users.length - 3 }}</span></template><span v-else class="text-muted">-</span></template></el-table-column>
        </el-table>
        <el-pagination v-if="pager.total > 0" class="pager" background layout="sizes, prev, pager, next, total" :current-page="pager.page" :page-size="pager.pageSize" :page-sizes="[10, 20, 50, 100]" :total="pager.total" @current-change="value => { pager.page = value; load() }" @size-change="value => { pager.page = 1; pager.pageSize = value; load() }" />
      </el-tab-pane>
      <el-tab-pane label="点击视角" name="click">
        <el-alert v-if="clickError" class="table-error" type="error" :title="clickError" show-icon :closable="false"><template #default><el-button link type="primary" @click="loadClickPaths">重试</el-button></template></el-alert>
        <el-alert v-else-if="clickEmptyWithRange" class="table-error" type="info" show-icon :closable="false">
          <template #title>当前时间范围内没有点击路径数据</template>
          <template #default>点击事件通常跨数十天分布，当前所选时间窗可能将其整体过滤为空。请尝试在右上角将时间范围改为「全部时间」或「最近90天」后刷新。</template>
        </el-alert>
        <TopologyChart :nodes="clickPaths.nodes" :edges="clickPaths.edges" height="560px" v-loading="clickLoading" />
      </el-tab-pane>
    </el-tabs>
  </el-card>
</template>

<style scoped>
.table-error { margin-bottom: 12px; }
/* 路径列：让 cell 给 step chips 留出垂直空间；取消默认换行抑制 */
:deep(.path-col .cell) {
  padding: 8px 12px 12px;
  line-height: 1.5;
}
</style>
