<script setup>
import EventTable from '../../../components/EventTable.vue'
import RankPanel from '../../../components/RankPanel.vue'
import SearchPanel from '../../../components/SearchPanel.vue'
import { behavior, behaviorEvents, behaviorPager, setPage, setPageSize, tableLoading } from '../../../dashboard.js'
</script>

<template>
  <SearchPanel :fields="['range', 'appId', 'release', 'path', 'userId', 'keyword']" />
  <RankPanel title="行为排行" subtitle="behavior / track" :items="behavior" />
  <EventTable title="行为事件" :rows="behaviorEvents" :loading="tableLoading.behavior" :total="behaviorPager.total" :page="behaviorPager.page" :page-size="behaviorPager.pageSize" stream @page-change="setPage('behavior', $event)" @size-change="setPageSize('behavior', $event)" />
</template>
