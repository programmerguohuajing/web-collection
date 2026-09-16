<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRouter } from 'vue-router'
import {
  DocumentCopy,
  InfoFilled,
  Lock,
  Plus,
  QuestionFilled,
  Refresh,
  Right,
  Setting,
  User
} from '@element-plus/icons-vue'
import { api, normalizePageResponse, pageLoading } from '../../../dashboard.js'
import {
  CHANGEABLE_ROLE_OPTIONS,
  LEVEL_LABELS,
  LEVEL_OPTIONS,
  ROLE_LABELS,
  useAuth
} from '../../../composables/useAuth'
import OverflowTip from '../../../components/OverflowTip.vue'

const router = useRouter()
const {
  accountsEnabled,
  authApi,
  currentTeamId,
  isLoggedIn,
  loadMe,
  me,
  switchTeam
} = useAuth()

const activeTab = ref('apps')
const applications = ref([])
const loading = ref(false)
const loadError = ref('')
const dialogOpen = ref(false)
const saving = ref(false)
const form = reactive({ name: '', platform: 'web', endpoint: '', description: '' })
const ingest = reactive({ errors: true, sampleRate: 100, batchSize: 30, flushInterval: 60000, replay: false })
const rules = reactive({ regression: true, highErrorRate: true, slowPage: false })
// 保存前先拉取当前全局配置，merge 后再回写，避免覆盖远程配置已设的其他字段
const collectConfig = ref(null)
const appSettings = ref(null)

// ---------------- 数据留存配置状态 ----------------
const retention = reactive({
  eventsDays: 30,
  logsDays: 14,
  replaysDays: 7,
  resolvedIssuesDays: 90,
  sourcemapsDays: 180,
  alertsDays: 90,
  syntheticResultsDays: 30
})
const loadingRetention = ref(false)
const savingRetention = ref(false)
const cleaning = ref(false)
const cleanupDialogOpen = ref(false)
const cleanupResult = ref(null)

// ---------------- 成员与权限状态 ----------------
const members = ref([])
const loadingMembers = ref(false)
const membersError = ref('')
const inviteDialogOpen = ref(false)
const inviteSaving = ref(false)
const inviteForm = reactive({ email: '', role: 'member', accessLevel: 'L2' })
const inviteResult = ref(null)

const activeLabel = computed(() => ({
  apps: '项目管理',
  ingest: '采样与上报',
  alerts: '告警规则',
  members: '成员权限',
  retention: '数据留存'
})[activeTab.value])

const canManageMembers = computed(() => ['owner', 'admin'].includes(me.value?.role || ''))
const currentTeamName = computed(() => {
  const current = me.value?.teams?.find(t => t.id === currentTeamId.value)
  return current?.name || '默认团队'
})

function normalize(row = {}) {
  return {
    ...row,
    id: row.id || row.app_id || row.appId || row.name,
    name: row.name || row.appName || row.app_id || row.appId || '-',
    appKey: row.app_key || row.appKey || row.app_id || row.appId || '-',
    enabled: row.enabled !== false,
    events: Number(row.events || row.event_count || 0)
  }
}

async function load() {
  loading.value = true
  loadError.value = ''
  pageLoading.value = true
  try {
    const data = await api('/api/applications', { requestKey: 'settings:applications' })
    applications.value = normalizePageResponse(data).items.map(normalize)
  } catch (error) {
    if (error?.code !== 'ABORT_ERR') {
      applications.value = []
      loadError.value = error.message || '应用列表加载失败'
    }
  } finally {
    loading.value = false
    pageLoading.value = false
  }
  void loadIngest()
  void loadAlerts()
  void loadRetention()
  if (accountsEnabled.value && isLoggedIn.value) {
    void loadMembers()
  }
}

function openCreate() {
  router.push({ path: '/governance', query: { action: 'create' } })
}

async function createApplication() {
  if (!form.name.trim()) {
    ElMessage.warning('请填写应用名称')
    return
  }
  saving.value = true
  try {
    const rawName = form.name.trim()
    const slug = rawName.toLowerCase().replace(/[^a-z0-9_-]/g, '')
    const appId = slug.length >= 2 ? slug.slice(0, 48) : `app_${Date.now().toString(36)}`
    await api('/api/applications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId, name: rawName, platform: form.platform, endpoint: form.endpoint.trim(), description: form.description.trim() })
    })
    dialogOpen.value = false
    ElMessage.success('应用已创建')
    await load()
  } catch (error) {
    ElMessage.error(error.message || '应用创建失败')
  } finally {
    saving.value = false
  }
}

function configure(row) {
  router.push({ path: '/governance', query: { appId: row.id || row.appKey } })
}

// ---------------- 采样与上报（对接全局 collect-config） ----------------
async function loadIngest() {
  try {
    const cfg = await api('/api/collect-config', { requestKey: 'settings:collect-config' })
    const c = cfg?.config || {}
    collectConfig.value = c
    if (c.plugins) ingest.replay = c.plugins.replay !== false
    if (c.sampling) {
      ingest.errors = Number(c.sampling.error) >= 1
      const perf = Number(c.sampling.performance)
      if (Number.isFinite(perf)) ingest.sampleRate = Math.round(perf * 100)
    }
  } catch { /* 加载失败保留表单默认值 */ }
}

