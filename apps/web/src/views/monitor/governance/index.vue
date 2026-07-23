<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { deleteAlertChannel, deleteApplication, deleteRelease, downloadReport, loadAlertDeliveries, loadGovernance, loadReleases, retryAlertDelivery, rotateCollectKey, runCleanup, saveAlertChannel, saveApplication, saveGovernanceSettings, saveRelease, testAlertChannel } from '../../../dashboard.js'

const loading = ref(false)
const exporting = ref('')
const applications = ref([])
const applicationOptions = ref([])
const alerts = ref([])
const channels = ref([])
const appPager = reactive({ page: 1, pageSize: 10, total: 0 })
const alertPager = reactive({ page: 1, pageSize: 10, total: 0 })
const channelPager = reactive({ page: 1, pageSize: 10, total: 0 })
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
const channelDialog = ref(false)
const channelSaving = ref(false)
const channelTesting = ref(0)
const deliveriesByAlert = reactive({})
const deliveryLoading = reactive({})
const channelForm = reactive(emptyChannel())
const channelTypeOptions = [
  ['email', '邮件'], ['sms', '短信'], ['feishu', '飞书'], ['wecom', '企业微信'], ['dingtalk', '钉钉'], ['webhook', '通用 Webhook']
]
const levelOptions = [['warning', '警告'], ['error', '错误'], ['critical', '严重']]
const metricOptions = [['error', '错误'], ['log_error', 'Error 日志'], ['regression', '回归'], ['lcp', 'LCP'], ['inp', 'INP'], ['cls', 'CLS'], ['longtask', '长任务']]

