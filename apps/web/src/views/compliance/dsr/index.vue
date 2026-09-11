<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api, pageLoading } from '../../../dashboard.js'
import { useFilterStore } from '../../../stores/filters.js'
import { useAuth } from '../../../composables/useAuth'
import OverflowTip from '../../../components/OverflowTip.vue'
import KpiGrid from '../../../components/KpiGrid.vue'
import CreateWizard from './create-wizard.vue'
import { QuestionFilled } from '@element-plus/icons-vue'

/**
 * D1 · 数据主体权利 DSR（PRD 13）列表页。
 * 工单列表（状态 tag / 主体 OverflowTip + maskPhone / 命中量 / 发起审批人）+ 发起向导入口 + SLA 30 天超期高亮（P1-1）。
 * `dsr` 能力位 false 的部署：显式提示「当前部署不支持」，不渲染任何写入口（非静默隐藏）。
 * 表格长文本一律 OverflowTip（EP 2.14 禁用原生 show-overflow-tooltip）。
 */
const router = useRouter()
const store = useFilterStore()
const { dsrEnabled, me } = useAuth()

/** 法定期限 SLA（GDPR 一个月口径，与 packages/dsr-service.js DSR_SLA_DAYS 对齐） */
const SLA_DAYS = 30

const STATUS_META = {
  draft: { label: '草稿', tag: 'info' },
  pending_approval: { label: '待审批', tag: 'warning' },
  approved: { label: '已批准', tag: 'primary' },
  executing: { label: '执行中', tag: 'warning' },
  completed: { label: '已完成', tag: 'success' },
  rejected: { label: '已拒绝', tag: 'danger' },
  cancelled: { label: '已取消', tag: 'info' }
}
const TERMINAL_STATUS = ['completed', 'rejected', 'cancelled']

const SUBJECT_LABELS = {
  user_id: '用户 ID',
  user_name: '用户名',
  user_phone: '手机号',
  device_id: '设备 ID',
  session_id: '会话 ID'
}

const list = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = 20
const loading = ref(false)
const loadError = ref('')
const statusFilter = ref('')
const typeFilter = ref('')
const wizardOpen = ref(false)

/** 当前用户 id（审批区/发起人操作显隐用；后端仍服务端强制兜底） */
const currentUserId = computed(() => me.value?.user?.id || '')

const kpis = computed(() => {
  const pending = list.value.filter(item => item.status === 'pending_approval').length
  const monthStart = new Date()
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)
  const completedThisMonth = list.value.filter(item =>
    item.status === 'completed' && Number(item.completedAt || 0) >= monthStart.getTime()).length
  const overdue = list.value.filter(item => isOverdue(item)).length
  return [
    { label: '工单总数', value: String(total.value), delta: '全部状态', valueClass: 'value-primary' },
    { label: '待审批', value: String(pending), delta: 'pending_approval', valueClass: pending > 0 ? 'value-danger' : '' },
    { label: '本月完成', value: String(completedThisMonth), delta: 'completed（自然月）', valueClass: 'value-success' },
    { label: '超期未完成', value: String(overdue), delta: `发起超 ${SLA_DAYS} 天未完成（GDPR 口径）`, valueClass: overdue > 0 ? 'value-danger' : '' }
  ]
})

/** P1-1 SLA：发起超 N 天且未到终态 → 列表高亮 */
function isOverdue(item) {
  if (TERMINAL_STATUS.includes(item.status)) return false
  return Date.now() - Number(item.createdAt || 0) > SLA_DAYS * 86400000
}

function statusMeta(status) {
  return STATUS_META[status] || { label: status, tag: 'info' }
}

function typeLabel(item) {
  return item.requestType === 'erasure' ? '擦除' : '查询导出'
}

function typeTag(item) {
  return item.requestType === 'erasure' ? 'danger' : 'primary'
}

/** 主体展示：手机号脱敏（maskPhone），执行完成后的清空占位原样展示 */
function subjectText(item) {
  const value = String(item.subjectValue || '')
  if (item.subjectType === 'user_phone') {
    return value.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2')
  }
  return value
}

function subjectDisplay(item) {
  return `${SUBJECT_LABELS[item.subjectType] || item.subjectType}：${subjectText(item)}`
}

function formatTime(ts) {
  if (!ts) return '—'
  try { return new Date(Number(ts)).toLocaleString() } catch { return '—' }
}

/** 发起人操作：提交（draft）/ 取消（draft、pending_approval） */
function canSubmit(item) {
  return item.status === 'draft' && currentUserId.value && item.requestedBy === currentUserId.value
}

function canCancel(item) {
  return ['draft', 'pending_approval'].includes(item.status) && currentUserId.value && item.requestedBy === currentUserId.value
}

async function load() {
  // BUG-005 修复：能力位关闭时不再发请求（避免 503 噪音）；模板已用 v-if/v-else 只渲染占位提示。
  if (!dsrEnabled.value) return
  loading.value = true
  loadError.value = ''
  pageLoading.value = true
  try {
    const params = new URLSearchParams({ page: String(page.value), pageSize: String(pageSize) })
    if (statusFilter.value) params.set('status', statusFilter.value)
    if (typeFilter.value) params.set('requestType', typeFilter.value)
    if (store.appId) params.set('appId', store.appId)
    const data = await api(`/api/dsr/requests?${params}`, { requestKey: 'dsr:list' })
    list.value = Array.isArray(data?.items) ? data.items : []
    total.value = Number(data?.total ?? list.value.length)
  } catch (error) {
    if (error?.code !== 'ABORT_ERR') loadError.value = error.message || 'DSR 工单列表加载失败'
    list.value = []
    total.value = 0
  } finally {
    loading.value = false
    pageLoading.value = false
  }
}

