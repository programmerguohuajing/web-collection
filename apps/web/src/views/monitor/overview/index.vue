<script setup>
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import TrendChart from '../../../components/TrendChart.vue'
import KpiGrid from '../../../components/KpiGrid.vue'
import OverviewDistribution from '../../../components/OverviewDistribution.vue'
import { events, issues, replays, summary } from '../../../dashboard.js'
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
</script>

<template>
  <div class="page-heading"><div><h1>实时概览</h1><p>过去 24 小时全站遥测数据汇总</p></div><div class="segmented"><button v-for="item in [{ label: '1h', value: '1h' }, { label: '24h', value: '24h' }, { label: '7d', value: '7d' }, { label: '30d', value: '30d' }]" :key="item.value" type="button" :class="{ active: selectedRange === item.value }" @click="selectedRange = item.value">{{ item.label }}</button></div></div>

  <KpiGrid :items="overviewKpis" />

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
      <el-table-column label="页面 / 接口" min-width="210" show-overflow-tooltip><template #default="{ row }">{{ row.path || row.url || '-' }}</template></el-table-column>
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
@media (max-width: 1000px) { .overview-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 760px) { .overview-metrics { grid-template-columns: 1fr; } }
</style>
