<script setup>
/**
 * D3 · 用量页（PRD 15 §8）：KpiGrid 四卡 + 配额进度 + 超限告警条 + 按日趋势 + 按应用拆分表。
 * - 能力位 false 由容器 billing/index.vue 统一拦截（本组件仅在 meteringEnabled 时挂载，不主动发请求）；
 * - 长文本列一律 <OverflowTip>（EP 2.14 红线，禁用原生 show-overflow-tooltip）；
 * - 席位卡在 seatsSupported=false 时显示「—（当前部署无团队维度）」，不填 0 冒充；
 * - quota === -1 → 「不限量」（unlimited 标记，来自后端）；
 * - hard 文案不得宣称「已停止接收」（P0 hard_action='none'）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useAuth } from '../../composables/useAuth'
import OverflowTip from '../../components/OverflowTip.vue'
import KpiGrid from '../../components/KpiGrid.vue'
import MiniLineChart from '../../components/MiniLineChart.vue'
import QuotaProgress from './QuotaProgress.vue'
import { getUsage, getDaily, getByApp } from '../../api/metering.js'

const { meteringEnabled } = useAuth()

const period = ref(currentMonth())
const usage = ref(null)
const daily = ref([])
const appRows = ref([])
const loading = ref(false)
const loadError = ref('')
const dailyAppId = ref('')
const dailyAppName = ref('')

const METRIC_LABEL = { events: '事件', replay_sessions: '回放会话', seats: '席位' }

function currentMonth() {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
function fmt(n) {
  return Number(n || 0).toLocaleString()
}
function labelOf(metric) {
  return METRIC_LABEL[metric] || metric
}
/** yyyyMMdd → 本地零点毫秒时间戳（供 MiniLineChart 时间轴，formatTime 用本地时区展示为 MM-DD 00:00）。 */
function dayToTs(day) {
  const s = String(day)
  return new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8))).getTime()
}

const quotaMetrics = computed(() => (Array.isArray(usage.value?.metrics) ? usage.value.metrics : []))
const plan = computed(() => usage.value?.plan || {})
const seatsSupported = computed(() => Boolean(usage.value?.seatsSupported))
const softLimitPct = computed(() => Number(plan.value?.softLimitPct) || 80)

const kpis = computed(() => {
  const u = usage.value
  if (!u) return []
  const find = m => (u.metrics || []).find(x => x.metric === m) || {}
  const ev = find('events')
  const rp = find('replay_sessions')
  const st = find('seats')
  return [
    {
      label: '本月事件数',
      value: fmt(ev.used ?? 0),
      delta: ev.unlimited ? '配额 不限量' : `配额 ${fmt(ev.quota)}`,
      valueClass: ev.level === 'hard' ? 'value-danger' : 'value-primary'
    },
    {
      label: '本月回放会话数',
      value: fmt(rp.used ?? 0),
      delta: rp.unlimited ? '配额 不限量' : `配额 ${fmt(rp.quota)}`,
      valueClass: rp.level === 'hard' ? 'value-danger' : ''
    },
    seatsSupported.value
      ? {
          label: '当前席位',
          value: st.used == null ? '—' : fmt(st.used),
          delta: st.unlimited ? '配额 不限量' : `配额 ${fmt(st.quota)}`,
          valueClass: st.level === 'hard' ? 'value-danger' : 'value-success'
        }
      : { label: '当前席位', value: '—', delta: '当前部署无团队维度', valueClass: '' },
    {
      label: '距周期结束',
      value: `${u.daysRemaining ?? 0} 天`,
      delta: `周期 ${u.period || period.value}`,
      valueClass: ''
    }
  ]
})

const hardMetrics = computed(() => quotaMetrics.value.filter(m => m.level === 'hard'))
const softMetrics = computed(() => quotaMetrics.value.filter(m => m.level === 'soft'))

const chartSeries = computed(() => [
  { name: '事件数', data: daily.value.map(p => [dayToTs(p.day), Number(p.events || 0)]), color: '#4f46e5' },
  { name: '回放会话数', data: daily.value.map(p => [dayToTs(p.day), Number(p.replay_sessions || 0)]), color: '#0ea5e9', axis: 'right' }
])

async function load() {
  if (!meteringEnabled.value) return
  loading.value = true
  loadError.value = ''
  try {
    const [u, d, a] = await Promise.all([
      getUsage(period.value),
      getDaily({ period: period.value, appId: dailyAppId.value || undefined }),
      getByApp(period.value)
    ])
    usage.value = u
    daily.value = Array.isArray(d) ? d : []
    appRows.value = Array.isArray(a) ? a : []
  } catch (error) {
    loadError.value = error?.message || '用量数据加载失败'
    usage.value = null
    daily.value = []
    appRows.value = []
  } finally {
    loading.value = false
  }
}

