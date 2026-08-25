<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { MagicStick, RefreshRight } from '@element-plus/icons-vue'
import { api } from '../dashboard.js'
import { useFilterStore } from '../stores/filters.js'
import { useDiagnosisStore } from '../stores/diagnosis.js'

const props = defineProps({ modelValue: Boolean })
const emit = defineEmits(['update:modelValue'])

const route = useRoute()
const filterStore = useFilterStore()
const diagnosisStore = useDiagnosisStore()

const visible = computed({
  get: () => props.modelValue,
  set: v => emit('update:modelValue', v)
})

// 三态标签页：auto（当前上下文）/ manual-trace / manual-error
const activeTab = ref('auto')
const traceInput = ref('')
const errorInput = ref('')
const loading = ref(false)
const result = ref(null)          // 诊断结果（含 degraded）
const errorMessage = ref('')
const feedback = reactive({ rating: null, correction: '' })

// 自动检测当前上下文
const autoTraceId = computed(() => route.query.traceId || diagnosisStore.currentTraceId || '')
const autoIssueFp = computed(() => diagnosisStore.currentIssueFingerprint || '')
const autoKind = computed(() =>
  (autoTraceId.value ? 'trace' : autoIssueFp.value ? 'error' : ''))

const currentContextLabel = computed(() => {
  if (autoKind.value === 'trace') return `正在诊断 trace：${autoTraceId.value}`
  if (autoKind.value === 'error') return `正在诊断 issue：${short(autoIssueFp.value)}`
  return '未检测到当前选中的 trace / issue，可切换到手动输入'
})

function short(v) { return String(v || '').slice(0, 12) }

async function diagnose(payload) {
  loading.value = true
  errorMessage.value = ''
  result.value = null
  feedback.rating = null
  feedback.correction = ''
  try {
    const body = { appId: filterStore.appId || undefined }
    if (payload.traceId) body.traceId = payload.traceId
    if (payload.issueFp) body.issueId = payload.issueFp
    if (payload.errorText) body.errorText = payload.errorText
    if (body.traceId) body.type = 'trace'
    else body.type = 'error'
    result.value = await api('/api/ai/diagnose', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      requestKey: `ai:diagnose:${Date.now()}`
    })
  } catch (e) {
    errorMessage.value = e?.message || '诊断失败，请稍后重试'
  } finally {
    loading.value = false
  }
}

function diagnoseCurrent() {
  if (autoKind.value === 'trace') return diagnose({ traceId: autoTraceId.value })
  if (autoKind.value === 'error') return diagnose({ issueFp: autoIssueFp.value })
  activeTab.value = 'manual-trace'
  ElMessage.info('未检测到上下文，请切换到手动输入')
}

function diagnoseManualTrace() {
  if (!traceInput.value.trim()) return ElMessage.warning('请输入 traceId')
  diagnose({ traceId: traceInput.value.trim() })
}

function diagnoseManualError() {
  if (!errorInput.value.trim()) return ElMessage.warning('请输入错误文本或 issue 指纹')
  // 纯指纹短文本 → 按 issueId 查；含空格/堆栈 → 文本匹配
  const t = errorInput.value.trim()
  if (t.length <= 64 && !/\s/.test(t)) diagnose({ issueFp: t })
  else diagnose({ errorText: t })
}

async function submitFeedback() {
  if (!result.value?.refId) return
  const rating = feedback.rating
  if (!rating) return ElMessage.warning('请先选择赞 / 踩')
  try {
    await api('/api/ai/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diagnosisId: result.value.refId, rating, correction: feedback.correction || undefined })
    })
    ElMessage.success('感谢反馈，将用于改进诊断')
    feedback.rating = null
    feedback.correction = ''
  } catch (e) {
    ElMessage.error(e?.message || '反馈提交失败')
  }
}

function pct(v) { return v == null ? '-' : `${Math.round(Number(v) * 100)}%` }
function tagType(v) { return Number(v) >= 0.7 ? 'success' : Number(v) >= 0.4 ? 'warning' : 'info' }

function rediagnose() {
  if (result.value?.refId) diagnose({ traceId: result.value.refId })
}

function open() { visible.value = true }
defineExpose({ open })
</script>

