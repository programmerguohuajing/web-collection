<script setup lang="ts">
/**
 * /teams —— 顶层团队管理控制台（不套 Layout）。
 *
 * - 未登录 → 跳 /login。
 * - 顶部：团队切换（x-team-id）、当前用户角色/等级徽章、退出登录、创建团队。
 * - 三分区：成员（Admin+ 改 role/level、移除）、邀请（Admin+ 生成一次性链接）、审计（Admin+ 团队审计）。
 * - 长文本（邮箱 / 审计对象）统一用 <OverflowTip>，禁用 EP 2.14 原生溢出提示。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  useAuth,
  ROLE_LABELS,
  LEVEL_LABELS,
  CHANGEABLE_ROLE_OPTIONS,
  LEVEL_OPTIONS
} from '../../composables/useAuth'
import OverflowTip from '../../components/OverflowTip.vue'

const { me, currentTeamId, isLoggedIn, authApi, logout, loadMe, switchTeam, loadCapabilities } = useAuth()
const router = useRouter()

type Role = 'owner' | 'admin' | 'member' | 'viewer'
type AccessLevel = 'L1' | 'L2' | 'L3' | 'L4'

interface TeamMember {
  id?: string
  userId?: string
  email: string
  name?: string
  role: Role
  level: AccessLevel
  status: string
  lastActiveAt?: number | string | null
}

interface Invitation {
  id: string
  email: string
  role: Role
  level: AccessLevel
  token?: string
  link?: string
  status?: string
  createdAt?: number | string
}

interface AuditItem {
  id?: string
  createdAt?: number | string
  actorEmail?: string
  actor?: string
  action?: string
  targetId?: string
  targetType?: string
  detail?: string
}

const activeTab = ref<'members' | 'invitations' | 'audit'>('members')
const ready = ref(false)
const members = ref<TeamMember[]>([])
const invitations = ref<Invitation[]>([])
const auditItems = ref<AuditItem[]>([])
const loadingMembers = ref(false)
const loadingInvitations = ref(false)
const loadingAudit = ref(false)
const switching = ref(false)

const inviteDialog = ref(false)
const inviteSaving = ref(false)
const inviteForm = reactive({ email: '', role: 'member' as Role, accessLevel: 'L2' as AccessLevel })

const createDialog = ref(false)
const createSaving = ref(false)
const createForm = reactive({ name: '', slug: '' })

const canManage = computed(() => ['owner', 'admin'].includes(me.value?.role || ''))

function memberUserId(m: TeamMember): string {
  return m.userId || m.id || ''
}

function inviteUrl(inv: Invitation): string {
  if (inv.link) return inv.link
  if (inv.token) return `${window.location.origin}/login?invite=${encodeURIComponent(inv.token)}`
  return ''
}

function activeLabel(ts?: number | string | null): string {
  if (!ts) return '-'
  const n = Number(ts)
  if (Number.isNaN(n)) return String(ts)
  const diff = Date.now() - n
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return new Date(n).toLocaleString()
}

async function loadMembers(): Promise<void> {
  loadingMembers.value = true
  try {
    const data = await authApi<TeamMember[]>(`/api/teams/${encodeURIComponent(currentTeamId.value)}/members`)
    members.value = Array.isArray(data) ? data : []
  } catch (e) {
    members.value = []
    ElMessage.error((e as { message?: string })?.message || '成员列表加载失败')
  } finally {
    loadingMembers.value = false
  }
}

async function loadInvitations(): Promise<void> {
  if (!canManage.value) return
  loadingInvitations.value = true
  try {
    const data = await authApi<Invitation[]>(`/api/teams/${encodeURIComponent(currentTeamId.value)}/invitations`)
    invitations.value = Array.isArray(data) ? data : []
  } catch (e) {
    invitations.value = []
    ElMessage.error((e as { message?: string })?.message || '邀请列表加载失败')
  } finally {
    loadingInvitations.value = false
  }
}

async function loadAudit(): Promise<void> {
  if (!canManage.value) return
  loadingAudit.value = true
  try {
    const data = await authApi<AuditItem[]>(`/api/teams/${encodeURIComponent(currentTeamId.value)}/audit`)
    auditItems.value = Array.isArray(data) ? data : []
  } catch (e) {
    auditItems.value = []
    ElMessage.error((e as { message?: string })?.message || '审计日志加载失败')
  } finally {
    loadingAudit.value = false
  }
}

async function reloadAll(): Promise<void> {
  await loadMe()
  await Promise.all([
    loadMembers(),
    canManage.value ? loadInvitations() : Promise.resolve(),
    canManage.value ? loadAudit() : Promise.resolve()
  ])
}

async function onSwitchTeam(teamId: string): Promise<void> {
  if (teamId === currentTeamId.value) return
  switching.value = true
  try {
    await switchTeam(teamId)
    await reloadAll()
  } catch (e) {
    ElMessage.error((e as { message?: string })?.message || '切换团队失败')
  } finally {
    switching.value = false
  }
}

async function changeRole(m: TeamMember, role: Role): Promise<void> {
  const userId = memberUserId(m)
  if (!userId) return
  try {
    await authApi(`/api/teams/${encodeURIComponent(currentTeamId.value)}/members/${encodeURIComponent(userId)}/role`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role })
    })
    m.role = role
    ElMessage.success('角色已更新')
    if (userId === me.value?.user?.id) await loadMe()
  } catch (e) {
    ElMessage.error((e as { message?: string })?.message || '角色更新失败')
  }
}

async function changeLevel(m: TeamMember, level: AccessLevel): Promise<void> {
  const userId = memberUserId(m)
  if (!userId) return
  try {
    await authApi(`/api/teams/${encodeURIComponent(currentTeamId.value)}/members/${encodeURIComponent(userId)}/access-level`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level })
    })
    m.level = level
    ElMessage.success('数据等级已更新')
  } catch (e) {
    ElMessage.error((e as { message?: string })?.message || '等级更新失败')
  }
}

async function removeMember(m: TeamMember): Promise<void> {
  const userId = memberUserId(m)
  if (!userId) return
  try {
    await ElMessageBox.confirm(`确认将 ${m.email} 移出团队？`, '移除成员', {
      type: 'warning',
      confirmButtonText: '移除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  try {
    await authApi(`/api/teams/${encodeURIComponent(currentTeamId.value)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' })
    members.value = members.value.filter(x => memberUserId(x) !== userId)
    ElMessage.success('已移除成员')
  } catch (e) {
    ElMessage.error((e as { message?: string })?.message || '移除失败（末位 Owner 不可移除）')
  }
}

function openInvite(): void {
  Object.assign(inviteForm, { email: '', role: 'member', accessLevel: 'L2' })
  inviteDialog.value = true
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy') } catch { /* ignore */ }
    ta.remove()
  }
}

