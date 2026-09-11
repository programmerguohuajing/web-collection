<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, pageLoading } from '../../../dashboard.js'
import { useAuth } from '../../../composables/useAuth'
import OverflowTip from '../../../components/OverflowTip.vue'
import { QuestionFilled } from '@element-plus/icons-vue'

/**
 * D1 工单详情页（PRD §7）：
 * 工单信息 + 命中预览 + 审批区（当前用户 ≠ 发起人 且 Admin+ 才显示同意/拒绝）+ 执行结果（影响行数）+ el-timeline 审计时间线。
 * subject_value 展示限权（本页仅 dsr:view 可达）；执行完成后的清空占位 [DSR-CLEARED] 原样展示（服务端已清空原文）。
 * access 执行返回导出文件包（csv/json），前端逐文件 Blob 下载。
 */
const route = useRoute()
const router = useRouter()
const { me, dsrEnabled } = useAuth()

const STATUS_META = {
  draft: { label: '草稿', tag: 'info' },
  pending_approval: { label: '待审批', tag: 'warning' },
  approved: { label: '已批准', tag: 'primary' },
  executing: { label: '执行中', tag: 'warning' },
  completed: { label: '已完成', tag: 'success' },
  rejected: { label: '已拒绝', tag: 'danger' },
  cancelled: { label: '已取消', tag: 'info' }
}
const ACTION_LABELS = {
  create: '创建工单',
  submit: '提交审批',
  approve: '审批通过',
  reject: '审批拒绝',
  cancel: '取消工单',
  execute_export: '执行导出',
  execute_erasure: '执行擦除',
  complete: '执行完成',
  illegal_transition: '非法操作（已留痕）'
}

const requestId = computed(() => String(route.params.id || ''))
const request = ref(null)
const audit = ref([])
const loading = ref(false)
const loadError = ref('')
const acting = ref(false)

const currentUserId = computed(() => me.value?.user?.id || '')
const isAdminPlus = computed(() => ['owner', 'admin'].includes(me.value?.role || ''))

/** 审批区显隐：待审批 + 当前用户为 Admin+ 且 ≠ 发起人（后端仍服务端强制兜底） */
const canApprove = computed(() =>
  request.value?.status === 'pending_approval' && isAdminPlus.value &&
  currentUserId.value && request.value.requestedBy !== currentUserId.value)
/** 执行/继续执行：approved 可执行；executing 为 partial 续跑（QA #3，复用 execute 端点幂等重跑） */
const canExecute = computed(() =>
  ['approved', 'executing'].includes(request.value?.status || '') && isAdminPlus.value)
const canSubmit = computed(() =>
  request.value?.status === 'draft' && currentUserId.value && request.value.requestedBy === currentUserId.value)
const canCancel = computed(() =>
  ['draft', 'pending_approval'].includes(request.value?.status || '') &&
  currentUserId.value && request.value.requestedBy === currentUserId.value)

function statusMeta(status) {
  return STATUS_META[status] || { label: status, tag: 'info' }
}

function typeLabel(item) {
  return item?.requestType === 'erasure' ? '擦除' : '查询导出'
}

function modeLabel(item) {
  if (item?.requestType !== 'erasure') return item?.exportFormat ? item.exportFormat.toUpperCase() : '-'
  return item.mode === 'hard_delete' ? '硬删除（不可逆）' : '匿名化'
}

/** 主体展示：手机号脱敏；[DSR-CLEARED] 清空占位原样展示 */
function subjectText(item) {
  const value = String(item?.subjectValue || '')
  if (item?.subjectType === 'user_phone') return value.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2')
  return value
}

function formatTime(ts) {
  if (!ts) return '—'
  try { return new Date(Number(ts)).toLocaleString() } catch { return '—' }
}

function formatDetail(detail) {
  if (!detail || typeof detail !== 'object') return ''
  try { return JSON.stringify(detail) } catch { return '' }
}

async function load() {
  // BUG-005 修复：能力位关闭时不再发请求（避免 503 噪音）；模板已用 v-if/v-else 只渲染占位提示。
  if (!dsrEnabled.value || !requestId.value) return
  loading.value = true
  loadError.value = ''
  pageLoading.value = true
  try {
    const data = await api(`/api/dsr/requests/${requestId.value}`, { requestKey: 'dsr:detail' })
    request.value = data?.request || null
    audit.value = Array.isArray(data?.audit) ? data.audit : []
  } catch (error) {
    if (error?.code !== 'ABORT_ERR') loadError.value = error.message || 'DSR 工单详情加载失败'
  } finally {
    loading.value = false
    pageLoading.value = false
  }
}

