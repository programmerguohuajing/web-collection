<script setup>
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import TrendChart from '../../../components/TrendChart.vue'
import KpiGrid from '../../../components/KpiGrid.vue'
import OverviewDistribution from '../../../components/OverviewDistribution.vue'
import OverflowTip from '../../../components/OverflowTip.vue'
import { events, issues, replays, summary, api } from '../../../dashboard.js'
import { formatDuration, readableText } from '../../../utils/format.js'

const router = useRouter()
const primaryIssue = computed(() => issues.value.find(item => item.status !== 'resolved') || issues.value[0])
const overviewKpis = computed(() => [
  { label: '今日错误数', value: Number(summary.value?.errors ?? summary.value?.issueCount ?? issues.value.length).toLocaleString(), delta: '当前筛选范围内', valueClass: 'value-danger' },
  { label: '平均首屏 FCP', value: summary.value?.perf?.fcp != null ? formatDuration(summary.value.perf.fcp) : '-', delta: 'Core Web Vitals', valueClass: 'value-primary' },
  { label: 'Apdex 体验分', value: summary.value?.apdex != null ? Number(summary.value.apdex).toFixed(2) : '-', delta: '体验评分', valueClass: 'value-purple' },
  { label: '在线用户', value: Number(summary.value?.users ?? replays.value.length).toLocaleString(), delta: '实时', valueClass: 'value-success' }
])
const selectedRange = ref('7d')
const activityRows = computed(() => {
  const errorRows = issues.value.slice(0, 3).map(item => ({
    ts: item.lastSeen, title: readableText(item.message, item.name), level: item.status === 'regression' ? 'P1' : 'P2',
    impact: item.affectedUsers || item.count || 0, path: item.url || '-', traceId: item.props?.traceId,
    logs: item.count || 0, replay: item.props?.sessionId, release: item.release
  }))
  const eventRows = events.value.filter(item => item.type !== 'error').slice(0, 4).map(item => ({
    ts: item.ts, title: readableText(item.message, item.name, item.metric, item.type), level: item.type === 'perf' ? 'P3' : '-',
    impact: item.userId ? 1 : 0, path: item.path || item.url || '-', traceId: item.traceId,
    logs: item.type === 'log' ? 1 : 0, replay: item.sessionId, release: item.release
  }))
  return [...errorRows, ...eventRows].sort((a, b) => Number(b.ts) - Number(a.ts)).slice(0, 6)
})

function openIssue() { router.push('/errors') }
function openReplay(sessionId) { router.push({ path: '/replays', query: { replayId: sessionId } }) }

// ── 采集健康（PRD P0/P2：让业务方直观区分「没流量」与「采集挂了」）──
const ingestionHealth = ref(null)
const ingestionError = ref(false)
let ingestionTimer = null
async function loadIngestionHealth() {
  try {
    ingestionHealth.value = await api('/api/monitoring/ingestion')
    ingestionError.value = false
  } catch {
    ingestionError.value = true
  }
}
// 自动刷新开关：0 = 暂停（暂为缓解 D1 行读爆量），恢复时改回 30000
const INGESTION_REFRESH_MS = 0
onMounted(() => {
  loadIngestionHealth()
  if (INGESTION_REFRESH_MS > 0) ingestionTimer = setInterval(loadIngestionHealth, INGESTION_REFRESH_MS)
})
onUnmounted(() => { if (ingestionTimer) clearInterval(ingestionTimer) })

