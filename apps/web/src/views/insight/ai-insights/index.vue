<script setup>
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { BellFilled, Refresh, MagicStick, Promotion } from '@element-plus/icons-vue'
import { api } from '../../../dashboard.js'

const router = useRouter()
const items = ref([])
const loading = ref(false)
const scanning = ref(false)
const detail = reactive({ open: false, finding: null, diagnosis: null, diagnosing: false, pushing: false })

const SCOPE_LABEL = {
  'error-cluster': '错误簇', 'release-regression': '发布回归',
  'perf-regression': '性能退化', 'metric-drop': '指标骤降'
}
const STATUS_LABEL = { open: '待处理', ack: '已确认', resolved: '已解决', ignored: '已忽略' }
const STATUS_TYPE = { open: 'danger', ack: 'warning', resolved: 'success', ignored: 'info' }

function pct(v) { return v == null ? '-' : `${Math.round(Number(v) * 100)}%` }

async function load() {
  loading.value = true
  try {
    const data = await api('/api/ai/findings?limit=100', { requestKey: 'insights:list' })
    items.value = data?.items || []
  } catch (e) {
    ElMessage.error(e?.message || '洞察加载失败')
  } finally {
    loading.value = false
  }
}

async function scan() {
  scanning.value = true
  try {
    const r = await api('/api/ai/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', requestKey: 'insights:scan' })
    ElMessage.success(`扫描完成：新增 ${r.inserted?.length || 0} 条，跳过 ${r.skipped || 0} 条`)
    await load()
  } catch (e) {
    ElMessage.error(e?.message || '扫描失败')
  } finally {
    scanning.value = false
  }
}

async function openDetail(f) {
  detail.open = true
  detail.finding = f
  detail.diagnosis = null
}

async function setStatus(f, status) {
  try {
    await api(`/api/ai/findings/${f.id}/status`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }), requestKey: `insights:status:${f.id}`
    })
    f.status = status
    ElMessage.success('状态已更新')
  } catch (e) {
    ElMessage.error(e?.message || '状态更新失败')
  }
}

async function pushFinding(f) {
  detail.pushing = true
  try {
    const r = await api(`/api/ai/findings/${f.id}/notify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', requestKey: `insights:notify:${f.id}` })
    if (r?.ok) ElMessage.success('已推送至配置的告警通道')
    else ElMessage.warning('推送完成，但部分通道失败')
  } catch (e) {
    ElMessage.error(e?.message || '推送失败')
  } finally {
    detail.pushing = false
  }
}

/** 深诊断：用 P0 scope 引擎对洞察对象做完整诊断 */
async function deepDiagnose(f) {
  detail.diagnosing = true
  detail.diagnosis = null
  try {
    const r = await api('/api/ai/diagnose', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: f.scope, ref: f.object }), requestKey: `insights:deep:${f.id}`
    })
    detail.diagnosis = r
  } catch (e) {
    ElMessage.error(e?.message || '深诊断失败')
  } finally {
    detail.diagnosing = false
  }
}

function askInAssistant(f) {
  router.push({ path: '/ai-assistant', query: { q: `分析这条 AI 洞察：${f.summary}` } })
}

onMounted(load)
</script>

<template>
  <div class="insights-page">
    <div class="page-head">
      <div>
        <h2><el-icon><BellFilled /></el-icon> AI 洞察流</h2>
        <p class="sub">系统主动扫描发现的错误簇 / 发布回归 / 性能退化 / 指标骤降，无需点开错误即可发现。</p>
      </div>
      <div class="actions">
        <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
        <el-button type="primary" :icon="MagicStick" :loading="scanning" @click="scan">立即扫描</el-button>
      </div>
    </div>

    <el-table :data="items" v-loading="loading" empty-text="暂无洞察，点击「立即扫描」开始">
      <el-table-column label="类型" width="120">
        <template #default="{ row }"><el-tag size="small">{{ SCOPE_LABEL[row.scope] || row.scope }}</el-tag></template>
      </el-table-column>
      <el-table-column label="对象" prop="object" width="160" />
      <el-table-column label="结论" min-width="280">
        <template #default="{ row }"><span class="summary">{{ row.summary }}</span></template>
      </el-table-column>
      <el-table-column label="置信度" width="100">
        <template #default="{ row }">{{ pct(row.confidence) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="110">
        <template #default="{ row }"><el-tag :type="STATUS_TYPE[row.status]" size="small">{{ STATUS_LABEL[row.status] }}</el-tag></template>
      </el-table-column>
      <el-table-column label="发现时间" width="170">
        <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template>
      </el-table-column>
      <el-table-column label="操作" width="200" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDetail(row)">详情</el-button>
          <el-button v-if="row.status === 'open'" link type="success" @click="setStatus(row, 'resolved')">已解决</el-button>
          <el-button v-if="row.status === 'open'" link type="info" @click="setStatus(row, 'ignored')">忽略</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-drawer v-model="detail.open" title="洞察详情" size="min(560px, 94vw)">
      <template v-if="detail.finding">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="类型">{{ SCOPE_LABEL[detail.finding.scope] || detail.finding.scope }}</el-descriptions-item>
          <el-descriptions-item label="对象">{{ detail.finding.object }}</el-descriptions-item>
          <el-descriptions-item label="置信度">{{ pct(detail.finding.confidence) }}</el-descriptions-item>
          <el-descriptions-item label="结论">{{ detail.finding.summary }}</el-descriptions-item>
        </el-descriptions>

        <h4>证据</h4>
        <div class="evidence">
          <el-tag v-for="(ev, i) in (detail.finding.evidence || [])" :key="i" size="small" type="info" effect="plain">{{ ev }}</el-tag>
        </div>

        <div class="detail-actions">
          <el-button :icon="MagicStick" :loading="detail.diagnosing" @click="deepDiagnose(detail.finding)">深诊断</el-button>
          <el-button :icon="Promotion" :loading="detail.pushing" @click="pushFinding(detail.finding)">推送通道</el-button>
          <el-button @click="askInAssistant(detail.finding)">在助手追问</el-button>
        </div>

        <template v-if="detail.diagnosis">
          <el-divider />
          <h4>诊断结论</h4>
          <p v-if="detail.diagnosis.summary">{{ detail.diagnosis.summary }}</p>
          <div v-for="(h, i) in (detail.diagnosis.hypotheses || [])" :key="i" class="hypo">
            <strong>{{ h.cause }}</strong> <el-tag size="small">{{ pct(h.confidence) }}</el-tag>
          </div>
          <ol v-if="detail.diagnosis.suggestions?.length">
            <li v-for="(s, i) in detail.diagnosis.suggestions" :key="i">{{ s.action }}</li>
          </ol>
        </template>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.insights-page { padding: 16px 20px; }
.page-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; }
.page-head h2 { display: flex; align-items: center; gap: 8px; margin: 0; }
.page-head .sub { color: var(--el-text-color-secondary); margin: 6px 0 0; font-size: 13px; }
.summary { word-break: break-all; }
.evidence { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 16px; }
.detail-actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
.hypo { padding: 6px 0; display: flex; gap: 8px; align-items: center; }
</style>
