<script setup>
import EventTable from '../components/EventTable.vue'
import IssuesPanel from '../components/IssuesPanel.vue'
import SearchPanel from '../components/SearchPanel.vue'
import KpiGrid from '../components/KpiGrid.vue'
import { computed } from 'vue'
import { eventPager, events, issuePager, issues, resolveIssue, setPage, tableLoading } from '../dashboard.js'

const errorKpis = computed(() => [
  { label: '今日错误', value: events.value.filter(item => item.type === 'error').length.toLocaleString(), delta: '当前筛选范围', valueClass: 'value-danger' },
  { label: '影响用户', value: issues.value.reduce((total, item) => total + Number(item.affectedUsers || 0), 0).toLocaleString(), delta: '关联错误与会话', valueClass: 'value-purple' },
  { label: '未解决', value: issues.value.filter(item => item.status !== 'resolved').length.toLocaleString(), delta: '需关注', valueClass: 'value-danger' },
  { label: '已忽略', value: issues.value.filter(item => item.status === 'ignored' || item.status === 'dismissed').length.toLocaleString(), delta: '静默', valueClass: 'value-primary' }
])
</script>

<template>
  <KpiGrid :items="errorKpis" />
  <SearchPanel :fields="['range', 'appId', 'release', 'status', 'path', 'userId', 'userName', 'userPhone', 'keyword']" />
  <IssuesPanel :issues="issues" :loading="tableLoading.issues" :total="issuePager.total" :page="issuePager.page" :page-size="issuePager.pageSize" @resolve="resolveIssue" @page-change="setPage('issues', $event)" />
  <EventTable title="错误事件" :rows="events.filter(item => item.type === 'error')" :loading="tableLoading.events" :total="eventPager.total" :page="eventPager.page" :page-size="eventPager.pageSize" stream @page-change="setPage('events', $event)" />
</template>
