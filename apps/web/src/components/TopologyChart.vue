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
  // 按节点 type 着色（宝石色系）
  nodeColors: {
    type: Object,
    default: () => ({ page: '#6366f1', api: '#059669', click: '#d97706', default: '#64748b' })
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
    const color = colorMap[type] || colorMap.default
    const size = Math.max(20, Math.min(68, 18 + Math.sqrt(value || 1) * 6.5))
    const displayName = n.label || n.id
    return {
      id: n.id,
      name: displayName,
      value,
      category: type,
      symbolSize: size,
      itemStyle: {
        color: {
          type: 'radial', x: 0.35, y: 0.3, r: 0.9,
          colorStops: [
            { offset: 0, color: lighten(color, 28) },
            { offset: 1, color }
          ]
        },
        shadowBlur: 14,
        shadowColor: hexA(color, 0.35),
        shadowOffsetY: 3,
        borderWidth: 2,
        borderColor: '#ffffff'
      },
      label: {
        show: true,
        position: 'bottom',
        distance: 6,
        formatter: () => displayName,
        fontSize: 11,
        fontWeight: 600,
        color: '#2b3547',
        backgroundColor: 'rgba(255,255,255,.92)',
        borderColor: '#e2e8f0',
        borderWidth: 1,
        borderRadius: 8,
        padding: [4, 8]
      },
      emphasis: {
        scale: 1.12,
        itemStyle: { shadowBlur: 22, shadowColor: hexA(color, 0.5) }
      }
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
        color: hasError ? '#f87171' : '#b6c0d1',
        width: Math.max(1.2, Math.min(5, Math.log2(weight + 1) * 1.3)),
        curveness: 0.18,
        opacity: hasError ? 0.95 : 0.7
      },
      label: {
        show: true,
        formatter: hasError ? `⚠${e.errors}` : String(weight),
        color: hasError ? '#dc2626' : '#7c8aa0',
        fontSize: 10,
        backgroundColor: hasError ? '#fef2f2' : 'rgba(255,255,255,.9)',
        borderColor: hasError ? '#fecaca' : '#e2e8f0',
        borderWidth: 1,
        borderRadius: 7,
        padding: [2, 6]
      }
    }
  })

  return {
    tooltip: {
      confine: true,
      backgroundColor: 'rgba(255,255,255,.97)',
      borderColor: '#e2e8f0',
      borderWidth: 1,
      padding: [10, 14],
      textStyle: { color: '#2b3547', fontSize: 12 },
      extraCssText: 'box-shadow:0 8px 24px rgba(23,32,51,.12);border-radius:10px;',
      formatter: (p) => {
        if (p.dataType === 'node') {
          return `<div style="font-weight:700;color:#4f46e5;margin-bottom:4px">${escapeHtml(p.name)}</div>`
            + `<div style="color:#7c8aa0;font-size:11px">类型：${escapeHtml(p.data.category)}<br/>权重：${p.data.value}</div>`
        }
        const e = props.edges[p.dataIndex] || {}
        const parts = [`<div style="font-weight:700;margin-bottom:4px">调用次数：${e.calls ?? e.sessions ?? '-'}</div>`]
        if (e.avgDuration != null) parts.push(`<div style="color:#7c8aa0;font-size:11px">平均耗时：${e.avgDuration}ms</div>`)
        if (e.errors) parts.push(`<div style="color:#dc2626;font-size:11px;font-weight:600">错误数：${e.errors}</div>`)
        if (e.sessions != null) parts.push(`<div style="color:#7c8aa0;font-size:11px">会话数：${e.sessions}</div>`)
        return parts.join('')
      }
    },
    legend: [{
      data: types, top: 10, type: 'scroll',
      textStyle: { color: '#627085', fontSize: 11 },
      itemWidth: 14, itemHeight: 10, itemStyle: { borderRadius: 5 }
    }],
    animationDuration: 700,
    animationEasing: 'cubicOut',
    series: [{
      type: 'graph',
      layout: 'force',
      roam: true,
      draggable: true,
      zoom: 1,
      force: { repulsion: 320, edgeLength: [80, 200], gravity: 0.06, friction: 0.2, layoutAnimation: true },
      edgeSymbol: ['none', 'arrow'],
      edgeSymbolSize: 7,
      emphasis: { focus: 'adjacency', scale: true },
      categories,
      data,
      links
    }]
  }
}

/** hex 颜色提亮 */
function lighten(hex, amt = 20) {
  const h = String(hex || '#64748b').replace('#', '')
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h.padEnd(6, '0')
  const p = Math.max(0, Math.min(100, amt)) / 100
  const ch = [0, 2, 4].map(i => {
    const v = parseInt(full.slice(i, i + 2), 16)
    return Math.round(v + (255 - v) * p).toString(16).padStart(2, '0')
  })
  return '#' + ch.join('')
}
/** hex 转 rgba */
function hexA(hex, alpha = 1) {
  const h = String(hex || '#64748b').replace('#', '')
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h.padEnd(6, '0')
  const [r, g, b] = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16))
  return `rgba(${r},${g},${b},${alpha})`
}
/** HTML 转义（tooltip 防注入） */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
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
.topology-canvas {
  width: 100%;
  background:
    radial-gradient(1000px 420px at 50% -10%, rgba(99,102,241,.05), transparent 60%),
    linear-gradient(180deg, #fbfcfe 0%, #f4f6fa 100%);
  border: 1px solid var(--line, #dfe5ec);
  border-radius: 10px;
}
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
