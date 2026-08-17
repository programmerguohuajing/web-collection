<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as echarts from 'echarts/core'
import { LineChart, PieChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
echarts.use([LineChart, PieChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer])

const props = defineProps({ events: { type: Array, default: () => [] } })
const chartEl = ref(null)
const chart = ref(null)

function processData() {
  const trend = []
  const categoryMap = new Map()
  for (const e of props.events) {
    if (e.type !== 'error') continue
    const hour = new Date(Number(e.ts)).toISOString().slice(0, 13)
    if (!trend.find(t => t.bucket === hour)) trend.push({ bucket: hour, errors: 0, users: new Set() })
    const bucket = trend.find(t => t.bucket === hour)
    bucket.errors++
    if (e.userId || e.deviceId) bucket.users.add(e.userId || e.deviceId)
    const cat = e.name || 'Other'
    categoryMap.set(cat, (categoryMap.get(cat) || 0) + 1)
  }
  return {
    trend: trend.slice(-24).map(t => ({ name: t.bucket, errors: t.errors, users: t.users.size })),
    categories: [...categoryMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  }
}

onMounted(() => {
  chart.value = echarts.init(chartEl.value)
  updateChart()
})

watch(() => props.events, updateChart)
onBeforeUnmount(() => chart.value?.dispose())

function updateChart() {
  if (!chart.value) return
  const { trend, categories } = processData()
  chart.value.setOption({
    tooltip: { trigger: 'axis', confine: true },
    legend: { data: ['错误数', '受影响用户'], bottom: 0 },
    grid: { left: 48, right: 20, top: 20, bottom: 40 },
    xAxis: { type: 'category', data: trend.map(t => t.name.slice(5)) },
    yAxis: [{ type: 'value', name: '错误数' }, { type: 'value', name: '用户数' }],
    series: [
      { name: '错误数', type: 'bar', data: trend.map(t => t.errors), itemStyle: { color: '#ef4444' } },
      { name: '受影响用户', type: 'line', yAxisIndex: 1, data: trend.map(t => t.users), smooth: true, itemStyle: { color: '#6d4aff' } }
    ]
  })
}
</script>

<template>
  <div style="margin-top:20px">
    <div class="panel-head" style="margin-bottom:12px"><b>错误趋势</b><small style="margin-left:8px">近 24 小时</small></div>
    <div ref="chartEl" style="height:300px"></div>
  </div>
</template>
