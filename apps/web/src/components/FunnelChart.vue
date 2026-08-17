<script setup>
import { FunnelChart } from 'echarts/charts'
import { TitleComponent, TooltipComponent, LegendComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import * as echarts from 'echarts/core'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

echarts.use([FunnelChart, TitleComponent, TooltipComponent, LegendComponent, CanvasRenderer])

const props = defineProps({
  steps: { type: Array, default: () => [] },
  title: { type: String, default: '' }
})
const element = ref(null)
let chart
let observer

function render() {
  if (!chart) return
  const data = (props.steps || []).map(item => ({
    name: item.step,
    value: Number(item.count) || 0,
    _rate: item.rate,
    _stepRate: item.stepRate,
    _lost: item.lost
  }))
  chart.setOption({
    title: props.title ? { text: props.title, left: 'center', textStyle: { fontSize: 14, color: '#1f2733' } } : undefined,
    tooltip: {
      confine: true,
      trigger: 'item',
      formatter: params => {
        const d = params.data
        return `${d.name}<br/>用户数：${d.value}<br/>整体转化率：${d._rate}%<br/>较上一步：${d._stepRate}%<br/>流失：${d._lost}`
      }
    },
    legend: { type: 'scroll', bottom: 0 },
    series: [{
      type: 'funnel',
      top: props.title ? 36 : 16,
      bottom: 36,
      left: '8%',
      width: '84%',
      min: 0,
      max: data[0]?.value || 1,
      sort: 'none',
      gap: 2,
      label: {
        show: true,
        position: 'inside',
        color: '#fff',
        fontSize: 12,
        formatter: p => `${p.data.name}  ${p.data.value}（${p.data._rate}%）`
      },
      labelLine: { show: false },
      itemStyle: { borderColor: '#fff', borderWidth: 1 },
      emphasis: { label: { fontSize: 14 } },
      data
    }]
  }, true)
}

onMounted(() => {
  chart = echarts.init(element.value)
  observer = new ResizeObserver(() => { if (element.value?.clientWidth && element.value?.clientHeight) chart?.resize() })
  observer.observe(element.value)
  nextTick(render)
})
onBeforeUnmount(() => { observer?.disconnect(); chart?.dispose(); chart = null })
watch(() => props.steps, render, { deep: true })
</script>

<template>
  <div ref="element" class="funnel-chart" role="img" aria-label="漏斗转化图"></div>
</template>

<style scoped>
.funnel-chart { width: 100%; min-height: 340px; }
</style>
