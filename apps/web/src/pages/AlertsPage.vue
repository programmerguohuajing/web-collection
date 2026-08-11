<script setup>
import { ElMessage, ElMessageBox } from 'element-plus'
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, normalizePageResponse, queryFromFilters, deleteAlertChannel, saveAlertChannel, testAlertChannel, pageLoading, toList } from '../dashboard.js'
import { buildAlertChannelPayload, channelEndpointStatus, channelFilters, channelScope, createAlertChannelForm } from '../alert-channels.js'

const router = useRouter()
const rows = ref([])
const total = ref(0)
const pager = reactive({ page: 1, pageSize: 20, total: 0 })
const query = reactive({ level: '', status: '', metric: '', keyword: '' })
const channels = ref([])
const channelDialog = ref(false)
const channelSaving = ref(false)
const channelTestingId = ref(null)
const channelForm = reactive(createAlertChannelForm())
const alertsLoading = ref(false)
const alertsError = ref('')
const channelsLoading = ref(false)
let alertsRequestId = 0
let channelsRequestId = 0

async function load() {
  const requestId = ++alertsRequestId
  alertsLoading.value = true
  alertsError.value = ''
  pageLoading.value = true
  try {
    const suffix = queryFromFilters({ ...query, page: pager.page, pageSize: pager.pageSize })
    const data = await api(`/api/alerts?${suffix}`, { requestKey: 'alerts:list' })
    if (requestId !== alertsRequestId) return
    const normalized = normalizePageResponse(data, pager)
    rows.value = normalized.items
    Object.assign(pager, normalized)
  } catch (error) {
    if (requestId === alertsRequestId && error?.code !== 'ABORT_ERR') {
      rows.value = []
      Object.assign(pager, { total: 0 })
      alertsError.value = error.message || '告警记录加载失败'
    }
  } finally {
    if (requestId === alertsRequestId) {
      alertsLoading.value = false
      pageLoading.value = false
    }
  }
}

async function loadChannels() {
  const requestId = ++channelsRequestId
  channelsLoading.value = true
  try {
    const data = await api('/api/alert-channels', { requestKey: 'alerts:channels' })
    if (requestId === channelsRequestId) channels.value = toList(data)
  } catch {
    if (requestId === channelsRequestId) channels.value = []
  } finally {
    if (requestId === channelsRequestId) channelsLoading.value = false
  }
}

