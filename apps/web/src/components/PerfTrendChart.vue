<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api, queryFromFilters } from '../dashboard.js'
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

async function load() {
  loading.value = true
  try {
    const rows = await Promise.all(props.metrics.map(m =>
      api(`/api/analytics/insights/query`, {
        method: 'POST',
        body: { definition: { interval: 'day', measure: 'avg', breakdown: 'release', filter: [{ metric: m }] } }
      }).catch(() => ({ series: [] }))
    ))
    const points = new Map()
    for (const series of rows) {
      for (const s of (series.series || [])) {
        for (const p of (s.points || [])) {
          const key = `${p.bucket}_${m}`
          if (!points.has(key)) points.set(key, { bucket: p.bucket, values: {} })
          points.get(key).values[s.name] = p.value
        }
      }
    }
    trendData.value = [...points.values()].sort((a, b) => a.bucket - b.bucket)
  } finally { loading.value = false }
}

onMounted(() => {
  chart.value = echarts.init(chartEl.value)
  chart.value.setOption({
    tooltip: { trigger: 'axis' },
    legend: { data: props.metrics.map(m => m.toUpperCase()), bottom: 0 },
    grid: { left: 48, right: 20, top: 20, bottom: 40 },
    xAxis: { type: 'category', boundaryGap: false },
    yAxis: { type: 'value' },
    series: props.metrics.map(m => ({
      name: m.toUpperCase(), type: 'line', smooth: true, data: [],
      markLine: m === 'cls' ? { silent: true, data: [{ yAxis: 0.1, lineStyle: { type: 'dashed', color: '#ef4444' } }] } : undefined
    }))
  })
  load()
})

watch(() => props.metrics, () => { chart.value?.dispose(); chart.value = echarts.init(chartEl.value); load() })

onBeforeUnmount(() => chart.value?.dispose())
</script>

<template>
  <div style="margin-top:20px">
    <div class="panel-head" style="margin-bottom:12px"><b>性能趋势</b><small style="margin-left:8px">{{ metrics.map(m => m.toUpperCase()).join(' / ') }}</small><el-button text size="small" @click="load" :loading="loading">刷新</el-button></div>
    <div ref="chartEl" style="height:320px"></div>
  </div>
</template>
