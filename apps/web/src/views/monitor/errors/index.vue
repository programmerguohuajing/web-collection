<script setup>
import EventTable from '../../../components/EventTable.vue'
import IssuesPanel from '../../../components/IssuesPanel.vue'
import SearchPanel from '../../../components/SearchPanel.vue'
import { eventPager, events, issuePager, issues, resolveIssue, setPage, setPageSize, tableLoading } from '../../../dashboard.js'
</script>

<template>
  <SearchPanel :fields="['range', 'appId', 'release', 'status', 'path', 'userId', 'userName', 'userPhone', 'keyword']" />
  <IssuesPanel :issues="issues" :loading="tableLoading.issues" :total="issuePager.total" :page="issuePager.page" :page-size="issuePager.pageSize" @resolve="resolveIssue" @page-change="setPage('issues', $event)" @size-change="setPageSize('issues', $event)" />
  <EventTable title="错误事件" :rows="events.filter(item => item.type === 'error')" :loading="tableLoading.events" :total="eventPager.total" :page="eventPager.page" :page-size="eventPager.pageSize" stream @page-change="setPage('events', $event)" @size-change="setPageSize('events', $event)" />
</template>