<template>
  <el-drawer
    :model-value="visible"
    size="min(440px, 92vw)"
    :with-header="false"
    class="ai-diagnosis-drawer"
    @close="visible = false"
  >
    <div class="ai-drawer-head">
      <h3><el-icon><MagicStick /></el-icon> AI 诊断</h3>
      <el-button text @click="visible = false">关闭</el-button>
    </div>

    <el-tabs v-model="activeTab">
      <el-tab-pane label="当前上下文" name="auto">
        <p class="ctx-label">{{ currentContextLabel }}</p>
        <el-button type="primary" :loading="loading" :disabled="!autoKind" @click="diagnoseCurrent">
          开始诊断
        </el-button>
      </el-tab-pane>

      <el-tab-pane label="按 traceId" name="manual-trace">
        <div class="manual-row">
          <el-input v-model="traceInput" placeholder="粘贴 / 输入 traceId" clearable />
          <el-button type="primary" :loading="loading" @click="diagnoseManualTrace">诊断</el-button>
        </div>
      </el-tab-pane>

      <el-tab-pane label="按错误" name="manual-error">
        <div class="manual-row manual-stack">
          <el-input
            v-model="errorInput"
            type="textarea"
            :rows="5"
            placeholder="粘贴错误文本 / 原始 stack / issue 指纹"
          />
          <el-button type="primary" :loading="loading" @click="diagnoseManualError">诊断</el-button>
        </div>
      </el-tab-pane>
    </el-tabs>

    <el-alert v-if="errorMessage" class="section" type="error" :title="errorMessage" show-icon />

    <!-- 降级态 -->
    <el-alert
      v-if="result?.degraded"
      class="section"
      type="warning"
      :title="result.summary || '模型暂不可用，建议人工排查'"
      show-icon
    >
      <template #default>
        <el-button v-if="result.refId" size="small" text type="primary" @click="diagnose({ traceId: result.refId })">
          <el-icon><RefreshRight /></el-icon> 重新诊断
        </el-button>
      </template>
    </el-alert>

    <!-- 结果态 -->
    <template v-if="result && !result.degraded">
      <section v-if="result.summary" class="result-block">
        <h4>根因摘要</h4>
        <p class="summary">{{ result.summary }}</p>
      </section>

      <section v-if="result.hypotheses?.length" class="result-block">
        <h4>假设（{{ result.hypotheses.length }}）</h4>
        <div v-for="(h, i) in result.hypotheses" :key="i" class="hypothesis">
          <div class="hypo-head">
            <strong>{{ h.cause }}</strong>
            <el-tag size="small" :type="tagType(h.confidence)">{{ pct(h.confidence) }}</el-tag>
          </div>
          <div v-if="h.evidence?.length" class="evidence">
            <el-tag
              v-for="(ev, j) in h.evidence"
              :key="j"
              size="small"
              type="info"
              effect="plain"
            >{{ ev }}</el-tag>
          </div>
        </div>
      </section>

      <section v-if="result.suggestions?.length" class="result-block">
        <h4>建议</h4>
        <ol class="suggestions">
          <li v-for="(s, i) in result.suggestions" :key="i">
            {{ s.action }}
            <code v-if="s.codeRef">{{ s.codeRef }}</code>
            <el-tag v-if="s.kbLink" size="small" type="success" effect="plain">{{ s.kbLink }}</el-tag>
          </li>
        </ol>
      </section>

      <section v-if="result.relatedKb?.length" class="result-block">
        <h4>相关知识</h4>
        <div v-for="(k, i) in result.relatedKb" :key="i" class="kb-row">
          <span>{{ k.title }}</span>
          <el-tag size="small" type="warning" effect="plain">{{ pct(k.score) }}</el-tag>
        </div>
      </section>

      <section class="result-block">
        <h4>反馈</h4>
        <div class="feedback-row">
          <el-button
            :type="feedback.rating === 'up' ? 'success' : 'default'"
            size="small"
            @click="feedback.rating = 'up'"
          >有用</el-button>
          <el-button
            :type="feedback.rating === 'down' ? 'danger' : 'default'"
            size="small"
            @click="feedback.rating = 'down'"
          >无用</el-button>
          <el-button size="small" :loading="false" @click="submitFeedback">提交</el-button>
        </div>
        <el-input
          v-model="feedback.correction"
          class="correction"
          placeholder="补充修正意见（选填）"
          size="small"
        />
        <el-button
          v-if="result.refId"
          class="rediagnose"
          size="small"
          text
          type="primary"
          @click="rediagnose"
        ><el-icon><RefreshRight /></el-icon> 重新诊断</el-button>
      </section>

      <div class="meta" v-if="result.model">
        <span>模型：{{ result.model }}</span>
        <span>置信度：{{ result.confidence ?? '-' }}</span>
      </div>
    </template>

    <el-empty v-if="!loading && !errorMessage && !result" description="选择一个 tab 开始 AI 诊断" />
    <div v-if="loading" class="loading-tip"><el-icon class="is-loading"><RefreshRight /></el-icon> 正在分析…</div>
  </el-drawer>
</template>

<style scoped>
.ai-drawer-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.ai-drawer-head h3 { display: flex; align-items: center; gap: 6px; margin: 0; }
.ctx-label { color: var(--el-text-color-secondary); margin: 0 0 12px; font-size: 13px; word-break: break-all; }
.manual-row { display: flex; gap: 8px; }
.manual-stack { flex-direction: column; align-items: stretch; }
.result-block { margin-top: 16px; }
.result-block h4 { margin: 0 0 8px; font-size: 14px; }
.summary { margin: 0; }
.hypothesis { padding: 8px 0; border-bottom: 1px solid var(--el-border-color-lighter); }
.hypo-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.hypothesis strong { font-size: 13px; }
.evidence { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.suggestions { margin: 0; padding-left: 20px; }
.suggestions li { margin-bottom: 6px; font-size: 13px; }
.suggestions code { background: var(--el-fill-color); padding: 0 4px; border-radius: 3px; font-size: 12px; }
.kb-row { display: flex; justify-content: space-between; align-items: center; font-size: 13px; padding: 4px 0; }
.feedback-row { display: flex; gap: 8px; margin-bottom: 8px; }
.correction { margin-bottom: 8px; }
.meta { margin-top: 16px; font-size: 12px; color: var(--el-text-color-placeholder); display: flex; gap: 12px; }
.section { margin-top: 12px; }
.loading-tip { display: flex; align-items: center; gap: 6px; color: var(--el-text-color-secondary); margin-top: 16px; }
.rediagnose { display: none; }
</style>
