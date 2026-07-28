<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import * as echarts from 'echarts/core'
import { PieChart } from 'echarts/charts'
import { TooltipComponent, LegendComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
echarts.use([PieChart, TooltipComponent, LegendComponent, CanvasRenderer])

const props = defineProps({ events: { type: Array, default: () => [] } })
const chartEl = ref(null)
const chart = ref(null)

const categoryData = computed(() => {
  const map = new Map()
  for (const e of props.events) {
    if (e.type !== 'error') continue
    const cat = e.name || 'Other'
    map.set(cat, (map.get(cat) || 0) + 1)
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, value]) => ({ name, value }))
})

onMounted(() => {
  chart.value = echarts.init(chartEl.value)
  chart.value.setOption({
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    series: [{ type: 'pie', radius: ['40%', '70%'], data: categoryData.value }]
  })
})

watch(() => props.events, () => {
  chart.value?.setOption({ series: [{ data: categoryData.value }] })
})
</script>

<template>
  <div style="margin-top:20px">
    <div class="panel-head" style="margin-bottom:12px"><b>错误分类</b></div>
    <div ref="chartEl" style="height:260px"></div>
  </div>
</template>
