<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import TrendChart from '../../../components/TrendChart.vue'
import { events, issues, replays, summary } from '../../../dashboard.js'
import { formatDuration, readableText, scoreWebVitals } from '../../../utils/format.js'

const router = useRouter()
const primaryIssue = computed(() => issues.value.find(item => item.status !== 'resolved') || issues.value[0])
const affectedUsers = computed(() => issues.value.reduce((sum, item) => sum + Number(item.affectedUsers || 0), 0))
const p95 = computed(() => summary.value?.perf?.lcp || summary.value?.performance?.lcp?.p95 || 0)
const health = computed(() => summary.value?.perfScore || scoreWebVitals(summary.value?.perf))
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
  <div class="page-heading"><div><h1>总览</h1><p>全局健康与活动概览</p></div></div>

  <section v-if="primaryIssue" class="incident-banner">
    <el-tag type="danger" effect="dark">P1</el-tag>
    <div><b>检测到高优先级问题</b><strong>{{ readableText(primaryIssue.message, primaryIssue.name) }}</strong><small>发生于 {{ new Date(primaryIssue.lastSeen).toLocaleString() }} · 影响用户 {{ primaryIssue.affectedUsers || primaryIssue.count || 0 }}</small></div>
    <el-button type="primary" @click="openIssue">查看高优先级问题</el-button>
  </section>

  <section class="metrics overview-metrics">
    <el-card shadow="never"><span>错误数</span><strong class="danger-value">{{ summary?.errors ?? summary?.issueCount ?? issues.length }}</strong><small>当前筛选范围内</small></el-card>
    <el-card shadow="never"><span>受影响用户</span><strong class="violet-value">{{ affectedUsers }}</strong><small>关联错误与会话</small></el-card>
    <el-card shadow="never"><span>P95 页面加载耗时</span><strong class="primary-value">{{ p95 ? formatDuration(p95) : '-' }}</strong><small>Core Web Vitals</small></el-card>
    <el-card shadow="never"><span>活跃会话</span><strong class="success-value">{{ summary?.users ?? replays.length }}</strong><small>当前筛选范围内</small></el-card>
    <el-card shadow="never"><span>页面健康度</span><strong class="health-value">{{ health ? `${health.score} / 100` : '-' }}</strong><small>{{ health ? `Web Vitals · ${health.grade} 级` : '暂无 Web Vitals 数据' }}</small></el-card>
  </section>

  <el-card shadow="never" class="panel section trend-panel">
    <template #header><div class="panel-head"><div><h2>错误与性能趋势</h2><small>错误数、受影响用户与页面性能关联</small></div><div class="chart-legend"><span class="red-dot">错误数</span><span class="violet-dot">受影响用户</span><span class="blue-dot">P95 加载耗时</span></div></div></template>
    <TrendChart :events="events" />
  </el-card>

  <el-card shadow="never" class="panel section activity-panel">
    <template #header><div class="panel-head"><div><h2>统一活动（相关性视图）</h2><small>问题、追踪、日志与回放聚合</small></div><el-button>筛选</el-button></div></template>
    <el-table :data="activityRows" empty-text="暂无活动数据">
      <el-table-column label="发生时间" width="150"><template #default="{ row }">{{ new Date(row.ts).toLocaleString() }}</template></el-table-column>
      <el-table-column label="问题 / 级别" min-width="250"><template #default="{ row }"><b class="activity-title">{{ row.title }}</b><el-tag v-if="row.level !== '-'" size="small" :type="row.level === 'P1' ? 'danger' : row.level === 'P2' ? 'warning' : 'primary'">{{ row.level }}</el-tag></template></el-table-column>
      <el-table-column label="影响" width="100"><template #default="{ row }">{{ row.impact }} 用户</template></el-table-column>
      <el-table-column prop="path" label="页面 / 接口" min-width="210" show-overflow-tooltip />
      <el-table-column label="追踪" min-width="150"><template #default="{ row }"><router-link v-if="row.traceId" :to="`/traces?keyword=${row.traceId}`">{{ row.traceId }}</router-link><span v-else>-</span></template></el-table-column>
      <el-table-column prop="logs" label="日志" width="80" />
      <el-table-column label="会话回放" width="120"><template #default="{ row }"><el-button v-if="row.replay" link type="primary" @click="openReplay(row.replay)">播放会话</el-button><span v-else>-</span></template></el-table-column>
      <el-table-column prop="release" label="发布版本" width="110" />
    </el-table>
  </el-card>
</template>

<style scoped>
.overview-metrics { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.health-value { color: #0f766e; }
@media (max-width: 1000px) { .overview-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 760px) { .overview-metrics { grid-template-columns: 1fr; } }
</style>