async function load() {
  loading.value = true
  try {
    const data = await loadGovernance({
      alertPage: alertPager.page, alertPageSize: alertPager.pageSize,
      appPage: appPager.page, appPageSize: appPager.pageSize,
      channelPage: channelPager.page, channelPageSize: channelPager.pageSize
    })
    applications.value = data.applications.items
    applicationOptions.value = data.applicationOptions
    Object.assign(appPager, { page: data.applications.page, pageSize: data.applications.pageSize, total: data.applications.total })
    alerts.value = data.alerts.items
    Object.assign(alertPager, { page: data.alerts.page, pageSize: data.alerts.pageSize, total: data.alerts.total })
    channels.value = data.channels.items
    Object.assign(channelPager, { page: data.channels.page, pageSize: data.channels.pageSize, total: data.channels.total })
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
async function resetKey(row) {
  collectKeyDialog.value = false
  newCollectKey.value = ''
  try {
    newCollectKey.value = (await rotateCollectKey(row.app_id)).collectKey
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

function emptyChannel() {
  return {
    id: null, name: '', type: 'feishu', enabled: true, endpoint: '', configured: false,
    appIds: [], levels: [], metrics: [],
    method: 'POST', authType: 'none', headersText: '{}', bodyTemplate: '',
    recipients: '', subject: 'Web Collection 告警', templateId: '',
    token: '', username: '', password: '', secretsText: '{}'
  }
}

function editChannel(row = {}) {
  const config = row.config || {}
  Object.assign(channelForm, emptyChannel(), {
    id: row.id || null,
    name: row.name || '',
    type: row.type || 'feishu',
    enabled: row.enabled ?? true,
    configured: Boolean(row.configured),
    appIds: [...(row.appIds || [])],
    levels: [...(row.levels || [])],
    metrics: [...(row.metrics || [])],
    method: config.method || 'POST',
    authType: config.authType || 'none',
    headersText: JSON.stringify(config.headers || {}, null, 2),
    bodyTemplate: config.bodyTemplate || '',
    recipients: config.recipients || '',
    subject: config.subject || 'Web Collection 告警',
    templateId: config.templateId || ''
  })
  channelDialog.value = true
}

async function submitChannel() {
  if (!channelForm.name.trim()) return ElMessage.warning('请输入渠道名称')
  if (!channelForm.endpoint.trim() && !channelForm.configured) return ElMessage.warning('请输入 HTTPS 渠道地址')
  let headers, extraSecrets
  try {
    headers = JSON.parse(channelForm.headersText || '{}')
    extraSecrets = JSON.parse(channelForm.secretsText || '{}')
    if (channelForm.bodyTemplate) JSON.parse(channelForm.bodyTemplate)
    if (!extraSecrets || Array.isArray(extraSecrets) || typeof extraSecrets !== 'object') throw new Error()
  } catch {
    return ElMessage.warning('请求头、请求体模板和附加密钥必须是有效 JSON')
  }
  channelSaving.value = true
  try {
    const secrets = { ...extraSecrets, ...Object.fromEntries(Object.entries({
      url: channelForm.endpoint.trim(), token: channelForm.token.trim(),
      username: channelForm.username.trim(), password: channelForm.password
    }).filter(([, value]) => value)) }
    await saveAlertChannel({
      id: channelForm.id, name: channelForm.name, type: channelForm.type, enabled: channelForm.enabled,
      appIds: channelForm.appIds, levels: channelForm.levels, metrics: channelForm.metrics,
      config: {
        method: channelForm.method, authType: channelForm.authType, headers,
        bodyTemplate: channelForm.bodyTemplate, recipients: channelForm.recipients,
        subject: channelForm.subject, templateId: channelForm.templateId
      },
      secrets
    })
    channelDialog.value = false
    channelPager.page = 1
    ElMessage.success('告警渠道已保存')
    await load()
  } catch (error) {
    ElMessage.error(error.message || '告警渠道保存失败')
  } finally {
    channelSaving.value = false
  }
}

async function toggleChannel(row) {
  try {
    await saveAlertChannel({ ...row, enabled: row.enabled, secrets: {} })
    ElMessage.success(row.enabled ? '渠道已启用' : '渠道已停用')
  } catch (error) {
    row.enabled = !row.enabled
    ElMessage.error(error.message || '渠道状态更新失败')
  }
}

async function removeChannel(row) {
  const confirmed = await ElMessageBox.confirm(`确定删除告警渠道“${row.name}”吗？未完成的投递会被取消。`, '删除渠道', { type: 'warning' }).then(() => true).catch(() => false)
  if (!confirmed) return
  await deleteAlertChannel(row.id)
  if (channels.value.length === 1 && channelPager.page > 1) channelPager.page--
  ElMessage.success('告警渠道已删除')
  await load()
}

async function testChannel(row) {
  channelTesting.value = row.id
  try {
    await testAlertChannel(row.id)
    ElMessage.success('测试告警发送成功')
    await load()
  } catch (error) {
    ElMessage.error(error.message || '测试发送失败')
    await load()
  } finally {
    channelTesting.value = 0
  }
}

async function loadDeliveryDetails(row, expandedRows) {
  if (!expandedRows.some(item => item.id === row.id) || deliveriesByAlert[row.id]) return
  deliveryLoading[row.id] = true
  try { deliveriesByAlert[row.id] = await loadAlertDeliveries(row.id, 1, 100) } finally { deliveryLoading[row.id] = false }
}

async function retryDelivery(row) {
  try {
    await retryAlertDelivery(row.id)
    delete deliveriesByAlert[row.alert_id]
    const alert = alerts.value.find(item => Number(item.id) === Number(row.alert_id))
    if (alert) await loadDeliveryDetails(alert, [alert])
    ElMessage.success('已重新提交投递')
    await load()
  } catch (error) {
    ElMessage.error(error.message || '重试失败')
  }
}

function channelTypeLabel(value) { return Object.fromEntries(channelTypeOptions)[value] || value }
function routeLabel(row) {
  const apps = row.appIds?.length ? row.appIds.join('、') : '全部应用'
  const levels = row.levels?.length ? row.levels.join('、') : '全部级别'
  const metrics = row.metrics?.length ? row.metrics.join('、') : '全部指标'
  return `${apps} / ${levels} / ${metrics}`
}
function alertDeliveryLabel(row) {
  const total = Number(row.delivery_total || 0), sent = Number(row.delivery_sent || 0), failed = Number(row.delivery_failed || 0), pending = Number(row.delivery_pending || 0)
  if (!total) return row.notified ? '已发送' : '无匹配渠道'
  if (pending) return sent ? '部分发送' : '待发送'
  if (sent === total) return '全部成功'
  if (sent) return '部分成功'
  if (failed) return '全部失败'
  return '未发送'
}
function alertDeliveryType(row) {
  const label = alertDeliveryLabel(row)
  return label === '全部成功' || label === '已发送' ? 'success' : label === '全部失败' ? 'danger' : 'warning'
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
      <template #header><div class="panel-head"><b>告警渠道</b><el-button type="primary" @click="editChannel()">新增渠道</el-button></div></template>
      <el-table :data="channels" border>
        <el-table-column prop="name" label="渠道名称" min-width="150" />
        <el-table-column label="类型" width="120"><template #default="{ row }">{{ channelTypeLabel(row.type) }}</template></el-table-column>
        <el-table-column label="路由范围" min-width="300" show-overflow-tooltip><template #default="{ row }">{{ routeLabel(row) }}</template></el-table-column>
        <el-table-column label="密钥" width="90"><template #default="{ row }"><el-tag :type="row.configured ? 'success' : 'warning'">{{ row.configured ? '已配置' : '未配置' }}</el-tag></template></el-table-column>
        <el-table-column label="最近测试" width="180">
          <template #default="{ row }">
            <el-tooltip v-if="row.lastTestError" :content="row.lastTestError" placement="top">
              <el-tag type="danger">失败</el-tag>
            </el-tooltip>
            <el-tag v-else-if="row.lastTestStatus === 'sent'" type="success">成功</el-tag>
            <span v-else>-</span>
            <small v-if="row.lastTestAt" style="margin-left:6px">{{ new Date(row.lastTestAt).toLocaleString() }}</small>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90"><template #default="{ row }"><el-switch v-model="row.enabled" @change="toggleChannel(row)" /></template></el-table-column>
        <el-table-column label="操作" width="210">
          <template #default="{ row }">
            <el-button link type="primary" @click="editChannel(row)">编辑</el-button>
            <el-button link type="primary" :loading="channelTesting === row.id" @click="testChannel(row)">测试</el-button>
            <el-button link type="danger" @click="removeChannel(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination class="pager" background layout="sizes, prev, pager, next, total" :current-page="channelPager.page" :page-size="channelPager.pageSize" :page-sizes="[10, 20, 50, 100]" :total="channelPager.total" @current-change="value => { channelPager.page = value; load() }" @size-change="value => { channelPager.page = 1; channelPager.pageSize = value; load() }" />
    </el-card>

    <el-card shadow="never" class="section panel">
      <template #header><div class="panel-head"><b>报表与告警记录</b><el-space><el-button :loading="exporting === 'events'" :disabled="Boolean(exporting)" @click="exportReport('events')">导出事件</el-button><el-button :loading="exporting === 'issues'" :disabled="Boolean(exporting)" @click="exportReport('issues')">导出错误</el-button><el-button :loading="exporting === 'replays'" :disabled="Boolean(exporting)" @click="exportReport('replays')">导出回放</el-button></el-space></div></template>
      <el-table :data="alerts" border :tooltip-options="{ appendTo: 'body', teleported: true }" @expand-change="loadDeliveryDetails">
        <el-table-column type="expand" width="48">
          <template #default="{ row }">
            <div v-loading="deliveryLoading[row.id]" style="padding:12px 24px">
              <el-table :data="deliveriesByAlert[row.id]?.items || []" border size="small">
                <el-table-column prop="channel_name" label="渠道" min-width="140" />
                <el-table-column label="类型" width="110"><template #default="{ row: item }">{{ channelTypeLabel(item.channel_type) }}</template></el-table-column>
                <el-table-column prop="status" label="状态" width="100" />
                <el-table-column prop="attempts" label="尝试次数" width="90" />
                <el-table-column prop="last_error" label="失败原因" min-width="260" show-overflow-tooltip />
                <el-table-column label="发送时间" width="180"><template #default="{ row: item }">{{ item.sent_at ? new Date(Number(item.sent_at)).toLocaleString() : '-' }}</template></el-table-column>
                <el-table-column label="操作" width="80"><template #default="{ row: item }"><el-button v-if="['failed','dead'].includes(item.status)" link type="primary" @click="retryDelivery(item)">重试</el-button></template></el-table-column>
              </el-table>
              <el-empty v-if="!deliveryLoading[row.id] && !deliveriesByAlert[row.id]?.items?.length" description="该告警没有渠道投递记录" :image-size="60" />
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="created_at" label="时间" width="180"><template #default="{ row }">{{ new Date(Number(row.created_at)).toLocaleString() }}</template></el-table-column>
        <el-table-column prop="app_id" label="应用" width="140" />
        <el-table-column prop="metric" label="指标" width="110" />
        <el-table-column prop="level" label="级别" width="90" />
        <el-table-column prop="message" label="告警内容" min-width="320" show-overflow-tooltip />
        <el-table-column label="通知" width="110"><template #default="{ row }"><el-tag :type="alertDeliveryType(row)">{{ alertDeliveryLabel(row) }}</el-tag></template></el-table-column>
      </el-table>
      <el-pagination class="pager" v-model:current-page="alertPager.page" v-model:page-size="alertPager.pageSize" :total="alertPager.total" layout="total, sizes, prev, pager, next" @change="load" />
    </el-card>
  </div>

  <el-dialog v-model="channelDialog" :title="channelForm.id ? '编辑告警渠道' : '新增告警渠道'" width="760px">
    <el-form :model="channelForm" label-width="120px">
      <el-form-item label="渠道名称"><el-input v-model="channelForm.name" maxlength="128" /></el-form-item>
      <el-form-item label="渠道类型"><el-select v-model="channelForm.type" style="width:100%"><el-option v-for="item in channelTypeOptions" :key="item[0]" :label="item[1]" :value="item[0]" /></el-select></el-form-item>
      <el-form-item label="HTTPS 地址">
        <el-input v-model="channelForm.endpoint" type="password" show-password :placeholder="channelForm.configured ? '已配置；留空保持原值' : 'https://...'" />
      </el-form-item>
      <el-form-item label="应用范围"><el-select v-model="channelForm.appIds" multiple clearable collapse-tags style="width:100%" placeholder="留空表示全部应用"><el-option v-for="app in applicationOptions" :key="app.app_id" :label="`${app.name} (${app.app_id})`" :value="app.app_id" /></el-select></el-form-item>
      <el-form-item label="告警级别"><el-select v-model="channelForm.levels" multiple clearable style="width:100%" placeholder="留空表示全部级别"><el-option v-for="item in levelOptions" :key="item[0]" :label="item[1]" :value="item[0]" /></el-select></el-form-item>
      <el-form-item label="告警指标"><el-select v-model="channelForm.metrics" multiple clearable collapse-tags style="width:100%" placeholder="留空表示全部指标"><el-option v-for="item in metricOptions" :key="item[0]" :label="item[1]" :value="item[0]" /></el-select></el-form-item>
      <el-form-item label="启用"><el-switch v-model="channelForm.enabled" /></el-form-item>
      <template v-if="['email','sms','webhook'].includes(channelForm.type)">
        <el-form-item label="请求方法"><el-select v-model="channelForm.method"><el-option v-for="item in ['POST','PUT','PATCH']" :key="item" :label="item" :value="item" /></el-select></el-form-item>
        <el-form-item label="认证方式"><el-select v-model="channelForm.authType"><el-option label="无" value="none" /><el-option label="Bearer Token" value="bearer" /><el-option label="Basic Auth" value="basic" /></el-select></el-form-item>
        <el-form-item v-if="channelForm.authType === 'bearer'" label="Token"><el-input v-model="channelForm.token" type="password" show-password placeholder="留空保持原值" /></el-form-item>
        <template v-if="channelForm.authType === 'basic'">
          <el-form-item label="用户名"><el-input v-model="channelForm.username" placeholder="留空保持原值" /></el-form-item>
          <el-form-item label="密码"><el-input v-model="channelForm.password" type="password" show-password placeholder="留空保持原值" /></el-form-item>
        </template>
        <el-form-item v-if="['email','sms'].includes(channelForm.type)" label="接收人"><el-input v-model="channelForm.recipients" placeholder="多个接收人按网关要求填写" /></el-form-item>
        <el-form-item v-if="channelForm.type === 'email'" label="邮件主题"><el-input v-model="channelForm.subject" /></el-form-item>
        <el-form-item v-if="channelForm.type === 'sms'" label="模板 ID"><el-input v-model="channelForm.templateId" /></el-form-item>
        <el-form-item label="请求头 JSON"><el-input v-model="channelForm.headersText" type="textarea" :rows="3" placeholder='{"x-api-key":"{{secret.token}}"}' /></el-form-item>
        <el-form-item label="请求体模板">
          <el-input v-model="channelForm.bodyTemplate" type="textarea" :rows="6" placeholder='{"text":"{{message}}","appId":"{{appId}}"}' />
          <small>支持 message、appId、level、metric、value、threshold、page、release、traceId、occurredAt、recipients、subject、templateId，以及 secret.token 等密钥变量。</small>
        </el-form-item>
      </template>
      <el-form-item label="附加密钥 JSON"><el-input v-model="channelForm.secretsText" type="textarea" :rows="3" placeholder='{"apiKey":"仅写入，不回显"}' /><small>保存后不回显；编辑时填写的同名字段会覆盖旧值，其余密钥保持不变。</small></el-form-item>
    </el-form>
    <template #footer><el-button @click="channelDialog=false">取消</el-button><el-button type="primary" :loading="channelSaving" @click="submitChannel">保存</el-button></template>
  </el-dialog>

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
    <el-table :data="releases" border>
      <el-table-column prop="release_name" label="版本" min-width="180" />
      <el-table-column prop="status" label="状态" width="120" />
      <el-table-column label="首次上报时间" width="190"><template #default="{ row }">{{ new Date(Number(row.created_at)).toLocaleString() }}</template></el-table-column>
      <el-table-column label="操作" width="80"><template #default="{ row }"><el-button link type="danger" @click="removeRelease(row)">删除</el-button></template></el-table-column>
    </el-table>
    <el-pagination class="pager" background layout="sizes, prev, pager, next, total" :current-page="releasePager.page" :page-size="releasePager.pageSize" :page-sizes="[10, 20, 50, 100]" :total="releasePager.total" @current-change="value => { releasePager.page = value; loadReleasePage() }" @size-change="value => { releasePager.page = 1; releasePager.pageSize = value; loadReleasePage() }" />
  </el-dialog>
</template>