function viewApp(row) {
  dailyAppId.value = row.appId
  dailyAppName.value = row.appName || row.appId
  load()
}
function clearAppFilter() {
  dailyAppId.value = ''
  dailyAppName.value = ''
  load()
}

watch(period, () => load())
onMounted(load)
</script>

<template>
  <div class="usage-view" v-loading="loading">
    <div class="caliber-note">
      <span class="ci">i</span>
      <span>
        口径说明：统计周期为<b>自然月（UTC）</b>；<b>事件数</b>为实际落库事件行数（客户端采样丢弃与入库失败不计）；
        <b>回放会话数</b>为去重会话数（分段续传不重复计）；<b>席位</b>为团队活跃成员数（按日快照取当月最大值）。
      </span>
    </div>

    <el-alert v-if="loadError" class="section" type="warning" :title="loadError" show-icon :closable="false" />

    <el-alert
      v-for="m in hardMetrics"
      :key="'hard-' + m.metric"
      class="section"
      type="error"
      :closable="false"
      show-icon
      :title="`${labelOf(m.metric)}用量已达配额上限`"
      :description="`已用 ${fmt(m.used)} / 配额 ${fmt(m.quota)}。当前阶段不阻断数据接收（hard_action=${plan.hardAction || 'none'}），请及时升档或调低采样率。`"
    />
    <el-alert
      v-for="m in softMetrics"
      :key="'soft-' + m.metric"
      class="section"
      type="warning"
      :closable="false"
      show-icon
      :title="`${labelOf(m.metric)}用量接近配额上限`"
      :description="`已用 ${fmt(m.used)} / 配额 ${fmt(m.quota)}（${Math.round(m.pct)}%）。超出后可能影响数据接收，建议提前规划。`"
    />

    <KpiGrid :items="kpis" />

    <el-card class="section" shadow="never">
      <template #header>
        <div class="panel-head">
          <b>配额进度</b>
          <small>软限 {{ softLimitPct }}% 预警 · 硬限 100% 警示（P0 不阻断接收）</small>
        </div>
      </template>
      <QuotaProgress :metrics="quotaMetrics" :soft-limit-pct="softLimitPct" />
    </el-card>

    <el-card class="section" shadow="never">
      <template #header>
        <div class="panel-head">
          <b>按日趋势</b>
          <small v-if="dailyAppName">正在查看：{{ dailyAppName }}（按日明细）</small>
          <small v-else>全应用合计</small>
        </div>
      </template>
      <div class="daily-toolbar">
        <el-tag v-if="dailyAppName" type="info" closable @close="clearAppFilter">应用：{{ dailyAppName }}</el-tag>
        <span v-else class="muted">全应用合计</span>
      </div>
      <MiniLineChart
        :series="chartSeries"
        :axis-names="{ left: '事件数', right: '回放会话数' }"
        height="260px"
        empty-text="本月暂无用量数据"
      />
    </el-card>

    <el-card class="section" shadow="never">
      <template #header>
        <div class="panel-head">
          <b>按应用拆分</b>
          <small>按事件数降序（Top 50）</small>
        </div>
      </template>
      <el-table :data="appRows" row-key="appId" empty-text="本月暂无应用用量">
        <el-table-column label="应用" min-width="180">
          <template #default="{ row }"><OverflowTip :text="row.appName || row.appId" /></template>
        </el-table-column>
        <el-table-column label="事件数" width="120" align="right">
          <template #default="{ row }">{{ fmt(row.events) }}</template>
        </el-table-column>
        <el-table-column label="占比" min-width="160">
          <template #default="{ row }">
            <div class="dist-bar" style="grid-template-columns: 1fr 56px; margin: 0">
              <div class="db-track"><div class="db-fill" :style="{ width: Math.min(100, row.pct || 0) + '%' }"></div></div>
              <div class="db-val">{{ row.pct }}%</div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="回放会话数" width="130" align="right">
          <template #default="{ row }">{{ fmt(row.replay_sessions) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="130" fixed="right">
          <template #default="{ row }">
            <el-button text type="primary" @click="viewApp(row)">查看该应用</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
.usage-view { width: 100%; }
.daily-toolbar { margin-bottom: 10px; display: flex; align-items: center; gap: 8px; min-height: 24px; }
.muted { color: var(--c-text-muted); font-size: 12px; }
</style>
