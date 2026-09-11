<script setup>
import { computed, ref, watch } from 'vue'
import { api, pageLoading, queryFromFilters, refreshVersion } from '../../../dashboard.js'
import { useFilterStore } from '../../../stores/filters.js'
import KpiGrid from '../../../components/KpiGrid.vue'
import OverflowTip from '../../../components/OverflowTip.vue'
import TopologyChart from '../../../components/TopologyChart.vue'
import MiniLineChart from '../../../components/MiniLineChart.vue'
import { QuestionFilled } from '@element-plus/icons-vue'

/**
 * API 健康视图（Next Horizon E2）。
 * 数据源复用已有 fetch/xhr 性能事件（/api/analytics/api-health），不新增任何采集。
 * 时间范围统一沿用顶部全局筛选（store.range），页面内不再提供第二套时间选择器。
 * 表格列溢出一律使用 OverflowTip（禁用原生 show-overflow-tooltip）。
 */
const store = useFilterStore()

const endpoints = ref([])
const total = ref(0)
const loading = ref(false)
const loadError = ref('')
const keyword = ref('')
const drawerOpen = ref(false)
const activeEndpoint = ref('')
const series = ref([])
const seriesLoading = ref(false)

/** 当前全局时间范围的可读描述（仅展示，页面内不提供独立时间选择器）。 */
const rangeLabel = computed(() => {
  const [start, end] = store.range || []
  if (!start || !end) return '全部时间'
  const hours = Math.max(1, Math.round((end - start) / 3600000))
  return hours < 24 ? `近 ${hours} 小时` : `近 ${Math.round(hours / 24)} 天`
})

const filtered = computed(() => {
  const key = keyword.value.trim().toLowerCase()
  if (!key) return endpoints.value
  return endpoints.value.filter(item => String(item.endpoint || '').toLowerCase().includes(key))
})

const kpis = computed(() => {
  const calls = endpoints.value.reduce((sum, item) => sum + Number(item.count || 0), 0)
  const errors = endpoints.value.reduce((sum, item) => sum + Number(item.errorCount || 0), 0)
  const worstP95 = endpoints.value.reduce((max, item) => Math.max(max, Number(item.p95 || 0)), 0)
  const worstErrorRate = endpoints.value.reduce((max, item) => Math.max(max, Number(item.errorRate || 0)), 0)
  return [
    { label: '端点数', value: endpoints.value.length.toLocaleString(), delta: '当前筛选范围', valueClass: 'value-primary' },
    { label: '总调用量', value: calls.toLocaleString(), delta: 'fetch / xhr', valueClass: 'value-success' },
    { label: '整体错误率', value: calls ? `${(errors / calls * 100).toFixed(2)}%` : '0%', delta: '状态码 ≥ 400', valueClass: 'value-danger' },
    { label: '最高 P95', value: `${worstP95.toLocaleString()} ms`, delta: `最高错误率 ${(worstErrorRate * 100).toFixed(1)}%`, valueClass: 'value-purple' }
  ]
})

// 依赖拓扑：当前仅能拿到前端 fetch/xhr 聚合，无法还原服务端内部调用链，
// 因此以「客户端 → 各 API 端点」的调用关系占位，页面上已明确标注该限制。
const topology = computed(() => {
  const source = filtered.value.slice(0, 12)
  const nodes = [{ id: 'client', label: '浏览器 / 客户端', type: 'page', value: source.reduce((sum, item) => sum + Number(item.count || 0), 0) }]
  const edges = []
  for (const item of source) {
    const id = `api:${item.endpoint}`
    nodes.push({ id, label: item.endpoint, type: 'api', value: Number(item.count || 0) })
    edges.push({
      source: 'client',
      target: id,
      calls: Number(item.count || 0),
      sessions: Number(item.count || 0),
      avgDuration: Number(item.avgDuration || 0),
      errors: Number(item.errorCount || 0)
    })
  }
  return { nodes, edges }
})

const seriesChart = computed(() => {
  const points = series.value
  if (!points.length) return []
  return [
    { name: 'P95 耗时(ms)', axis: 'left', color: '#409EFF', data: points.map(point => [point.bucket, point.p95]) },
    { name: '平均耗时(ms)', axis: 'left', color: '#67C23A', data: points.map(point => [point.bucket, point.avgDuration]) },
    { name: '错误率(%)', axis: 'right', color: '#F56C6C', data: points.map(point => [point.bucket, Number((point.errorRate * 100).toFixed(2))]) }
  ]
})

async function load() {
  loading.value = true
  loadError.value = ''
  pageLoading.value = true
  try {
    const data = await api(`/api/analytics/api-health?${queryFromFilters()}`, { requestKey: 'api-health:list' })
    endpoints.value = Array.isArray(data?.endpoints) ? data.endpoints : []
    total.value = Number(data?.total ?? endpoints.value.length)
  } catch (error) {
    if (error?.code !== 'ABORT_ERR') loadError.value = error.message || 'API 健康数据加载失败'
    endpoints.value = []
    total.value = 0
  } finally {
    loading.value = false
    pageLoading.value = false
  }
}

async function openDetail(row) {
  activeEndpoint.value = row?.endpoint || ''
  drawerOpen.value = true
  series.value = []
  seriesLoading.value = true
  try {
    const data = await api(
      `/api/analytics/api-health?endpoint=${encodeURIComponent(activeEndpoint.value)}&${queryFromFilters()}`,
      { requestKey: 'api-health:series' }
    )
    series.value = Array.isArray(data?.series) ? data.series : []
  } catch {
    series.value = []
  } finally {
    seriesLoading.value = false
  }
}