async function acknowledge(row) {
  try {
    await api(`/api/alerts/${row.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'acknowledged' }) })
    row.status = 'acknowledged'
  } catch (e) { ElMessage.error(e.message || '操作失败') }
}
async function resolve(row) {
  try {
    await api(`/api/alerts/${row.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'resolved' }) })
    row.status = 'resolved'
  } catch (e) { ElMessage.error(e.message || '操作失败') }
}
async function dismiss(row) {
  const confirmed = await ElMessageBox.confirm('确定关闭此告警吗？', '确认', { type: 'warning' }).then(() => true).catch(() => false)
  if (!confirmed) return
  try {
    await api(`/api/alerts/${row.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'dismissed' }) })
    row.status = 'dismissed'
  } catch (e) { ElMessage.error(e.message || '操作失败') }
}

async function viewDetail(row) {
  if (row.trace_id) router.push({ path: '/traces', query: { traceId: row.trace_id } })
  else if (row.url) router.push({ path: '/errors', query: { path: row.url } })
  else ElMessage.info('该告警无关联的链路追踪或错误页面')
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

// --- 告警渠道 ---
async function editChannel(row = {}) {
  Object.assign(channelForm, createAlertChannelForm(row))
  channelDialog.value = true
}
async function submitChannel() {
  channelSaving.value = true
  try {
    await saveAlertChannel(buildAlertChannelPayload(channelForm))
    ElMessage.success(channelForm.id ? '渠道已更新' : '渠道已添加')
    channelDialog.value = false
    await loadChannels()
  } catch (error) {
    ElMessage.error(error.message || '渠道保存失败')
  } finally { channelSaving.value = false }
}
async function toggleChannel(row) {
  try {
    await saveAlertChannel({ ...row, enabled: !row.enabled })
    row.enabled = !row.enabled
  } catch (error) {
    ElMessage.error(error.message || '渠道状态更新失败')
  }
}
async function removeChannel(row) {
  const confirmed = await ElMessageBox.confirm(`确定删除渠道"${row.name}"吗？`, '确认', { type: 'warning' }).then(() => true).catch(() => false)
  if (!confirmed) return
  await deleteAlertChannel(row.id)
  ElMessage.success('渠道已删除')
  loadChannels()
}
async function testChannel(row) {
  channelTestingId.value = row.id
  try {
    await testAlertChannel(row.id)
    ElMessage.success('测试消息已发送')
    await loadChannels()
  } catch (error) {
    ElMessage.error(error.message || '测试消息发送失败')
  } finally { channelTestingId.value = null }
}
function channelTypeLabel(type) {
  return { email: '邮件', webhook: 'Webhook', sms: '短信', dingtalk: '钉钉', feishu: '飞书', wecom: '企业微信' }[type] || type
}

onMounted(() => { load(); loadChannels() })
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

    <el-alert v-if="alertsError" class="table-error" type="error" :title="alertsError" show-icon :closable="false"><template #default><el-button link type="primary" @click="load">重试</el-button></template></el-alert>
    <el-table :data="rows" border v-loading="alertsLoading" empty-text="暂无告警记录">
      <el-table-column label="时间" width="180"><template #default="{ row }">{{ new Date(Number(row.created_at)).toLocaleString() }}</template></el-table-column>
      <el-table-column prop="app_id" label="应用" width="140" />
      <el-table-column label="指标" width="100">
        <template #default="{ row }">
          <el-tag :type="metricType(row.metric)" size="small">{{ metricLabel(row.metric) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="级别" width="90"><template #default="{ row }"><el-tag :type="levelType(row.level)" size="small">{{ row.level }}</el-tag></template></el-table-column>
      <el-table-column label="告警内容" min-width="280" show-overflow-tooltip>
        <template #default="{ row }">
          {{ row.message }}
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
    <el-pagination v-if="pager.total > 0" class="pager" v-model:current-page="pager.page" v-model:page-size="pager.pageSize" :total="pager.total" layout="total, sizes, prev, pager, next" @current-change="onPageChange" @size-change="onPageChange" />
  </el-card>

  <el-card shadow="never" class="section panel">
    <template #header>
      <div class="panel-head">
        <div><b>通知渠道</b></div>
        <el-button type="primary" @click="editChannel()">新增渠道</el-button>
      </div>
    </template>
    <el-table :data="channels" border v-loading="channelsLoading" empty-text="暂无通知渠道">
      <template #empty><el-empty description="暂无渠道" :image-size="60" /></template>
      <el-table-column prop="name" label="名称" min-width="160" />
      <el-table-column label="类型" width="110"><template #default="{ row }">{{ channelTypeLabel(row.type) }}</template></el-table-column>
      <el-table-column label="服务地址" min-width="130"><template #default="{ row }"><el-tag :type="row.configured ? 'success' : 'danger'" size="small">{{ channelEndpointStatus(row) }}</el-tag></template></el-table-column>
      <el-table-column label="接收人" min-width="180" show-overflow-tooltip><template #default="{ row }">{{ row.config?.recipients || '-' }}</template></el-table-column>
      <el-table-column label="应用范围" width="160"><template #default="{ row }">{{ channelScope(row) }}</template></el-table-column>
      <el-table-column label="级别" width="180"><template #default="{ row }">{{ channelFilters(row.levels) }}</template></el-table-column>
      <el-table-column label="指标" width="220"><template #default="{ row }">{{ channelFilters(row.metrics) }}</template></el-table-column>
      <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag :type="row.enabled ? 'success' : 'info'" size="small">{{ row.enabled ? '启用' : '停用' }}</el-tag></template></el-table-column>
      <el-table-column label="操作" width="240" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="editChannel(row)">编辑</el-button>
          <el-button link size="small" @click="testChannel(row)" :loading="channelTestingId === row.id">测试</el-button>
          <el-button link :type="row.enabled ? 'warning' : 'success'" size="small" @click="toggleChannel(row)">{{ row.enabled ? '停用' : '启用' }}</el-button>
          <el-button link type="danger" size="small" @click="removeChannel(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-dialog v-model="channelDialog" :title="channelForm.id ? '编辑渠道' : '新增渠道'" width="560px" :loading="channelSaving">
    <el-form :model="channelForm" label-width="110px">
      <el-form-item label="名称"><el-input v-model="channelForm.name" /></el-form-item>
      <el-form-item label="类型"><el-select v-model="channelForm.type" style="width:100%"><el-option v-for="t in ['email','webhook','sms','dingtalk','feishu','wecom']" :key="t" :label="channelTypeLabel(t)" :value="t" /></el-select></el-form-item>
      <el-form-item label="服务地址" required>
        <el-input v-model="channelForm.endpoint" :placeholder="channelForm.endpointConfigured ? '已加密保存；留空表示不修改' : 'https://provider.example.com/webhook'" />
      </el-form-item>
      <el-form-item v-if="channelForm.type === 'email' || channelForm.type === 'sms'" label="接收人" required>
        <el-input v-model="channelForm.recipients" :placeholder="channelForm.type === 'email' ? '多个邮箱以逗号分隔' : '多个手机号以逗号分隔'" />
      </el-form-item>
      <el-form-item label="应用 App ID"><el-select v-model="channelForm.appIds" multiple filterable allow-create default-first-option style="width:100%" placeholder="留空则匹配全部应用" /></el-form-item>
      <el-form-item label="告警级别"><el-select v-model="channelForm.levels" multiple style="width:100%"><el-option label="警告" value="warning" /><el-option label="错误" value="error" /><el-option label="严重" value="critical" /></el-select></el-form-item>
      <el-form-item label="指标"><el-select v-model="channelForm.metrics" multiple style="width:100%"><el-option v-for="metric in ['error','log_error','regression','lcp','inp','cls','longtask']" :key="metric" :label="metricLabel(metric)" :value="metric" /></el-select></el-form-item>
      <el-form-item label="启用"><el-switch v-model="channelForm.enabled" /></el-form-item>
      <template v-if="channelForm.type === 'webhook'">
        <el-form-item label="请求方法"><el-select v-model="channelForm.method" style="width:100%"><el-option v-for="method in ['POST','PUT','PATCH']" :key="method" :label="method" :value="method" /></el-select></el-form-item>
        <el-form-item label="认证方式"><el-select v-model="channelForm.authType" style="width:100%"><el-option label="无" value="none" /><el-option label="Bearer Token" value="bearer" /><el-option label="Basic Auth" value="basic" /></el-select></el-form-item>
        <el-form-item v-if="channelForm.authType === 'bearer'" label="Token"><el-input v-model="channelForm.token" type="password" show-password :placeholder="channelForm.endpointConfigured ? '留空表示不修改' : ''" /></el-form-item>
        <template v-if="channelForm.authType === 'basic'">
          <el-form-item label="用户名"><el-input v-model="channelForm.username" :placeholder="channelForm.endpointConfigured ? '留空表示不修改' : ''" /></el-form-item>
          <el-form-item label="密码"><el-input v-model="channelForm.password" type="password" show-password :placeholder="channelForm.endpointConfigured ? '留空表示不修改' : ''" /></el-form-item>
        </template>
        <el-form-item label="Headers"><el-input v-model="channelForm.headers" type="textarea" :rows="3" placeholder="每行一条，敏感值请使用 {{secret.token}}" /></el-form-item>
        <el-form-item label="请求体模板"><el-input v-model="channelForm.bodyTemplate" type="textarea" :rows="4" placeholder='可选 JSON，例如 {"text":"{{message}}"}' /></el-form-item>
      </template>
      <el-form-item v-if="channelForm.type === 'email'" label="邮件主题"><el-input v-model="channelForm.subject" /></el-form-item>
      <el-form-item v-if="channelForm.type === 'sms'" label="模板 ID"><el-input v-model="channelForm.templateId" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="channelDialog=false">取消</el-button>
      <el-button type="primary" @click="submitChannel" :loading="channelSaving">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.filter-bar { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; align-items: center; }
.table-error { margin-bottom: 12px; }
</style>
