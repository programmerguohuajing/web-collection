<script setup>
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import EventTable from '../../../components/EventTable.vue'
import IssuesPanel from '../../../components/IssuesPanel.vue'
import SearchPanel from '../../../components/SearchPanel.vue'
import KpiGrid from '../../../components/KpiGrid.vue'
import { api, errorEventPager, errorEvents, issuePager, issues, normalizePageResponse, queryFromFilters, resolveIssue, setPage, setPageSize, tableLoading, refreshAll } from '../../../dashboard.js'
import { exportCsv, fetchAllPages } from '../../../utils/csv.js'

const errorKpis = computed(() => [
  { label: '今日错误', value: errorEventPager.value.total.toLocaleString(), delta: '当前筛选范围', valueClass: 'value-danger' },
  { label: '影响用户', value: issues.value.reduce((total, item) => total + Number(item.affectedUsers || 0), 0).toLocaleString(), delta: '关联错误与会话', valueClass: 'value-purple' },
  { label: '未解决', value: issues.value.filter(item => item.status !== 'resolved').length.toLocaleString(), delta: '需关注', valueClass: 'value-danger' },
  { label: '已忽略', value: issues.value.filter(item => item.status === 'ignored' || item.status === 'dismissed').length.toLocaleString(), delta: '静默', valueClass: 'value-primary' }
])

const exporting = ref(false)
async function exportErrorEvents() {
  exporting.value = true
  try {
    const rows = await fetchAllPages(async (page, pageSize) => {
      const query = queryFromFilters({ type: 'error' })
      const data = await api(`/api/events?${query}&page=${page}&pageSize=${pageSize}`, { requestKey: 'errors:export' })
      const normalized = normalizePageResponse(data)
      return { items: normalized.items, total: normalized.total }
    })
    const count = exportCsv('错误事件', [
      { key: 'ts', label: '时间' },
      { key: 'type', label: '类型' },
      { key: 'message', label: '错误信息' },
      { key: 'path', label: '页面' },
      { key: 'release', label: '版本' }
    ], rows.map(r => ({ ...r, ts: r.ts ? new Date(Number(r.ts)).toLocaleString() : '' })))
    ElMessage.success(`已导出 ${count} 条`)
  } catch (error) {
    ElMessage.error(error.message || '导出失败')
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <KpiGrid :items="errorKpis" />
  <SearchPanel :fields="['status', 'path', 'userId', 'userName', 'userPhone']" @search="refreshAll" />
  <IssuesPanel :issues="issues" :loading="tableLoading.issues" :total="issuePager.total" :page="issuePager.page" :page-size="issuePager.pageSize" @resolve="resolveIssue" @page-change="setPage('issues', $event)" @size-change="setPageSize('issues', $event)" />
  <div class="table-toolbar">
    <el-button size="small" :loading="exporting" @click="exportErrorEvents">导出 CSV</el-button>
  </div>
  <EventTable title="错误事件" :rows="errorEvents" :loading="tableLoading.errorEvents" :total="errorEventPager.total" :page="errorEventPager.page" :page-size="errorEventPager.pageSize" stream @page-change="setPage('errorEvents', $event)" @size-change="setPageSize('errorEvents', $event)" />
</template>

<style scoped>
.table-toolbar { display: flex; justify-content: flex-end; margin-bottom: 8px; }
</style>
