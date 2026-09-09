<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, pageLoading } from '../../../dashboard.js'
import { useAuth } from '../../../composables/useAuth'
import OverflowTip from '../../../components/OverflowTip.vue'
import MiniLineChart from '../../../components/MiniLineChart.vue'

/**
 * B2 · SLO 详情页：错误预算概览 + 达标率/燃烧率趋势 + 燃尽告警列表。
 * 数据全部来自后端真实计算（/api/slo/:id*）；无快照时显式标注，不臆造。
 */
const route = useRoute()
const router = useRouter()
const { sloEnabled } = useAuth()

const SLI_LABELS = { error_rate: '错误率', availability: '可用性', latency_threshold: '时延达标' }
const STATUS_META = {
  healthy: { label: '达标', tag: 'success' },
  warning: { label: '预算过半', tag: 'warning' },
  burnt: { label: '预算耗尽', tag: 'danger' }
}

const sloId = computed(() => String(route.params.id || ''))
const definition = ref(null)
const budget = ref(null)
const trend = ref([])
const alerts = ref([])
const alertsTotal = ref(0)
const loading = ref(false)
const loadError = ref('')
const computing = ref(false)

const statusMeta = computed(() => STATUS_META[budget.value?.status] || null)

const kpis = computed(() => {
  const b = budget.value
  if (!b || b.noData) {
    return [
      { label: '达标率', value: '—', delta: '暂无快照', valueClass: '' },
      { label: '预算剩余', value: '—', delta: '请先「立即计算」', valueClass: '' },
      { label: '燃烧率', value: '—', delta: '快照约 5 分钟刷新', valueClass: '' },
      { label: '状态', value: '无数据', delta: '窗口内暂无事件', valueClass: '' }
    ]
  }
  return [
    { label: '达标率', value: `${(Number(b.goodRatio) * 100).toFixed(3)}%`, delta: `目标 ${(definition.value?.objective * 100).toFixed(2)}%`, valueClass: 'value-success' },
    { label: '预算剩余', value: `${(Math.max(0, 1 - Number(b.budgetUsed)) * 100).toFixed(1)}%`, delta: `已消耗 ${(Number(b.budgetUsed) * 100).toFixed(1)}%`, valueClass: 'value-primary' },
    { label: '燃烧率', value: `${Number(b.burnRate).toFixed(2)}×`, delta: `坏/总 ${Number(b.bad || 0).toLocaleString()} / ${Number(b.total || 0).toLocaleString()}`, valueClass: Number(b.burnRate) > 1 ? 'value-danger' : '' },
    { label: '状态', value: statusMeta.value?.label || b.status, delta: `快照 ${formatTime(b.snapAt)}`, valueClass: 'value-purple' }
  ]
})

const trendSeries = computed(() => {
  const points = trend.value
  if (!points.length) return []
  return [
    { name: '达标率(%)', axis: 'left', color: '#67C23A', data: points.map(p => [p.bucket, Number((p.goodRatio * 100).toFixed(3))]) },
    { name: '燃烧率(×)', axis: 'right', color: '#F56C6C', data: points.map(p => [p.bucket, Number(p.burnRate.toFixed(2))]) }
  ]
})

function formatTime(ts) {
  if (!ts) return '—'
  try { return new Date(Number(ts)).toLocaleString() } catch { return '—' }
}

async function load() {
  if (!sloId.value) return
  loading.value = true
  loadError.value = ''
  pageLoading.value = true
  try {
    const end = Date.now()
    const start = end - 30 * 86400000
    const [detail, trendData, alertData] = await Promise.all([
      api(`/api/slo/${sloId.value}`, { requestKey: 'slo:detail' }),
      api(`/api/slo/${sloId.value}/trend?start=${start}&end=${end}`, { requestKey: 'slo:trend' }),
      api(`/api/slo/${sloId.value}/alerts?page=1&pageSize=20`, { requestKey: 'slo:alerts' })
    ])
    definition.value = detail?.definition || null
    budget.value = detail?.budget || null
    trend.value = Array.isArray(trendData?.points) ? trendData.points : []
    alerts.value = Array.isArray(alertData?.items) ? alertData.items : []
    alertsTotal.value = Number(alertData?.total ?? alerts.value.length)
  } catch (error) {
    if (error?.code !== 'ABORT_ERR') loadError.value = error.message || 'SLO 详情加载失败'
  } finally {
    loading.value = false
    pageLoading.value = false
  }
}

