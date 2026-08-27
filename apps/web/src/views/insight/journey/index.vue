<script setup>
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api, pageLoading } from '../../../dashboard.js'
import { useFilterStore } from '../../../stores/filters.js'

const route = useRoute()
const router = useRouter()
const store = useFilterStore()

// ---------------- 检索区（FR-1：URL 带参可分享） ----------------
const searchForm = reactive({
  type: ['user', 'device', 'session', 'trace'].includes(route.query.type) ? route.query.type : 'session',
  value: String(route.query.value || ''),
  range: '24h'
})
const TYPE_OPTIONS = [
  { value: 'session', label: '会话 ID' },
  { value: 'user', label: '用户 ID' },
  { value: 'device', label: '设备 ID' },
  { value: 'trace', label: 'TraceId' }
]
const loading = ref(false)
const loadError = ref('')
const sessions = ref([])
const sessionStats = reactive({ events: 0, errors: 0 })

// ---------------- 会话列表 / 时间线 / 详情 ----------------
const selectedSession = ref(null)
const timeline = ref(null) // { session, events }
const timelineLoading = ref(false)
const selectedEvent = ref(null)
const aiDrawer = ref(false)

const rangeStart = () => searchForm.range === '7d' ? Date.now() - 7 * 86400000 : Date.now() - 86400000

function syncUrl() {
  router.replace({ query: { ...route.query, type: searchForm.type, value: searchForm.value || undefined } })
}

async function loadSessions() {
  const value = searchForm.value.trim()
  if (!value) return ElMessage.warning('请输入标识值')
  syncUrl()
  loading.value = true
  loadError.value = ''
  pageLoading.value = true
  try {
    const params = new URLSearchParams({ type: searchForm.type, value })
    if (store.appId) params.set('appId', store.appId)
    params.set('startTime', String(rangeStart()))
    params.set('endTime', String(Date.now()))
    const data = await api(`/api/journey/sessions?${params}`, { requestKey: 'journey:sessions' })
    sessions.value = Array.isArray(data?.sessions) ? data.sessions : []
    sessionStats.events = sessions.value.reduce((sum, item) => sum + Number(item.eventCount || 0), 0)
    sessionStats.errors = sessions.value.reduce((sum, item) => sum + Number(item.errorCount || 0), 0)
    if (sessions.value.length) await selectSession(sessions.value[0])
    else { selectedSession.value = null; timeline.value = null; selectedEvent.value = null }
  } catch (error) {
    if (error?.code !== 'ABORT_ERR') loadError.value = error.message || '会话检索失败'
  } finally {
    loading.value = false
    pageLoading.value = false
  }
}

async function selectSession(session) {
  selectedSession.value = session
  selectedEvent.value = null
  timelineLoading.value = true
  try {
    const params = new URLSearchParams({ sessionId: session.sessionId })
    if (store.appId) params.set('appId', store.appId)
    timeline.value = await api(`/api/journey/timeline?${params}`, { requestKey: `journey:timeline:${session.sessionId}` })
    buildTimelineRows()
  } catch (error) {
    if (error?.code !== 'ABORT_ERR') ElMessage.error(error.message || '时间线加载失败')
  } finally {
    timelineLoading.value = false
  }
}

// ---------------- 时间线渲染：同批折叠 + 时段分隔（FR-3） ----------------
const timelineRows = ref([])
const expandedBatches = ref(new Set())
const truncatedLabel = computed(() => timeline.value?.truncated ? '已截断（收窄时间范围）' : '完整')

const CATEGORY_META = {
  pv: { label: 'pv', icon: '📄' },
  behavior: { label: 'behavior', icon: '🖱' },
  error: { label: 'error', icon: '❌' },
  api: { label: 'API', icon: '🔗' },
  log: { label: 'log', icon: '📝' },
  perf: { label: 'perf', icon: '⏱' }
}

