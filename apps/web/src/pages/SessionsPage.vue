<script setup>
import { onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ArrowDown, ArrowRight, ArrowUp } from '@element-plus/icons-vue'
import EventTable from '../components/EventTable.vue'
import OverflowTip from '../components/OverflowTip.vue'
import SearchPanel from '../components/SearchPanel.vue'
import { api, normalizePageResponse, queryFromFilters, pageLoading } from '../dashboard.js'
import { formatDuration } from '../utils/format.js'

const PATH_PREVIEW = 3 // 单元格内联展示的页面数
const route = useRoute()
const rows = ref([])
const total = ref(0)
const pager = reactive({ page: 1, pageSize: 10, total: 0 })
const activeSession = ref(null)
const drawerOpen = ref(false)
const sessionEvents = ref([])
const sessionPager = reactive({ page: 1, pageSize: 20, total: 0 })
const listLoading = ref(false)
const eventLoading = ref(false)
const listError = ref('')
const eventError = ref('')
const tableRef = ref(null)
const expandedRowKeys = ref(new Set())
let listRequestId = 0
let eventRequestId = 0

function text(value) {
  return value == null || value === '' ? '-' : String(value)
}

function formatDate(value) {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '-'
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString()
}

function normalizeSession(row = {}) {
  return {
    ...row,
    session_id: row.session_id || row.sessionId || '',
    user_id: row.user_id || row.userId || '',
    user_name: row.user_name || row.userName || '',
    started_at: Number(row.started_at ?? row.startedAt ?? 0),
    ended_at: Number(row.ended_at ?? row.endedAt ?? 0),
    duration: Number(row.duration ?? 0),
    event_count: Number(row.event_count ?? row.eventCount ?? 0),
    error_count: Number(row.error_count ?? row.errorCount ?? 0),
    paths: Array.isArray(row.paths) ? row.paths.filter(Boolean) : []
  }
}

async function load() {
  const requestId = ++listRequestId
  listLoading.value = true
  listError.value = ''
  pageLoading.value = true
  try {
    const suffix = queryFromFilters({ page: pager.page, pageSize: pager.pageSize })
    const data = await api(`/api/analytics/sessions?${suffix}`, { requestKey: 'sessions:list' })
    if (requestId !== listRequestId) return
    const normalized = normalizePageResponse(data, pager)
    rows.value = normalized.items.map(normalizeSession)
    Object.assign(pager, normalized)
    total.value = normalized.total
  } catch (error) {
    if (requestId === listRequestId && error?.code !== 'ABORT_ERR') listError.value = error.message || '会话列表加载失败'
  } finally {
    if (requestId === listRequestId) {
      listLoading.value = false
      pageLoading.value = false
    }
  }
}

function visiblePaths(row) {
  return row.paths.slice(0, PATH_PREVIEW)
}

function rowExpanded(row) {
  return expandedRowKeys.value.has(row.session_id)
}

function toggleExpand(row) {
  tableRef.value?.toggleRowExpansion(row)
}

function onExpandChange(row, expandedRows) {
  const set = new Set(expandedRowKeys.value)
  if (expandedRows.some(item => item.session_id === row.session_id)) set.add(row.session_id)
  else set.delete(row.session_id)
  expandedRowKeys.value = set
}

async function viewSession(row) {
  const session = normalizeSession(row)
  if (!session.session_id) return
  activeSession.value = session
  drawerOpen.value = true
  sessionPager.page = 1
  await loadSessionEvents(session.session_id)
}

async function loadSessionEvents(sessionId) {
  if (!sessionId) return
  const requestId = ++eventRequestId
  eventLoading.value = true
  eventError.value = ''
  try {
    const suffix = queryFromFilters({}, ['startTime', 'endTime'])
    const data = await api(`/api/analytics/sessions/${encodeURIComponent(sessionId)}?${suffix}&page=${sessionPager.page}&pageSize=${sessionPager.pageSize}`, { requestKey: `sessions:events:${sessionId}` })
    if (requestId !== eventRequestId) return
    const normalized = normalizePageResponse(data, sessionPager)
    sessionEvents.value = normalized.items
    Object.assign(sessionPager, normalized)
  } catch (error) {
    if (requestId === eventRequestId && error?.code !== 'ABORT_ERR') eventError.value = error.message || '会话事件加载失败'
  } finally {
    if (requestId === eventRequestId) eventLoading.value = false
  }
}

function onSearch() { pager.page = 1; void load() }
function onSessionPageChange() { if (activeSession.value) void loadSessionEvents(activeSession.value.session_id) }

watch(() => route.query.userId, value => { if (value) { onSearch() } })
watch(() => route.query.sessionId, value => {
  if (value) {
    const row = rows.value.find(item => item.session_id === value)
    if (row) void viewSession(row)
  }
})

onMounted(() => { void load() })
</script>