async function computeNow() {
  computing.value = true
  try {
    await api(`/api/slo/${sloId.value}/compute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    await load()
  } catch (error) {
    loadError.value = error.message || '计算失败'
  } finally {
    computing.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="slo-detail">
    <div class="detail-head">
      <el-button text @click="router.push('/slo')">← 返回列表</el-button>
      <div class="head-main" v-if="definition">
        <h2><OverflowTip :text="definition.name" /></h2>
        <div class="sub">
          {{ SLI_LABELS[definition.sliType] || definition.sliType }}
          · 目标 {{ (definition.objective * 100).toFixed(2) }}%
          · 窗口 {{ definition.windowDays }} 天
          · 应用 {{ definition.appId }}
          <el-tag v-if="statusMeta" :type="statusMeta.tag" effect="light" size="small" class="head-tag">{{ statusMeta.label }}</el-tag>
        </div>
      </div>
      <div class="head-actions">
        <el-button type="primary" :loading="computing" @click="computeNow">立即计算</el-button>
      </div>
    </div>

    <el-alert v-if="!sloEnabled" class="section" type="info" :closable="false" show-icon title="当前部署未开启 SLO 能力，数据可能不可用" />
    <el-alert v-if="loadError" class="section" type="error" :title="loadError" show-icon />

    <section class="section kpi-row">
      <el-card v-for="item in kpis" :key="item.label" shadow="never" class="kpi-card">
        <div class="kpi-label">{{ item.label }}</div>
        <div class="kpi-value" :class="item.valueClass">{{ item.value }}</div>
        <div class="kpi-delta">{{ item.delta }}</div>
      </el-card>
    </section>

    <section class="section">
      <div class="block-head">
        <h3>达标率 / 燃烧率趋势（按日，近 30 天）</h3>
        <span class="muted">来自定时快照聚合，约 5 分钟刷新一次</span>
      </div>
      <MiniLineChart v-if="trendSeries.length" :series="trendSeries" height="280px" />
      <el-empty v-else description="暂无快照数据 — 点击「立即计算」生成第一份快照" :image-size="80" />
    </section>

    <section class="section">
      <div class="block-head">
        <h3>燃尽告警（{{ alertsTotal }}）</h3>
        <span class="muted">多窗口多燃烧率判定（1h×14.4 / 6h×6 / 3d×3 / 30d×1），复用告警中心通道投递</span>
      </div>
      <el-table :data="alerts" v-loading="loading">
        <el-table-column label="时间" width="180">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="级别" width="100">
          <template #default="{ row }">
            <el-tag :type="row.level === 'critical' ? 'danger' : 'warning'" effect="light" size="small">{{ row.level }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="燃烧率" width="100">
          <template #default="{ row }">{{ Number(row.value).toFixed(1) }}×</template>
        </el-table-column>
        <el-table-column label="内容" min-width="280">
          <template #default="{ row }"><OverflowTip :text="row.message || '-'" /></template>
        </el-table-column>
        <el-table-column label="投递状态" width="110">
          <template #default="{ row }">{{ row.status || 'pending' }}</template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!alerts.length && !loading" description="暂无燃尽告警" :image-size="60" />
    </section>
  </div>
</template>

<style scoped>
.detail-head { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 8px; }
.head-main { flex: 1; min-width: 0; }
.head-main h2 { margin: 0; font-size: 18px; }
.head-main .sub { color: var(--el-text-color-secondary); font-size: 12px; margin-top: 4px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.head-tag { margin-left: 4px; }
.block-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; }
.block-head h3 { margin: 0; font-size: 15px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.kpi-card :deep(.el-card__body) { padding: 14px 16px; }
.kpi-label { color: var(--el-text-color-secondary); font-size: 12px; }
.kpi-value { font-size: 22px; font-weight: 700; margin-top: 4px; }
.kpi-value.value-success { color: var(--el-color-success); }
.kpi-value.value-danger { color: var(--el-color-danger); }
.kpi-value.value-primary { color: var(--el-color-primary); }
.kpi-value.value-purple { color: var(--el-color-purple, #9254de); }
.kpi-delta { color: var(--el-text-color-secondary); font-size: 12px; margin-top: 2px; }
</style>
