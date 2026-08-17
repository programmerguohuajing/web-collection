<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { deleteApplication, deleteRelease, loadGovernance, loadReleases, normalizePageResponse, pageLoading, rotateCollectKey, runCleanup, saveApplication, saveGovernanceSettings, saveRelease, toList } from '../../../dashboard.js'

const applications = ref([])
const applicationOptions = ref([])
const appPager = reactive({ page: 1, pageSize: 10, total: 0 })
const settings = reactive({ retention: {}, alerts: {} })
const appDialog = ref(false)
const releaseDialog = ref(false)
const activeAppId = ref('')
const releases = ref([])
const releasePager = reactive({ page: 1, pageSize: 10, total: 0 })
const releaseForm = reactive({ release: '', status: 'active' })
const appForm = reactive({ appId: '', name: '', platform: 'web', owner: '', enabled: true, sampleRate: 1, replaySampleRate: 1, allowedOrigins: '', blockedTypes: '', blockedNames: '' })
const newCollectKey = ref('')
const collectKeyDialog = ref(false)
const governanceLoading = ref(false)
const governanceError = ref('')
const releaseLoading = ref(false)
const releaseError = ref('')
let governanceRequestId = 0
let releaseRequestId = 0

function normalizeApplication(row = {}) {
  return {
    ...row,
    app_id: row.app_id || row.appId || '',
    name: row.name || row.appName || row.app_id || row.appId || '-',
    platform: row.platform || '-',
    owner: row.owner || '-',
    enabled: row.enabled !== false,
    sample_rate: Number(row.sample_rate ?? row.sampleRate ?? 0),
    replay_sample_rate: Number(row.replay_sample_rate ?? row.replaySampleRate ?? 0),
    release_count: Number(row.release_count ?? row.releaseCount ?? 0)
  }
}

function normalizeRelease(row = {}) {
  return { ...row, release_name: row.release_name || row.releaseName || row.release || '', status: row.status || '-' }
}

async function load() {
  const requestId = ++governanceRequestId
  governanceLoading.value = true
  governanceError.value = ''
  pageLoading.value = true
  try {
    const data = await loadGovernance({
      appPage: appPager.page, appPageSize: appPager.pageSize
    })
    if (requestId !== governanceRequestId) return
    const appData = normalizePageResponse(data.applications, appPager)
    applications.value = appData.items.map(normalizeApplication)
    applicationOptions.value = toList(data.applicationOptions).map(normalizeApplication)
    Object.assign(appPager, appData)
    Object.assign(settings.retention, data.settings?.retention || {})
    Object.assign(settings.alerts, data.settings?.alerts || {})
  } catch (error) {
    if (requestId === governanceRequestId && error?.code !== 'ABORT_ERR') governanceError.value = error.message || '采集治理加载失败'
  } finally {
    if (requestId === governanceRequestId) {
      governanceLoading.value = false
      pageLoading.value = false
    }
  }
}

function editApp(row = {}) {
  Object.assign(appForm, {
    appId: row.app_id || row.appId || '', name: row.name || '', platform: row.platform || 'web', owner: row.owner || '', enabled: row.enabled ?? true,
    sampleRate: Number(row.sample_rate ?? row.sampleRate ?? 1), replaySampleRate: Number(row.replay_sample_rate ?? row.replaySampleRate ?? 1),
    allowedOrigins: row.rules_json?.allowedOrigins?.join('\n') || '', blockedTypes: row.rules_json?.blockedTypes?.join(',') || '', blockedNames: row.rules_json?.blockedNames?.join(',') || ''
  })
  appDialog.value = true
}

