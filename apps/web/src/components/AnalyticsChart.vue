<script setup>
import { BarChart, LineChart, SankeyChart } from 'echarts/charts'
import { AriaComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

echarts.use([LineChart, BarChart, SankeyChart, AriaComponent, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

const props = defineProps({
  kind: { type: String, required: true },
  result: { type: Object, default: () => ({}) },
  chartType: { type: String, default: 'line' }
})
const emit = defineEmits(['select-node'])
const element = ref(null)
let chart
let observer

function render() {
  if (!chart) return
  chart.setOption(props.kind === 'path' ? pathOption(props.result) : trendOption(props.result, props.chartType), true)
}

function trendOption(result, chartType) {
  const buckets = [...new Set((result.table || []).map(item => Number(item.bucket)))].sort((a, b) => a - b)
  return {
    aria: { enabled: true },
    tooltip: { trigger: 'axis' },
    legend: { type: 'scroll' },
    grid: { left: 55, right: 24, top: 45, bottom: 45 },
    xAxis: { type: 'category', data: buckets.map(formatBucket), boundaryGap: chartType === 'bar' },
    yAxis: { type: 'value', minInterval: 1 },
    series: (result.series || []).map(item => ({
      name: item.name,
      type: chartType === 'bar' ? 'bar' : 'line',
      smooth: chartType !== 'bar',
      data: buckets.map(bucket => item.points?.find(point => Number(point.bucket) === bucket)?.value || 0)
    }))
  }
}

function pathOption(result) {
  const labels = new Map((result.nodes || []).map(item => [item.id, item.label]))
  return {
    animation: false,
    aria: { enabled: true },
    tooltip: {
      trigger: 'item',
      formatter: params => params.dataType === 'edge'
        ? `${labels.get(params.data.source) || params.data.source} → ${labels.get(params.data.target) || params.data.target}<br/>用户 ${params.data.users} · 会话 ${params.data.sessions}`
        : `${params.data.display}<br/>用户 ${params.data.users} · 会话 ${params.data.sessions}`
    },
    series: [{
      type: 'sankey',
      emphasis: { focus: 'adjacency' },
      nodeAlign: 'left',
      draggable: false,
      data: (result.nodes || []).map(item => ({ name: item.id, display: item.label, users: item.users, sessions: item.sessions, value: item.users, label: { formatter: item.label } })),
      links: result.edges || [],
      lineStyle: { color: 'gradient', curveness: 0.5 },
      levels: Array.from({ length: 8 }, (_, depth) => ({ depth, itemStyle: { borderWidth: 0 }, lineStyle: { opacity: 0.32 } }))
    }]
  }
}

function formatBucket(value) {
  const date = new Date(value)
  return date.getHours() || date.getMinutes()
    ? `${date.getMonth() + 1}-${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:00`
    : `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

onMounted(() => {
  chart = echarts.init(element.value)
  chart.on('click', params => {
    if (props.kind === 'path' && params.dataType === 'node') emit('select-node', (props.result.nodes || []).find(item => item.id === params.data.name))
  })
  observer = new ResizeObserver(() => {
    if (element.value?.clientWidth && element.value?.clientHeight) chart?.resize()
  })
  observer.observe(element.value)
  nextTick(render)
})
onBeforeUnmount(() => { observer?.disconnect(); chart?.dispose(); chart = null })
watch(() => [props.kind, props.result, props.chartType], render, { deep: true })
</script>

<template>
  <div ref="element" class="analytics-chart" role="img" :aria-label="kind === 'path' ? '用户路径图' : '事件趋势图'"></div>
</template>

<style scoped>
.analytics-chart { width: 100%; min-height: 380px; }
</style>
