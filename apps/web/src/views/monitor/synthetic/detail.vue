<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api, pageLoading } from '../../../dashboard.js'
import { useAuth } from '../../../composables/useAuth'
import OverflowTip from '../../../components/OverflowTip.vue'
import MiniLineChart from '../../../components/MiniLineChart.vue'
import { QuestionFilled } from '@element-plus/icons-vue'

/**
 * B3 · 合成监控详情页：可用率/时延 KPI + 最近 N 次结果时间线 + 结果表。
 * 数据全部来自后端真实探测（/api/synthetic/:id*）；无结果显式标注，不臆造。
 * 长文本（URL / 失败原因）一律 OverflowTip（EP 2.14 红线）。
 */
const route = useRoute()
const router = useRouter()
const { syntheticEnabled } = useAuth()

const OUTCOME_META = {
  success: { label: '成功', tag: 'success' },
  fail: { label: '失败', tag: 'danger' },
  timeout: { label: '超时', tag: 'warning' }
}

const checkId = computed(() => String(route.params.id || ''))
const check = ref(null)
const timeline = ref([])
const stats1h = ref(null)
const stats24h = ref(null)
const loading = ref(false)
const loadError = ref('')
const running = ref(false)

const kpis = computed(() => {
  const s1 = stats1h.value
  const s24 = stats24h.value
  const fmtAv = s => (s && s.availability != null ? `${(Number(s.availability) * 100).toFixed(2)}%` : '—')
  const fmtMs = v => (v != null ? `${Math.round(Number(v))}ms` : '—')
  return [
    { label: '可用率（近 1h）', value: fmtAv(s1), delta: s1 ? `样本 ${Number(s1.total || 0)}` : '暂无数据', valueClass: 'value-success' },
    { label: '可用率（近 24h）', value: fmtAv(s24), delta: s24 ? `样本 ${Number(s24.total || 0)}` : '暂无数据', valueClass: 'value-primary' },
    { label: 'P50 时延（24h）', value: fmtMs(s24?.p50), delta: `超阈值 ${Number(s24?.latencyExceededCount || 0)} 次`, valueClass: '' },
    { label: 'P95 时延（24h）', value: fmtMs(s24?.p95), delta: `连续失败 ${Number(check.value?.consecutiveFailures || 0)}`, valueClass: Number(s24?.p95) > Number(check.value?.latencyThresholdMs || Infinity) ? 'value-danger' : '' }
  ]
})

/** 时间线图：时间升序重排；左轴时延，右轴结果（1=成功 / 0=失败）。 */
const timelineSeries = computed(() => {
  const items = [...timeline.value].reverse()
  if (!items.length) return []
  return [
    { name: '时延(ms)', axis: 'left', color: '#409EFF', data: items.map(item => [item.checkedAt, item.latencyMs ?? 0]) },
    { name: '结果(1成功/0失败)', axis: 'right', color: '#F56C6C', data: items.map(item => [item.checkedAt, item.ok ? 1 : 0]) }
  ]
})

function outcomeMeta(row) {
  return OUTCOME_META[row.outcome] || { label: row.outcome || '-', tag: 'info' }
}

function formatTime(ts) {
  if (!ts) return '—'
  try { return new Date(Number(ts)).toLocaleString() } catch { return '—' }
}

async function load() {
  // BUG-005 修复：能力位关闭时不再发请求（避免 503 噪音）；模板已用 v-if/v-else 只渲染占位提示。
  if (!syntheticEnabled.value || !checkId.value) return
  loading.value = true
  loadError.value = ''
  pageLoading.value = true
  try {
    const [detail, timelineData, stats1hData, stats24hData] = await Promise.all([
      api(`/api/synthetic/${checkId.value}`, { requestKey: 'synthetic:detail' }),
      api(`/api/synthetic/${checkId.value}/timeline?limit=50`, { requestKey: 'synthetic:timeline' }),
      api(`/api/synthetic/${checkId.value}/stats?window=1h`, { requestKey: 'synthetic:stats1h' }),
      api(`/api/synthetic/${checkId.value}/stats?window=24h`, { requestKey: 'synthetic:stats24h' })
    ])
    check.value = detail?.check || null
    timeline.value = Array.isArray(timelineData?.items) ? timelineData.items : []
    stats1h.value = stats1hData || null
    stats24h.value = stats24hData || null
  } catch (error) {
    if (error?.code !== 'ABORT_ERR') loadError.value = error.message || '探针详情加载失败'
  } finally {
    loading.value = false
    pageLoading.value = false
  }
}

