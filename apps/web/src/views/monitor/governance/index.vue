<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { deleteApplication, deleteRelease, downloadReport, loadGovernance, loadReleases, rotateCollectKey, runCleanup, saveApplication, saveGovernanceSettings, saveRelease } from '../../../dashboard.js'

const loading = ref(false)
const exporting = ref('')
const applications = ref([])
const alerts = ref([])
const appPager = reactive({ page: 1, pageSize: 10, total: 0 })
const alertPager = reactive({ page: 1, pageSize: 10, total: 0 })
const settings = reactive({ retention: {}, alerts: {} })
const appDialog = ref(false)
const releaseDialog = ref(false)
const activeAppId = ref('')
const releases = ref([])
const releasePager = reactive({ page: 1, pageSize: 10, total: 0 })
const releaseForm = reactive({ release: '', status: 'active' })
const appForm = reactive({ appId: '', name: '', platform: 'web', owner: '', enabled: true, sampleRate: 1, replaySampleRate: 1, allowedOrigins: '', blockedTypes: '', blockedNames: '' })
const newCollectKey = ref('')

async function load() {
  loading.value = true
  try {
    const data = await loadGovernance({ alertPage: alertPager.page, alertPageSize: alertPager.pageSize, appPage: appPager.page, appPageSize: appPager.pageSize })
    applications.value = data.applications.items
    Object.assign(appPager, { page: data.applications.page, pageSize: data.applications.pageSize, total: data.applications.total })
    alerts.value = data.alerts.items
    Object.assign(alertPager, { page: data.alerts.page, pageSize: data.alerts.pageSize, total: data.alerts.total })
    Object.assign(settings.retention, data.settings.retention)
    Object.assign(settings.alerts, data.settings.alerts)
  } finally { loading.value = false }
}

