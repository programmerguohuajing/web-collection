<script setup>
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, normalizePageResponse, queryFromFilters, deleteAlertChannel, saveAlertChannel, testAlertChannel, pageLoading, toList } from '../dashboard.js'
import { buildAlertChannelPayload, channelEndpointStatus, channelFilters, channelScope, createAlertChannelForm } from '../alert-channels.js'
import KpiGrid from '../components/KpiGrid.vue'
import OverflowTip from '../components/OverflowTip.vue'
import TemplateEditor from '../components/TemplateEditor.vue'
import { levelLabel, levelTagType, metricLabel, metricTagType } from '../utils/format.js'
import { channelMessageTypes, variablesForChannel } from '../../../../packages/alert-templates.js'

const router = useRouter()
const rows = ref([])
const pager = reactive({ page: 1, pageSize: 20, total: 0 })
const query = reactive({ level: '', status: '', metric: '', keyword: '' })
const channels = ref([])
const applications = ref([])
const channelDialog = ref(false)
const channelSaving = ref(false)
const channelTestingId = ref(null)
const channelForm = reactive(createAlertChannelForm())
const alertsLoading = ref(false)
const alertsError = ref('')
const channelsLoading = ref(false)
const alertKpis = computed(() => [
  { label: '今日告警', value: Number(pager.total || rows.value.length).toLocaleString(), delta: '当前筛选范围', valueClass: 'value-danger' },
  { label: '已触达', value: rows.value.filter(row => row.notified).length.toLocaleString(), delta: '通知已发送', valueClass: 'value-success' },
  { label: '告警规则', value: channels.value.length.toLocaleString(), delta: '启用中的通知渠道', valueClass: 'value-primary' },
  { label: '未发送', value: rows.value.filter(row => !row.notified).length.toLocaleString(), delta: '待重试', valueClass: 'value-purple' }
])
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