function buildTimelineRows() {
  expandedBatches.value = new Set()
  const events = timeline.value?.events || []
  const rows = []
  let lastTs = null
  for (const event of events) {
    // 时段分隔：相邻间隔 >30 分钟
    if (lastTs != null && event.ts - lastTs > 30 * 60000) {
      rows.push({ kind: 'sep', gapMinutes: Math.round((event.ts - lastTs) / 60000) })
    }
    lastTs = event.ts
    rows.push({ kind: 'event', event })
  }
  timelineRows.value = rows
}

/** 渲染视图模型：把相邻同批事件折叠为一行 */
const renderedRows = computed(() => {
  const out = []
  let batch = null
  for (const row of timelineRows.value) {
    if (row.kind !== 'event') { flushBatch(); out.push(row); continue }
    const key = row.event.batchId || `t${Math.round(row.event.ts / 50)}`
    const prev = batch
    if (prev && prev.key === key && Math.abs(row.event.ts - prev.lastTs) < 50 && row.event.category === prev.category) {
      batch.items.push(row.event)
      batch.lastTs = row.event.ts
      continue
    }
    flushBatch()
    batch = { kind: 'batch', key, category: row.event.category, items: [row.event], lastTs: row.event.ts }
  }
  flushBatch()
  return out

  function flushBatch() {
    if (!batch) return
    if (batch.items.length >= 3) out.push(batch)
    else for (const event of batch.items) out.push({ kind: 'event', event })
    batch = null
  }
})

function toggleBatch(batchRow) {
  const next = new Set(expandedBatches.value)
  next.has(batchRow.key) ? next.delete(batchRow.key) : next.add(batchRow.key)
  expandedBatches.value = next
}
const isExpanded = key => expandedBatches.value.has(key)

/** 批内明细行（展开时显示，跳过已渲染的首条） */
function batchDetailItems(batchRow) {
  return isExpanded(batchRow.key) ? batchRow.items.slice(1) : []
}
function selectEvent(event) {
  selectedEvent.value = event
  // 节点详情更新给用户视觉反馈：长会话中右栏变化不易察觉
  nextTick(() => {
    const col = document.querySelector('.j-col.detail-col .timeline')
    if (col) col.scrollTop = 0
  })
}

// ---------------- 节点详情（FR-4） ----------------
const detailKv = computed(() => {
  const detail = selectedEvent.value?.detail || {}
  return [
    ['事件名', selectedEvent.value?.name],
    ['类别', selectedEvent.value?.category],
    ['发生时间', detail.occurredAt ? new Date(detail.occurredAt).toLocaleString() : formatTime(selectedEvent.value?.ts)],
    ['接收时间', detail.receivedAt ? new Date(detail.receivedAt).toLocaleString() : null],
    ['页面', detail.path || detail.url],
    ['应用 / 版本', [detail.appId, detail.release].filter(Boolean).join(' · ')],
    ['设备 / OS', [detail.device, detail.os].filter(Boolean).join(' · ')],
    ['浏览器', detail.browser],
    ['用户标识', detail.userId || detail.deviceId],
    ['IP', detail.ip]
  ].filter(([, value]) => value != null && value !== '')
})
const detailJson = computed(() => JSON.stringify({
  ...(selectedEvent.value?.detail || {}),
  props: undefined,
  context: undefined,
  _props: selectedEvent.value?.detail?.props,
  _context: selectedEvent.value?.detail?.context
}, null, 2))

async function copyJson() {
  try {
    await navigator.clipboard.writeText(JSON.stringify(selectedEvent.value, null, 2))
    ElMessage.success('JSON 已复制')
  } catch { ElMessage.error('复制失败') }
}
function jumpErrors() {
  const name = selectedEvent.value?.detail?.name || ''
  router.push(`/errors?keyword=${encodeURIComponent(name)}`)
}
function jumpTrace() {
  const traceId = selectedEvent.value?.detail?.traceId || selectedEvent.value?.refs?.traceId
  if (!traceId) return ElMessage.info('该节点未关联 Trace')
  router.push(`/traces?traceId=${encodeURIComponent(traceId)}`)
}
function jumpReplay() {
  if (!selectedSession.value?.hasReplay) return ElMessage.info('该会话未录制回放')
  router.push(`/replays?sessionId=${encodeURIComponent(selectedSession.value.sessionId)}`)
}