async function submitInvite(): Promise<void> {
  if (!inviteForm.email.trim()) return ElMessage.warning('请输入受邀邮箱')
  inviteSaving.value = true
  try {
    const data = await authApi<Invitation>(`/api/teams/${encodeURIComponent(currentTeamId.value)}/invitations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: inviteForm.email.trim(), role: inviteForm.role, accessLevel: inviteForm.accessLevel })
    })
    invitations.value = [data, ...invitations.value]
    inviteDialog.value = false
    const url = inviteUrl(data)
    if (url) {
      await copyText(url)
      ElMessage.success('邀请已生成，邀请链接已复制到剪贴板')
    } else {
      ElMessage.success('邀请已生成')
    }
  } catch (e) {
    ElMessage.error((e as { message?: string })?.message || '邀请生成失败')
  } finally {
    inviteSaving.value = false
  }
}

async function revokeInvite(inv: Invitation): Promise<void> {
  try {
    await ElMessageBox.confirm(`撤销对 ${inv.email} 的邀请？`, '撤销邀请', {
      type: 'warning',
      confirmButtonText: '撤销',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  try {
    await authApi(`/api/teams/${encodeURIComponent(currentTeamId.value)}/invitations/${encodeURIComponent(inv.id)}`, { method: 'DELETE' })
    invitations.value = invitations.value.filter(x => x.id !== inv.id)
    ElMessage.success('邀请已撤销')
  } catch (e) {
    ElMessage.error((e as { message?: string })?.message || '撤销失败')
  }
}

function openCreate(): void {
  Object.assign(createForm, { name: '', slug: '' })
  createDialog.value = true
}

async function submitCreate(): Promise<void> {
  if (!createForm.name.trim()) return ElMessage.warning('请输入团队名称')
  const slug = createForm.slug.trim() || createForm.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  if (!slug) return ElMessage.warning('团队标识无效')
  createSaving.value = true
  try {
    const data = await authApi<{ id: string }>('/api/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: createForm.name.trim(), slug })
    })
    createDialog.value = false
    ElMessage.success('团队已创建')
    await onSwitchTeam(data.id)
  } catch (e) {
    ElMessage.error((e as { message?: string })?.message || '创建团队失败')
  } finally {
    createSaving.value = false
  }
}

async function onLogout(): Promise<void> {
  await logout()
  await router.replace('/login')
}

async function onTabChange(): Promise<void> {
  if (activeTab.value === 'invitations') await loadInvitations()
  if (activeTab.value === 'audit') await loadAudit()
}

onMounted(async () => {
  await loadCapabilities()
  if (!isLoggedIn.value) {
    await router.replace('/login')
    return
  }
  try {
    await loadMe()
  } catch {
    await router.replace('/login')
    return
  }
  await reloadAll()
  ready.value = true
})
</script>

<template>
  <div class="teams-shell" v-if="ready">
    <header class="teams-bar">
      <div class="teams-brand">
        <span class="brand-logo">{{ brandShortName }}</span>
        <div>
          <h1>团队管理</h1>
          <p>{{ brandName }} · 账号与权限</p>
        </div>
      </div>
      <div class="teams-actions">
        <el-select
          :model-value="currentTeamId"
          @change="onSwitchTeam"
          :loading="switching"
          placeholder="选择团队"
          class="team-select"
        >
          <el-option v-for="t in (me?.teams || [])" :key="t.id" :label="t.name" :value="t.id" />
        </el-select>
        <span class="me-chip">
          <span class="me-avatar">{{ (me?.user?.name || me?.user?.email || '?').slice(0, 1).toUpperCase() }}</span>
          <OverflowTip :text="me?.user?.email || ''" />
        </span>
        <el-tag
          v-if="me?.role"
          :type="me.role === 'owner' ? 'danger' : me.role === 'admin' ? 'warning' : 'info'"
          effect="light"
        >
          {{ ROLE_LABELS[me.role] }} · {{ LEVEL_LABELS[me.level] }}
        </el-tag>
        <el-button text @click="onLogout">退出登录</el-button>
      </div>
    </header>

    <main class="teams-body">
      <el-tabs v-model="activeTab" class="teams-tabs" @tab-change="onTabChange">
        <el-tab-pane label="成员" name="members" />
        <el-tab-pane v-if="canManage" label="邀请" name="invitations" />
        <el-tab-pane v-if="canManage" label="审计" name="audit" />
      </el-tabs>

      <!-- 成员 -->
      <section v-if="activeTab === 'members'">
        <div class="section-head">
          <h2>团队成员</h2>
          <el-button v-if="canManage" type="primary" @click="openCreate">创建团队</el-button>
        </div>
        <el-table :data="members" border v-loading="loadingMembers" empty-text="暂无成员">
          <el-table-column label="邮箱 / 名称" min-width="220">
            <template #default="{ row }">
              <div class="cell-stack">
                <OverflowTip :text="row.email" />
                <small v-if="row.name" class="muted">{{ row.name }}</small>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="角色" width="170">
            <template #default="{ row }">
              <span v-if="row.role === 'owner'" class="role-badge owner">所有者</span>
              <el-select
                v-else
                :model-value="row.role"
                :disabled="!canManage"
                @change="(v) => changeRole(row, v)"
                size="small"
                style="width: 130px"
              >
                <el-option v-for="o in CHANGEABLE_ROLE_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="数据等级" width="150">
            <template #default="{ row }"><span class="lvl-badge" :class="row.level">{{ row.level }}</span></template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag size="small" :type="row.status === 'active' ? 'success' : 'info'" effect="plain">{{ row.status || '未知' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="最后活跃" width="140">
            <template #default="{ row }">{{ activeLabel(row.lastActiveAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="100" v-if="canManage">
            <template #default="{ row }">
              <el-button v-if="row.role !== 'owner'" link type="danger" @click="removeMember(row)">移除</el-button>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
        </el-table>
      </section>

      <!-- 邀请 -->
      <section v-else-if="activeTab === 'invitations'">
        <div class="section-head">
          <h2>团队邀请</h2>
          <el-button type="primary" @click="openInvite">新建邀请</el-button>
        </div>
        <el-table :data="invitations" border v-loading="loadingInvitations" empty-text="暂无邀请">
          <el-table-column label="受邀邮箱" min-width="220">
            <template #default="{ row }"><OverflowTip :text="row.email" /></template>
          </el-table-column>
          <el-table-column label="角色" width="120">
            <template #default="{ row }">{{ ROLE_LABELS[row.role] || row.role }}</template>
          </el-table-column>
          <el-table-column label="数据等级" width="110">
            <template #default="{ row }"><span class="lvl-badge" :class="row.level">{{ row.level }}</span></template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag size="small" :type="row.status === 'pending' ? 'warning' : 'info'" effect="plain">{{ row.status || 'pending' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="160">
            <template #default="{ row }">
              <el-button link type="primary" :disabled="!inviteUrl(row)" @click="copyText(inviteUrl(row))">复制链接</el-button>
              <el-button link type="danger" @click="revokeInvite(row)">撤销</el-button>
            </template>
          </el-table-column>
        </el-table>
      </section>

      <!-- 审计 -->
      <section v-else>
        <div class="section-head">
          <h2>团队审计日志</h2>
          <el-button :loading="loadingAudit" @click="loadAudit">刷新</el-button>
        </div>
        <el-table :data="auditItems" border v-loading="loadingAudit" empty-text="暂无审计记录">
          <el-table-column label="时间" width="180">
            <template #default="{ row }">{{ row.createdAt ? new Date(Number(row.createdAt)).toLocaleString() : '-' }}</template>
          </el-table-column>
          <el-table-column label="操作者" width="200">
            <template #default="{ row }"><OverflowTip :text="row.actorEmail || row.actor || '-'" /></template>
          </el-table-column>
          <el-table-column prop="action" label="动作" width="160" />
          <el-table-column label="对象" min-width="220">
            <template #default="{ row }"><OverflowTip :text="row.targetId || row.targetType || '-'" /></template>
          </el-table-column>
        </el-table>
      </section>
    </main>

    <!-- 邀请对话框 -->
    <el-dialog v-model="inviteDialog" title="新建团队邀请" width="440px">
      <el-form label-width="90px">
        <el-form-item label="受邀邮箱"><el-input v-model="inviteForm.email" placeholder="teammate@team.com" /></el-form-item>
        <el-form-item label="角色">
          <el-select v-model="inviteForm.role" style="width: 100%">
            <el-option v-for="o in CHANGEABLE_ROLE_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="数据等级">
          <el-select v-model="inviteForm.accessLevel" style="width: 100%">
            <el-option v-for="o in LEVEL_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="inviteDialog = false">取消</el-button>
        <el-button type="primary" :loading="inviteSaving" @click="submitInvite">生成邀请</el-button>
      </template>
    </el-dialog>

    <!-- 创建团队对话框 -->
    <el-dialog v-model="createDialog" title="创建团队" width="440px">
      <el-form label-width="90px">
        <el-form-item label="团队名称"><el-input v-model="createForm.name" placeholder="如 前端平台组" /></el-form-item>
        <el-form-item label="团队标识"><el-input v-model="createForm.slug" placeholder="留空将自动生成（英文/数字/连字符）" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialog = false">取消</el-button>
        <el-button type="primary" :loading="createSaving" @click="submitCreate">创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.teams-shell { min-height: 100vh; padding: 20px 24px 40px; box-sizing: border-box; background: var(--el-bg-color-page, #f5f7fa); }
.teams-bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
.teams-brand { display: flex; align-items: center; gap: 12px; }
.brand-logo { width: 40px; height: 40px; border-radius: 10px; background: linear-gradient(135deg,#4f7cff,#3b5bdb); color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 16px; }
.teams-brand h1 { margin: 0; font-size: 18px; }
.teams-brand p { margin: 2px 0 0; font-size: 12px; color: var(--el-text-color-secondary); }
.teams-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.team-select { width: 200px; }
.me-chip { display: inline-flex; align-items: center; gap: 8px; max-width: 220px; }
.me-avatar { width: 28px; height: 28px; border-radius: 50%; background: linear-gradient(135deg,#6366f1,#0ea5e9); color: #fff; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex: none; }
.section-head { display: flex; align-items: center; justify-content: space-between; margin: 8px 0 12px; }
.section-head h2 { margin: 0; font-size: 15px; }
.cell-stack { display: flex; flex-direction: column; line-height: 1.4; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.role-badge { display: inline-flex; align-items: center; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; background: #eef2ff; color: #4338ca; }
.role-badge.owner { background: #fee2e2; color: #b91c1c; }
</style>
