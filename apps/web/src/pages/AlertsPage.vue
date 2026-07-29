<script setup>
import { ElMessageBox } from 'element-plus'
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, queryFromFilters } from '../dashboard.js'

const router = useRouter()
const loading = ref(false)
const rows = ref([])
const total = ref(0)
const pager = reactive({ page: 1, pageSize: 20, total: 0 })
const query = reactive({ level: '', status: '', metric: '', keyword: '' })

onMounted(load)

async function load() {
  loading.value = true
  try {
    const suffix = queryFromFilters({ ...query, page: pager.page, pageSize: pager.pageSize })
    const data = await api(`/api/alerts?${suffix}`)
    rows.value = data.items
    pager.total = data.total
  } finally { loading.value = false }
}

async function acknowledge(row) {
  await api(`/api/alerts/${row.id}`, { method: 'PATCH', body: { status: 'acknowledged' } })
  row.status = 'acknowledged'
}

async function resolve(row) {
  await api(`/api/alerts/${row.id}`, { method: 'PATCH', body: { status: 'resolved' } })
  row.status = 'resolved'
}

async function dismiss(row) {
  const confirmed = await ElMessageBox.confirm('确定关闭此告警吗？', '确认', { type: 'warning' }).then(() => true).catch(() => false)
  if (!confirmed) return
  await api(`/api/alerts/${row.id}`, { method: 'PATCH', body: { status: 'dismissed' } })
  row.status = 'dismissed'
}

async function viewDetail(row) {
  if (row.trace_id) router.push({ path: '/traces', query: { traceId: row.trace_id } })
  else if (row.url) router.push({ path: '/errors', query: { path: row.url } })
}

function metricLabel(metric) {
  const map = { error: '错误', log_error: 'Error 日志', regression: '回归', lcp: 'LCP', inp: 'INP', cls: 'CLS', longtask: '长任务' }
  return map[metric] || metric || '-'
}
function metricType(metric) {
  if (metric === 'error' || metric === 'log_error' || metric === 'regression') return 'danger'
  if (metric === 'lcp' || metric === 'inp' || metric === 'cls' || metric === 'longtask') return 'warning'
  return 'info'
}
function levelType(level) {
  return level === 'critical' ? 'danger' : level === 'error' ? 'danger' : level === 'warning' ? 'warning' : 'info'
}

function statusType(status) {
  return status === 'resolved' ? 'success' : status === 'dismissed' ? 'info' : status === 'acknowledged' ? 'warning' : 'danger'
}

function statusLabel(status) {
  const labels = { pending: '待处理', acknowledged: '处理中', resolved: '已解决', dismissed: '已关闭' }
  return labels[status] || status || '-'
}

function onSearch() { pager.page = 1; load() }
function onPageChange() { load() }

onMounted(load)
</script>

<template>
  <div class="page-heading"><div><h1>告警中心</h1><p>告警规则触发记录与处理状态</p></div></div>

  <el-card shadow="never" class="section panel">
    <template #header>
      <div class="panel-head">
        <div><b>告警记录</b><small style="margin-left:8px">共 {{ total }} 条</small></div>
        <el-button @click="load">刷新</el-button>
      </div>
    </template>

    <div class="filter-bar">
      <el-select v-model="query.level" clearable placeholder="级别" style="width:120px" @change="onSearch">
        <el-option label="严重" value="critical" />
        <el-option label="错误" value="error" />
        <el-option label="警告" value="warning" />
      </el-select>
      <el-select v-model="query.metric" clearable placeholder="指标" style="width:130px" @change="onSearch">
        <el-option label="错误" value="error" />
        <el-option label="Error 日志" value="log_error" />
        <el-option label="回归" value="regression" />
        <el-option label="LCP" value="lcp" />
        <el-option label="INP" value="inp" />
        <el-option label="CLS" value="cls" />
        <el-option label="长任务" value="longtask" />
      </el-select>
      <el-select v-model="query.status" clearable placeholder="状态" style="width:120px" @change="onSearch">
        <el-option label="待处理" value="pending" />
        <el-option label="处理中" value="acknowledged" />
        <el-option label="已解决" value="resolved" />
        <el-option label="已关闭" value="dismissed" />
      </el-select>
      <el-input v-model="query.keyword" placeholder="搜索告警内容" clearable style="width:200px" @keyup.enter="onSearch" />
      <el-button type="primary" @click="onSearch">搜索</el-button>
    </div>

    <el-table v-loading="loading" :data="rows" border>
      <el-table-column label="时间" width="180"><template #default="{ row }">{{ new Date(Number(row.created_at)).toLocaleString() }}</template></el-table-column>
      <el-table-column prop="app_id" label="应用" width="140" />
      <el-table-column label="指标" width="100">
        <template #default="{ row }">
          <el-tag :type="metricType(row.metric)" size="small">{{ metricLabel(row.metric) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="级别" width="90"><template #default="{ row }"><el-tag :type="levelType(row.level)" size="small">{{ row.level }}</el-tag></template></el-table-column>
      <el-table-column label="告警内容" min-width="280">
        <template #default="{ row }">
          <el-tooltip :content="row.message" placement="top">
            <span class="cell-ellipsis">{{ row.message }}</span>
          </el-tooltip>
        </template>
      </el-table-column>
      <el-table-column label="当前值" width="100"><template #default="{ row }">{{ row.value != null ? Number(row.value).toFixed(2) : '-' }}</template></el-table-column>
      <el-table-column prop="threshold" label="阈值" width="100"><template #default="{ row }">{{ row.threshold != null ? Number(row.threshold).toFixed(2) : '-' }}</template></el-table-column>
      <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="statusType(row.status)" size="small">{{ statusLabel(row.status) }}</el-tag></template></el-table-column>
      <el-table-column label="通知" width="100"><template #default="{ row }"><el-tag :type="row.notified ? 'success' : 'info'" size="small">{{ row.notified ? '已发送' : '未发送' }}</el-tag></template></el-table-column>
      <el-table-column label="操作" width="220" fixed="right">
        <template #default="{ row }">
          <el-button v-if="row.status === 'pending'" link type="primary" size="small" @click="acknowledge(row)">处理</el-button>
          <el-button v-if="row.status !== 'resolved' && row.status !== 'dismissed'" link type="success" size="small" @click="resolve(row)">解决</el-button>
          <el-button v-if="row.status === 'pending'" link type="info" size="small" @click="dismiss(row)">关闭</el-button>
          <el-button link type="primary" size="small" @click="viewDetail(row)">查看</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-pagination class="pager" v-model:current-page="pager.page" v-model:page-size="pager.pageSize" :total="pager.total" layout="total, sizes, prev, pager, next" @current-change="onPageChange" @size-change="onPageChange" />
  </el-card>
</template>

<style scoped>
.filter-bar { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; align-items: center; }
.cell-ellipsis { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
</style>