async function submitApp() {
  await saveApplication({ ...appForm, rules: { allowedOrigins: lines(appForm.allowedOrigins), blockedTypes: lines(appForm.blockedTypes), blockedNames: lines(appForm.blockedNames) } })
  appDialog.value = false
  ElMessage.success('应用配置已保存')
  appPager.page = 1
  await load()
}
async function removeApp(row) {
  const confirmed = await ElMessageBox.confirm(
    `确定删除应用"${row.name}"吗？此操作将同步删除该应用所有入库数据（事件、错误、回放、SourceMap、告警历史等），且不可恢复。`,
    '删除应用',
    { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
  ).then(() => true).catch(() => false)
  if (!confirmed) return
  await deleteApplication(row.app_id)
  ElMessage.success('应用已删除')
  if (applications.value.length === 1 && appPager.page > 1) appPager.page--
  await load()
}
function lines(value) { return String(value || '').split(/[,\n]/).map(item => item.trim()).filter(Boolean) }
async function resetKey(row) {
  collectKeyDialog.value = false
  newCollectKey.value = ''
  try {
    newCollectKey.value = (await rotateCollectKey(row.app_id || row.appId)).collectKey
    collectKeyDialog.value = true
  } catch (error) {
    ElMessage.error(error.message || '采集密钥生成失败')
  }
}

async function submitSettings() {
  await saveGovernanceSettings(settings)
  ElMessage.success('治理策略已保存')
  await load()
}

async function openReleases(row) {
  activeAppId.value = row.app_id || row.appId || ''
  if (!activeAppId.value) return
  releasePager.page = 1
  await loadReleasePage()
  releaseDialog.value = true
}

async function loadReleasePage() {
  if (!activeAppId.value) return
  const requestId = ++releaseRequestId
  releaseLoading.value = true
  releaseError.value = ''
  try {
    const data = await loadReleases(activeAppId.value, releasePager.page, releasePager.pageSize)
    if (requestId !== releaseRequestId) return
    const normalized = normalizePageResponse(data, releasePager)
    releases.value = normalized.items.map(normalizeRelease)
    Object.assign(releasePager, normalized)
  } catch (error) {
    if (requestId === releaseRequestId && error?.code !== 'ABORT_ERR') releaseError.value = error.message || '版本列表加载失败'
  } finally {
    if (requestId === releaseRequestId) releaseLoading.value = false
  }
}

function formatRate(value) {
  const rate = Number(value)
  return Number.isFinite(rate) ? `${Math.round(rate * 100)}%` : '-'
}

function formatDate(value) {
  const date = new Date(Number(value))
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString()
}

async function submitRelease() {
  const release = releaseForm.release.trim()
  if (!release) return ElMessage.warning('请输入版本号')
  try {
    await saveRelease(activeAppId.value, release, releaseForm.status)
    releasePager.page = 1
    await loadReleasePage()
    releaseForm.release = ''
    ElMessage.success('版本已保存')
    await load()
  } catch (error) {
    ElMessage.error(error.message || '版本保存失败')
  }
}
async function removeRelease(row) {
  const confirmed = await ElMessageBox.confirm(`确定删除版本"${row.release_name}"吗？SDK 继续上报该版本时会重新出现。`, '删除版本', { type: 'warning' }).then(() => true).catch(() => false)
  if (!confirmed) return
  await deleteRelease(activeAppId.value, row.release_name)
  if (releases.value.length === 1 && releasePager.page > 1) releasePager.page--
  await loadReleasePage()
  ElMessage.success('版本已删除')
  await load()
}

async function cleanup() {
  const result = await runCleanup()
  ElMessage.success(`清理完成：${Object.values(result).reduce((sum, value) => sum + value, 0)} 条`)
}

onMounted(load)
</script>

<template>
  <div>
    <el-card shadow="never" class="section panel">
      <template #header><div class="panel-head"><b>应用与采样</b><el-button type="primary" @click="editApp()">新增应用</el-button></div></template>
      <el-alert v-if="governanceError" class="table-error" type="error" :title="governanceError" show-icon :closable="false"><template #default><el-button link type="primary" @click="load">重试</el-button></template></el-alert>
      <el-table :data="applications" border v-loading="governanceLoading" empty-text="暂无应用数据">
        <el-table-column prop="app_id" label="App ID" min-width="150" />
        <el-table-column prop="name" label="应用名称" min-width="150" />
        <el-table-column prop="platform" label="平台" width="100" />
        <el-table-column prop="owner" label="负责人" min-width="120" />
        <el-table-column label="事件采样率" width="120"><template #default="{ row }">{{ formatRate(row.sample_rate ?? row.sampleRate) }}</template></el-table-column>
        <el-table-column label="回放采样率" width="120"><template #default="{ row }">{{ formatRate(row.replay_sample_rate ?? row.replaySampleRate) }}</template></el-table-column>
        <el-table-column label="版本数" width="90"><template #default="{ row }">{{ row.release_count ?? row.releaseCount ?? 0 }}</template></el-table-column>
        <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag></template></el-table-column>
        <el-table-column label="操作" width="270"><template #default="{ row }"><el-button link type="primary" @click="editApp(row)">编辑</el-button><el-button link type="primary" @click="openReleases(row)">版本</el-button><el-button link type="warning" @click="resetKey(row)">重置密钥</el-button><el-button link type="danger" @click="removeApp(row)">删除</el-button></template></el-table-column>
      </el-table>
      <el-pagination class="pager" background layout="sizes, prev, pager, next, total" :current-page="appPager.page" :page-size="appPager.pageSize" :page-sizes="[10, 20, 50, 100]" :total="appPager.total" @current-change="value => { appPager.page = value; load() }" @size-change="value => { appPager.page = 1; appPager.pageSize = value; load() }" />
    </el-card>

    <el-card shadow="never" class="section panel">
      <template #header><b>保留与告警策略</b></template>
      <el-form label-width="150px" class="governance-form">
        <el-form-item label="事件保留（天）"><el-input-number v-model="settings.retention.eventsDays" :min="1" :max="3650" /></el-form-item>
        <el-form-item label="日志保留（天）"><el-input-number v-model="settings.retention.logsDays" :min="1" :max="3650" /></el-form-item>
        <el-form-item label="回放保留（天）"><el-input-number v-model="settings.retention.replaysDays" :min="1" :max="3650" /></el-form-item>
        <el-form-item label="已解决错误保留（天）"><el-input-number v-model="settings.retention.resolvedIssuesDays" :min="1" :max="3650" /></el-form-item>
        <el-form-item label="SourceMap 保留（天）"><el-input-number v-model="settings.retention.sourcemapsDays" :min="1" :max="3650" /></el-form-item>
        <el-form-item label="告警冷却（分钟）"><el-input-number v-model="settings.alerts.cooldownMinutes" :min="1" :max="1440" /></el-form-item>
        <el-form-item label="错误累计阈值"><el-input-number v-model="settings.alerts.errorCount" :min="1" :max="100000" /></el-form-item>
        <el-form-item label="启用告警"><el-switch v-model="settings.alerts.enabled" /></el-form-item>
        <el-form-item label="LCP 阈值（ms）"><el-input-number v-model="settings.alerts.lcp" :min="0" /></el-form-item>
        <el-form-item label="INP 阈值（ms）"><el-input-number v-model="settings.alerts.inp" :min="0" /></el-form-item>
        <el-form-item label="CLS 阈值"><el-input-number v-model="settings.alerts.cls" :min="0" :step="0.05" /></el-form-item>
        <el-form-item label="长任务阈值（ms）"><el-input-number v-model="settings.alerts.longtask" :min="0" /></el-form-item>
        <el-form-item label="错误通知"><el-switch v-model="settings.alerts.error" /></el-form-item>
        <el-form-item label="error 日志通知"><el-switch v-model="settings.alerts.logError" /></el-form-item>
        <el-form-item label="回归通知"><el-switch v-model="settings.alerts.regression" /></el-form-item>
      </el-form>
      <el-space>
        <el-button type="primary" @click="submitSettings">保存策略</el-button>
        <el-button @click="cleanup">立即清理</el-button>
      </el-space>
    </el-card>
  </div>

  <el-dialog v-model="appDialog" title="应用配置" width="520px">
    <el-form :model="appForm" label-width="110px">
      <el-form-item label="App ID"><el-input v-model="appForm.appId" :disabled="applications.some(item => item.app_id === appForm.appId)" /></el-form-item>
      <el-form-item label="应用名称"><el-input v-model="appForm.name" /></el-form-item>
      <el-form-item label="平台"><el-select v-model="appForm.platform"><el-option v-for="item in ['web','miniapp','uni-app','taro','react-native']" :key="item" :label="item" :value="item" /></el-select></el-form-item>
      <el-form-item label="负责人"><el-input v-model="appForm.owner" /></el-form-item>
      <el-form-item label="启用采集"><el-switch v-model="appForm.enabled" /></el-form-item>
      <el-form-item label="事件采样率"><el-slider v-model="appForm.sampleRate" :min="0" :max="1" :step="0.01" show-input /></el-form-item>
      <el-form-item label="回放采样率"><el-slider v-model="appForm.replaySampleRate" :min="0" :max="1" :step="0.01" show-input /></el-form-item>
      <el-form-item label="可信来源"><el-input v-model="appForm.allowedOrigins" type="textarea" placeholder="每行一个 Origin，例如 https://shop.example.com" /></el-form-item>
      <el-form-item label="禁用事件类型"><el-input v-model="appForm.blockedTypes" placeholder="逗号分隔，例如 log,replay" /></el-form-item>
      <el-form-item label="禁用事件名称"><el-input v-model="appForm.blockedNames" placeholder="逗号分隔" /></el-form-item>
    </el-form>
    <template #footer><el-button @click="appDialog=false">取消</el-button><el-button type="primary" @click="submitApp">保存</el-button></template>
  </el-dialog>
  <el-dialog v-model="collectKeyDialog" title="新采集密钥" width="620px"><el-alert type="warning" title="该密钥仅显示一次，请立即复制到 SDK collectKey 配置。" :closable="false" /><el-input :model-value="newCollectKey" readonly style="margin-top:12px" /></el-dialog>

  <el-dialog v-model="releaseDialog" :title="`${activeAppId} 版本管理`" width="620px">
    <el-form inline @submit.prevent="submitRelease">
      <el-form-item label="版本"><el-input v-model="releaseForm.release" placeholder="例如 1.2.0" /></el-form-item>
      <el-form-item label="状态"><el-select v-model="releaseForm.status" style="width: 120px"><el-option label="active" value="active" /><el-option label="archived" value="archived" /></el-select></el-form-item>
      <el-form-item><el-button type="primary" @click="submitRelease">添加</el-button></el-form-item>
    </el-form>
    <el-alert v-if="releaseError" class="table-error" type="error" :title="releaseError" show-icon :closable="false"><template #default><el-button link type="primary" @click="loadReleasePage">重试</el-button></template></el-alert>
    <el-table :data="releases" border v-loading="releaseLoading" empty-text="暂无版本数据">
      <el-table-column label="版本" min-width="180"><template #default="{ row }">{{ row.release_name || row.release || '-' }}</template></el-table-column>
      <el-table-column label="状态" width="120"><template #default="{ row }">{{ row.status || '-' }}</template></el-table-column>
      <el-table-column label="首次上报时间" width="200" cell-class-name="time-cell"><template #default="{ row }">{{ formatDate(row.created_at ?? row.createdAt) }}</template></el-table-column>
      <el-table-column label="操作" width="80"><template #default="{ row }"><el-button link type="danger" @click="removeRelease(row)">删除</el-button></template></el-table-column>
    </el-table>
    <el-pagination class="pager" background layout="sizes, prev, pager, next, total" :current-page="releasePager.page" :page-size="releasePager.pageSize" :page-sizes="[10, 20, 50, 100]" :total="releasePager.total" @current-change="value => { releasePager.page = value; loadReleasePage() }" @size-change="value => { releasePager.page = 1; releasePager.pageSize = value; loadReleasePage() }" />
  </el-dialog>
</template>

<style scoped>
.table-error { margin-bottom: 12px; }
</style>