/** 立即探测：同步执行单次并刷新页面数据。 */
async function runNow() {
  running.value = true
  try {
    const data = await api(`/api/synthetic/${checkId.value}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const result = data?.result
    if (result?.ok) ElMessage.success(`探测成功：HTTP ${result.status_code ?? '-'} · ${result.latency_ms ?? '-'}ms`)
    else ElMessage.error(`探测失败：${result?.error || result?.outcome || '未知原因'}`)
    await load()
  } catch (error) {
    ElMessage.error(error.message || '探测失败')
  } finally {
    running.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="synthetic-detail">
    <div class="detail-head">
      <el-button text @click="router.push('/synthetic')">← 返回列表</el-button>
      <div class="head-main" v-if="check">
        <h2><OverflowTip :text="check.name" /></h2>
        <div class="sub">
          <span class="sub-url"><OverflowTip :text="check.url || '-'" /></span>
          · 间隔 {{ check.intervalSeconds }}s
          · 期望 {{ check.expectedStatus }}
          <el-tag v-if="check.keyword" size="small" effect="plain" class="head-tag">关键词断言</el-tag>
          <el-tag v-if="check.lastStatus && check.lastStatus !== 'unknown'" size="small" effect="light" :type="OUTCOME_META[check.lastStatus]?.tag || 'info'" class="head-tag">
            {{ OUTCOME_META[check.lastStatus]?.label || check.lastStatus }}
          </el-tag>
        </div>
      </div>
      <div class="head-actions">
        <el-button type="primary" :loading="running" @click="runNow">立即探测</el-button>
      </div>
    </div>

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
        <h3>最近 {{ timeline.length }} 次结果时间线</h3>
        <span class="muted">左轴时延（ms），右轴探测结果（1=成功 / 0=失败）；失败原因见下方结果表</span>
      </div>
      <MiniLineChart v-if="timelineSeries.length" :series="timelineSeries" height="280px" :axis-names="{ left: 'ms', right: 'ok' }" />
      <el-empty v-else description="暂无探测结果 — 点击「立即探测」生成第一条记录" :image-size="80" />
    </section>

    <section class="section">
      <div class="block-head">
        <h3>探测结果表</h3>
        <span class="muted">最近 50 次，新结果在上；响应体原文永不落库（数据最小化）</span>
      </div>
      <el-table :data="timeline" v-loading="loading">
        <el-table-column label="时间" width="180">
          <template #default="{ row }">{{ formatTime(row.checkedAt) }}</template>
        </el-table-column>
        <el-table-column label="结果" width="100">
          <template #default="{ row }">
            <el-tag :type="outcomeMeta(row).tag" effect="light" size="small">{{ outcomeMeta(row).label }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态码" width="90">
          <template #default="{ row }">{{ row.statusCode ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="时延" width="100">
          <template #default="{ row }">{{ row.latencyMs != null ? `${row.latencyMs}ms` : '—' }}</template>
        </el-table-column>
        <el-table-column label="超阈值" width="90">
          <template #default="{ row }">
            <el-tag v-if="row.latencyExceeded" type="warning" effect="plain" size="small">超阈值</el-tag>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="失败原因" min-width="260">
          <template #default="{ row }">
            <OverflowTip v-if="row.error" :text="row.error" />
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!timeline.length && !loading" description="暂无探测结果" :image-size="60" />
    </section>
  </div>
</template>

<style scoped>
.detail-head { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 8px; }
.head-main { flex: 1; min-width: 0; }
.head-main h2 { margin: 0; font-size: 18px; }
.head-main .sub { color: var(--el-text-color-secondary); font-size: 12px; margin-top: 4px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sub-url { min-width: 0; max-width: 480px; }
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
.kpi-delta { color: var(--el-text-color-secondary); font-size: 12px; margin-top: 2px; }
</style>
