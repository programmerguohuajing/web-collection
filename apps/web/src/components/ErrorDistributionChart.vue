<script setup>
import { PieChart } from 'echarts/charts'
import { AriaComponent, TooltipComponent } from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

echarts.use([PieChart, AriaComponent, TooltipComponent, CanvasRenderer])

const props = defineProps({ items: { type: Array, default: () => [] } })
const root = ref(null)
let chart
let observer
let frame

function render() {
  if (!chart) return
  const data = props.items.map(item => ({ name: item.label, value: item.value, percent: item.percent, itemStyle: { color: item.color } }))
  chart.setOption({
    animation: false,
    aria: { enabled: true, decal: { show: false } },
    tooltip: { trigger: 'item', formatter: params => `${params.name}<br/>${params.value}（${params.percent}%）` },
    series: [{ type: 'pie', radius: ['62%', '82%'], center: ['50%', '50%'], avoidLabelOverlap: true, label: { show: false }, labelLine: { show: false }, data }]
  }, true)
}

onMounted(async () => {
  await nextTick()
  frame = requestAnimationFrame(() => {
    if (!root.value?.clientWidth || !root.value?.clientHeight) return
    chart = echarts.init(root.value)
    observer = new ResizeObserver(() => chart?.resize())
    observer.observe(root.value)
    render()
  })
})
onBeforeUnmount(() => { cancelAnimationFrame(frame); observer?.disconnect(); chart?.dispose(); chart = null })
watch(() => props.items, render, { deep: true })
</script>

<template><div ref="root" class="error-distribution-chart" role="img" aria-label="错误类型分布环形图" /></template>

<style scoped>
.error-distribution-chart { width: 124px; height: 124px; flex: 0 0 124px; }
</style>
