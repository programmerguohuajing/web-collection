<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../../../dashboard.js'
import { useFilterStore } from '../../../stores/filters.js'

/**
 * D1 发起向导（PRD §7 三步）：
 * ① 类型 + 主体标识 → 创建草稿（服务端同步计算命中量快照，作为实时预览）；
 * ② 命中预览 + 模式选择（擦除：默认匿名化，硬删必填理由；导出：csv/json，命中回放时提示执行需二次确认）；
 * ③ 摘要确认 → submit（draft → pending_approval）。
 * 步骤②修改模式/格式后继续时，自动取消旧草稿并按最终参数重建（命中量随重建刷新）；
 * 对话框中途关闭时若仍为 draft，自动取消工单（不留孤儿草稿）。
 */
const emit = defineEmits(['changed'])
const store = useFilterStore()

const SUBJECT_OPTIONS = [
  { value: 'user_id', label: '用户 ID' },
  { value: 'user_name', label: '用户名' },
  { value: 'user_phone', label: '手机号' },
  { value: 'device_id', label: '设备 ID' },
  { value: 'session_id', label: '会话 ID' }
]

const step = ref(0)
const creating = ref(false)
const submitting = ref(false)
const request = ref(null)
const applications = ref([])
const form = ref(emptyForm())

function emptyForm() {
  return {
    requestType: 'access',
    subjectType: 'user_id',
    subjectValue: '',
    appId: '',
    mode: 'anonymize',
    exportFormat: 'csv',
    reason: ''
  }
}

const isErasure = computed(() => form.value.requestType === 'erasure')
const createdRequest = computed(() => request.value)
/** 步骤②参数是否与已创建草稿一致（不一致则重建） */
const needsRecreate = computed(() => {
  if (!request.value) return false
  if (isErasure.value) return request.value.mode !== form.value.mode
  return request.value.exportFormat !== form.value.exportFormat
})

function validateStep1() {
  if (!String(form.value.subjectValue || '').trim()) { ElMessage.warning('请填写主体标识值'); return false }
  return true
}

function validateStep2() {
  if (isErasure.value && form.value.mode === 'hard_delete' && !String(form.value.reason || '').trim()) {
    ElMessage.warning('硬删除不可逆，必须填写理由')
    return false
  }
  return true
}