async function submitRequest(row) {
  try {
    await api(`/api/dsr/requests/${row.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    ElMessage.success('已提交审批')
    await load()
  } catch (error) {
    ElMessage.error(error?.message || '提交审批失败')
  }
}

async function cancelRequest(row) {
  try {
    await api(`/api/dsr/requests/${row.id}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    ElMessage.success('工单已取消')
    await load()
  } catch (error) {
    ElMessage.error(error?.message || '取消失败')
  }
}

watch([statusFilter, typeFilter], () => { page.value = 1; load() })
watch(() => store.appId, () => { page.value = 1; load() })

onMounted(load)
</script>

<template>
  <div class="dsr-page">
    <div class="page-heading">
      <h1>数据主体权利 · DSR<el-tooltip content="当前部署不支持数据主体权利 DSR（capability: dsr）。DSR（查询 / 导出 / 擦除）需要后端开启 dsr 能力位后使用（Worker 部署需设置 DSR_ENABLED=1），并依赖账号体系 RBAC（ACCOUNTS_ENABLED=1）；本页当前为只读占位，不会发起写操作。" placement="top"><el-icon class="help-icon"><QuestionFilled /></el-icon></el-tooltip></h1>
    </div>
    <template v-if="dsrEnabled">
      <KpiGrid :items="kpis" />
      <el-alert v-if="loadError" class="section" type="error" :title="loadError" show-icon />

      <section class="section">
        <div class="section-head">
          <div>
            <h2>DSR 工单</h2>
            <div class="sub">数据主体权利响应（GDPR 15/17 · PIPL）· 双人制衡审批 · 全程审计留痕</div>
          </div>
          <div class="head-actions">
            <el-select v-model="statusFilter" clearable placeholder="全部状态" style="width: 150px">
              <el-option v-for="(meta, key) in STATUS_META" :key="key" :label="meta.label" :value="key" />
            </el-select>
            <el-select v-model="typeFilter" clearable placeholder="全部类型" style="width: 130px">
              <el-option label="查询导出" value="access" />
              <el-option label="擦除" value="erasure" />
            </el-select>
            <el-button type="primary" @click="wizardOpen = true">＋ 发起工单</el-button>
          </div>
        </div>

        <el-table :data="list" v-loading="loading" row-key="id">
          <el-table-column label="工单号" width="200">
            <template #default="{ row }"><OverflowTip :text="row.id" /></template>
          </el-table-column>
          <el-table-column label="类型" width="100">
            <template #default="{ row }">
              <el-tag :type="typeTag(row)" effect="light">{{ typeLabel(row) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="主体标识" min-width="220">
            <template #default="{ row }"><OverflowTip :text="subjectDisplay(row)" /></template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="statusMeta(row.status).tag" effect="light">{{ statusMeta(row.status).label }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="命中量 (事件/问题/回放)" width="180">
            <template #default="{ row }">
              <span class="hit-text">{{ row.hitEvents }} / {{ row.hitIssues }} / {{ row.hitReplays }}</span>
            </template>
          </el-table-column>
          <el-table-column label="发起人" width="110">
            <template #default="{ row }"><OverflowTip :text="row.requestedBy || '-'" /></template>
          </el-table-column>
          <el-table-column label="审批人" width="110">
            <template #default="{ row }"><OverflowTip :text="row.approvedBy || '-'" /></template>
          </el-table-column>
          <el-table-column label="发起时间" width="170">
            <template #default="{ row }">
              <span :class="{ 'overdue-text': isOverdue(row) }">{{ formatTime(row.createdAt) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="200" fixed="right">
            <template #default="{ row }">
              <el-button text type="primary" @click="router.push(`/dsr/${row.id}`)">详情</el-button>
              <el-button v-if="canSubmit(row)" text type="warning" @click="submitRequest(row)">提交审批</el-button>
              <el-button v-if="canCancel(row)" text type="danger" @click="cancelRequest(row)">取消</el-button>
            </template>
          </el-table-column>
        </el-table>

        <el-pagination
          v-if="total > pageSize"
          class="pager"
          layout="prev, pager, next"
          :total="total"
          :page-size="pageSize"
          :current-page="page"
          @current-change="value => { page = value; load() }"
        />
      </section>

      <el-dialog v-model="wizardOpen" title="发起 DSR 工单" width="680px" :close-on-click-modal="false">
        <CreateWizard @changed="load" />
      </el-dialog>
    </template>
  </div>
</template>

<style scoped>
.section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.section-head h2 { margin: 0; font-size: 16px; }
.section-head .sub { color: var(--el-text-color-secondary); font-size: 12px; margin-top: 2px; }
.head-actions { display: flex; gap: 10px; align-items: center; }
.hit-text { font-family: var(--font-mono); font-size: 12px; }
.overdue-text { color: var(--el-color-danger); font-weight: 600; }
.pager { margin-top: 12px; justify-content: flex-end; }
</style>
