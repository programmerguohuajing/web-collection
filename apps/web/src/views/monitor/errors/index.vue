<script setup>
import { computed } from 'vue'
import EventTable from '../../../components/EventTable.vue'
import IssuesPanel from '../../../components/IssuesPanel.vue'
import SearchPanel from '../../../components/SearchPanel.vue'
import KpiGrid from '../../../components/KpiGrid.vue'
import { errorEventPager, errorEvents, issuePager, issues, resolveIssue, setPage, setPageSize, tableLoading, refreshAll } from '../../../dashboard.js'

const errorKpis = computed(() => [
  { label: '今日错误', value: errorEventPager.value.total.toLocaleString(), delta: '当前筛选范围', valueClass: 'value-danger' },
  { label: '影响用户', value: issues.value.reduce((total, item) => total + Number(item.affectedUsers || 0), 0).toLocaleString(), delta: '关联错误与会话', valueClass: 'value-purple' },
  { label: '未解决', value: issues.value.filter(item => item.status !== 'resolved').length.toLocaleString(), delta: '需关注', valueClass: 'value-danger' },
  { label: '已忽略', value: issues.value.filter(item => item.status === 'ignored' || item.status === 'dismissed').length.toLocaleString(), delta: '静默', valueClass: 'value-primary' }
])
</script>

<template>
  <KpiGrid :items="errorKpis" />
  <SearchPanel :fields="['status', 'path', 'userId', 'userName', 'userPhone']" @search="refreshAll" />
  <IssuesPanel :issues="issues" :loading="tableLoading.issues" :total="issuePager.total" :page="issuePager.page" :page-size="issuePager.pageSize" @resolve="resolveIssue" @page-change="setPage('issues', $event)" @size-change="setPageSize('issues', $event)" />
  <EventTable title="错误事件" :rows="errorEvents" :loading="tableLoading.errorEvents" :total="errorEventPager.total" :page="errorEventPager.page" :page-size="errorEventPager.pageSize" stream @page-change="setPage('errorEvents', $event)" @size-change="setPageSize('errorEvents', $event)" />
</template>