async function createDraft() {
  const body = {
    appId: form.value.appId || '',
    subjectType: form.value.subjectType,
    subjectValue: String(form.value.subjectValue || '').trim(),
    requestType: form.value.requestType
  }
  if (isErasure.value) {
    body.mode = form.value.mode
    if (form.value.mode === 'hard_delete') body.reason = String(form.value.reason || '').trim()
  } else {
    body.exportFormat = form.value.exportFormat
  }
  const data = await api('/api/dsr/requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  request.value = data
  emit('changed')
  return data
}

async function goPreview() {
  if (!validateStep1()) return
  creating.value = true
  try {
    if (request.value) {
      // 回退修改了类型/主体等身份参数：取消旧草稿后按新参数重建（不留孤儿草稿）
      await api(`/api/dsr/requests/${request.value.id}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      request.value = null
      emit('changed')
    }
    await createDraft()
    step.value = 1
  } catch (error) {
    ElMessage.error(error?.message || '创建草稿失败')
  } finally {
    creating.value = false
  }
}

async function goConfirm() {
  if (!validateStep2()) return
  creating.value = true
  try {
    if (needsRecreate.value) {
      // 模式/格式变更：取消旧草稿并按最终参数重建（命中量随重建刷新）
      await api(`/api/dsr/requests/${request.value.id}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      request.value = null
      await createDraft()
    }
    step.value = 2
  } catch (error) {
    ElMessage.error(error?.message || '操作失败')
  } finally {
    creating.value = false
  }
}

async function submitForApproval() {
  if (!request.value) return
  submitting.value = true
  try {
    await api(`/api/dsr/requests/${request.value.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    ElMessage.success('已提交审批，等待第二管理员审批（审批人 ≠ 发起人）')
    emit('changed')
    reset()
  } catch (error) {
    ElMessage.error(error?.message || '提交审批失败')
  } finally {
    submitting.value = false
  }
}

/** 对话框关闭/完成后收尾：未提交的草稿自动取消（不留孤儿草稿） */
async function reset() {
  const draft = request.value
  request.value = null
  form.value = emptyForm()
  step.value = 0
  if (draft && draft.status === 'draft') {
    try {
      await api(`/api/dsr/requests/${draft.id}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      emit('changed')
    } catch { /* 取消失败不阻塞关闭 */ }
  }
}

function summaryLines() {
  const r = createdRequest.value
  if (!r) return []
  return [
    `工单号：${r.id}`,
    `类型：${isErasure.value ? '擦除' : '查询导出'} · 主体：${form.value.subjectType} = ${form.value.subjectValue}`,
    isErasure.value
      ? `模式：${form.value.mode === 'hard_delete' ? `硬删除（不可逆，理由：${form.value.reason}）` : '匿名化（个人字段置 [DSR-ERASED]，session_id 保留）'}`
      : `导出格式：${form.value.exportFormat.toUpperCase()}（单表上限 10000 行，超限截断标注）`,
    `命中量：事件 ${r.hitEvents} · 问题 ${r.hitIssues} · 回放 ${r.hitReplays}`,
    !isErasure.value && Number(r.hitReplays) > 0 ? '注意：命中会话回放（录屏敏感数据），执行导出时需二次确认' : '',
    '提交后需另一位 Admin/Owner 审批通过方可执行（双人制衡）'
  ].filter(Boolean)
}

onMounted(async () => {
  if (store.appId) form.value.appId = store.appId
  try {
    const data = await api('/api/applications', { requestKey: 'dsr:applications' })
    const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : []
    applications.value = items.map(item => ({
      appId: item.app_id || item.appId || '',
      name: item.name || item.appName || item.app_id || item.appId || ''
    })).filter(item => item.appId)
  } catch { /* 选择器数据缺失不阻塞向导 */ }
})
</script>

<template>
  <div class="dsr-wizard">
    <el-steps :active="step" align-center finish-status="success" simple>
      <el-step title="类型与主体" />
      <el-step title="预览与模式" />
      <el-step title="摘要确认" />
    </el-steps>

    <!-- 步骤 ①：类型 + 主体标识 -->
    <div v-if="step === 0" class="step-body">
      <el-form label-width="120px">
        <el-form-item label="工单类型" required>
          <el-radio-group v-model="form.requestType">
            <el-radio-button value="access">查询导出</el-radio-button>
            <el-radio-button value="erasure">擦除</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="应用范围">
          <el-select v-model="form.appId" clearable filterable placeholder="全部应用（团队边界内）" style="width: 100%">
            <el-option v-for="app in applications" :key="app.appId" :label="app.name" :value="app.appId" />
          </el-select>
          <div class="form-hint-line">DSR 按团队边界内执行（不做跨团队主体数据合并）</div>
        </el-form-item>
        <el-form-item label="主体标识类型" required>
          <el-select v-model="form.subjectType" style="width: 100%">
            <el-option v-for="option in SUBJECT_OPTIONS" :key="option.value" :label="option.label" :value="option.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="主体标识值" required>
          <el-input v-model="form.subjectValue" maxlength="256" placeholder="如：user@example.com / 138****0000 原文 / 设备 ID" />
          <div class="form-hint-line">擦除执行需要原文精确匹配；工单完成后原文将被服务端清空（[DSR-CLEARED]）</div>
        </el-form-item>
      </el-form>
      <div class="wizard-actions">
        <el-button @click="reset">取消</el-button>
        <el-button type="primary" :loading="creating" @click="goPreview">计算命中并继续</el-button>
      </div>
    </div>

    <!-- 步骤 ②：命中预览 + 模式选择 -->
    <div v-else-if="step === 1" class="step-body">
      <el-alert
        v-if="createdRequest && createdRequest.hitEvents + createdRequest.hitIssues + createdRequest.hitReplays === 0"
        class="section"
        type="warning"
        :closable="false"
        show-icon
        title="未命中任何数据"
        description="当前主体标识在该范围内无命中，请确认主体标识值是否正确（精确等值匹配）。"
      />
      <el-descriptions v-else-if="createdRequest" :column="3" border class="section">
        <el-descriptions-item label="事件 (events)">{{ createdRequest.hitEvents }}</el-descriptions-item>
        <el-descriptions-item label="问题 (issues)">{{ createdRequest.hitIssues }}</el-descriptions-item>
        <el-descriptions-item label="回放 (replays)">{{ createdRequest.hitReplays }}</el-descriptions-item>
      </el-descriptions>

      <el-form label-width="120px" v-if="createdRequest">
        <template v-if="isErasure">
          <el-form-item label="擦除模式" required>
            <el-radio-group v-model="form.mode">
              <el-radio value="anonymize">匿名化（默认，推荐）</el-radio>
              <el-radio value="hard_delete">硬删除（不可逆）</el-radio>
            </el-radio-group>
            <div class="form-hint-line">匿名化：user_id/user_name/user_phone/device_id 置 [DSR-ERASED]，session_id 保留（统计价值）；分批 ≤10000 行/批执行</div>
          </el-form-item>
          <el-form-item v-if="form.mode === 'hard_delete'" label="硬删理由" required>
            <el-input v-model="form.reason" maxlength="512" placeholder="必填：硬删除理由（随审批与审计留痕）" />
          </el-form-item>
        </template>
        <template v-else>
          <el-form-item label="导出格式">
            <el-radio-group v-model="form.exportFormat">
              <el-radio value="csv">CSV</el-radio>
              <el-radio value="json">JSON 单包</el-radio>
            </el-radio-group>
            <div class="form-hint-line">events / issues / replays 分表打包；执行导出时可在详情页下载</div>
          </el-form-item>
          <el-alert
            v-if="Number(createdRequest.hitReplays) > 0"
            class="section"
            type="warning"
            :closable="false"
            show-icon
            title="命中会话回放（录屏敏感数据）"
            description="执行导出时需勾选二次确认后方可包含回放数据。"
          />
        </template>
      </el-form>
      <div class="wizard-actions">
        <el-button @click="step = 0">上一步</el-button>
        <el-button type="primary" :loading="creating" @click="goConfirm">下一步</el-button>
      </div>
    </div>

    <!-- 步骤 ③：摘要确认 -->
    <div v-else class="step-body">
      <el-descriptions :column="1" border class="section">
        <el-descriptions-item v-for="(line, index) in summaryLines()" :key="index" :label="index === 0 ? '工单' : ' '">
          <span :class="{ 'warn-line': line.startsWith('注意') }">{{ line }}</span>
        </el-descriptions-item>
      </el-descriptions>
      <div class="wizard-actions">
        <el-button @click="step = 1">上一步</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForApproval">提交审批</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.step-body { margin-top: 18px; }
.wizard-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }
.form-hint-line { color: var(--el-text-color-secondary); font-size: 12px; margin-top: 4px; line-height: 1.4; }
.warn-line { color: var(--el-color-warning); font-weight: 600; }
</style>
