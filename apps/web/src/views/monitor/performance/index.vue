<script setup>
import EventTable from '../../../components/EventTable.vue'
import PerfPanel from '../../../components/PerfPanel.vue'
import SearchPanel from '../../../components/SearchPanel.vue'
import { perfEvents, perfPager, setPage, setPageSize, summary, tableLoading } from '../../../dashboard.js'
</script>

<template>
  <SearchPanel :fields="['path']" />
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
