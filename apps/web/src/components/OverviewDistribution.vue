<script setup>
import { computed } from 'vue'
import ErrorDistributionChart from './ErrorDistributionChart.vue'

const props = defineProps({
  summary: { type: Object, default: () => ({}) },
  events: { type: Array, default: () => [] }
})

const source = computed(() => {
  const byType = props.summary?.byType || {}
  if (Object.keys(byType).length) return byType
  return props.events.reduce((result, event) => {
    const key = event.type || 'other'
    result[key] = (result[key] || 0) + 1
    return result
  }, {})
})
const items = computed(() => {
  const labels = { error: 'JS 错误', resource: '资源加载', perf: '接口异常', performance: '接口异常', behavior: '行为事件', track: '埋点事件', other: '其他' }
  const colors = { error: '#ef4444', resource: '#f59e0b', perf: '#0ea5e9', performance: '#0ea5e9', behavior: '#8b5cf6', track: '#4f46e5', other: '#9aa3b2' }
  const rows = Object.entries(source.value).map(([key, value]) => ({ key, label: labels[key] || key, value: Number(value) || 0, color: colors[key] || colors.other }))
  const total = rows.reduce((sum, item) => sum + item.value, 0)
  return rows.sort((a, b) => b.value - a.value).slice(0, 4).map(item => ({ ...item, percent: total ? Math.round(item.value / total * 100) : 0 }))
})
const browsers = [
  { label: 'Chrome', percent: 74, color: '#4f46e5' },
  { label: 'Safari', percent: 16, color: '#0ea5e9' },
  { label: '其他', percent: 10, color: '#9aa3b2' }
]
</script>

<template>
  <el-card shadow="never" class="panel distribution-card">
    <template #header><div class="panel-head"><h2>错误等级分布</h2></div></template>
    <div v-if="items.length" class="distribution-overview">
      <ErrorDistributionChart :items="items" />
      <div class="distribution-legend">
        <div v-for="item in items" :key="item.key" class="legend-row"><span class="distribution-dot" :style="{ background: item.color }" /><span class="distribution-name">{{ item.label }}</span><strong>{{ item.percent }}%</strong></div>
      </div>
    </div>
    <div v-else class="distribution-empty">暂无错误分布数据</div>
    <hr class="hr">
    <div class="browser-title">浏览器分布</div>
    <div v-for="item in browsers" :key="item.label" class="browser-row">
      <span>{{ item.label }}</span><div class="distribution-track"><span :style="{ width: `${item.percent}%`, background: item.color }" /></div><strong>{{ item.percent }}%</strong>
    </div>
  </el-card>
</template>

<style scoped>
.distribution-overview { display: flex; align-items: center; gap: 20px; min-height: 124px; }
.distribution-legend, .browser-row { display: grid; gap: 10px; }
.legend-row { display: grid; grid-template-columns: 9px minmax(84px, 1fr) 38px; align-items: center; gap: 8px; font-size: 13px; }
.distribution-dot { width: 9px; height: 9px; border-radius: 3px; }
.distribution-name, .browser-row > span { color: var(--c-text-muted); }
.distribution-track { height: 8px; overflow: hidden; background: var(--c-surface-3); border-radius: 6px; }
.distribution-track span { display: block; height: 100%; border-radius: inherit; }
.distribution-row strong, .browser-row strong { color: var(--c-text); font-family: var(--font-mono); font-size: 12px; text-align: right; }
.browser-title { margin-bottom: 10px; color: var(--c-text-muted); font-size: 13px; font-weight: 600; }
.browser-row { grid-template-columns: 50px minmax(0, 1fr) 38px; align-items: center; }
.distribution-empty { padding: 25px; color: var(--c-text-faint); text-align: center; }
@media (max-width: 1180px) { .distribution-overview { gap: 12px; } .error-distribution-chart { width: 112px; height: 112px; flex-basis: 112px; } }
</style>
