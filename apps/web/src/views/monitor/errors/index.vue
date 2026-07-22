<script setup>
import EventTable from '../../../components/EventTable.vue'
import IssuesPanel from '../../../components/IssuesPanel.vue'
import SearchPanel from '../../../components/SearchPanel.vue'
import { errorEventPager, errorEvents, issuePager, issues, resolveIssue, setPage, setPageSize, tableLoading } from '../../../dashboard.js'
</script>

<template>
  <SearchPanel :fields="['status', 'path', 'userId', 'userName', 'userPhone']" />
  <IssuesPanel :issues="issues" :loading="tableLoading.issues" :total="issuePager.total" :page="issuePager.page" :page-size="issuePager.pageSize" @resolve="resolveIssue" @page-change="setPage('issues', $event)" @size-change="setPageSize('issues', $event)" />
  <EventTable title="错误事件" :rows="errorEvents" :loading="tableLoading.errorEvents" :total="errorEventPager.total" :page="errorEventPager.page" :page-size="errorEventPager.pageSize" stream @page-change="setPage('errorEvents', $event)" @size-change="setPageSize('errorEvents', $event)" />
</template>
