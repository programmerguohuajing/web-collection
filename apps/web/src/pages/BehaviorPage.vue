<script setup>
import { computed } from 'vue'
import EventTable from '../components/EventTable.vue'
import KpiGrid from '../components/KpiGrid.vue'
import RankPanel from '../components/RankPanel.vue'
import SearchPanel from '../components/SearchPanel.vue'
import { behavior, behaviorEvents, behaviorPager, setPage, summary, tableLoading } from '../dashboard.js'

const behaviorKpis = computed(() => [
  { label: '会话数', value: Number(summary.value?.sessions ?? summary.value?.users ?? 0).toLocaleString(), delta: '当前筛选范围', valueClass: 'value-primary', deltaClass: 'delta-good' },
  { label: '页面浏览 PV', value: Number(summary.value?.behavior?.pv ?? 0).toLocaleString(), delta: '行为事件', valueClass: 'value-purple', deltaClass: 'delta-good' },
  { label: '平均停留', value: summary.value?.behavior?.stay ?? '-', delta: '当前筛选范围', valueClass: 'value-success', deltaClass: 'delta-good' },
  { label: '跳出率', value: summary.value?.behavior?.bounceRate != null ? `${summary.value.behavior.bounceRate}%` : '-', delta: '页面会话', valueClass: 'value-danger', deltaClass: 'delta-good' }
])
</script>

<template>
  <KpiGrid :items="behaviorKpis" />
  <SearchPanel :fields="['range', 'appId', 'release', 'path', 'userId', 'keyword']" />
  <RankPanel title="行为排行" subtitle="behavior / track" :items="behavior" />
  <EventTable title="行为事件" :rows="behaviorEvents" :loading="tableLoading.behavior" :total="behaviorPager.total" :page="behaviorPager.page" :page-size="behaviorPager.pageSize" stream :show-user="false" @page-change="setPage('behavior', $event)" />
</template>
