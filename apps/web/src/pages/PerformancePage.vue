<script setup>
import EventTable from '../components/EventTable.vue'
import PerfPanel from '../components/PerfPanel.vue'
import SearchPanel from '../components/SearchPanel.vue'
import { eventPager, perfEvents, setPage, summary, tableLoading } from '../dashboard.js'
</script>

<template>
  <SearchPanel :fields="['range', 'appId', 'release', 'path', 'keyword']" />
  <PerfPanel :perf="summary?.perf || {}" />
  <section class="grid">
    <EventTable title="慢接口" :rows="summary?.api || []" />
    <EventTable title="慢资源" :rows="summary?.resources || []" />
  </section>
  <EventTable title="性能事件" :rows="perfEvents" :loading="tableLoading.events" :total="eventPager.total" :page="eventPager.page" :page-size="eventPager.pageSize" stream @page-change="setPage('events', $event)" />
</template>
