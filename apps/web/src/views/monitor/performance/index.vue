<script setup>
import { computed } from 'vue'
import EventTable from '../../../components/EventTable.vue'
import PerfPanel from '../../../components/PerfPanel.vue'
import SearchPanel from '../../../components/SearchPanel.vue'
import KpiGrid from '../../../components/KpiGrid.vue'
import { perfEvents, perfPager, setPage, setPageSize, summary, tableLoading, refreshAll } from '../../../dashboard.js'

const perfKpis = computed(() => [
  { label: 'LCP 最大内容渲染', value: summary.value?.perf?.lcp != null ? `${(Number(summary.value.perf.lcp) / 1000).toFixed(2)} s` : '-', delta: 'Core Web Vitals', valueClass: 'value-danger' },
  { label: 'FCP 首次内容渲染', value: summary.value?.perf?.fcp != null ? `${(Number(summary.value.perf.fcp) / 1000).toFixed(2)} s` : '-', delta: 'Core Web Vitals', valueClass: 'value-success' },
  { label: 'CLS 布局偏移', value: summary.value?.perf?.cls != null ? Number(summary.value.perf.cls).toFixed(2) : '-', delta: '页面稳定性', valueClass: 'value-success' },
  { label: 'INP 交互延迟', value: summary.value?.perf?.inp != null ? `${Math.round(Number(summary.value.perf.inp))} ms` : '-', delta: '交互体验', valueClass: 'value-success' }
])
</script>

<template>
  <div class="page-heading"><div><h1>性能分析</h1><p>Web Vitals、资源加载与长任务的性能指标分析</p></div></div>
  <KpiGrid :items="perfKpis" />
  <SearchPanel :fields="['path', 'keyword']" @search="refreshAll" />
  <PerfPanel :perf="summary?.perf || {}" :counts="summary?.perfCounts || {}" />
  <section class="grid performance-grid">
    <EventTable title="慢接口" :rows="summary?.api || []" />
    <EventTable title="慢资源" :rows="summary?.resources || []" />
  </section>
  <EventTable title="性能事件" :rows="perfEvents" :loading="tableLoading.perf" :total="perfPager.total" :page="perfPager.page" :page-size="perfPager.pageSize" stream @page-change="setPage('perf', $event)" @size-change="setPageSize('perf', $event)" />
</template>

<style scoped>
.performance-grid { margin-top: 14px; }
</style>