// ---------------- AI 摘要抽屉（FR-6 前端推导版） ----------------
const aiSummary = computed(() => {
  const events = timeline.value?.events || []
  const anchors = events.filter(e => e.category === 'error' || e.level === 'warn')
  const sequences = anchors.map(anchor => {
    const index = events.indexOf(anchor)
    return {
      anchor,
      before: events.slice(Math.max(0, index - 3), index).map(e => `${CATEGORY_META[e.category]?.icon || ''}${e.name}`).join(' → ')
    }
  })
  return {
    errorCount: events.filter(e => e.category === 'error').length,
    apiFailCount: events.filter(e => e.category === 'api' && e.level === 'warn').length,
    sequences
  }
})

function formatTime(ts) {
  if (!ts) return '-'
  const date = new Date(Number(ts))
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleTimeString('zh-CN', { hour12: false })
}
function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000))
  return total >= 60 ? `${Math.floor(total / 60)}m${total % 60}s` : `${total}s`
}

onMounted(() => {
  if (searchForm.value.trim()) void loadSessions()
})
</script>

<template>
  <div>
    <div class="page-heading">
      <div>
        <h1>用户链路</h1>
        <p>给定用户 / 设备 / 会话 / trace 任一标识，快速还原完整行为序列；前端事件、JS 错误、API 请求、日志在一条时间线合并呈现。</p>
      </div>
      <el-button @click="aiDrawer = true" :disabled="!timeline">AI 分析此会话</el-button>
    </div>

    <div class="caliber-note">
      <span class="ci">◈</span>
      <div><b>口径</b>：时间线合并 events 六类与后端 spans（经 trace_id 关联），按 ts 升序；同批（batch_id 或 ts 相差 &lt;50ms）折叠；相邻间隔 &gt;30min 插入时段分隔线。敏感字段按当前数据访问等级脱敏。</div>
    </div>

    <el-card shadow="never" class="section panel">
      <div class="journey-search">
        <el-select v-model="searchForm.type" style="width: 130px">
          <el-option v-for="item in TYPE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
        <el-input v-model="searchForm.value" placeholder="粘贴标识，自动 trim" clearable style="flex: 1; min-width: 260px" @keyup.enter="loadSessions" />
        <el-select v-model="searchForm.range" style="width: 120px">
          <el-option label="近 24 小时" value="24h" />
          <el-option label="近 7 天" value="7d" />
        </el-select>
        <el-button type="primary" :loading="loading" @click="loadSessions">查询</el-button>
      </div>
      <el-alert v-if="loadError" type="error" :title="loadError" show-icon :closable="false" style="margin-top: 10px" />
    </el-card>

    <div class="j3">
      <!-- 左栏：会话列表 -->
      <div class="j-col">
        <div class="j-col-head"><h3>会话列表</h3><span class="health"><span class="dot" />{{ sessions.length }} 个会话</span></div>
        <div class="j-col-head" style="border-bottom: 1px solid var(--c-border-2); background: var(--c-surface-2)">
          <span style="font-size: 12px; color: var(--c-text-muted)">总事件 <b>{{ sessionStats.events.toLocaleString() }}</b> · 异常 <b style="color: var(--c-danger)">{{ sessionStats.errors }}</b></span>
        </div>
        <div v-loading="loading" class="j-list">
          <div v-for="session in sessions" :key="session.sessionId" class="j-session" :class="{ sel: selectedSession?.sessionId === session.sessionId }" @click="selectSession(session)">
            <div class="js-top">
              <span class="js-id">{{ session.sessionId.slice(0, 18) }}…</span>
              <span v-if="session.errorCount > 0" class="health stalled"><span class="dot" />⚠ {{ session.errorCount }}</span>
            </div>
            <div class="js-meta">
              <span>事件 {{ session.eventCount }}</span>
              <span>{{ session.browser || session.device || '-' }}</span>
              <span>{{ formatTime(session.lastAt) }}</span>
              <span v-if="session.hasReplay">⏯</span>
            </div>
          </div>
          <div v-if="!loading && !sessions.length" class="j-empty">输入标识开始检索</div>
        </div>
      </div>

      <!-- 中栏：事件时间线 -->
      <div class="j-col">
        <div class="j-col-head">
          <h3>事件时间线</h3>
          <span class="health" v-if="timeline">{{ timeline.events.length }} 条 · {{ truncatedLabel }}</span>
        </div>
        <template v-if="timeline?.session">
          <div class="tl-session-card">
            <div class="sc-item"><div class="sc-k">身份链路</div><div class="sc-v">{{ timeline.session.identityChain.join(' → ') || '-' }}</div></div>
            <div class="sc-item"><div class="sc-k">会话时长</div><div class="sc-v">{{ formatDuration(timeline.session.durationMs) }}</div></div>
            <div class="sc-item"><div class="sc-k">错误数</div><div class="sc-v" :style="timeline.session.errorCount ? 'color: var(--c-danger)' : ''">{{ timeline.session.errorCount }}</div></div>
            <div class="sc-item"><div class="sc-k">版本</div><div class="sc-v">{{ timeline.session.release || '-' }} · SDK {{ timeline.session.sdkVersion || '-' }}</div></div>
            <div class="sc-item"><div class="sc-k">设备</div><div class="sc-v">{{ [timeline.session.device, timeline.session.browser].filter(Boolean).join(' · ') || '-' }}</div></div>
          </div>
        </template>
        <div v-loading="timelineLoading" class="timeline">
          <template v-for="(row, index) in renderedRows" :key="`${row.kind}-${index}`">
            <div v-if="row.kind === 'sep'" class="period-sep">操作时段 · 间隔 {{ row.gapMinutes }} 分钟</div>
            <template v-else-if="row.kind === 'batch'">
              <div class="tl-item" @click="selectEvent(row.items[0])">
                <div class="tl-rail"><div class="tl-dot" :class="row.category">{{ CATEGORY_META[row.category]?.icon }}</div><div class="tl-line" /></div>
                <div class="tl-main">
                  <div class="tl-row1">
                    <span class="tl-time">{{ formatTime(row.items[0].ts) }}</span>
                    <span class="batch-badge" @click.stop="toggleBatch(row)">⧉ 同批 {{ row.items.length }} 条 {{ isExpanded(row.key) ? '收起' : '展开' }}</span>
                    <span class="tl-summary" style="margin: 0">{{ row.items.map(item => item.name).slice(0, 4).join(' / ') }}{{ row.items.length > 4 ? ' …' : '' }}</span>
                  </div>
                </div>
              </div>
              <div v-for="event in batchDetailItems(row)" :key="event.id" class="tl-item" @click="selectEvent(event)">
                <div class="tl-rail"><div class="tl-dot" :class="event.category">{{ CATEGORY_META[event.category]?.icon }}</div><div class="tl-line" /></div>
                <div class="tl-main">
                  <div class="tl-row1"><span class="tl-time">{{ formatTime(event.ts) }}</span><span class="tl-name">{{ event.name }}</span></div>
                  <div class="tl-summary">{{ event.summary }}</div>
                </div>
              </div>
            </template>
            <div v-else class="tl-item" :class="{ sel: selectedEvent?.id === row.event.id }" @click="selectEvent(row.event)">
              <div class="tl-rail"><div class="tl-dot" :class="row.event.category">{{ CATEGORY_META[row.event.category]?.icon }}</div><div class="tl-line" /></div>
              <div class="tl-main">
                <div class="tl-row1">
                  <span class="tl-time">{{ formatTime(row.event.ts) }}</span>
                  <span class="tl-name">{{ row.event.name }}</span>
                  <span class="health" :class="{ stalled: row.event.level === 'error', fluctuating: row.event.level === 'warn' }"><span class="dot" />{{ CATEGORY_META[row.event.category]?.label }}</span>
                </div>
                <div class="tl-summary">{{ row.event.summary }}</div>
              </div>
            </div>
          </template>
          <div v-if="!timelineLoading && !renderedRows.length" class="j-empty">选择左侧会话查看时间线</div>
        </div>
      </div>

      <!-- 右栏：节点详情 -->
      <div class="j-col detail-col">
        <div class="j-col-head"><h3>节点详情</h3><span v-if="selectedEvent" class="health" :class="{ stalled: selectedEvent.level === 'error' }"><span class="dot" />{{ selectedEvent.category }}</span></div>
        <div v-loading="false" class="timeline">
          <template v-if="selectedEvent">
            <div class="kv">
              <div v-for="[key, value] in detailKv" :key="key" class="row"><span class="k">{{ key }}</span><span class="v">{{ value }}</span></div>
            </div>
            <details style="margin-top: 10px">
              <summary style="cursor: pointer; color: var(--c-primary); font-size: 12.5px">展开 context_json</summary>
              <pre class="kv-json" style="margin-top: 8px">{{ detailJson }}</pre>
            </details>
            <div class="node-jumps">
              <el-button size="small" type="primary" :disabled="selectedEvent.category !== 'error'" @click="jumpErrors">查看错误详情</el-button>
              <el-button size="small" @click="jumpTrace">关联 Trace</el-button>
              <el-button size="small" :disabled="!selectedSession?.hasReplay" @click="jumpReplay">↗ 回放页{{ selectedSession?.hasReplay ? '' : '（无回放）' }}</el-button>
              <el-button size="small" text @click="copyJson">⧉ 复制 JSON</el-button>
            </div>
          </template>
          <div v-else class="j-empty">点击时间线节点查看详情</div>
        </div>
      </div>
    </div>

    <!-- AI 分析抽屉 -->
    <el-drawer v-model="aiDrawer" title="AI 分析此会话" size="480px">
      <template v-if="aiSummary.sequences.length">
        <div class="ai-result" style="margin-top: 0">
          <h4>异常点定位</h4>
          <ul>
            <li v-for="(item, index) in aiSummary.sequences.slice(0, 5)" :key="index">
              <code>{{ formatTime(item.anchor.ts) }}</code> 触发 <b>{{ item.anchor.name }}</b>；前序操作：<code>{{ item.before || '会话起始' }}</code>
            </li>
          </ul>
          <h4 style="margin-top: 12px">会话概览</h4>
          <ul>
            <li>JS 错误 <b>{{ aiSummary.errorCount }}</b> 次、失败 API <b>{{ aiSummary.apiFailCount }}</b> 次</li>
            <li>共 {{ timeline?.events?.length || 0 }} 个事件，覆盖 {{ timeline?.session?.identityChain?.length || 0 }} 层身份</li>
          </ul>
          <div class="ai-actions">
            <el-button size="small" type="primary" @click="aiDrawer = false; jumpErrors()">定位错误详情</el-button>
          </div>
        </div>
      </template>
      <el-empty v-else description="该会话未检出错误/失败请求，暂无 AI 分析结论" />
    </el-drawer>
  </div>
</template>

<style scoped>
.journey-search { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.j-empty { padding: 40px 0; color: var(--c-text-faint); font-size: 12.5px; text-align: center; }
.health.fluctuating { font-size: 11px; }
</style>
