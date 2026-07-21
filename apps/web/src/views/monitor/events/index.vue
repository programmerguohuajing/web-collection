<script setup>
import EventTable from '../../../components/EventTable.vue'
import SearchPanel from '../../../components/SearchPanel.vue'
import { eventPager, events, setPage, setPageSize, tableLoading } from '../../../dashboard.js'
</script>

<template>
  <SearchPanel :fields="['range', 'appId', 'release', 'type', 'path', 'userId', 'keyword']" />
  <EventTable title="事件流" stream :rows="events" :loading="tableLoading.events" :total="eventPager.total" :page="eventPager.page" :page-size="eventPager.pageSize" @page-change="setPage('events', $event)" @size-change="setPageSize('events', $event)" />
</template>
