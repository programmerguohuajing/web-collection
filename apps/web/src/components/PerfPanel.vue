<script setup>
/**
 * @file 性能指标面板组件
 * 展示 Web Vitals 各指标的 P75 值（LCP、INP、FID、CLS、FCP、TTFB、LongTask）。
 */
defineProps({ perf: { type: Object, default: () => ({}) } })
/** 展示的性能指标列表 */
const metrics = ['lcp', 'inp', 'fid', 'cls', 'fcp', 'ttfb', 'longtask']

const metricLabels = {
  lcp: '最大内容渲染',
  inp: '交互延迟',
  fid: '首次输入延迟',
  cls: '累积布局偏移',
  fcp: '首次内容渲染',
  ttfb: '首字节时间',
  longtask: '长任务'
}

function formatMs(value) {
  if (value == null || Number.isNaN(Number(value))) return '-'
  return `${Math.round(Number(value))}ms`
}
</script>

<template>
  <el-card shadow="never" class="panel">
    <template #header><div class="panel-head"><h2>性能 P75</h2><small>Web Vitals</small></div></template>
    <div class="perf-list">
      <div v-for="name in metrics" :key="name"><span>{{ metricLabels[name] || name }}</span><strong>{{ formatMs(perf[name]) }}</strong></div>
    </div>
  </el-card>
</template>