/** 状态码分布对象 → 按次数降序的标签数组（0 视为未采集）。 */
function statusList(row) {
  const codes = row?.statusCodes || {}
  return Object.entries(codes)
    .map(([code, count]) => ({ code: Number(code), count: Number(count) || 0 }))
    .filter(item => item.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
}

function statusLabel(code) {
  return code === 0 ? '未知' : String(code)
}

function statusTagType(code) {
  if (code >= 500) return 'danger'
  if (code >= 400) return 'warning'
  if (code === 0) return 'info'
  if (code >= 300) return 'info'
  return 'success'
}

function errorRateType(rate) {
  if (rate >= 0.1) return 'danger'
  if (rate >= 0.01) return 'warning'
  return 'success'
}

// 顶部全局条件（含时间范围）切换时 refreshVersion 自增，统一在此重载。
watch(refreshVersion, () => load(), { immediate: true })
</script>

<template>
  <div class="api-health-toolbar">
    <el-input v-model="keyword" size="small" clearable placeholder="按端点关键字过滤" class="api-health-keyword" />
    <el-button size="small" type="primary" :loading="loading" @click="load">刷新</el-button>
    <span class="api-health-range-hint">时间范围沿用顶部全局筛选 · {{ rangeLabel }}</span>
  </div>

  <el-alert v-if="loadError" class="table-error" type="error" :title="loadError" show-icon :closable="false">
    <template #default><el-button link type="primary" @click="load">重试</el-button></template>
  </el-alert>

  <KpiGrid :items="kpis" />

  <el-card shadow="never" class="panel section">
    <template #header>
      <div class="panel-head">
        <h2>API 端点健康</h2>
        <small>{{ filtered.length }} 个端点 / 共 {{ total }} 个</small>
      </div>
    </template>
    <el-table :data="filtered" border size="small" v-loading="loading" empty-text="暂无 API 调用数据">
      <el-table-column label="端点" min-width="280">
        <template #default="{ row }">
          <div class="endpoint-cell">
            <el-tag size="small" effect="plain" type="info">{{ row.method }}</el-tag>
            <OverflowTip :text="row.url" />
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="count" label="调用量" width="110" align="right" sortable />
      <el-table-column label="错误率" width="110" align="right">
        <template #default="{ row }">
          <el-tag size="small" :type="errorRateType(row.errorRate)">{{ (row.errorRate * 100).toFixed(1) }}%</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="p50" label="P50(ms)" width="100" align="right" sortable />
      <el-table-column prop="p95" label="P95(ms)" width="100" align="right" sortable />
      <el-table-column prop="maxDuration" label="最大(ms)" width="100" align="right" />
      <el-table-column label="状态码分布" min-width="230">
        <template #default="{ row }">
          <div class="status-cell">
            <el-tag v-for="item in statusList(row)" :key="item.code" size="small" :type="statusTagType(item.code)">
              {{ statusLabel(item.code) }}×{{ item.count }}
            </el-tag>
            <span v-if="!statusList(row).length" class="muted">-</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="100" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDetail(row)">下钻</el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-card shadow="never" class="panel section">
    <template #header>
      <div class="panel-head">
        <h2>API 依赖拓扑</h2>
        <small>端点调用关系</small>
      </div>
    </template>
    <TopologyChart :nodes="topology.nodes" :edges="topology.edges" height="420px" empty-text="暂无端点可绘制拓扑" />
  </el-card>

  <el-drawer v-model="drawerOpen" :title="`端点详情 · ${activeEndpoint}`" size="60%">
    <div v-loading="seriesLoading">
      <el-alert v-if="!series.length && !seriesLoading" type="info" :closable="false" show-icon title="暂无该端点的时序数据" />
      <template v-else>
        <MiniLineChart :series="seriesChart" :axis-names="{ left: '耗时(ms)', right: '错误率(%)' }" height="260px" />
        <el-table :data="series" size="small" border class="series-table">
          <el-table-column label="时间" min-width="170">
            <template #default="{ row }">{{ new Date(row.bucket).toLocaleString() }}</template>
          </el-table-column>
          <el-table-column prop="count" label="调用量" width="90" align="right" />
          <el-table-column prop="errorCount" label="错误数" width="90" align="right" />
          <el-table-column label="错误率" width="100" align="right">
            <template #default="{ row }">{{ (row.errorRate * 100).toFixed(1) }}%</template>
          </el-table-column>
          <el-table-column prop="avgDuration" label="平均(ms)" width="100" align="right" />
          <el-table-column prop="p95" label="P95(ms)" width="100" align="right" />
        </el-table>
      </template>
    </div>
  </el-drawer>
</template>

<style scoped>
.api-health-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 12px; }
.api-health-keyword { width: 240px; }
.api-health-keyword :deep(.el-input__wrapper) { height: 32px; padding: 0 11px; }
.api-health-keyword :deep(.el-input__inner) { height: 30px; line-height: 30px; }
.api-health-range-hint { color: var(--c-text-muted); font-size: 12px; }
.table-error { margin-bottom: 12px; }
.endpoint-cell { display: flex; align-items: center; gap: 8px; min-width: 0; }
/* 方法标签（GET/POST…）不参与 flex 收缩：URL 过长时标签会被压缩成「G…」「PO…」，
   flex:0 0 auto + nowrap 保证方法名始终全文展示，溢出省略交给右侧 OverflowTip（悬浮全文）。 */
.endpoint-cell .el-tag { flex: 0 0 auto; white-space: nowrap; }
.status-cell { display: flex; flex-wrap: wrap; gap: 5px; }
.muted { color: var(--c-text-muted); }
.topology-note { margin-bottom: 12px; }
.series-table { margin-top: 16px; }
</style>
