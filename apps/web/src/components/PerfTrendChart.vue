<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api, normalizePageResponse, queryFromFilters } from '../dashboard.js'
import { metricLabel } from '../utils/format.js'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
echarts.use([LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer])

const props = defineProps({ metrics: { type: Array, default: () => ['lcp', 'inp', 'cls'] } })
const chartEl = ref(null)
const chart = ref(null)
const trendData = ref([])
const loading = ref(false)
const loadError = ref('')
let loadRequestId = 0

function metricList() {
  return [...new Set((Array.isArray(props.metrics) ? props.metrics : []).map(metric => String(metric || '').trim().toLowerCase()).filter(Boolean))]
}

function initChart() {
  if (!chartEl.value) return
  chart.value = echarts.init(chartEl.value)
  chart.value.setOption({
    tooltip: { trigger: 'axis', confine: true },
    legend: { data: metricList().map(metric => metricLabel(metric)), bottom: 0 },
    grid: { left: 48, right: 20, top: 20, bottom: 40 },
    xAxis: { type: 'category', boundaryGap: false, data: [] },
    yAxis: { type: 'value' },
    series: metricList().map(metric => ({
      name: metricLabel(metric), type: 'line', smooth: true, data: [],
      markLine: metric === 'cls' ? { silent: true, data: [{ yAxis: 0.1, lineStyle: { type: 'dashed', color: '#ef4444' } }] } : undefined
    }))
  })
}

function renderChart() {
  if (!chart.value) return
  const metrics = metricList()
  chart.value.setOption({
    legend: { data: metrics.map(metric => metricLabel(metric)) },
    xAxis: { data: trendData.value.map(point => point.label) },
    series: metrics.map(metric => ({
      name: metricLabel(metric),
      type: 'line',
      smooth: true,
      data: trendData.value.map(point => point.values[metric] ?? null)
    }))
  })
}

async function load() {
  const requestId = ++loadRequestId
  const metrics = metricList()
  loadError.value = ''
  loading.value = true
  try {
    if (!metrics.length) {
      trendData.value = []
      renderChart()
      return
    }
    const query = queryFromFilters({ type: 'perf', page: 1, pageSize: 100 }, ['appId', 'release', 'startTime', 'endTime', 'type', 'page', 'pageSize'])
    const response = await api(`/api/events?${query}`, {
      requestKey: 'analytics:perf-trend',
      timeout: 15000
    })
    if (requestId !== loadRequestId) return
    const rows = normalizePageResponse(response).items
    const wanted = new Set(metrics)
    const grouped = new Map()
    for (const row of rows) {
      const metric = String(row?.metric || row?.name || '').toLowerCase()
      const value = Number(row?.value)
      const timestamp = Number(row?.ts)
      if (!wanted.has(metric) || !Number.isFinite(value) || !Number.isFinite(timestamp)) continue
      const bucket = new Date(timestamp)
      bucket.setHours(0, 0, 0, 0)
      const key = bucket.getTime()
      const point = grouped.get(key) || { bucket: key, label: bucket.toLocaleDateString(), values: {}, counts: {} }
      point.values[metric] = (point.values[metric] || 0) + value
      point.counts[metric] = (point.counts[metric] || 0) + 1
      grouped.set(key, point)
    }
    trendData.value = [...grouped.values()].sort((a, b) => a.bucket - b.bucket).map(point => {
      const values = {}
      for (const metric of metrics) values[metric] = point.counts[metric] ? point.values[metric] / point.counts[metric] : null
      return { bucket: point.bucket, label: point.label, values }
    })
    renderChart()
  } catch (error) {
    if (requestId === loadRequestId && error?.code !== 'ABORT_ERR') {
      trendData.value = []
      renderChart()
      loadError.value = error?.message || '性能趋势加载失败，请稍后重试'
    }
  } finally {
    if (requestId === loadRequestId) loading.value = false
  }
}

onMounted(() => {
  initChart()
  void load()
})

watch(() => props.metrics, () => {
  chart.value?.dispose()
  chart.value = null
  initChart()
  void load()
})

onBeforeUnmount(() => chart.value?.dispose())
</script>

<template>
  <div style="margin-top:20px">
    <div class="panel-head" style="margin-bottom:12px"><b>性能趋势</b><small style="margin-left:8px">{{ metrics.map(m => metricLabel(m)).join(' / ') }}</small><el-button text size="small" @click="load" :loading="loading">刷新</el-button></div>
    <el-alert v-if="loadError" type="error" :title="loadError" show-icon :closable="false" class="trend-alert">
      <template #default><el-button link type="primary" @click="load">重试</el-button></template>
    </el-alert>
    <el-empty v-else-if="!loading && !trendData.length" description="当前筛选条件暂无性能趋势数据" :image-size="60" />
    <div ref="chartEl" style="height:320px"></div>
  </div>
</template>

<style scoped>
.trend-alert { margin-bottom: 10px; }
</style>
