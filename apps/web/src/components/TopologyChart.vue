<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as echarts from 'echarts/core'
import { GraphChart } from 'echarts/charts'
import { TooltipComponent, LegendComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([GraphChart, TooltipComponent, LegendComponent, CanvasRenderer])

const props = defineProps({
  // 节点：{ id, label, type, value }
  nodes: { type: Array, default: () => [] },
  // 边：{ source, target, calls|sessions, avgDuration?, errors? }
  edges: { type: Array, default: () => [] },
  height: { type: String, default: '520px' },
  // 按节点 type 着色
  nodeColors: {
    type: Object,
    default: () => ({ page: '#409EFF', api: '#67C23A', click: '#E6A23C', default: '#909399' })
  },
  emptyText: { type: String, default: '暂无拓扑数据' }
})

const chartEl = ref(null)
let chart = null
let resizeObserver = null

function buildOption() {
  const colorMap = props.nodeColors
  const types = [...new Set(props.nodes.map(n => n.type || 'default'))]
  const categories = types.map(t => ({ name: t, itemStyle: { color: colorMap[t] || colorMap.default } }))

  const data = props.nodes.map(n => {
    const type = n.type || 'default'
    const value = Number(n.value || 0)
    return {
      id: n.id,
      name: n.id,
      label: n.label || n.id,
      value,
      category: type,
      symbolSize: Math.max(18, Math.min(64, 16 + Math.sqrt(value || 1) * 6)),
      itemStyle: { color: colorMap[type] || colorMap.default }
    }
  })

  const links = props.edges.map(e => {
    const hasError = Number(e.errors || 0) > 0
    const weight = Number(e.calls ?? e.sessions ?? 1)
    return {
      source: e.source,
      target: e.target,
      value: weight,
      lineStyle: {
        color: hasError ? '#F56C6C' : '#C0C4CC',
        width: Math.max(1, Math.min(6, Math.log2(weight + 1) * 1.4)),
        curveness: 0.12,
        opacity: 0.85
      },
      label: {
        show: true,
        formatter: hasError ? `✕${e.errors}` : String(weight),
        color: hasError ? '#F56C6C' : '#909399',
        fontSize: 10
      }
    }
  })

  return {
    tooltip: {
      confine: true,
      formatter: (p) => {
        if (p.dataType === 'node') {
          return `${p.data.label}<br/>类型：${p.data.category}<br/>权重：${p.data.value}`
        }
        const e = props.edges[p.dataIndex] || {}
        const parts = [`调用次数：${e.calls ?? e.sessions ?? '-'}`]
        if (e.avgDuration != null) parts.push(`平均耗时：${e.avgDuration}ms`)
        if (e.errors) parts.push(`错误数：${e.errors}`)
        if (e.sessions != null) parts.push(`会话数：${e.sessions}`)
        return parts.join('<br/>')
      }
    },
    legend: [{ data: types, top: 8, type: 'scroll' }],
    animationDuration: 600,
    series: [{
      type: 'graph',
      layout: 'force',
      roam: true,
      draggable: true,
      zoom: 1,
      force: { repulsion: 240, edgeLength: [60, 160], gravity: 0.08, friction: 0.18 },
      label: { show: true, position: 'right', formatter: p => p.data.label, fontSize: 11, color: '#303133' },
      edgeSymbol: ['none', 'arrow'],
      edgeSymbolSize: 6,
      emphasis: { focus: 'adjacency', label: { show: true } },
      categories,
      data,
      links
    }]
  }
}

function render() {
  if (!chart) return
  chart.setOption(buildOption(), true)
}

function resize() {
  if (chart) chart.resize()
}

onMounted(() => {
  if (!chartEl.value) return
  chart = echarts.init(chartEl.value)
  render()
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(chartEl.value)
  } else {
    window.addEventListener('resize', resize)
  }
})

watch(() => [props.nodes, props.edges], () => render(), { deep: true })

onBeforeUnmount(() => {
  if (resizeObserver) resizeObserver.disconnect()
  else window.removeEventListener('resize', resize)
  if (chart) {
    chart.dispose()
    chart = null
  }
})
</script>

<template>
  <div class="topology-wrap">
    <div ref="chartEl" class="topology-canvas" :style="{ height }"></div>
    <div v-if="!nodes.length && !edges.length" class="topology-empty" :style="{ height }">
      <el-empty :description="emptyText" />
    </div>
  </div>
</template>

<style scoped>
.topology-wrap { position: relative; width: 100%; }
.topology-canvas { width: 100%; }
.topology-empty {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
</style>