async function loadApplications() {
  try {
    const data = await api('/api/applications', { requestKey: 'alerts:applications' })
    applications.value = normalizePageResponse(data).items.map(item => ({
      appId: item.app_id || item.appId || '',
      name: item.name || item.appName || item.app_id || item.appId || '-'
    }))
  } catch {
    applications.value = []
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
  return { email: '邮件', webhook: 'Webhook', sms: '短信', dingtalk: '钉钉', feishu: '飞书', feishu_app: '飞书智能体', wecom: '企业微信' }[type] || type
}

const channelVars = computed(() => variablesForChannel(channelForm.type))
const messageTypeOptions = computed(() => {
  const opts = channelMessageTypes[channelForm.type] || ['text']
  const labels = { text: '文本', interactive: '飞书卡片', markdown: 'Markdown', json: 'JSON', sms: '短信' }
  return opts.map(t => ({ value: t, label: labels[t] || t }))
})
const showMessageTypeSelect = computed(() => ['feishu', 'feishu_app', 'dingtalk'].includes(channelForm.type))
const showMessageTemplate = computed(() => ['feishu', 'feishu_app', 'wecom', 'dingtalk'].includes(channelForm.type))
const showDingtalkTitle = computed(() => channelForm.type === 'dingtalk' && channelForm.messageType === 'markdown')
const showEmailSubject = computed(() => channelForm.type === 'email')
const showHttpAdvanced = computed(() => ['webhook', 'email'].includes(channelForm.type))
const showSmsTemplate = computed(() => channelForm.type === 'sms')
const tplMode = computed(() => {
  if ((channelForm.type === 'feishu' || channelForm.type === 'feishu_app') && channelForm.messageType === 'interactive') return 'json'
  if (channelForm.type === 'webhook') return 'json'
  return 'text'
})
const messagePlaceholder = computed(() => {
  if (tplMode.value === 'json') return '卡片 JSON，例如 {"elements":[{"tag":"div","text":{"content":"${message}"}}]}'
  return '消息内容，例如 【${level}】${message}'
})

onMounted(() => { load(); loadChannels(); loadApplications() })
</script>

<template>
  <KpiGrid :items="alertKpis" />

  <el-card shadow="never" class="section panel">
    <template #header>
      <div class="panel-head">
        <div><b>告警记录</b><small style="margin-left:8px">共 {{ pager.total || rows.length }} 条</small></div>
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
      <el-table-column label="时间" width="200" cell-class-name="time-cell"><template #default="{ row }">{{ new Date(Number(row.created_at)).toLocaleString() }}</template></el-table-column>
      <el-table-column label="应用" width="140"><template #default="{ row }"><OverflowTip :text="row.app_id" /></template></el-table-column>
      <el-table-column label="指标" width="100">
        <template #default="{ row }">
          <el-tag :type="metricTagType(row.metric)" size="small">{{ metricLabel(row.metric) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="级别" width="90"><template #default="{ row }"><el-tag :type="levelTagType(row.level)" size="small">{{ levelLabel(row.level) }}</el-tag></template></el-table-column>
      <el-table-column label="告警内容" min-width="280">
        <template #default="{ row }">
          <OverflowTip :text="row.message" />
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
      <el-table-column label="名称" min-width="160"><template #default="{ row }"><OverflowTip :text="row.name" /></template></el-table-column>
      <el-table-column label="类型" width="110"><template #default="{ row }">{{ channelTypeLabel(row.type) }}</template></el-table-column>
      <el-table-column label="服务地址" min-width="130"><template #default="{ row }"><el-tag :type="row.configured ? 'success' : 'danger'" size="small">{{ channelEndpointStatus(row) }}</el-tag></template></el-table-column>
      <el-table-column label="接收人" min-width="180"><template #default="{ row }"><OverflowTip :text="row.config?.recipients || '-'" /></template></el-table-column>
      <el-table-column label="应用范围" width="160"><template #default="{ row }"><OverflowTip :text="channelScope(row)" /></template></el-table-column>
      <el-table-column label="级别" width="180"><template #default="{ row }"><OverflowTip :text="channelFilters(row.levels)" /></template></el-table-column>
      <el-table-column label="指标" width="220"><template #default="{ row }"><OverflowTip :text="channelFilters(row.metrics)" /></template></el-table-column>
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

  <el-dialog v-model="channelDialog" :title="channelForm.id ? '编辑渠道' : '新增渠道'" width="min(760px, calc(100vw - 32px))" :loading="channelSaving">
    <el-form :model="channelForm" label-width="130px">
      <el-form-item label="名称"><el-input v-model="channelForm.name" /></el-form-item>
      <el-form-item label="类型"><el-select v-model="channelForm.type" style="width:100%"><el-option v-for="t in ['email','webhook','sms','dingtalk','feishu','feishu_app','wecom']" :key="t" :label="channelTypeLabel(t)" :value="t" /></el-select></el-form-item>
      <el-form-item v-if="channelForm.type !== 'feishu_app'" label="服务地址" required>
        <el-input v-model="channelForm.endpoint" :placeholder="channelForm.endpointConfigured ? '已加密保存；留空表示不修改' : 'https://provider.example.com/webhook'" />
      </el-form-item>
      <template v-if="channelForm.type === 'feishu_app'">
        <el-form-item label="App ID"><el-input v-model="channelForm.appId" placeholder="飞书开放平台应用的 App ID" /></el-form-item>
        <el-form-item label="App Secret" required>
          <el-input v-model="channelForm.appSecret" type="password" show-password :placeholder="channelForm.endpointConfigured ? '留空表示不修改' : '飞书开放平台应用的 App Secret'" />
        </el-form-item>
        <el-form-item label="目标群/用户 ID" required>
          <el-input v-model="channelForm.chatId" placeholder="群 ID（oc_xxxx）或用户 open_id / user_id" />
        </el-form-item>
        <el-form-item label="发送范围">
          <el-select v-model="channelForm.receiveIdType" style="width:100%">
            <el-option label="群（chat_id）" value="chat_id" />
            <el-option label="用户 open_id" value="open_id" />
            <el-option label="用户 user_id" value="user_id" />
            <el-option label="用户 union_id" value="union_id" />
          </el-select>
        </el-form-item>
        <el-alert type="info" :closable="false" show-icon title="需先把该应用机器人加入目标群并发布版本">
          <template #default>智能体/应用机器人需在飞书开放平台开启「机器人」能力并发布，且在目标群内有发言权限、已申请 im:message 权限。</template>
        </el-alert>
      </template>
      <el-form-item v-if="channelForm.type === 'email' || channelForm.type === 'sms'" label="接收人" required>
        <el-input v-model="channelForm.recipients" :placeholder="channelForm.type === 'email' ? '多个邮箱以逗号分隔' : '多个手机号以逗号分隔'" />
      </el-form-item>
      <el-form-item label="应用 App ID">
        <el-select v-model="channelForm.appIds" multiple filterable allow-create default-first-option style="width:100%" placeholder="留空则匹配全部应用">
          <el-option v-for="app in applications" :key="app.appId" :label="app.name === '-' ? app.appId : `${app.name}（${app.appId}）`" :value="app.appId" />
        </el-select>
      </el-form-item>
      <el-form-item label="告警级别"><el-select v-model="channelForm.levels" multiple style="width:100%"><el-option label="警告" value="warning" /><el-option label="错误" value="error" /><el-option label="严重" value="critical" /></el-select></el-form-item>
      <el-form-item label="指标"><el-select v-model="channelForm.metrics" multiple style="width:100%"><el-option v-for="metric in ['error','log_error','regression','lcp','inp','cls','longtask']" :key="metric" :label="metricLabel(metric)" :value="metric" /></el-select></el-form-item>
      <el-form-item label="启用"><el-switch v-model="channelForm.enabled" /></el-form-item>
      <el-form-item v-if="showMessageTypeSelect" label="消息类型">
        <el-select v-model="channelForm.messageType" style="width:100%">
          <el-option v-for="opt in messageTypeOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="showDingtalkTitle" label="消息标题">
        <el-input v-model="channelForm.titleTemplate" placeholder="支持变量，如 【${level}】告警通知" />
      </el-form-item>
      <el-form-item v-if="showEmailSubject" label="邮件主题">
        <el-input v-model="channelForm.subjectTemplate" placeholder="支持变量，如 【${level}】${message}" />
      </el-form-item>
      <el-form-item v-if="showMessageTemplate" label="消息模板">
        <TemplateEditor v-model="channelForm.messageTemplate" :mode="tplMode" :variables="channelVars" :placeholder="messagePlaceholder" :min-height="140" />
      </el-form-item>
      <template v-if="showHttpAdvanced">
        <el-form-item label="请求方法"><el-select v-model="channelForm.method" style="width:100%"><el-option v-for="method in ['POST','PUT','PATCH']" :key="method" :label="method" :value="method" /></el-select></el-form-item>
        <el-form-item label="认证方式"><el-select v-model="channelForm.authType" style="width:100%"><el-option label="无" value="none" /><el-option label="Bearer Token" value="bearer" /><el-option label="Basic Auth" value="basic" /></el-select></el-form-item>
        <el-form-item v-if="channelForm.authType === 'bearer'" label="Token"><el-input v-model="channelForm.token" type="password" show-password :placeholder="channelForm.endpointConfigured ? '留空表示不修改' : ''" /></el-form-item>
        <template v-if="channelForm.authType === 'basic'">
          <el-form-item label="用户名"><el-input v-model="channelForm.username" :placeholder="channelForm.endpointConfigured ? '留空表示不修改' : ''" /></el-form-item>
          <el-form-item label="密码"><el-input v-model="channelForm.password" type="password" show-password :placeholder="channelForm.endpointConfigured ? '留空表示不修改' : ''" /></el-form-item>
        </template>
        <el-form-item label="Headers"><el-input v-model="channelForm.headers" type="textarea" :rows="3" placeholder="每行一条，敏感值请使用 ${secret.token}" /></el-form-item>
        <el-form-item label="请求体模板">
          <TemplateEditor v-model="channelForm.bodyTemplate" mode="json" :variables="channelVars" placeholder='可选 JSON，例如 {"text":"${message}"}' :min-height="120" />
        </el-form-item>
      </template>
      <el-form-item v-if="showSmsTemplate" label="模板 ID"><el-input v-model="channelForm.templateId" /></el-form-item>
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