async function saveIngest() {
  let base = collectConfig.value
  if (!base || typeof base !== 'object') {
    try {
      const cfg = await api('/api/collect-config', { requestKey: 'settings:collect-config' })
      base = cfg?.config || {}
    } catch { base = {} }
  }
  const config = {
    ...base,
    sampling: {
      ...(base.sampling || {}),
      error: ingest.errors ? 1 : ingest.sampleRate / 100,
      performance: ingest.sampleRate / 100,
      behavior: ingest.sampleRate / 100
    },
    plugins: { ...(base.plugins || {}), replay: ingest.replay }
  }
  try {
    await api('/api/collect-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: {}, config, operator: 'admin' })
    })
    collectConfig.value = config
    ElMessage.success('采样与上报设置已保存（批量上报大小 / 间隔为 SDK 初始化参数，需在 SDK 初始化时配置）')
  } catch (error) {
    ElMessage.error(error.message || '保存失败')
  }
}

// ---------------- 告警规则（对接全局 settings.alerts） ----------------
async function loadAlerts() {
  try {
    const data = await api('/api/settings', { requestKey: 'settings:app-settings' })
    const a = data?.alerts || {}
    appSettings.value = data || {}
    rules.regression = a.regression !== false
    rules.highErrorRate = a.error !== false
    rules.slowPage = a.slowPage === true
  } catch { /* 加载失败保留表单默认值 */ }
}

async function saveAlerts() {
  const baseAlerts = (appSettings.value && appSettings.value.alerts) || {}
  const alerts = {
    ...baseAlerts,
    regression: rules.regression,
    error: rules.highErrorRate,
    slowPage: rules.slowPage
  }
  try {
    await api('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alerts })
    })
    appSettings.value = { ...(appSettings.value || {}), alerts }
    ElMessage.success('告警规则设置已保存')
  } catch (error) {
    ElMessage.error(error.message || '保存失败')
  }
}

// ---------------- 数据留存（对接全局 settings.retention & cleanup） ----------------
async function loadRetention() {
  loadingRetention.value = true
  try {
    const data = await api('/api/settings', { requestKey: 'settings:retention-settings' })
    appSettings.value = data || {}
    const r = data?.retention || {}
    if (r.eventsDays !== undefined) retention.eventsDays = Number(r.eventsDays)
    if (r.logsDays !== undefined) retention.logsDays = Number(r.logsDays)
    if (r.replaysDays !== undefined) retention.replaysDays = Number(r.replaysDays)
    if (r.resolvedIssuesDays !== undefined) retention.resolvedIssuesDays = Number(r.resolvedIssuesDays)
    if (r.sourcemapsDays !== undefined) retention.sourcemapsDays = Number(r.sourcemapsDays)
    if (r.alertsDays !== undefined) retention.alertsDays = Number(r.alertsDays)
    if (r.syntheticResultsDays !== undefined) retention.syntheticResultsDays = Number(r.syntheticResultsDays)
  } catch { /* 保留默认值 */ }
  finally {
    loadingRetention.value = false
  }
}

async function saveRetention() {
  savingRetention.value = true
  try {
    let base = appSettings.value
    if (!base || typeof base !== 'object') {
      try { base = (await api('/api/settings', { requestKey: 'settings:save-retention-base' })) || {} } catch { base = {} }
    }
    const payload = {
      ...base,
      retention: {
        eventsDays: Math.max(1, Math.min(3650, Math.round(Number(retention.eventsDays) || 30))),
        logsDays: Math.max(1, Math.min(3650, Math.round(Number(retention.logsDays) || 14))),
        replaysDays: Math.max(1, Math.min(365, Math.round(Number(retention.replaysDays) || 7))),
        resolvedIssuesDays: Math.max(1, Math.min(3650, Math.round(Number(retention.resolvedIssuesDays) || 90))),
        sourcemapsDays: Math.max(1, Math.min(3650, Math.round(Number(retention.sourcemapsDays) || 180))),
        alertsDays: Math.max(1, Math.min(3650, Math.round(Number(retention.alertsDays) || 90))),
        syntheticResultsDays: Math.max(1, Math.min(3650, Math.round(Number(retention.syntheticResultsDays) || 30)))
      }
    }
    await api('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
    appSettings.value = payload
    ElMessage.success('数据留存设置已保存')
  } catch (error) {
    ElMessage.error(error.message || '保存数据留存设置失败')
  } finally {
    savingRetention.value = false
  }
}

async function runManualCleanup() {
  try {
    await ElMessageBox.confirm(
      '立即执行过期数据清理将依据设定的留存周期，物理删除已超期的事件、日志、回放录屏、已解决 Issue 等历史记录。此操作不可逆，是否继续？',
      '确认清理过期数据',
      {
        confirmButtonText: '确认清理',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
  } catch {
    return
  }

  cleaning.value = true
  try {
    const res = await api('/api/maintenance/cleanup', { method: 'POST' })
    cleanupResult.value = res || {}
    cleanupDialogOpen.value = true
    ElMessage.success('过期数据清理已完成')
  } catch (error) {
    ElMessage.error(error.message || '执行数据清理失败')
  } finally {
    cleaning.value = false
  }
}

// ---------------- 成员权限（对接 /api/teams/:id/members & useAuth） ----------------
async function loadMembers() {
  if (!isLoggedIn.value) return
  loadingMembers.value = true
  membersError.value = ''
  try {
    if (!currentTeamId.value) {
      await loadMe()
    }
    const teamId = currentTeamId.value || me.value?.teams?.[0]?.id
    if (!teamId) {
      members.value = []
      return
    }
    const data = await authApi(`/api/teams/${encodeURIComponent(teamId)}/members`, { requestKey: 'settings:team-members' })
    members.value = Array.isArray(data) ? data : []
  } catch (error) {
    members.value = []
    membersError.value = error.message || '成员列表加载失败'
  } finally {
    loadingMembers.value = false
  }
}

async function onSwitchTeam(teamId) {
  if (!teamId || teamId === currentTeamId.value) return
  try {
    await switchTeam(teamId)
    await loadMe()
    await loadMembers()
    ElMessage.success('已切换团队')
  } catch (error) {
    ElMessage.error(error.message || '切换团队失败')
  }
}

async function changeMemberRole(row, nextRole) {
  const userId = row.userId || row.id
  if (!userId) return
  try {
    await authApi(`/api/teams/${encodeURIComponent(currentTeamId.value)}/members/${encodeURIComponent(userId)}/role`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: nextRole })
    })
    row.role = nextRole
    ElMessage.success(`已将 ${row.name || row.email} 的角色修改为「${ROLE_LABELS[nextRole] || nextRole}」`)
    if (userId === me.value?.user?.id) {
      await loadMe()
    }
  } catch (error) {
    ElMessage.error(error.message || '修改角色失败')
    await loadMembers()
  }
}

