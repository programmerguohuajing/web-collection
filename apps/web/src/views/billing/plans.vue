<script setup>
/**
 * D3 · 套餐页（PRD 15 §8）：当前套餐卡 + 三档对比表 + 变更抽屉。
 * - 当前档列高亮「当前」置灰不可选；无 team_plans 行时后端逻辑默认 free 档；
 * - 变更走抽屉 → ElMessageBox 二次确认；降配额明确提示「新配额立即生效，历史用量不做追溯减免」；
 * - meterManage 不足（非 owner/admin）时按钮置灰 + tooltip「需要 Admin 及以上角色」。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAuth } from '../../composables/useAuth'
import OverflowTip from '../../components/OverflowTip.vue'
import { getPlans, getCurrentPlan, putPlan } from '../../api/metering.js'

const { me } = useAuth()

const plans = ref([])
const current = ref(null)
const loading = ref(false)
const error = ref('')
const drawerOpen = ref(false)
const saving = ref(false)
const selectedCode = ref('')

const canManage = computed(() => ['owner', 'admin'].includes(me.value?.role))

const currentCode = computed(() => current.value?.plan?.code)
const quota = computed(() => current.value?.quota || {})
const customized = computed(() => Boolean(current.value?.customized))

const HARD_ACTION_TEXT = {
  none: '仅告警（不阻断接收）',
  reject: '拒绝接收（HTTP 429）',
  sample_down: '降采样 + 停录回放'
}

function fmtQuota(n) {
  return n === -1 || n == null ? '不限量' : Number(n).toLocaleString()
}

const compareRows = computed(() => {
  const get = (p, key) => {
    if (key === 'soft') return `${p.softLimitPct || 80}%`
    if (key === 'hard') return HARD_ACTION_TEXT[p.hardAction] || p.hardAction || '—'
    if (key === 'retention') return p.quota?.retention_days ? `${p.quota.retention_days} 天` : '—'
    return fmtQuota(p.quota?.[key])
  }
  const row = (label, key) => ({ label, values: Object.fromEntries(plans.value.map(p => [p.code, get(p, key)])) })
  return [
    row('事件数 / 月', 'events'),
    row('回放会话数 / 月', 'replay_sessions'),
    row('席位', 'seats'),
    row('数据保留', 'retention'),
    row('软限提醒', 'soft'),
    row('超限动作', 'hard')
  ]
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [p, c] = await Promise.all([getPlans(), getCurrentPlan()])
    plans.value = Array.isArray(p) ? p : []
    current.value = c
  } catch (e) {
    error.value = e?.message || '套餐信息加载失败'
  } finally {
    loading.value = false
  }
}

function openChange() {
  selectedCode.value = currentCode.value || ''
  drawerOpen.value = true
}

/** 检测是否降级：新档位任一维度的生效配额严格低于当前生效配额。 */
function isDowngrade(target) {
  const tq = target?.quota || {}
  const cq = quota.value
  return ['events', 'replay_sessions', 'seats', 'retention_days'].some(key => {
    const t = Number(tq[key])
    const c = Number(cq[key])
    return Number.isFinite(t) && Number.isFinite(c) && c !== -1 && t !== -1 && t < c
  })
}