const ingestionStatusType = computed(() => {
  const s = ingestionHealth.value?.ingestion?.status
  if (s === 'critical') return 'danger'
  if (s === 'degraded') return 'warning'
  return 'success'
})
const ingestionStatusText = computed(() => {
  const s = ingestionHealth.value?.ingestion?.status
  return { healthy: '采集正常', degraded: '采集异常（降级）', critical: '采集中断' }[s] || '未知'
})
const ingestionStalledText = computed(() => {
  const ms = ingestionHealth.value?.ingestion?.stalledMs
  if (ms == null) return '无数据'
  const m = Math.floor(ms / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  return `${h} 小时 ${m % 60} 分钟前`
})
</script>

<template>
  <div class="page-heading"><div><h1>实时概览</h1><p>过去 24 小时全站遥测数据汇总</p></div><div class="segmented"><button v-for="item in [{ label: '1h', value: '1h' }, { label: '24h', value: '24h' }, { label: '7d', value: '7d' }, { label: '30d', value: '30d' }]" :key="item.value" type="button" :class="{ active: selectedRange === item.value }" @click="selectedRange = item.value">{{ item.label }}</button></div></div>

  <KpiGrid :items="overviewKpis" />

  <el-card shadow="never" class="panel section ingestion-health-panel">
    <template #header><div class="panel-head"><div><h2>采集健康</h2><small>SDK 采集与入库链路状态</small></div><el-tag :type="ingestionStatusType" effect="dark">{{ ingestionStatusText }}</el-tag></div></template>
    <div v-if="ingestionError" class="ingestion-error">监控接口暂不可达</div>
    <div v-else-if="ingestionHealth" class="ingestion-metrics">
      <div class="im"><span class="im-k">最后入库</span><span class="im-v">{{ ingestionStalledText }}</span></div>
      <div class="im"><span class="im-k">窗口接收 / 入库</span><span class="im-v">{{ ingestionHealth.ingestion.received }} / {{ ingestionHealth.ingestion.written }}</span></div>
      <div class="im"><span class="im-k">入库失败</span><span class="im-v" :class="{ danger: ingestionHealth.ingestion.failed > 0 }">{{ ingestionHealth.ingestion.failed }}</span></div>
      <div class="im"><span class="im-k">近 1h 入库告警</span><span class="im-v" :class="{ danger: ingestionHealth.ingestion.ingestErrorCount > 0 }">{{ ingestionHealth.ingestion.ingestErrorCount }}</span></div>
      <div class="im im-wide"><span class="im-k">最近错误</span><span class="im-v err">{{ ingestionHealth.ingestion.lastErrorMessage || '无' }}</span></div>
    </div>
    <div v-else class="ingestion-error">加载中…</div>
  </el-card>

  <section class="grid overview-insights">
    <el-card shadow="never" class="panel trend-panel">
      <template #header><div class="panel-head"><div><h2>错误 &amp; 请求趋势</h2><small>last 24h</small></div><div class="chart-legend"><span class="red-dot">错误数</span><span class="blue-dot">请求数</span></div></div></template>
      <TrendChart :events="events" />
    </el-card>
    <OverviewDistribution :summary="summary" :events="events" />
  </section>

  <el-card shadow="never" class="panel section activity-panel">
    <template #header><div class="panel-head"><div><h2>最近错误</h2><small>问题、追踪、日志与回放聚合</small></div><el-button>筛选</el-button></div></template>
    <el-table :data="activityRows" empty-text="暂无活动数据">
      <el-table-column label="发生时间" width="200" cell-class-name="time-cell"><template #default="{ row }">{{ new Date(row.ts).toLocaleString() }}</template></el-table-column>
      <el-table-column label="问题 / 级别" min-width="250"><template #default="{ row }"><b class="activity-title">{{ row.title }}</b><el-tag v-if="row.level !== '-'" size="small" :type="row.level === 'P1' ? 'danger' : row.level === 'P2' ? 'warning' : 'primary'">{{ row.level }}</el-tag></template></el-table-column>
      <el-table-column label="影响" width="100"><template #default="{ row }">{{ row.impact }} 用户</template></el-table-column>
      <el-table-column label="页面 / 接口" min-width="210"><template #default="{ row }"><OverflowTip :text="row.path || row.url || '-'" /></template></el-table-column>
      <el-table-column label="追踪" min-width="150"><template #default="{ row }"><router-link v-if="row.traceId" :to="`/traces?traceId=${row.traceId}`">{{ row.traceId }}</router-link><span v-else>-</span></template></el-table-column>
      <el-table-column prop="logs" label="日志" width="80" />
      <el-table-column label="会话回放" width="120"><template #default="{ row }"><el-button v-if="row.replay" link type="primary" @click="openReplay(row.replay)">播放会话</el-button><span v-else>-</span></template></el-table-column>
      <el-table-column prop="release" label="发布版本" width="110" />
    </el-table>
  </el-card>

  <section v-if="primaryIssue" class="incident-banner incident-banner--secondary">
    <el-tag type="danger" effect="dark">P1</el-tag>
    <div><b>检测到高优先级问题</b><strong>{{ readableText(primaryIssue.message, primaryIssue.name) }}</strong><small>发生于 {{ new Date(primaryIssue.lastSeen).toLocaleString() }} · 影响用户 {{ primaryIssue.affectedUsers || primaryIssue.count || 0 }}</small></div>
    <el-button type="primary" @click="openIssue">查看高优先级问题</el-button>
  </section>
</template>

<style scoped>
.overview-metrics { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.health-value { color: #0f766e; }
.ingestion-health-panel .ingestion-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px 24px; }
.ingestion-health-panel .im { display: flex; flex-direction: column; gap: 4px; }
.ingestion-health-panel .im-wide { grid-column: 1 / -1; }
.ingestion-health-panel .im-k { font-size: 12px; color: var(--c-text-faint); }
.ingestion-health-panel .im-v { font-size: 16px; font-weight: 600; min-height: 22px; }
.ingestion-health-panel .im-v.danger { color: #ef4444; }
.ingestion-health-panel .im-v.err { font-size: 13px; font-weight: 400; color: #b91c1c; word-break: break-all; }
.ingestion-health-panel .ingestion-error { color: var(--c-text-faint); padding: 8px 0; }
@media (max-width: 1000px) { .overview-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 760px) {
  .overview-metrics { grid-template-columns: 1fr; }
  .ingestion-health-panel .ingestion-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
