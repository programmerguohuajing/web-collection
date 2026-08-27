<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, pageLoading } from '../../../dashboard.js'

const loading = ref(false)
const members = ref([])
const currentLevel = ref(null)
// 邀请 / 调整
const memberDialog = ref(false)
const memberSaving = ref(false)
const memberForm = reactive({ id: null, name: '', role: '', level: 'L2' })
// 审计
const auditDrawer = ref(false)
const auditItems = ref([])

const LEVELS = [
  {
    key: 'L4', cls: 'l4', title: '完整数据', role: '平台管理员',
    rows: [['IP', '完整 IP', true], ['userId / 手机', '原值', true], ['原始事件', '✅', true], ['导出', '✅', true]]
  },
  {
    key: 'L3', cls: 'l3', title: '运维诊断', role: '研发',
    rows: [['IP', '段脱敏 + 归属地', true], ['userId / 手机', '原值 / 脱敏', true], ['原始事件', '✅', true], ['导出', '✅ 脱敏', true]]
  },
  {
    key: 'L2', cls: 'l2', title: '业务分析', role: '产品 / 运营（默认）',
    rows: [['IP', '归属省市 + 运营商', true], ['userId / 手机', 'hash8 / 脱敏', true], ['原始事件', '✅ 脱敏', true], ['导出', '❌', false]]
  },
  {
    key: 'L1', cls: 'l1', title: '只读统计', role: '外部 / 演示',
    rows: [['IP', '❌', false], ['userId / 手机', '❌', false], ['原始事件', '❌ 仅聚合', false], ['导出', '❌', false]]
  }
]
const LEVEL_OPTIONS = [
  { value: 'L1', label: 'L1 · 只读统计' },
  { value: 'L2', label: 'L2 · 业务分析（默认）' },
  { value: 'L3', label: 'L3 · 运维诊断' },
  { value: 'L4', label: 'L4 · 完整数据' }
]

async function load() {
  loading.value = true
  pageLoading.value = true
  try {
    const [membersData, levelData] = await Promise.all([
      api('/api/members', { requestKey: 'al:members' }).catch(() => []),
      api('/api/me/access-level', { requestKey: 'al:me' }).catch(() => null)
    ])
    members.value = Array.isArray(membersData) ? membersData : []
    currentLevel.value = levelData?.level || null
  } finally {
    loading.value = false
    pageLoading.value = false
  }
}

function openInvite() {
  Object.assign(memberForm, { id: null, name: '', role: '', level: 'L2' })
  memberDialog.value = true
}
function openAdjust(member) {
  Object.assign(memberForm, { id: member.id, name: member.name, role: member.role, level: member.level })
  memberDialog.value = true
}

async function submitMember() {
  if (!memberForm.name.trim()) return ElMessage.warning('请输入成员名称')
  const isAdjust = Boolean(memberForm.id)
  if (isAdjust) {
    const confirmed = await ElMessageBox.confirm(
      `将「${memberForm.name}」的数据访问等级调整为 ${memberForm.level}？该敏感操作将写入审计日志。`,
      '等级调整确认',
      { type: 'warning', confirmButtonText: '确认调整', cancelButtonText: '取消' }
    ).then(() => true).catch(() => false)
    if (!confirmed) return
  }
  memberSaving.value = true
  try {
    if (isAdjust) {
      await api(`/api/members/${encodeURIComponent(memberForm.id)}/level`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level: memberForm.level })
      })
    } else {
      await api('/api/members', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: memberForm.name.trim(), role: memberForm.role.trim(), level: memberForm.level })
      })
    }
    memberDialog.value = false
    ElMessage.success(isAdjust ? '等级已调整并记入审计' : '成员已登记')
    await load()
  } catch (error) {
    ElMessage.error(error.message || '保存失败')
  } finally {
    memberSaving.value = false
  }
}

async function openAudit() {
  auditDrawer.value = true
  try {
    const data = await api('/api/audit/data-access', { requestKey: 'al:audit' })
    auditItems.value = Array.isArray(data) ? data : []
  } catch {
    auditItems.value = []
  }
}