async function post(path, body = {}) {
  acting.value = true
  try {
    const data = await api(`/api/dsr/requests/${requestId.value}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    await load()
    return data
  } finally {
    acting.value = false
  }
}

async function submitForApproval() {
  try { await post('/submit'); ElMessage.success('已提交审批') } catch (error) { ElMessage.error(error?.message || '提交失败') }
}

async function cancelRequest() {
  try { await ElMessageBox.confirm('确定取消该 DSR 工单？', '取消确认', { type: 'warning' }) } catch { return }
  try { await post('/cancel'); ElMessage.success('工单已取消') } catch (error) { ElMessage.error(error?.message || '取消失败') }
}

async function decide(decision) {
  let reason = ''
  try {
    const { value } = await ElMessageBox.prompt(
      decision === 'approve' ? '确认审批通过该 DSR 工单？' : '请填写拒绝理由（必填）',
      decision === 'approve' ? '审批通过' : '审批拒绝',
      { type: decision === 'approve' ? 'info' : 'warning', inputPlaceholder: decision === 'approve' ? '选填' : '必填' }
    )
    reason = String(value || '').trim()
  } catch { return }
  if (decision === 'reject' && !reason) { ElMessage.warning('拒绝理由必填'); return }
  try {
    await post('/approve', { decision, reason })
    ElMessage.success(decision === 'approve' ? '已审批通过' : '已拒绝')
  } catch (error) {
    ElMessage.error(error?.message || '审批失败')
  }
}

async function execute() {
  const item = request.value
  if (!item) return
  const body = {}
  if (item.requestType === 'erasure' && item.mode === 'hard_delete') {
    try {
      await ElMessageBox.confirm(
        '该工单为硬删除模式：相关数据行将被物理删除且不可恢复。确认执行？',
        '硬删除确认（不可逆）',
        { type: 'error', confirmButtonText: '确认硬删除', cancelButtonText: '取消' }
      )
    } catch { return }
    body.hardDeleteConfirmed = true
  }
  if (item.requestType === 'access' && Number(item.hitReplays) > 0) {
    try {
      await ElMessageBox.confirm(
        '导出包含会话回放（录屏敏感数据），确认一并导出？',
        '回放导出确认',
        { type: 'warning' }
      )
    } catch { return }
    body.replaysConfirm = true
  }
  try {
    const data = await post('/execute', body)
    if (data?.partial) {
      // QA #3 partial：单次调用预算耗尽，工单保持 executing，可再次点击「执行」继续
      ElMessage.warning(`本次已处理 ${Number(data.processed || 0)} 行（达单次调用上限），工单保持执行中，可再次点击「执行」继续`)
      return
    }
    if (Array.isArray(data?.files) && data.files.length) {
      for (const file of data.files) downloadFile(file)
      ElMessage.success(`导出完成，已生成 ${data.files.length} 个文件`)
    } else {
      ElMessage.success('擦除执行完成')
    }
  } catch (error) {
    ElMessage.error(error?.message || '执行失败')
  }
}

/** 导出文件 Blob 下载（csv 已带 BOM；json 直接序列化） */
function downloadFile(file) {
  const blob = new Blob([file.content || ''], { type: file.name.endsWith('.json') ? 'application/json' : 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.name
  anchor.click()
  URL.revokeObjectURL(url)
}

onMounted(load)
</script>

<template>
  <div class="dsr-detail">
    <!-- BUG-005 修复：能力位关闭时显式占位（对齐 slo/synthetic/experiment 详情页模式），不发请求。 -->
    <template>
    <div class="detail-head">
      <el-button text @click="router.push('/dsr')">← 返回列表</el-button>
      <div class="head-main" v-if="request">
        <h2><OverflowTip :text="request.id" /><el-tooltip content="数据主体权利（DSR）工单：查询 / 导出 / 擦除，需后端开启 dsr 能力位并依赖账号 RBAC。双人制衡审批、全程审计留痕。" placement="top"><el-icon class="help-icon"><QuestionFilled /></el-icon></el-tooltip></h2>
        <div class="sub">
          <el-tag :type="request.requestType === 'erasure' ? 'danger' : 'primary'" effect="light">{{ typeLabel(request) }}</el-tag>
          <el-tag class="head-tag" :type="statusMeta(request.status).tag" effect="light">{{ statusMeta(request.status).label }}</el-tag>
          <span class="head-mode">{{ modeLabel(request) }}</span>
        </div>
      </div>
      <div class="head-actions" v-if="request && dsrEnabled">
        <el-button v-if="canSubmit" type="warning" :loading="acting" @click="submitForApproval">提交审批</el-button>
        <template v-if="canApprove">
          <el-button type="success" :loading="acting" @click="decide('approve')">同意</el-button>
          <el-button type="danger" :loading="acting" @click="decide('reject')">拒绝</el-button>
        </template>
        <el-button v-if="canExecute" type="primary" :loading="acting" @click="execute">{{ request.status === 'executing' ? '继续执行' : '执行' }}</el-button>
        <el-button v-if="canCancel" type="danger" plain :loading="acting" @click="cancelRequest">取消工单</el-button>
      </div>
    </div>
    <el-alert v-if="loadError" class="section" type="error" :title="loadError" show-icon />

    <template v-if="request">
      <section class="section">
        <h3>工单信息</h3>
        <el-descriptions :column="2" border>
          <el-descriptions-item label="主体标识类型">{{ request.subjectType }}</el-descriptions-item>
          <el-descriptions-item label="主体标识值">
            <OverflowTip :text="subjectText(request)" />
            <el-tag v-if="request.subjectValue === '[DSR-CLEARED]'" size="small" effect="plain" class="head-tag">执行后已清空</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="应用范围">{{ request.appId || '团队全应用' }}</el-descriptions-item>
          <el-descriptions-item label="归属团队"><OverflowTip :text="request.teamId || '-'" /></el-descriptions-item>
          <el-descriptions-item label="发起人">{{ request.requestedBy }}</el-descriptions-item>
          <el-descriptions-item label="审批人">{{ request.approvedBy || '—' }}</el-descriptions-item>
          <el-descriptions-item label="执行人">{{ request.executedBy || '—' }}</el-descriptions-item>
          <el-descriptions-item label="拒绝理由">
            <OverflowTip v-if="request.rejectReason" :text="request.rejectReason" />
            <span v-else>—</span>
          </el-descriptions-item>
          <el-descriptions-item label="发起时间">{{ formatTime(request.createdAt) }}</el-descriptions-item>
          <el-descriptions-item label="审批时间">{{ formatTime(request.decidedAt) }}</el-descriptions-item>
          <el-descriptions-item label="执行时间">{{ formatTime(request.executedAt) }}</el-descriptions-item>
          <el-descriptions-item label="完成时间">{{ formatTime(request.completedAt) }}</el-descriptions-item>
        </el-descriptions>
      </section>

      <section class="section">
        <h3>命中预览（发起时快照）</h3>
        <el-descriptions :column="3" border>
          <el-descriptions-item label="事件 (events)">{{ request.hitEvents }}</el-descriptions-item>
          <el-descriptions-item label="问题 (issues)">{{ request.hitIssues }}</el-descriptions-item>
          <el-descriptions-item label="回放 (replays)">{{ request.hitReplays }}</el-descriptions-item>
        </el-descriptions>
        <div class="hint-line">命中口径：events/replays 按主体列精确等值匹配；issues 按 props/original_json 包含匹配（保守口径）</div>
      </section>

      <section class="section" v-if="request.status === 'completed' || request.rowsAffectedEvents || request.rowsAffectedIssues || request.rowsAffectedReplays">
        <h3>执行结果（影响行数）</h3>
        <el-descriptions :column="3" border>
          <el-descriptions-item label="事件 (events)">{{ request.rowsAffectedEvents }}</el-descriptions-item>
          <el-descriptions-item label="问题 (issues)">{{ request.rowsAffectedIssues }}</el-descriptions-item>
          <el-descriptions-item label="回放 (replays)">{{ request.rowsAffectedReplays }}</el-descriptions-item>
        </el-descriptions>
        <el-alert
          v-if="request.result?.truncated"
          class="section"
          type="warning"
          :closable="false"
          show-icon
          title="导出已截断"
          :description="request.result?.note || '命中超过单表 10000 行上限，全量走 JSON 分页导出（P1-3 规划中）'"
        />
        <div class="hint-line" v-if="request.result?.format">导出格式：{{ String(request.result.format).toUpperCase() }}</div>
      </section>

      <section class="section">
        <h3>审计时间线</h3>
        <el-timeline v-if="audit.length">
          <el-timeline-item
            v-for="entry in audit"
            :key="entry.id"
            :timestamp="formatTime(entry.ts)"
            :type="entry.action === 'illegal_transition' ? 'danger' : entry.action === 'complete' ? 'success' : 'primary'"
          >
            <div class="audit-line">
              <strong>{{ ACTION_LABELS[entry.action] || entry.action }}</strong>
              <span class="audit-actor"> · {{ entry.actorId }}</span>
            </div>
            <div class="audit-detail"><OverflowTip :text="formatDetail(entry.detail)" /></div>
          </el-timeline-item>
        </el-timeline>
        <el-empty v-else description="暂无审计记录" :image-size="60" />
      </section>
    </template>
    </template>
  </div>
</template>

<style scoped>
.detail-head { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.head-main { flex: 1; min-width: 0; }
.head-main h2 { margin: 0; font-size: 18px; }
.head-main .sub { display: flex; align-items: center; gap: 8px; margin-top: 4px; color: var(--el-text-color-secondary); font-size: 12px; }
.head-tag { margin-left: 4px; }
.head-mode { font-family: var(--font-mono); }
.head-actions { display: flex; gap: 8px; }
section h3 { margin: 0 0 10px; font-size: 15px; }
.hint-line { color: var(--el-text-color-secondary); font-size: 12px; margin-top: 8px; }
.audit-line { font-size: 13px; }
.audit-actor { color: var(--el-text-color-secondary); }
.audit-detail { color: var(--el-text-color-secondary); font-size: 12px; max-width: 640px; margin-top: 2px; }
</style>
