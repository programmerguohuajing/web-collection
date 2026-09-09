<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

/**
 * 轻量双轴折线图，用于 API 健康视图的端点时序下钻。
 * 左轴默认承载耗时类指标（ms），右轴承载比率类指标（%），避免量纲差异把曲线压平。
 */
const props = defineProps({
  // series: [{ name, data: [[x, y], ...], color?, axis?: 'left' | 'right' }]
  series: { type: Array, default: () => [] },
  height: { type: String, default: '240px' },
  axisNames: { type: Object, default: () => ({ left: '', right: '' }) },
  emptyText: { type: String, default: '暂无时序数据' }
})

const chartEl = ref(null)
let chart = null
let resizeObserver = null

const hasData = computed(() => props.series.some(item => Array.isArray(item.data) && item.data.length > 0))

function pad(value) {
  return String(value).padStart(2, '0')
}

/** 时间轴标签统一为 MM-DD HH:mm，避免不同 locale 下标签宽度抖动。 */
function formatTime(value) {
  const date = new Date(Number(value))
  if (Number.isNaN(date.getTime())) return String(value)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function buildOption() {
  const useRightAxis = props.series.some(item => item.axis === 'right')
  const yAxis = [{ type: 'value', name: props.axisNames.left || '', scale: true, nameTextStyle: { color: '#909399' } }]
  if (useRightAxis) {
    yAxis.push({ type: 'value', name: props.axisNames.right || '', scale: true, nameTextStyle: { color: '#909399' } })
  }
  return {
    tooltip: { trigger: 'axis' },
    legend: { data: props.series.map(item => item.name), top: 0, textStyle: { color: '#606266' } },
    grid: { left: 12, right: useRightAxis ? 12 : 16, top: 38, bottom: 8, containLabel: true },
    xAxis: {
      type: 'time',
      axisLabel: { formatter: formatTime, color: '#909399' },
      axisLine: { lineStyle: { color: '#DCDFE6' } }
    },
    yAxis,
    series: props.series.map(item => ({
      name: item.name,
      type: 'line',
      smooth: true,
      showSymbol: false,
      data: item.data || [],
      yAxisIndex: item.axis === 'right' && useRightAxis ? 1 : 0,
      lineStyle: { width: 2, color: item.color },
      itemStyle: { color: item.color }
    }))
  }
}

function render() {
  if (!chartEl.value) return
  if (!hasData.value) {
    if (chart) {
      chart.dispose()
      chart = null
    }
    return
  }
  if (!chart) chart = echarts.init(chartEl.value)
  chart.setOption(buildOption(), true)
  chart.resize()
}

onMounted(() => {
  render()
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => chart?.resize())
    resizeObserver.observe(chartEl.value)
  }
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  chart?.dispose()
  chart = null
})

watch(() => props.series, render, { deep: true })
</script>

<template>
  <div class="mini-line-chart">
    <div v-show="hasData" ref="chartEl" class="mini-line-canvas" :style="{ height }"></div>
    <el-empty v-if="!hasData" :image-size="54" :description="emptyText" />
  </div>
</template>

<style scoped>
.mini-line-chart { width: 100%; }
.mini-line-canvas { width: 100%; min-height: 180px; }
</style>