async function confirmChange() {
  if (!canManage.value) {
    ElMessage.warning('需要 Admin 及以上角色才能变更套餐')
    return
  }
  const target = plans.value.find(p => p.code === selectedCode.value)
  if (!target) {
    ElMessage.warning('请选择目标套餐')
    return
  }
  if (selectedCode.value === currentCode.value) {
    ElMessage.info('未变更套餐')
    drawerOpen.value = false
    return
  }
  let msg = `确定将当前套餐变更为「${target.name}」？`
  if (isDowngrade(target)) {
    msg += '\n\n注意：新套餐配额低于当前生效配额，新配额立即生效，历史用量不做追溯减免。'
  }
  try {
    await ElMessageBox.confirm(msg, '变更套餐确认', {
      type: isDowngrade(target) ? 'warning' : 'info',
      confirmButtonText: '确认变更'
    })
  } catch {
    return
  }
  saving.value = true
  try {
    await putPlan({ planCode: target.code })
    ElMessage.success('套餐已更新')
    drawerOpen.value = false
    await load()
  } catch (e) {
    ElMessage.error(e?.message || '变更失败')
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="plans-view" v-loading="loading">
    <el-alert v-if="error" class="section" type="warning" :title="error" show-icon :closable="false" />

    <el-card class="section" shadow="never">
      <template #header>
        <div class="panel-head">
          <b>当前套餐</b>
          <span class="head-actions">
            <el-tooltip v-if="!canManage" content="需要 Admin 及以上角色" placement="top">
              <el-button size="small" disabled>变更套餐</el-button>
            </el-tooltip>
            <el-button v-else type="primary" size="small" @click="openChange">变更套餐</el-button>
          </span>
        </div>
      </template>

      <div v-if="current" class="current-plan">
        <div class="cp-head">
          <span class="cp-name">{{ current.plan?.name || '—' }}</span>
          <el-tag v-if="customized" type="warning" size="small">已定制</el-tag>
          <el-tag type="info" size="small">{{ current.plan?.code }}</el-tag>
        </div>
        <div class="cp-quota">
          <div class="cp-qrow"><span>事件数</span><b>{{ fmtQuota(quota.events) }}</b></div>
          <div class="cp-qrow"><span>回放会话数</span><b>{{ fmtQuota(quota.replay_sessions) }}</b></div>
          <div class="cp-qrow"><span>席位</span><b>{{ fmtQuota(quota.seats) }}</b></div>
          <div class="cp-qrow"><span>数据保留</span><b>{{ quota.retention_days ? `${quota.retention_days} 天` : '—' }}</b></div>
        </div>
        <div class="cp-meta muted">
          <span v-if="current.updatedBy">最近变更人：{{ current.updatedBy }}</span>
          <span v-if="current.updatedAt"> · 生效时间：{{ new Date(Number(current.updatedAt)).toLocaleString() }}</span>
        </div>
        <el-alert
          class="cp-note"
          type="info"
          :closable="false"
          show-icon
          title="配额超限提醒为团队级，请使用未限定应用的通知渠道；企业版可按团队定制配额覆盖（由运营配置）。"
        />
      </div>
    </el-card>

    <el-card class="section" shadow="never">
      <template #header>
        <div class="panel-head">
          <b>档位对比</b>
          <small>当前档位列高亮</small>
        </div>
      </template>
      <el-table :data="compareRows" border>
        <el-table-column label="能力项" prop="label" width="140" />
        <el-table-column v-for="p in plans" :key="p.code" :min-width="150">
          <template #header>
            <div class="col-head" :class="{ 'col-current': p.code === currentCode }">
              <OverflowTip :text="p.name" />
              <el-tag v-if="p.code === currentCode" type="success" size="small" class="cur-tag">当前</el-tag>
            </div>
          </template>
          <template #default="{ row }">
            <span :class="{ 'cell-current': p.code === currentCode }">{{ row.values[p.code] }}</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-drawer v-model="drawerOpen" title="变更套餐" size="460px">
      <el-alert v-if="!canManage" type="warning" :closable="false" show-icon title="当前角色无套餐变更权限（需要 Admin 及以上）" />
      <el-form v-else label-width="80px">
        <el-form-item label="目标套餐">
          <el-select v-model="selectedCode" placeholder="选择套餐" style="width: 100%">
            <el-option v-for="p in plans" :key="p.code" :label="p.name" :value="p.code" />
          </el-select>
        </el-form-item>
        <el-alert type="info" :closable="false" show-icon title="降配额将立即生效，历史用量不做追溯减免；升档请直接选择更高档位。" />
      </el-form>
      <template #footer>
        <el-button @click="drawerOpen = false">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="!canManage" @click="confirmChange">确认变更</el-button>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.plans-view { width: 100%; }
.head-actions { margin-left: auto; display: inline-flex; }
.current-plan { display: grid; gap: 14px; }
.cp-head { display: flex; align-items: center; gap: 8px; }
.cp-name { font-size: 18px; font-weight: 700; color: var(--c-text); }
.cp-quota { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 24px; max-width: 560px; }
.cp-qrow { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px dashed var(--c-border-2); }
.cp-qrow span { color: var(--c-text-muted); font-size: 13px; }
.cp-qrow b { font-family: var(--font-mono); font-size: 15px; color: var(--c-text); }
.cp-meta { font-size: 12px; }
.cp-note { margin-top: 4px; }
.col-head { display: flex; align-items: center; gap: 6px; }
.col-current { color: var(--c-primary); font-weight: 600; }
.cur-tag { margin-left: 0; }
.cell-current { color: var(--c-primary); font-weight: 600; }
.muted { color: var(--c-text-muted); }
</style>
