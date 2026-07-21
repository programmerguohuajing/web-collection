<script setup>
import AlertsPanel from '../../../components/AlertsPanel.vue'
import EventTable from '../../../components/EventTable.vue'
import IssuesPanel from '../../../components/IssuesPanel.vue'
import MetricCards from '../../../components/MetricCards.vue'
import PerfPanel from '../../../components/PerfPanel.vue'
import RankPanel from '../../../components/RankPanel.vue'
import SearchPanel from '../../../components/SearchPanel.vue'
import { behavior, byType, latestErrors, resolveIssue, summary } from '../../../dashboard.js'
</script>

<template>
  <SearchPanel :fields="['range', 'appId', 'release']" />
  <MetricCards :summary="summary" />
  <AlertsPanel :alerts="summary?.alerts || []" />
  <section class="grid">
    <PerfPanel :perf="summary?.perf || {}" />
    <IssuesPanel :issues="latestErrors" @resolve="resolveIssue" />
  </section>
  <section class="grid">
    <RankPanel title="事件结构" subtitle="type" :items="byType" />
    <RankPanel title="行为排行" subtitle="behavior / track" :items="behavior" />
  </section>
  <section class="grid">
    <EventTable title="慢接口" :rows="summary?.api || []" />
    <EventTable title="慢资源" :rows="summary?.resources || []" />
  </section>
</template>