<template>
  <el-card shadow="never" class="section panel">
    <template #header><div class="panel-head"><div><b>会话列表</b><small style="margin-left:8px">共 {{ total }} 个会话</small></div><el-button :loading="listLoading" @click="load">刷新</el-button></div></template>
    <SearchPanel :fields="['userId', 'userName', 'userPhone']" @search="onSearch" />
    <el-alert v-if="listError" class="table-error" type="error" :title="listError" show-icon :closable="false"><template #default><el-button link type="primary" @click="load">重试</el-button></template></el-alert>
    <el-table ref="tableRef" :data="rows" border v-loading="listLoading" empty-text="暂无会话数据" @row-click="viewSession" @expand-change="onExpandChange" style="cursor:pointer">
      <el-table-column type="expand" width="24">
        <template #default="{ row }">
          <div class="path-expand">
            <div class="path-expand-title">完整访问路径（共 {{ row.paths.length }} 页）</div>
            <div class="path-expand-body">
              <template v-for="(p, i) in row.paths" :key="i">
                <span class="path-crumb">{{ p }}</span>
                <el-icon v-if="i < row.paths.length - 1" class="path-crumb-arrow"><ArrowRight /></el-icon>
              </template>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="会话 ID" min-width="200"><template #default="{ row }"><OverflowTip :text="text(row.session_id)" /></template></el-table-column>
      <el-table-column label="用户 ID" width="180"><template #default="{ row }"><OverflowTip :text="text(row.user_id)" /></template></el-table-column>
      <el-table-column label="用户名称" width="120"><template #default="{ row }">{{ text(row.user_name) }}</template></el-table-column>
      <el-table-column label="开始时间" width="200" cell-class-name="time-cell"><template #default="{ row }">{{ formatDate(row.started_at) }}</template></el-table-column>
      <el-table-column label="结束时间" width="200" cell-class-name="time-cell"><template #default="{ row }">{{ formatDate(row.ended_at) }}</template></el-table-column>
      <el-table-column label="持续时长" width="110"><template #default="{ row }">{{ formatDuration(row.duration) }}</template></el-table-column>
      <el-table-column label="事件数" width="90" align="center"><template #default="{ row }">{{ row.event_count }}</template></el-table-column>
      <el-table-column label="错误数" width="90" align="center"><template #default="{ row }"><el-tag v-if="row.error_count" type="danger" size="small">{{ row.error_count }}</el-tag><span v-else>-</span></template></el-table-column>
      <el-table-column label="访问页面" min-width="240" cell-class-name="no-ellipsis">
        <template #default="{ row }">
          <span v-if="row.paths.length" class="path-cell">
            <template v-for="(p, i) in visiblePaths(row)" :key="i">
              <span class="path-crumb" :title="p">{{ p }}</span>
              <el-icon v-if="i < visiblePaths(row).length - 1" class="path-crumb-arrow"><ArrowRight /></el-icon>
            </template>
            <span v-if="row.paths.length > PATH_PREVIEW" class="path-toggle" :class="{ 'is-expanded': rowExpanded(row) }" @click.stop="toggleExpand(row)">
              +{{ row.paths.length - PATH_PREVIEW }} 页
              <el-icon class="path-toggle-arrow"><ArrowDown v-if="!rowExpanded(row)" /><ArrowUp v-else /></el-icon>
            </span>
          </span>
          <span v-else>-</span>
        </template>
      </el-table-column>
    </el-table>
    <el-pagination v-if="pager.total > 0" class="pager" v-model:current-page="pager.page" v-model:page-size="pager.pageSize" :total="pager.total" layout="total, sizes, prev, pager, next" @current-change="onSearch" @size-change="onSearch" />
  </el-card>

  <el-drawer v-if="activeSession" v-model="drawerOpen" :title="`会话 ${activeSession.session_id}`" size="60%" :append-to-body="true">
    <template #header><div style="display:flex;align-items:center;gap:12px"><span>会话 {{ activeSession.session_id?.slice(0, 16) }}...</span><el-tag v-if="activeSession.user_id" type="info" size="small">{{ activeSession.user_id }}</el-tag><el-tag v-if="activeSession.error_count" type="danger" size="small">{{ activeSession.error_count }} 个错误</el-tag></div></template>
    <div v-if="activeSession.paths.length" style="margin-bottom:16px"><b>访问路径：</b>{{ activeSession.paths.join(' → ') }}</div>
    <el-alert v-if="eventError" class="table-error" type="error" :title="eventError" show-icon :closable="false"><template #default><el-button link type="primary" @click="loadSessionEvents(activeSession.session_id)">重试</el-button></template></el-alert>
    <EventTable title="会话事件" :rows="sessionEvents" :loading="eventLoading" :total="sessionPager.total" :page="sessionPager.page" :page-size="sessionPager.pageSize" stream @page-change="sessionPager.page = $event; onSessionPageChange()" @size-change="sessionPager.pageSize = $event; sessionPager.page = 1; onSessionPageChange()" />
  </el-drawer>
</template>

<style scoped>
.table-error { margin-bottom: 12px; }
:deep(.el-table .cell.no-ellipsis) { overflow: visible; text-overflow: clip; white-space: normal; }
/* 隐藏原生 expand 列的箭头（展开/收起由单元格内切换器驱动） */
:deep(.el-table__expand-icon) { display: none; }
:deep(.el-table .el-table__expand-column .cell) { padding: 0; }

.path-cell { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px; max-width: 100%; }
.path-crumb { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--el-text-color-primary); }
.path-crumb-arrow { flex: none; color: var(--el-text-color-placeholder); font-size: 12px; }
.path-toggle { display: inline-flex; align-items: center; gap: 2px; flex: none; margin-left: 2px; color: var(--el-color-primary); cursor: pointer; font-size: 12px; user-select: none; }
.path-toggle:hover { color: var(--el-color-primary-light-3); }
.path-toggle-arrow { font-size: 12px; transition: transform .2s; }
.path-toggle.is-expanded .path-toggle-arrow { transform: rotate(180deg); }

.path-expand { padding: 4px 8px; font-size: 13px; }
.path-expand-title { font-weight: 600; margin-bottom: 8px; color: var(--el-text-color-primary); }
.path-expand-body { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; line-height: 1.7; }
.path-expand-body .path-crumb { max-width: 220px; }
.path-expand-body .path-crumb-arrow { color: var(--el-color-primary); }
</style>
