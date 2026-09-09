<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api, normalizePageResponse, pageLoading } from '../../../dashboard.js'
import OverflowTip from '../../../components/OverflowTip.vue'

// C2 集成市场：Slack / PagerDuty 通知集成（入口）+ Sentry issue 导入（指纹对齐）

const router = useRouter()
const applications = ref([])
const importForm = reactive({ appId: '', payload: '' })
const importing = ref(false)
const importResult = ref(null)

const payloadIssueCount = computed(() => {
  try {
    const parsed = JSON.parse(importForm.payload)
    if (Array.isArray(parsed)) return parsed.length
    if (Array.isArray(parsed?.issues)) return parsed.issues.length
    if (Array.isArray(parsed?.items)) return parsed.items.length
    return parsed && typeof parsed === 'object' ? 1 : 0
  } catch { return 0 }
})

async function loadApplications() {
  try {
    const data = await api('/api/applications', { requestKey: 'integrations:applications' })
    applications.value = normalizePageResponse(data).items.map(item => ({
      appId: item.app_id || item.appId || '',
      name: item.name || item.appName || item.app_id || item.appId || '-'
    }))
  } catch { applications.value = [] }
}

async function runImport() {
  if (!importForm.appId) { ElMessage.warning('请选择目标应用'); return }
  let issues
  try { issues = JSON.parse(importForm.payload) } catch { ElMessage.error('JSON 解析失败，请检查格式'); return }
  importing.value = true
  importResult.value = null
  try {
    const data = await api('/api/integrations/sentry/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: importForm.appId, issues }),
      requestKey: 'integrations:sentry:import'
    })
    importResult.value = data
    ElMessage.success(`导入完成：新增 ${data.imported}，合并 ${data.merged}`)
  } catch (err) {
    ElMessage.error(err.message || '导入失败')
  } finally { importing.value = false }
}

onMounted(loadApplications)
</script>

<template>
  <div v-loading="pageLoading">
    <el-alert class="section" type="info" :closable="false" show-icon
      title="集成中心：把 Web Collection 接入现有 DevOps 通知与迁移链路"
      description="Slack / PagerDuty 作为一等告警通道复用告警中心配置；Sentry issue 导入采用与本站采集事件一致的指纹公式，命中历史错误自动合并计数，迁移不产生重复 issue。" />

    <el-row :gutter="14" class="section">
      <el-col :span="8">
        <el-card shadow="never">
          <template #header><div class="card-head"><b>Slack</b><el-tag size="small" type="success">告警通道</el-tag></div></template>
          <p class="desc">Incoming Webhook 推送告警文本，支持 ${var} 消息模板与请求体模板（JSON）。可与燃尽告警（SLO）联动。</p>
          <el-button type="primary" plain @click="router.push('/alerts')">去告警中心配置</el-button>
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never">
          <template #header><div class="card-head"><b>PagerDuty</b><el-tag size="small" type="success">告警通道</el-tag></div></template>
          <p class="desc">Events API v2 触发事件（trigger），severity 按告警级别自动映射（critical/error/warning/info），dedup_key=告警 ID。</p>
          <el-button type="primary" plain @click="router.push('/alerts')">去告警中心配置</el-button>
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never">
          <template #header><div class="card-head"><b>Sentry 导入</b><el-tag size="small" type="warning">数据迁移</el-tag></div></template>
          <p class="desc">粘贴 Sentry 导出的 issues JSON（或含 issues 数组的 payload），映射为站内错误 issue；指纹与原生采集对齐。</p>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="section">
      <template #header><div class="card-head"><b>Sentry issue 导入</b><el-tag v-if="payloadIssueCount" size="small">{{ payloadIssueCount }} 条待导入</el-tag></div></template>
      <el-form label-width="100px">
        <el-form-item label="目标应用" required>
          <el-select v-model="importForm.appId" filterable style="width:100%" placeholder="选择导入到哪个应用">
            <el-option v-for="app in applications" :key="app.appId" :label="app.name === '-' ? app.appId : `${app.name}（${app.appId}）`" :value="app.appId" />
          </el-select>
        </el-form-item>
        <el-form-item label="Sentry JSON">
          <el-input v-model="importForm.payload" type="textarea" :rows="10"
            placeholder='支持：issue 导出数组 [{ "issue_id": 1, "title": "TypeError: x is not a function", "culprit": "app/main", "level": "error", "count": 12, "first_seen": "2026-01-01T00:00:00Z", "last_seen": "..." }]，或 { "issues": [...] }，或单条对象' />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="importing" :disabled="!payloadIssueCount" @click="runImport">开始导入</el-button>
        </el-form-item>
      </el-form>
      <el-table v-if="importResult" :data="importResult.results" size="small" max-height="320">
        <el-table-column label="指纹" prop="fingerprint" width="200"><template #default="{ row }"><OverflowTip :text="row.fingerprint" /></template></el-table-column>
        <el-table-column label="动作" width="110"><template #default="{ row }"><el-tag size="small" :type="row.action === 'imported' ? 'success' : 'info'">{{ row.action === 'imported' ? '新增' : '合并' }}</el-tag></template></el-table-column>
        <el-table-column label="错误" prop="name"><template #default="{ row }"><OverflowTip :text="row.name" /></template></el-table-column>
      </el-table>
      <p v-if="importResult" class="result-line">新增 {{ importResult.imported }} · 合并 {{ importResult.merged }} · 跳过 {{ importResult.skipped }}</p>
    </el-card>
  </div>
</template>

<style scoped>
.section { margin-bottom: 14px; }
.card-head { display: flex; align-items: center; gap: 8px; }
.desc { color: var(--el-text-color-secondary); font-size: 12.5px; line-height: 1.7; margin: 0 0 12px; }
.result-line { color: var(--el-text-color-secondary); font-size: 12.5px; margin: 8px 0 0; }
</style>