async function changeMemberLevel(row, nextLevel) {
  const userId = row.userId || row.id
  if (!userId) return
  try {
    await authApi(`/api/teams/${encodeURIComponent(currentTeamId.value)}/members/${encodeURIComponent(userId)}/access-level`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: nextLevel })
    })
    row.level = nextLevel
    ElMessage.success(`已将 ${row.name || row.email} 的数据等级调整为「${LEVEL_LABELS[nextLevel] || nextLevel}」`)
  } catch (error) {
    ElMessage.error(error.message || '调整数据等级失败')
    await loadMembers()
  }
}

async function removeMember(row) {
  const userId = row.userId || row.id
  if (!userId) return
  try {
    await ElMessageBox.confirm(
      `确认将成员「${row.name || row.email}」移出当前团队？移出后该成员将无法访问团队内应用与监测数据。`,
      '确认移除成员',
      {
        confirmButtonText: '确认移除',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
  } catch {
    return
  }

  try {
    await authApi(`/api/teams/${encodeURIComponent(currentTeamId.value)}/members/${encodeURIComponent(userId)}`, {
      method: 'DELETE'
    })
    members.value = members.value.filter(m => (m.userId || m.id) !== userId)
    ElMessage.success('成员已移出团队')
  } catch (error) {
    ElMessage.error(error.message || '移除成员失败（末位 Owner 不可移除）')
  }
}

function openInviteModal() {
  inviteForm.email = ''
  inviteForm.role = 'member'
  inviteForm.accessLevel = 'L2'
  inviteResult.value = null
  inviteDialogOpen.value = true
}

async function submitInvite() {
  const email = inviteForm.email.trim().toLowerCase()
  if (!email || !email.includes('@')) {
    ElMessage.warning('请填写有效的受邀成员邮箱')
    return
  }
  inviteSaving.value = true
  try {
    const res = await authApi(`/api/teams/${encodeURIComponent(currentTeamId.value)}/invitations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        role: inviteForm.role,
        accessLevel: inviteForm.accessLevel
      })
    })
    inviteResult.value = res
    ElMessage.success('邀请已成功创建')
  } catch (error) {
    ElMessage.error(error.message || '创建邀请失败')
  } finally {
    inviteSaving.value = false
  }
}

function inviteLinkOf(inv) {
  if (!inv) return ''
  if (inv.link) return inv.link
  if (inv.token) return `${window.location.origin}/login?invite=${encodeURIComponent(inv.token)}`
  return ''
}

async function copyText(text) {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('已复制到剪贴板')
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
      ElMessage.success('已复制到剪贴板')
    } catch {
      ElMessage.warning('复制失败，请手动复制')
    }
    ta.remove()
  }
}

function formatRelativeTime(ts) {
  if (!ts) return '-'
  const n = Number(ts)
  if (Number.isNaN(n) || n <= 0) return String(ts)
  const diff = Date.now() - n
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return new Date(n).toLocaleDateString()
}

watch(activeTab, tab => {
  if (tab === 'retention') {
    void loadRetention()
  } else if (tab === 'members') {
    void loadMembers()
  }
})

onMounted(load)
</script>

<template>
  <div class="settings-layout">
    <el-tabs v-model="activeTab" tab-position="left" class="settings-tabs">
      <el-tab-pane label="项目管理" name="apps" />
      <el-tab-pane label="采样与上报" name="ingest" />
      <el-tab-pane label="告警规则" name="alerts" />
      <el-tab-pane label="成员权限" name="members" />
      <el-tab-pane label="数据留存" name="retention" />
    </el-tabs>

    <div class="settings-content">

  <template v-if="activeTab === 'apps'">
    <el-card shadow="never" class="panel section">
      <template #header>
        <div class="panel-head"><div><h2>应用管理</h2><small>管理接入项目与 SDK Key</small></div><el-button type="primary" @click="openCreate">新建应用</el-button></div>
      </template>
      <el-alert v-if="loadError" class="table-error" type="error" :title="loadError" :closable="false" show-icon><template #default><el-button link type="primary" @click="load">重试</el-button></template></el-alert>
      <el-table :data="applications" v-loading="loading" empty-text="暂无应用数据">
        <el-table-column prop="name" label="应用名称" min-width="220" />
        <el-table-column prop="appKey" label="SDK Key" min-width="220" />
        <el-table-column label="状态" width="110"><template #default="{ row }"><el-tag class="status-tag" :type="row.enabled ? 'success' : 'info'" effect="plain">{{ row.enabled ? '启用' : '暂停' }}</el-tag></template></el-table-column>
        <el-table-column label="今日事件" width="130"><template #default="{ row }">{{ row.events.toLocaleString() }}</template></el-table-column>
        <el-table-column label="操作" width="120"><template #default="{ row }"><el-button link type="primary" @click="configure(row)">配置</el-button></template></el-table-column>
      </el-table>
    </el-card>
  </template>

  <template v-else-if="activeTab === 'ingest'">
    <el-card shadow="never" class="panel settings-form-card section">
      <template #header><div class="panel-head"><div><h2>采样与上报</h2><small>控制采集成本与数据完整性</small></div><el-button type="primary" @click="saveIngest">保存设置</el-button></div></template>
      <el-form label-position="top" class="settings-form">
        <el-form-item label="错误全量上报">
          <div class="ingest-row">
            <el-switch v-model="ingest.errors" />
            <small class="hint">关闭后将按采样率上报，避免高频噪音淹没关键错误</small>
          </div>
        </el-form-item>
        <el-form-item label="性能数据采样率">
          <div class="ingest-row">
            <el-input-number v-model="ingest.sampleRate" :min="0" :max="100" />
            <span class="field-suffix">%</span>
            <small class="hint">按百分比采样 Web Vitals 与资源加载</small>
          </div>
        </el-form-item>
        <el-form-item label="批量上报大小（batchSize）">
          <div class="ingest-row">
            <el-input-number v-model="ingest.batchSize" :min="1" :max="200" />
            <small class="hint">达到该条数立即 flush 上报（SDK 初始化参数，需于 createEys 时配置）</small>
          </div>
        </el-form-item>
        <el-form-item label="上报间隔（flushInterval）">
          <div class="ingest-row">
            <el-input-number v-model="ingest.flushInterval" :min="1000" :step="1000" />
            <span class="field-suffix">ms</span>
            <small class="hint">当前 {{ Math.round(ingest.flushInterval / 1000) }}s，抑制碎片化小批量（SDK 初始化参数，需于 createEys 时配置）</small>
          </div>
        </el-form-item>
        <el-form-item label="会话回放录制">
          <div class="ingest-row">
            <el-switch v-model="ingest.replay" />
            <small class="hint">录制用户操作用于排障（请遵守合规与脱敏策略）</small>
          </div>
        </el-form-item>
      </el-form>
    </el-card>
  </template>

  <template v-else-if="activeTab === 'alerts'">
    <el-card shadow="never" class="panel settings-form-card section">
      <template #header><div class="panel-head"><div><h2>告警规则</h2><small>定义需要关注的回归与异常阈值</small></div><el-button type="primary" @click="saveAlerts">保存设置</el-button></div></template>
      <el-form label-position="top" class="settings-form">
        <el-form-item label="错误回归">
          <div class="ingest-row">
            <el-switch v-model="rules.regression" />
            <small class="hint">检测已解决问题再次出现</small>
          </div>
        </el-form-item>
        <el-form-item label="错误率异常">
          <div class="ingest-row">
            <el-switch v-model="rules.highErrorRate" />
            <small class="hint">错误率超过基线时通知</small>
          </div>
        </el-form-item>
        <el-form-item label="页面加载变慢">
          <div class="ingest-row">
            <el-switch v-model="rules.slowPage" />
            <small class="hint">Core Web Vitals P95 超过阈值时通知</small>
          </div>
        </el-form-item>
      </el-form>
    </el-card>
  </template>

  <template v-else-if="activeTab === 'members'">
    <div class="members-tab-container">
      <!-- 账号体系未开启模式 -->
      <el-card v-if="!accountsEnabled" shadow="never" class="panel section mb-4">
        <template #header>
          <div class="panel-head">
            <div>
              <h2>成员与权限管理</h2>
              <small>单租户自托管部署模式</small>
            </div>
          </div>
        </template>
        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="当前平台运行于单租户自托管模式"
          description="系统已通过预设管理员凭证放行所有运维管理接口。如需启用多租户、团队协作与细粒度数据等级脱敏，请在服务端环境变量中启用 ACCOUNTS_ENABLED。"
        />
        <div class="matrix-guide mt-4">
          <h3>内置 RBAC 权限体系与数据访问分级</h3>
          <div class="guide-grid">
            <div class="guide-card">
              <h4>Owner / 团队所有者</h4>
              <p>具备最高管理权限，可转让团队、解散团队、分配 Admin 角色及管理全量应用与敏感数据。</p>
            </div>
            <div class="guide-card">
              <h4>Admin / 管理员</h4>
              <p>可邀请新成员、配置告警与远程采样规则、管理应用及执行合规 DSR 任务。</p>
            </div>
            <div class="guide-card">
              <h4>Member / 业务成员</h4>
              <p>具备常规监控大盘浏览、链路诊断与错误分析权限，默认查看脱敏数据。</p>
            </div>
            <div class="guide-card">
              <h4>Viewer / 只读访客</h4>
              <p>仅具备指标看板与聚合数据浏览权限，不展示任何 PII 个人敏感数据。</p>
            </div>
          </div>
        </div>
      </el-card>

      <!-- 未登录提示 -->
      <el-card v-else-if="!isLoggedIn" shadow="never" class="panel section text-center py-6">
        <el-empty description="请先登录后再管理团队成员与权限">
          <el-button type="primary" @click="router.push({ path: '/login', query: { redirect: '/settings' } })">
            立即登录
          </el-button>
        </el-empty>
      </el-card>

      <!-- 团队成员管理主面板 -->
      <template v-else>
        <el-card shadow="never" class="panel section">
          <template #header>
            <div class="panel-head">
              <div>
                <h2>成员与权限管理</h2>
                <small>管理「{{ currentTeamName }}」的成员构成、分配操作角色与 L1~L4 敏感数据访问级别</small>
              </div>
              <div class="header-actions">
                <el-button
                  v-if="canManageMembers"
                  type="primary"
                  :icon="Plus"
                  @click="openInviteModal"
                >
                  邀请成员
                </el-button>
                <el-button :icon="User" @click="router.push('/teams')">团队控制台</el-button>
                <el-button :icon="Lock" @click="router.push('/access-levels')">数据等级矩阵</el-button>
              </div>
            </div>
          </template>

          <div class="team-bar mb-3">
            <div class="team-bar-left">
              <span class="label">当前团队：</span>
              <el-select
                v-if="me?.teams && me.teams.length > 1"
                :model-value="currentTeamId"
                placeholder="选择团队"
                class="team-select"
                style="width: 160px"
                @change="onSwitchTeam"
              >
                <el-option
                  v-for="t in me.teams"
                  :key="t.id"
                  :label="t.name"
                  :value="t.id"
                />
              </el-select>
              <span v-else class="team-current-tag">{{ currentTeamName }}</span>

              <el-tag size="small" type="primary" effect="plain" class="ml-2">
                我的角色：{{ ROLE_LABELS[me?.role] || me?.role || '成员' }}
              </el-tag>
              <el-tag size="small" type="warning" effect="plain" class="ml-1">
                数据等级：{{ LEVEL_LABELS[me?.level] || me?.level || 'L2' }}
              </el-tag>
            </div>
            <div class="team-bar-right">
              <el-button link type="primary" :icon="Refresh" :loading="loadingMembers" @click="loadMembers">刷新列表</el-button>
            </div>
          </div>

          <el-alert
            v-if="membersError"
            class="table-error mb-3"
            type="error"
            :title="membersError"
            :closable="false"
            show-icon
          >
            <template #default>
              <el-button link type="primary" @click="loadMembers">重试</el-button>
            </template>
          </el-alert>

          <el-table
            :data="members"
            v-loading="loadingMembers"
            empty-text="暂无团队成员"
            stripe
          >
            <el-table-column label="成员" min-width="170">
              <template #default="{ row }">
                <div class="member-cell">
                  <span class="member-name">{{ row.name || (row.email ? row.email.split('@')[0] : '用户') }}</span>
                  <span v-if="(row.userId || row.id) === me?.user?.id" class="self-badge">我</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="登录邮箱" min-width="200">
              <template #default="{ row }">
                <OverflowTip :text="row.email || '-'" />
              </template>
            </el-table-column>
            <el-table-column label="操作角色" width="160">
              <template #default="{ row }">
                <div v-if="canManageMembers && row.role !== 'owner' && (row.userId || row.id) !== me?.user?.id">
                  <el-select
                    :model-value="row.role"
                    size="small"
                    style="width: 130px"
                    @change="val => changeMemberRole(row, val)"
                  >
                    <el-option
                      v-for="opt in CHANGEABLE_ROLE_OPTIONS"
                      :key="opt.value"
                      :label="opt.label"
                      :value="opt.value"
                    />
                  </el-select>
                </div>
                <el-tag
                  v-else
                  size="small"
                  :type="row.role === 'owner' ? 'danger' : row.role === 'admin' ? 'warning' : 'info'"
                  effect="plain"
                >
                  {{ ROLE_LABELS[row.role] || row.role }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="数据等级" width="180">
              <template #default="{ row }">
                <div v-if="canManageMembers">
                  <el-select
                    :model-value="row.level || 'L2'"
                    size="small"
                    style="width: 150px"
                    @change="val => changeMemberLevel(row, val)"
                  >
                    <el-option
                      v-for="opt in LEVEL_OPTIONS"
                      :key="opt.value"
                      :label="opt.label"
                      :value="opt.value"
                    />
                  </el-select>
                </div>
                <el-tag
                  v-else
                  size="small"
                  :type="row.level === 'L4' ? 'danger' : row.level === 'L3' ? 'warning' : row.level === 'L2' ? 'primary' : 'info'"
                  effect="plain"
                >
                  {{ LEVEL_LABELS[row.level] || row.level || 'L2' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag
                  size="small"
                  :type="row.status === 'active' || !row.status ? 'success' : 'info'"
                  effect="plain"
                >
                  {{ row.status === 'active' || !row.status ? '正常' : row.status }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="最近活跃" width="130">
              <template #default="{ row }">
                <span>{{ formatRelativeTime(row.lastActiveAt || row.createdAt) }}</span>
              </template>
            </el-table-column>
            <el-table-column v-if="canManageMembers" label="操作" width="90" fixed="right">
              <template #default="{ row }">
                <el-button
                  v-if="row.role !== 'owner' && (row.userId || row.id) !== me?.user?.id"
                  link
                  type="danger"
                  size="small"
                  @click="removeMember(row)"
                >
                  移除
                </el-button>
                <span v-else class="text-muted text-xs">-</span>
              </template>
            </el-table-column>
          </el-table>

          <!-- 权限与脱敏等级小字典 -->
          <div class="quick-notes-grid mt-4">
            <div class="note-box">
              <div class="note-title"><el-icon><User /></el-icon> 动作权限（RBAC）</div>
              <ul class="note-list">
                <li><b>Owner：</b>团队管理、应用归属转让、全权限放行</li>
                <li><b>Admin：</b>成员管理、告警策略、应用创建与配置</li>
                <li><b>Member：</b>查看监控大盘、链路分析、错误排查</li>
                <li><b>Viewer：</b>只读访问聚合大盘，无法更改任何规则</li>
              </ul>
            </div>
            <div class="note-box">
              <div class="note-title"><el-icon><Lock /></el-icon> 数据访问等级（L1~L4）</div>
              <ul class="note-list">
                <li><b>L4 完整数据：</b>平台管理员，全量明文 IP、userId 与导出</li>
                <li><b>L3 运维诊断：</b>研发排障，IP 段脱敏 + 归属地，Trace 明细</li>
                <li><b>L2 业务分析：</b>产品运营，字段脱敏，禁止原始数据导出</li>
                <li><b>L1 只读统计：</b>外部汇报，仅聚合统计指标，无明细事件</li>
              </ul>
            </div>
          </div>
        </el-card>
      </template>
    </div>
  </template>

  <template v-else-if="activeTab === 'retention'">
    <el-card shadow="never" class="panel settings-form-card section">
      <template #header>
        <div class="panel-head">
          <div>
            <h2>数据留存设置</h2>
            <small>设定事件、日志、会话回放等监控数据的保留周期，系统定时自动清理过期历史记录</small>
          </div>
          <div class="header-actions">
            <el-button
              type="warning"
              plain
              :loading="cleaning"
              @click="runManualCleanup"
            >
              立即清理过期数据
            </el-button>
            <el-button
              type="primary"
              :loading="savingRetention"
              @click="saveRetention"
            >
              保存设置
            </el-button>
          </div>
        </div>
      </template>

      <el-form label-position="top" class="settings-form" v-loading="loadingRetention">
        <el-form-item label="事件数据留存（eventsDays）">
          <div class="ingest-row">
            <el-input-number v-model="retention.eventsDays" :min="1" :max="3650" />
            <span class="field-suffix">天</span>
            <small class="hint">Web Vitals 性能指标、用户行为流、自定义事件与实验曝光记录（默认 30 天）</small>
          </div>
        </el-form-item>

        <el-form-item label="日志数据留存（logsDays）">
          <div class="ingest-row">
            <el-input-number v-model="retention.logsDays" :min="1" :max="3650" />
            <span class="field-suffix">天</span>
            <small class="hint">控制台 console.error/warn 日志与网络请求错误日志（默认 14 天）</small>
          </div>
        </el-form-item>

        <el-form-item label="会话回放留存（replaysDays）">
          <div class="ingest-row">
            <el-input-number v-model="retention.replaysDays" :min="1" :max="365" />
            <span class="field-suffix">天</span>
            <small class="hint">DOM 录屏快照与操作轨迹流，数据量较大，建议设为 7~30 天以优化存储空间</small>
          </div>
        </el-form-item>

        <el-form-item label="已解决 Issue 留存（resolvedIssuesDays）">
          <div class="ingest-row">
            <el-input-number v-model="retention.resolvedIssuesDays" :min="1" :max="3650" />
            <span class="field-suffix">天</span>
            <small class="hint">状态标记为已解决（Resolved）的历史异常聚合问题记录（默认 90 天）</small>
          </div>
        </el-form-item>

        <el-form-item label="SourceMap 映射文件留存（sourcemapsDays）">
          <div class="ingest-row">
            <el-input-number v-model="retention.sourcemapsDays" :min="1" :max="3650" />
            <span class="field-suffix">天</span>
            <small class="hint">生产构建上传的代码映射文件，超期自动物理删除释放空间（默认 180 天）</small>
          </div>
        </el-form-item>

        <el-form-item label="告警历史留存（alertsDays）">
          <div class="ingest-row">
            <el-input-number v-model="retention.alertsDays" :min="1" :max="3650" />
            <span class="field-suffix">天</span>
            <small class="hint">历史触发告警记录及 Webhook / 邮件渠道投递明细日志（默认 90 天）</small>
          </div>
        </el-form-item>

        <el-form-item label="合成监控探针结果留存（syntheticResultsDays）">
          <div class="ingest-row">
            <el-input-number v-model="retention.syntheticResultsDays" :min="1" :max="3650" />
            <span class="field-suffix">天</span>
            <small class="hint">探针定时网络拨测运行结果与时间线统计数据（默认 30 天）</small>
          </div>
        </el-form-item>
      </el-form>

      <div class="retention-info-card mt-4">
        <div class="info-head">
          <el-icon><InfoFilled /></el-icon>
          <span>留存策略与自动化清理机制</span>
        </div>
        <div class="info-content">
          <p>• <b>自动清理周期：</b>系统后台定时任务（Node 周期执行 / Cloudflare Worker Cron 定时器）将依照上方配置的天数周期性扫描并物理抹除超期记录。</p>
          <p>• <b>合规保证：</b>符合 GDPR 及个人敏感数据最小化存储准则，超期数据物理抹除后不可恢复。</p>
          <p>• <b>存储开销优化：</b>合理缩短日志与会话回放保留期可大幅缩减数据库存储空间并保持索引查询高吞吐。</p>
        </div>
      </div>
    </el-card>
  </template>

  <template v-else>
    <el-card shadow="never" class="panel settings-placeholder section">
      <el-empty :description="`${activeLabel}功能即将开放`" />
    </el-card>
  </template>

    </div>
  </div>

  <!-- 新建应用弹窗 -->
  <el-dialog v-model="dialogOpen" title="新建应用" width="min(560px, calc(100vw - 32px))" destroy-on-close>
    <el-form label-position="top" class="settings-form">
      <el-form-item label="应用名称" required><el-input v-model="form.name" placeholder="例如：螃蟹交易平台" /></el-form-item>
      <el-form-item label="平台"><el-select v-model="form.platform"><el-option label="Web（H5）" value="web" /><el-option label="微信小程序" value="miniprogram" /><el-option label="React Native" value="react-native" /><el-option label="uni-app" value="uni-app" /><el-option label="Taro" value="taro" /></el-select></el-form-item>
      <el-form-item label="上报域名"><el-input v-model="form.endpoint" placeholder="https://collect.example.com" /></el-form-item>
      <el-form-item label="描述"><el-input v-model="form.description" type="textarea" :rows="3" /></el-form-item>
    </el-form>
    <template #footer><el-button @click="dialogOpen = false">取消</el-button><el-button type="primary" :loading="saving" @click="createApplication">创建应用</el-button></template>
  </el-dialog>

  <!-- 邀请成员弹窗 -->
  <el-dialog
    v-model="inviteDialogOpen"
    title="邀请成员加入团队"
    width="min(520px, calc(100vw - 32px))"
    destroy-on-close
  >
    <el-form label-position="top">
      <el-form-item label="成员登录邮箱" required>
        <el-input
          v-model="inviteForm.email"
          placeholder="user@example.com"
          :disabled="inviteSaving || Boolean(inviteResult)"
        />
      </el-form-item>

      <el-form-item label="分配操作角色" required>
        <el-select
          v-model="inviteForm.role"
          style="width: 100%"
          :disabled="inviteSaving || Boolean(inviteResult)"
        >
          <el-option
            v-for="opt in CHANGEABLE_ROLE_OPTIONS"
            :key="opt.value"
            :label="opt.label"
            :value="opt.value"
          />
        </el-select>
        <small class="field-desc">角色决定操作权限（如应用管理、规则配置、成员邀请）</small>
      </el-form-item>

      <el-form-item label="分配数据访问等级" required>
        <el-select
          v-model="inviteForm.accessLevel"
          style="width: 100%"
          :disabled="inviteSaving || Boolean(inviteResult)"
        >
          <el-option
            v-for="opt in LEVEL_OPTIONS"
            :key="opt.value"
            :label="opt.label"
            :value="opt.value"
          />
        </el-select>
        <small class="field-desc">数据等级控制 API 敏感字段脱敏粒度（L1~L4）</small>
      </el-form-item>

      <!-- 邀请结果展示 -->
      <div v-if="inviteResult" class="invite-result-box mt-3">
        <el-alert
          type="success"
          :closable="false"
          show-icon
          title="邀请已生成！请将专属链接发送给受邀成员："
        />
        <div class="copy-input-row mt-2">
          <el-input
            :model-value="inviteLinkOf(inviteResult)"
            readonly
          />
          <el-button
            type="primary"
            :icon="DocumentCopy"
            @click="copyText(inviteLinkOf(inviteResult))"
          >
            复制
          </el-button>
        </div>
      </div>
    </el-form>

    <template #footer>
      <el-button @click="inviteDialogOpen = false">
        {{ inviteResult ? '关闭' : '取消' }}
      </el-button>
      <el-button
        v-if="!inviteResult"
        type="primary"
        :loading="inviteSaving"
        @click="submitInvite"
      >
        生成邀请
      </el-button>
    </template>
  </el-dialog>

  <!-- 手动清理结果统计弹窗 -->
  <el-dialog
    v-model="cleanupDialogOpen"
    title="数据清理完成报告"
    width="min(520px, calc(100vw - 32px))"
  >
    <div class="cleanup-report">
      <el-alert
        type="success"
        :closable="false"
        show-icon
        title="已按设定的留存周期成功清理过期记录"
        description="所有超期记录已从物理表中完全清除，释放了对应的存储空间。"
      />
      <div class="cleanup-stat-grid mt-3">
        <div class="cleanup-stat-item">
          <span class="label">事件记录 (events)</span>
          <span class="val">{{ (cleanupResult?.events || 0).toLocaleString() }} 条</span>
        </div>
        <div class="cleanup-stat-item">
          <span class="label">日志记录 (logs)</span>
          <span class="val">{{ (cleanupResult?.logs || 0).toLocaleString() }} 条</span>
        </div>
        <div class="cleanup-stat-item">
          <span class="label">会话回放 (replays)</span>
          <span class="val">{{ (cleanupResult?.replays || 0).toLocaleString() }} 条</span>
        </div>
        <div class="cleanup-stat-item">
          <span class="label">已解决 Issue</span>
          <span class="val">{{ (cleanupResult?.issues || 0).toLocaleString() }} 条</span>
        </div>
        <div class="cleanup-stat-item">
          <span class="label">SourceMap 映射</span>
          <span class="val">{{ (cleanupResult?.sourcemaps || 0).toLocaleString() }} 条</span>
        </div>
        <div class="cleanup-stat-item">
          <span class="label">告警通知历史</span>
          <span class="val">{{ (cleanupResult?.alerts || 0).toLocaleString() }} 条</span>
        </div>
        <div class="cleanup-stat-item">
          <span class="label">合成监控结果</span>
          <span class="val">{{ (cleanupResult?.syntheticResults || 0).toLocaleString() }} 条</span>
        </div>
        <div class="cleanup-stat-item">
          <span class="label">实验曝光记录</span>
          <span class="val">{{ (cleanupResult?.experimentExposures || 0).toLocaleString() }} 条</span>
        </div>
      </div>
    </div>
    <template #footer>
      <el-button type="primary" @click="cleanupDialogOpen = false">知道了</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.settings-layout { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 20px; align-items: start; }
.settings-tabs { min-width: 0; }
.settings-tabs :deep(.el-tabs__header.is-left) { width: 100%; margin-right: 0; }
.settings-tabs :deep(.el-tabs__nav-wrap.is-left::after) { display: none; }
.settings-tabs :deep(.el-tabs__active-bar.is-left) { display: none; }
.settings-tabs :deep(.el-tabs__item.is-left) { justify-content: flex-start; height: 40px; padding: 0 12px; color: var(--c-text-muted); border-radius: 8px; }
.settings-tabs :deep(.el-tabs__item.is-left:hover) { color: var(--c-text); background: var(--c-surface-3); }
.settings-tabs :deep(.el-tabs__item.is-left.is-active) { color: var(--c-primary); font-weight: 600; background: var(--c-primary-soft); }
.settings-tabs :deep(.el-tabs__content) { display: none; }
.settings-content { min-width: 0; }
.settings-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 24px; }
.settings-form .el-form-item { position: relative; margin-bottom: 20px; }
.settings-form .el-form-item small { display: block; margin-top: 6px; line-height: 1.45; }
.settings-form .el-select { width: 100%; }
.field-suffix { margin-left: 0; color: var(--c-text-muted); white-space: nowrap; }
.field-desc { color: var(--c-text-muted); font-size: 12px; margin-top: 4px; display: block; }
.ingest-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.ingest-row .hint { color: var(--c-text-muted); font-size: 12px; line-height: 1.5; flex: 1 1 auto; min-width: 160px; }
.status-tag { max-width: none !important; overflow: visible !important; }
.status-tag :deep(.el-tag__content) { overflow: visible !important; white-space: nowrap; }
.settings-placeholder { min-height: 280px; display: grid; place-items: center; }

.header-actions { display: flex; align-items: center; gap: 10px; }
.team-bar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 12px 16px; background: var(--c-surface-2, rgba(0,0,0,0.02)); border-radius: 8px; }
.team-bar-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.team-bar-left .label { font-size: 13px; color: var(--c-text-muted); }
.team-current-tag { font-weight: 600; font-size: 14px; color: var(--c-text); }

.member-cell { display: flex; align-items: center; gap: 6px; }
.member-name { font-weight: 500; }
.self-badge { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--c-primary-soft, #e6f4ff); color: var(--c-primary, #1677ff); }

.quick-notes-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-top: 20px; }
.note-box { padding: 14px 16px; background: var(--c-surface-2, rgba(0,0,0,0.02)); border-radius: 8px; border: 1px solid var(--c-border-subtle, rgba(0,0,0,0.06)); }
.note-title { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 13px; margin-bottom: 8px; color: var(--c-text); }
.note-list { margin: 0; padding-left: 18px; font-size: 12px; color: var(--c-text-muted); line-height: 1.8; }
.note-list li b { color: var(--c-text); }

.retention-info-card { padding: 16px; background: var(--c-surface-2, rgba(0,0,0,0.02)); border-radius: 8px; border: 1px solid var(--c-border-subtle, rgba(0,0,0,0.06)); }
.info-head { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13px; margin-bottom: 8px; color: var(--c-text); }
.info-content { font-size: 12px; color: var(--c-text-muted); line-height: 1.8; }
.info-content p { margin: 4px 0; }
.info-content b { color: var(--c-text); }

.copy-input-row { display: flex; align-items: center; gap: 8px; }

.cleanup-stat-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
.cleanup-stat-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: var(--c-surface-2, rgba(0,0,0,0.02)); border-radius: 6px; font-size: 13px; }
.cleanup-stat-item .label { color: var(--c-text-muted); }
.cleanup-stat-item .val { font-weight: 600; color: var(--c-primary, #1677ff); }

.matrix-guide { padding: 16px; background: var(--c-surface-2, rgba(0,0,0,0.02)); border-radius: 8px; }
.matrix-guide h3 { font-size: 14px; font-weight: 600; margin-bottom: 12px; }
.guide-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.guide-card { padding: 12px; background: var(--c-bg, #fff); border-radius: 6px; border: 1px solid var(--c-border-subtle, rgba(0,0,0,0.06)); }
.guide-card h4 { font-size: 13px; font-weight: 600; margin-bottom: 6px; color: var(--c-primary, #1677ff); }
.guide-card p { font-size: 12px; color: var(--c-text-muted); margin: 0; line-height: 1.5; }

@media (max-width: 900px) {
  .settings-layout { grid-template-columns: 150px minmax(0, 1fr); gap: 14px; }
  .quick-notes-grid, .guide-grid, .cleanup-stat-grid { grid-template-columns: 1fr; }
}
@media (max-width: 720px) {
  .settings-layout { grid-template-columns: 1fr; }
  .settings-tabs :deep(.el-tabs__nav) { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; }
  .settings-tabs :deep(.el-tabs__item.is-left) { justify-content: center; }
  .settings-form { grid-template-columns: 1fr; }
  .header-actions { flex-wrap: wrap; }
}
</style>