function editApp(row = {}) {
  Object.assign(appForm, {
    appId: row.app_id || '', name: row.name || '', platform: row.platform || 'web', owner: row.owner || '', enabled: row.enabled ?? true,
    sampleRate: Number(row.sample_rate ?? 1), replaySampleRate: Number(row.replay_sample_rate ?? 1),
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
  const confirmed = await ElMessageBox.confirm(`确定删除应用“${row.name}”吗？版本配置会一并删除，已采集数据仍会保留；SDK 继续上报时应用会重新出现。`, '删除应用', { type: 'warning' }).then(() => true).catch(() => false)
  if (!confirmed) return
  await deleteApplication(row.app_id)
  ElMessage.success('应用已删除')
  if (applications.value.length === 1 && appPager.page > 1) appPager.page--
  await load()
}
function lines(value) { return String(value || '').split(/[,\n]/).map(item => item.trim()).filter(Boolean) }
async function resetKey(row) { newCollectKey.value = (await rotateCollectKey(row.app_id)).collectKey }

async function submitSettings() {
  await saveGovernanceSettings(settings)
  ElMessage.success('治理策略已保存')
  await load()
}

async function openReleases(row) {
  activeAppId.value = row.app_id
  releasePager.page = 1
  await loadReleasePage()
  releaseDialog.value = true
}

async function loadReleasePage() {
  const data = await loadReleases(activeAppId.value, releasePager.page, releasePager.pageSize)
  releases.value = data.items
  Object.assign(releasePager, { page: data.page, pageSize: data.pageSize, total: data.total })
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
  const confirmed = await ElMessageBox.confirm(`确定删除版本“${row.release_name}”吗？SDK 继续上报该版本时会重新出现。`, '删除版本', { type: 'warning' }).then(() => true).catch(() => false)
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

async function exportReport(kind) {
  exporting.value = kind
  try {
    await downloadReport(kind)
    ElMessage.success('报表已导出')
  } catch (error) {
    ElMessage.error(error.message || '报表导出失败')
  } finally {
    exporting.value = ''
  }
}

onMounted(load)
</script>

<template>
  <div v-loading="loading">
    <el-card shadow="never" class="section panel">
      <template #header><div class="panel-head"><b>应用与采样</b><el-button type="primary" @click="editApp()">新增应用</el-button></div></template>
      <el-table :data="applications" border>
        <el-table-column prop="app_id" label="App ID" min-width="150" />
        <el-table-column prop="name" label="应用名称" min-width="150" />
        <el-table-column prop="platform" label="平台" width="100" />
        <el-table-column prop="owner" label="负责人" min-width="120" />
        <el-table-column label="事件采样率" width="120"><template #default="{ row }">{{ Math.round(row.sample_rate * 100) }}%</template></el-table-column>
        <el-table-column label="回放采样率" width="120"><template #default="{ row }">{{ Math.round(row.replay_sample_rate * 100) }}%</template></el-table-column>
        <el-table-column prop="release_count" label="版本数" width="90" />
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

    <el-card shadow="never" class="section panel">
      <template #header><div class="panel-head"><b>报表与告警记录</b><el-space><el-button :loading="exporting === 'events'" :disabled="Boolean(exporting)" @click="exportReport('events')">导出事件</el-button><el-button :loading="exporting === 'issues'" :disabled="Boolean(exporting)" @click="exportReport('issues')">导出错误</el-button><el-button :loading="exporting === 'replays'" :disabled="Boolean(exporting)" @click="exportReport('replays')">导出回放</el-button></el-space></div></template>
      <el-table :data="alerts" border :tooltip-options="{ appendTo: 'body', teleported: true }">
        <el-table-column prop="created_at" label="时间" width="180"><template #default="{ row }">{{ new Date(Number(row.created_at)).toLocaleString() }}</template></el-table-column>
        <el-table-column prop="app_id" label="应用" width="140" />
        <el-table-column prop="metric" label="指标" width="110" />
        <el-table-column prop="level" label="级别" width="90" />
        <el-table-column prop="message" label="告警内容" min-width="320" show-overflow-tooltip />
        <el-table-column label="通知" width="100"><template #default="{ row }"><el-tag :type="row.notified ? 'success' : 'warning'">{{ row.notified ? '已发送' : '未发送' }}</el-tag></template></el-table-column>
      </el-table>
      <el-pagination class="pager" v-model:current-page="alertPager.page" v-model:page-size="alertPager.pageSize" :total="alertPager.total" layout="total, sizes, prev, pager, next" @change="load" />
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
  <el-dialog v-model="newCollectKey" title="新采集密钥" width="620px"><el-alert type="warning" title="该密钥仅显示一次，请立即复制到 SDK collectKey 配置。" :closable="false" /><el-input :model-value="newCollectKey" readonly style="margin-top:12px" /></el-dialog>

  <el-dialog v-model="releaseDialog" :title="`${activeAppId} 版本管理`" width="620px">
    <el-form inline @submit.prevent="submitRelease">
      <el-form-item label="版本"><el-input v-model="releaseForm.release" placeholder="例如 1.2.0" /></el-form-item>
      <el-form-item label="状态"><el-select v-model="releaseForm.status" style="width: 120px"><el-option label="active" value="active" /><el-option label="archived" value="archived" /></el-select></el-form-item>
      <el-form-item><el-button type="primary" @click="submitRelease">添加</el-button></el-form-item>
    </el-form>
    <el-table :data="releases" border>
      <el-table-column prop="release_name" label="版本" min-width="180" />
      <el-table-column prop="status" label="状态" width="120" />
      <el-table-column label="首次上报时间" width="190"><template #default="{ row }">{{ new Date(Number(row.created_at)).toLocaleString() }}</template></el-table-column>
      <el-table-column label="操作" width="80"><template #default="{ row }"><el-button link type="danger" @click="removeRelease(row)">删除</el-button></template></el-table-column>
    </el-table>
    <el-pagination class="pager" background layout="sizes, prev, pager, next, total" :current-page="releasePager.page" :page-size="releasePager.pageSize" :page-sizes="[10, 20, 50, 100]" :total="releasePager.total" @current-change="value => { releasePager.page = value; loadReleasePage() }" @size-change="value => { releasePager.page = 1; releasePager.pageSize = value; loadReleasePage() }" />
  </el-dialog>
</template>
