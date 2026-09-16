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

  <template v-else>
    <el-card shadow="never" class="panel settings-placeholder section">
      <el-empty :description="`${activeLabel}功能即将开放`" />
    </el-card>
  </template>

    </div>
  </div>

  <el-dialog v-model="dialogOpen" title="新建应用" width="min(560px, calc(100vw - 32px))" destroy-on-close>
    <el-form label-position="top" class="settings-form">
      <el-form-item label="应用名称" required><el-input v-model="form.name" placeholder="例如：螃蟹交易平台" /></el-form-item>
      <el-form-item label="平台"><el-select v-model="form.platform"><el-option label="Web（H5）" value="web" /><el-option label="微信小程序" value="miniprogram" /><el-option label="React Native" value="react-native" /><el-option label="uni-app" value="uni-app" /><el-option label="Taro" value="taro" /></el-select></el-form-item>
      <el-form-item label="上报域名"><el-input v-model="form.endpoint" placeholder="https://collect.example.com" /></el-form-item>
      <el-form-item label="描述"><el-input v-model="form.description" type="textarea" :rows="3" /></el-form-item>
    </el-form>
    <template #footer><el-button @click="dialogOpen = false">取消</el-button><el-button type="primary" :loading="saving" @click="createApplication">创建应用</el-button></template>
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
.ingest-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.ingest-row .hint { color: var(--c-text-muted); font-size: 12px; line-height: 1.5; flex: 1 1 auto; min-width: 160px; }
.status-tag { max-width: none !important; overflow: visible !important; }
.status-tag :deep(.el-tag__content) { overflow: visible !important; white-space: nowrap; }
.settings-placeholder { min-height: 280px; display: grid; place-items: center; }
@media (max-width: 900px) { .settings-layout { grid-template-columns: 150px minmax(0, 1fr); gap: 14px; } }
@media (max-width: 720px) {
  .settings-layout { grid-template-columns: 1fr; }
  .settings-tabs :deep(.el-tabs__nav) { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; }
  .settings-tabs :deep(.el-tabs__item.is-left) { justify-content: center; }
  .settings-form { grid-template-columns: 1fr; }
}
</style>