function activeLabel(ts) {
  if (!ts) return '-'
  const diff = Date.now() - Number(ts)
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return new Date(Number(ts)).toLocaleDateString()
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-heading">
      <div>
        <h1>成员与数据等级</h1>
        <p>四级数据访问模型（L1~L4），按角色裁剪 API 响应中的敏感字段；展示层分级，存储始终含完整数据。</p>
      </div>
      <div style="display: flex; gap: 8px">
        <el-button @click="openAudit">审计日志</el-button>
        <el-button type="primary" @click="openInvite">＋ 登记成员</el-button>
      </div>
    </div>

    <div class="caliber-note">
      <span class="ci">◈</span>
      <div><b>合规内建</b>：查询侧统一脱敏中间件按请求者等级处理敏感字段（ip / userId / user_phone / context.* PII）。<b>白名单制</b>——新接口默认全脱敏，显式声明才放行；中间件故障 fail-close，绝不 fail-open。当前部署无账号体系，全局等级由环境变量 <code>DATA_ACCESS_LEVEL</code> 配置<template v-if="currentLevel">（当前：<b>{{ currentLevel }}</b>）</template>。</div>
    </div>

    <!-- 等级矩阵卡 -->
    <div class="lvl-grid">
      <div v-for="level in LEVELS" :key="level.key" class="lvl-card" :class="level.cls">
        <div class="lc-head">
          <div class="lc-badge">{{ level.key }}</div>
          <div><h4>{{ level.title }}</h4><div class="lc-role">{{ level.role }}<template v-if="currentLevel === level.key"> · 当前</template></div></div>
        </div>
        <div v-for="[label, value, yes] in level.rows" :key="label" class="lc-row">
          <span class="lk">{{ label }}</span>
          <span class="lv" :class="yes ? 'yes' : 'no'">{{ value }}</span>
        </div>
      </div>
    </div>

    <!-- 成员列表 -->
    <el-card shadow="never" class="section panel">
      <template #header><b>成员列表</b><small style="margin-left: 8px">无账号体系阶段为登记制；账号体系立项后自动归位</small></template>
      <el-table :data="members" border v-loading="loading" empty-text="暂无成员登记">
        <el-table-column label="名称" min-width="180"><template #default="{ row }"><b>{{ row.name }}</b></template></el-table-column>
        <el-table-column label="等级" width="100">
          <template #default="{ row }"><span class="lvl-badge" :class="row.level">{{ row.level }}</span></template>
        </el-table-column>
        <el-table-column prop="role" label="角色" min-width="140"><template #default="{ row }">{{ row.role || '-' }}</template></el-table-column>
        <el-table-column label="最后活跃" width="130"><template #default="{ row }">{{ activeLabel(row.lastActiveAt) }}</template></el-table-column>
        <el-table-column label="操作" width="110">
          <template #default="{ row }"><el-button link type="primary" @click="openAdjust(row)">调整等级</el-button></template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 成员对话框 -->
    <el-dialog v-model="memberDialog" :title="memberForm.id ? '调整等级' : '＋ 登记成员'" width="440px">
      <el-form label-width="90px">
        <el-form-item label="名称"><el-input v-model="memberForm.name" :disabled="Boolean(memberForm.id)" placeholder="如 zhang@team" /></el-form-item>
        <el-form-item label="角色"><el-input v-model="memberForm.role" placeholder="如 研发 / 产品" /></el-form-item>
        <el-form-item label="数据等级">
          <el-select v-model="memberForm.level" style="width: 100%">
            <el-option v-for="option in LEVEL_OPTIONS" :key="option.value" :label="option.label" :value="option.value" />
          </el-select>
        </el-form-item>
      </el-form>
      <div class="conflict-note">等级调整为敏感操作，将写入审计日志{{ memberForm.id ? '并需二次确认' : '' }}。</div>
      <template #footer>
        <el-button @click="memberDialog = false">取消</el-button>
        <el-button type="primary" :loading="memberSaving" @click="submitMember">{{ memberForm.id ? '确认调整' : '登记' }}</el-button>
      </template>
    </el-dialog>

    <!-- 审计抽屉 -->
    <el-drawer v-model="auditDrawer" title="数据访问审计" size="480px">
      <el-table :data="auditItems" size="small" border empty-text="暂无审计记录">
        <el-table-column label="时间" width="160"><template #default="{ row }">{{ new Date(Number(row.createdAt)).toLocaleString() }}</template></el-table-column>
        <el-table-column prop="memberId" label="操作者" width="120" show-overflow-tooltip />
        <el-table-column prop="action" label="动作" width="110" />
        <el-table-column prop="target" label="对象" min-width="160" show-overflow-tooltip />
      </el-table>
    </el-drawer>
  </div>
</template>
