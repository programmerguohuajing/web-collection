<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { api, pageLoading, queryFromFilters, refreshVersion } from '../../../dashboard.js'
import { useFilterStore } from '../../../stores/filters.js'
import KpiGrid from '../../../components/KpiGrid.vue'
import OverflowTip from '../../../components/OverflowTip.vue'

/**
 * SDK 健康视图（Next Horizon E3）。
 *
 * 回答两个问题：① 我的 SDK 注入是否健康？② 采集是否丢数据？
 *
 * 数据来源（全部为后端真实已有接口，无任何模拟数据）：
 * - `/api/monitoring/ingestion`：服务端采集健康（仅 Cloudflare Worker 提供，Node API 尚无该路由）。
 * - `/api/releases/quality?dim=sdk`：按 SDK 版本维度的接入健康（会话/错误/最后上报/上报延迟）。
 * - `/api/collect-config`（命中预览）+ `/api/collect-config/stats`：采集配置与配置版本分布。
 *
 * 后端没有的数据（SDK 端 sent/dropped/retried、SDK 体积开销）不编造，
 * 在「暂缺能力」区块显式标注并说明补齐成本。
 * 表格列溢出一律使用 OverflowTip（禁用原生 show-overflow-tooltip）。
 */
const store = useFilterStore()

/** 与 worker /api/diagnostics 保持一致的健康判定阈值。 */
const STALE_WARN_MS = 5 * 60 * 1000
const STALE_CRITICAL_MS = 15 * 60 * 1000
const INGESTION_POLL_MS = 30000

const loading = ref(false)
const sdkRows = ref([])
const qualityError = ref('')
const ingestion = ref(null)
const ingestionError = ref('')
const configPreview = ref(null)
const configError = ref('')
const configStats = ref(null)
const selectedVersion = ref('')
/** 顶部未选应用时的只读兜底（不反写全局筛选，避免污染顶栏）。 */
const fallbackAppId = ref('')
let ingestionTimer = null

const activeAppId = computed(() => store.appId || fallbackAppId.value || '')

/** 健康判定基准时间：优先取全局时间范围的结束时间，否则取当前时间。 */
const referenceNow = computed(() => {
  const [, end] = store.range || []
  return Number(end) > 0 ? Number(end) : Date.now()
})

/** 选中区间整体处于过去（结束时间已超过 15 分钟）时不做实时停报判定。 */
const isHistoricalRange = computed(() => {
  const [, end] = store.range || []
  return Number(end) > 0 && Date.now() - Number(end) > STALE_CRITICAL_MS
})

const versionOptions = computed(() => sdkRows.value.map(row => row.version).filter(Boolean))

const kpis = computed(() => {
  const ing = ingestion.value
  const accepted = Number(ing?.eventsAccepted || 0)
  const written = Number(ing?.written || 0)
  const successRate = accepted > 0 ? (written / accepted) * 100 : null
  const staleCount = sdkRows.value.filter(row => rowHealth(row).status === 'critical').length
  const latencyRows = sdkRows.value.filter(row => Number.isFinite(Number(row.reportLatencyP75)))
  const latencyAvg = latencyRows.length
    ? Math.round(latencyRows.reduce((sum, row) => sum + Number(row.reportLatencyP75), 0) / latencyRows.length)
    : null
  return [
    {
      label: '服务端采集状态',
      value: ing ? ingestionStatusText.value : '不可达',
      delta: '近 10 分钟窗口 · 全站维度',
      valueClass: ing ? ingestionValueClass.value : 'value-danger'
    },
    {
      label: '窗口入库成功率',
      value: successRate == null ? '—' : `${successRate.toFixed(1)}%`,
      delta: ing ? `失败 ${Number(ing.failed || 0)} 条 / 近1h告警 ${Number(ing.ingestErrorCount || 0)} 次` : '接口暂不可达',
      valueClass: successRate != null && successRate < 100 ? 'value-danger' : 'value-success'
    },
    {
      label: '在采集 SDK 版本',
      value: sdkRows.value.length.toLocaleString(),
      delta: activeAppId.value ? `应用 ${activeAppId.value}` : '未选择应用',
      valueClass: 'value-primary'
    },
    {
      label: '疑似停报版本',
      value: String(staleCount),
      delta: latencyAvg == null ? '上报延迟暂无样本' : `平均上报延迟 ${latencyAvg} ms`,
      valueClass: staleCount > 0 ? 'value-danger' : 'value-purple'
    }
  ]
})

const ingestionStatusText = computed(() => {
  if (!ingestion.value) return '不可达'
  return { healthy: '正常', degraded: '降级', critical: '中断' }[ingestion.value.status] || '未知'
})

const ingestionValueClass = computed(() => {
  const status = ingestion.value?.status
  if (status === 'critical') return 'value-danger'
  if (status === 'degraded') return 'value-danger'
  return 'value-success'
})

const ingestionTagType = computed(() => {
  const status = ingestion.value?.status
  if (status === 'critical') return 'danger'
  if (status === 'degraded') return 'warning'
  return 'success'
})

/** 配置明细：只渲染后端真实返回的配置项。 */
const configItems = computed(() => {
  const config = configPreview.value?.config
  if (!config) return []
  const sampling = config.sampling || {}
  const plugins = config.plugins || {}
  const rateLimits = config.rate_limits || {}
  const items = [
    { label: '总开关', value: config.master_switch || '-' },
    { label: '错误采样率', value: formatRate(sampling.error) },
    { label: '性能采样率', value: formatRate(sampling.performance) },
    { label: '回放采样率', value: formatRate(sampling.replay) },
    { label: '行为采样率', value: formatRate(sampling.behavior) },
    { label: '限流（每人每事件/10min）', value: rateLimits.per_event_per_user_10min == null ? '-' : String(rateLimits.per_event_per_user_10min) }
  ]
  const enabledPlugins = Object.keys(plugins).filter(name => plugins[name])
  items.push({ label: '已启用插件', value: enabledPlugins.length ? enabledPlugins.join('、') : '无' })
  const blocked = Array.isArray(config.blocked_events) ? config.blocked_events : []
  items.push({ label: '屏蔽事件', value: blocked.length ? blocked.join('、') : '无' })
  return items
})

/**
 * 兼容两种响应形状：worker 的 `/api/monitoring/ingestion` 返回扁平对象，
 * `/health` 与部分部署返回 `{ ingestion: {...} }` 信封。
 */
function normalizeIngestion(data) {
  const raw = data && typeof data === 'object' && data.ingestion && typeof data.ingestion === 'object'
    ? data.ingestion
    : data
  if (!raw || typeof raw !== 'object') return null
  return {
    status: raw.status || 'unknown',
    received: Number(raw.received || 0),
    eventsAccepted: Number(raw.eventsAccepted || 0),
    written: Number(raw.written || 0),
    failed: Number(raw.failed || 0),
    failureRate: Number(raw.failureRate || 0),
    lastWriteTs: raw.lastWriteTs == null ? null : Number(raw.lastWriteTs),
    stalledMs: raw.stalledMs == null ? null : Number(raw.stalledMs),
    ingestErrorCount: Number(raw.ingestErrorCount || 0),
    lastErrorMessage: raw.lastErrorMessage || raw.lastError?.message || '',
    recentErrors: Array.isArray(raw.recentErrors) ? raw.recentErrors : [],
    since: raw.since == null ? null : Number(raw.since)
  }
}

function formatRate(value) {
  return value == null || value === '' ? '-' : `${(Number(value) * 100).toFixed(0)}%`
}

/** SDK 版本行健康度：基于「最后上报时间」判定，阈值与 worker /api/diagnostics 一致。 */
function rowHealth(row) {
  const last = Number(row?.lastSeenAt || 0)
  if (!last) return { status: 'unknown', label: '无数据', type: 'info' }
  if (isHistoricalRange.value) return { status: 'history', label: '历史区间', type: 'info' }
  const gap = referenceNow.value - last
  if (gap > STALE_CRITICAL_MS) return { status: 'critical', label: '疑似停报', type: 'danger' }
  if (gap > STALE_WARN_MS) return { status: 'degraded', label: '上报延迟', type: 'warning' }
  return { status: 'healthy', label: '上报正常', type: 'success' }
}

/** 毫秒 → 中文相对时间。 */
function formatAgo(value) {
  const ts = Number(value || 0)
  if (!ts) return '—'
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  const minutes = Math.floor(diff / 60000)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分钟前`
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时前`
}

function formatTime(value) {
  const ts = Number(value || 0)
  return ts ? new Date(ts).toLocaleString() : '—'
}

function windowMinutes(value) {
  const since = Number(value || 0)
  if (!since) return '—'
  return `${Math.max(0, Math.round((Date.now() - since) / 60000))} 分钟`
}

/** 串行执行互不阻断的子任务，单个接口失败只影响对应区块。 */
async function safe(task, onError, message) {
  try {
    await task()
  } catch (error) {
    if (error?.code !== 'ABORT_ERR') onError(error?.message || message)
  }
}

/** 顶部未选应用时，复用发布列表挑一个近期真有上报的应用（与 ReleaseQualityPanel 一致）。 */
async function ensureAppId() {
  if (store.appId || fallbackAppId.value) return
  const data = await api('/api/analytics/releases?page=1&pageSize=50', { requestKey: 'sdk-health:apps' })
  const rows = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : [])
  const picked = rows.find(row => Number(row.events || 0) > 0 && (row.app_id || row.appId)) || rows[0]
  fallbackAppId.value = String(picked?.app_id || picked?.appId || '')
}

async function loadQuality() {
  if (!activeAppId.value) {
    sdkRows.value = []
    qualityError.value = '请先在顶部「全部应用」中选择一个应用（该接口按 appId 聚合）'
    return
  }
  qualityError.value = ''
  // /api/releases/quality 只接受 appId / dim / start / end（不是 startTime / endTime），
  // 这里显式传 start / end，其余仍走全局筛选构造器。
  const [start, end] = store.range || []
  const query = queryFromFilters({ appId: activeAppId.value, dim: 'sdk', start, end }, ['appId'])
  const data = await api(`/api/releases/quality?${query}`, { requestKey: 'sdk-health:quality' })
  sdkRows.value = Array.isArray(data?.items) ? data.items : []
  if (!selectedVersion.value || !sdkRows.value.some(row => row.version === selectedVersion.value)) {
    selectedVersion.value = sdkRows.value[0]?.version || ''
  }
}

async function loadIngestion() {
  const data = await api('/api/monitoring/ingestion', { requestKey: 'sdk-health:ingestion' })
  ingestion.value = normalizeIngestion(data)
  ingestionError.value = ingestion.value ? '' : '接口未返回采集健康数据'
}

async function loadConfig() {
  if (!activeAppId.value) {
    configPreview.value = null
    return
  }
  const params = new URLSearchParams()
  params.set('appId', activeAppId.value)
  if (selectedVersion.value) params.set('sdkVersion', String(selectedVersion.value))
  configPreview.value = await api(`/api/collect-config?${params.toString()}`, { requestKey: 'sdk-health:config' })
}

async function loadConfigStats() {
  configStats.value = await api('/api/collect-config/stats', { requestKey: 'sdk-health:config-stats' })
}

async function load() {
  loading.value = true
  pageLoading.value = true
  try {
    await safe(ensureAppId, () => {}, '应用列表加载失败')
    await Promise.all([
      safe(loadQuality, message => { qualityError.value = message; sdkRows.value = [] }, 'SDK 版本健康数据加载失败'),
      safe(loadConfig, message => { configError.value = message; configPreview.value = null }, '采集配置加载失败'),
      safe(loadConfigStats, () => { configStats.value = null }, '配置版本分布加载失败')
    ])
    await safe(loadIngestion, message => { ingestionError.value = message; ingestion.value = null }, '采集健康接口暂不可达')
  } finally {
    loading.value = false
    pageLoading.value = false
  }
}

function retryIngestion() {
  ingestionError.value = ''
  loadIngestion().catch(() => {})
}

onMounted(() => {
  ingestionTimer = setInterval(() => { loadIngestion().catch(() => {}) }, INGESTION_POLL_MS)
})

onUnmounted(() => {
  if (ingestionTimer) clearInterval(ingestionTimer)
  ingestionTimer = null
})

watch(refreshVersion, () => load(), { immediate: true })
watch(selectedVersion, () => { loadConfig().catch(() => {}) })
</script>

<template>
  <div class="sdk-health-toolbar">
    <el-select v-model="selectedVersion" size="small" class="sdk-health-version" clearable placeholder="选择 SDK 版本（配置预览）">
      <el-option v-for="version in versionOptions" :key="version" :label="version" :value="version" />
    </el-select>
    <el-button size="small" type="primary" :loading="loading" @click="load">刷新</el-button>
    <small>时间范围沿用顶部全局筛选；应用取顶部「全部应用」，未选时自动回退到近期有上报的应用</small>
  </div>

  <KpiGrid :items="kpis" />

  <el-card v-if="ingestion || ingestionError" shadow="never" class="panel section">
    <template #header>
      <div class="panel-head">
        <div><h2>服务端采集健康</h2><small>SDK 上报 → 服务端入库链路</small></div>
        <el-tag :type="ingestion ? ingestionTagType : 'info'" effect="dark">{{ ingestion ? ingestionStatusText : '不可达' }}</el-tag>
      </div>
    </template>

    <el-alert
      v-if="ingestionError"
      class="table-error"
      type="warning"
      show-icon
      :closable="false"
      :title="ingestionError"
    >
      <template #default>
        该接口当前由 Cloudflare Worker 提供（`GET /api/monitoring/ingestion`）；本地 Node API（apps/api）尚未实现此路由，
        因此自建/本地部署下此区块会显示不可达，其余区块不受影响。
        <el-button link type="primary" @click="retryIngestion">重试</el-button>
      </template>
    </el-alert>

    <div v-else-if="ingestion" class="ingestion-metrics">
      <div class="metric"><span class="metric-k">窗口起点</span><span class="metric-v">{{ windowMinutes(ingestion.since) }}前（滚动 10 分钟窗口）</span></div>
      <div class="metric"><span class="metric-k">接收请求 / 接收事件</span><span class="metric-v">{{ ingestion.received }} / {{ ingestion.eventsAccepted }}</span></div>
      <div class="metric"><span class="metric-k">成功入库</span><span class="metric-v">{{ ingestion.written }}</span></div>
      <div class="metric"><span class="metric-k">入库失败</span><span class="metric-v" :class="{ danger: ingestion.failed > 0 }">{{ ingestion.failed }}（失败率 {{ (ingestion.failureRate * 100).toFixed(2) }}%）</span></div>
      <div class="metric"><span class="metric-k">最后入库</span><span class="metric-v">{{ ingestion.lastWriteTs ? formatAgo(ingestion.lastWriteTs) : '无数据' }}</span></div>
      <div class="metric"><span class="metric-k">近 1h 入库告警</span><span class="metric-v" :class="{ danger: ingestion.ingestErrorCount > 0 }">{{ ingestion.ingestErrorCount }} 次</span></div>
      <div class="metric metric-wide"><span class="metric-k">最近错误</span><span class="metric-v err">{{ ingestion.lastErrorMessage || '无' }}</span></div>
    </div>

    <el-table v-if="ingestion?.recentErrors?.length" :data="ingestion.recentErrors" size="small" border class="error-table">
      <el-table-column label="时间" width="180">
        <template #default="{ row }">{{ formatTime(row.at) }}</template>
      </el-table-column>
      <el-table-column label="应用 ID" width="160">
        <template #default="{ row }"><OverflowTip :text="row.appId || '-'" /></template>
      </el-table-column>
      <el-table-column label="错误信息" min-width="320">
        <template #default="{ row }"><OverflowTip :text="row.message || '-'" /></template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-card shadow="never" class="panel section">
    <template #header>
      <div class="panel-head">
        <div><h2>SDK 版本接入健康</h2><small>按 SDK 版本聚合（dim=sdk）</small></div>
        <small>{{ sdkRows.length }} 个版本 · 应用 {{ activeAppId || '未选择' }}</small>
      </div>
    </template>

    <el-alert v-if="qualityError" class="table-error" type="error" show-icon :closable="false" :title="qualityError">
      <template #default><el-button link type="primary" @click="load">重试</el-button></template>
    </el-alert>

    <el-table :data="sdkRows" border size="small" v-loading="loading" empty-text="当前时间范围内没有 SDK 版本上报数据">
      <el-table-column label="SDK 版本" min-width="150">
        <template #default="{ row }"><OverflowTip :text="row.version || '-'" /></template>
      </el-table-column>
      <el-table-column prop="sessions" label="会话数" width="100" align="right" sortable />
      <el-table-column prop="users" label="用户数" width="100" align="right" sortable />
      <el-table-column prop="errors" label="错误数" width="100" align="right" sortable />
      <el-table-column label="错误/千会话" width="120" align="right">
        <template #default="{ row }">{{ row.errorsPerKSession == null ? '—' : row.errorsPerKSession }}</template>
      </el-table-column>
      <el-table-column label="最后上报" width="160">
        <template #default="{ row }">{{ formatAgo(row.lastSeenAt) }}</template>
      </el-table-column>
      <el-table-column label="上报延迟(ms)" width="130" align="right">
        <template #default="{ row }">{{ row.reportLatencyP75 == null ? '—' : row.reportLatencyP75 }}</template>
      </el-table-column>
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <el-tag size="small" :type="rowHealth(row).type">{{ rowHealth(row).label }}</el-tag>
        </template>
      </el-table-column>
    </el-table>

    <el-alert class="note" type="info" :closable="false" show-icon title="指标口径">
      <template #default>
        「上报延迟」= 服务端 <code>received_at − 事件 ts</code> 的平均毫秒数（后端字段名为 reportLatencyP75，实际计算为均值；未填充 received_at 的样本不计入）。
        「疑似停报 / 上报延迟 / 上报正常」按最后上报距今 &gt; 15 分钟 / &gt; 5 分钟 / 5 分钟内判定，阈值与 <code>/api/diagnostics</code> 一致；
        当顶部时间范围的结束时间已超过 15 分钟时判定为「历史区间」，不做实时停报判定。
      </template>
    </el-alert>
  </el-card>

  <el-card shadow="never" class="panel section">
    <template #header>
      <div class="panel-head">
        <div><h2>采集配置校验</h2><small>当前应用 + SDK 版本命中的远程采集配置</small></div>
        <el-tag v-if="configPreview" size="small" :type="configPreview.matched ? 'success' : 'info'" effect="plain">
          {{ configPreview.matched ? '命中自定义配置' : '使用默认配置' }}
        </el-tag>
      </div>
    </template>

    <el-alert v-if="configError" class="table-error" type="error" show-icon :closable="false" :title="configError" />

    <template v-if="configPreview">
      <div class="config-summary">
        <span>应用：<b>{{ activeAppId || '-' }}</b></span>
        <span>SDK 版本：<b>{{ selectedVersion || '未指定' }}</b></span>
        <span>配置版本：<b>#{{ configPreview.configVersion ?? '-' }}</b></span>
      </div>
      <el-table :data="configItems" size="small" border>
        <el-table-column prop="label" label="配置项" width="220" />
        <el-table-column label="当前值" min-width="260">
          <template #default="{ row }"><OverflowTip :text="row.value" /></template>
        </el-table-column>
      </el-table>
    </template>
    <div v-else-if="!configError" class="empty">暂无配置数据（请先选择应用）</div>

    <template v-if="configStats">
      <div class="config-sub">
        <h3>配置版本分布</h3>
        <small>近 24h 活跃会话 · 全站维度（该接口不区分 appId）· 当前最新配置版本 #{{ configStats.currentVersion }}</small>
      </div>
      <el-table :data="configStats.distribution || []" size="small" border empty-text="近 24h 无会话上报配置版本">
        <el-table-column label="配置版本" min-width="180">
          <template #default="{ row }"><OverflowTip :text="row.version || '-'" /></template>
        </el-table-column>
        <el-table-column prop="sessions" label="会话数" width="120" align="right" sortable />
      </el-table>
    </template>
  </el-card>

  <el-card shadow="never" class="panel section">
    <template #header>
      <div class="panel-head"><div><h2>暂缺能力（未做占位数据）</h2><small>需 SDK / 后端补齐后才会真实展示</small></div></div>
    </template>
    <el-alert class="note" type="warning" :closable="false" show-icon title="以下指标后端当前没有任何数据，页面不做数字占位">
      <template #default>
        <ul class="gap-list">
          <li>
            <b>SDK 端交付指标（sent / dropped / retried / timeout / queueFull）</b>：
            由 <code>packages/sdk/src/transport/self-monitor.js</code> 的 <code>SelfMonitor</code> 统计，但只存在于浏览器内存
            （<code>sdk.monitoring()</code> / <code>window.__EYS_MONITOR__</code>），<b>未上报后端</b>，后端无存储也无查询接口。
            补齐约 1.5 人日：SDK 新增自监控事件上报并限频（0.5d）+ 后端表/查询接口（0.5d）+ 本页接入（0.5d），
            另需评估自监控事件自身的采样与流量放大。
          </li>
          <li>
            <b>SDK 体积开销（包体 / gzip / 运行时内存）</b>：属于构建产物侧数据，后端无任何采集与存储。
            补齐约 1.5 人日：CI 产出 size 报告并上报（1d）+ 本页展示（0.5d）。
          </li>
          <li>
            <b>接入配置强校验（appId / collectKey 合法性、SDK 与平台匹配）</b>：后端仅在 <code>/api/collect</code> 时校验并返回 401，
            没有独立的校验接口与健康记录，因此本区块展示的是「当前命中的远程采集配置」这一真实替代数据。
            严格校验补齐约 0.5 人日（新增校验接口或聚合 collect 401 计数）。
          </li>
        </ul>
      </template>
    </el-alert>
  </el-card>
</template>

<style scoped>
.sdk-health-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 12px; }
.sdk-health-toolbar small { font-size: 12px; }
.sdk-health-version { width: 260px; }
.table-error { margin-bottom: 12px; }
.ingestion-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px 18px; }
.metric { display: grid; gap: 4px; min-width: 0; }
.metric-wide { grid-column: 1 / -1; }
.metric-k { color: var(--c-text-muted); font-size: 12px; }
.metric-v { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.metric-v.danger { color: var(--c-danger); }
.metric-v.err { color: var(--c-danger); font-weight: 500; white-space: normal; word-break: break-all; }
.error-table { margin-top: 14px; }
.note { margin-top: 14px; }
.note code { padding: 1px 4px; border-radius: 3px; background: #f2f4f7; font-size: 12px; }
.config-summary { display: flex; flex-wrap: wrap; gap: 18px; margin-bottom: 12px; font-size: 13px; color: var(--c-text-muted); }
.config-summary b { color: var(--c-text); }
.config-sub { margin: 18px 0 10px; }
.config-sub h3 { margin: 0; font-size: 14px; }
.config-sub small { font-size: 12px; }
.empty { padding: 12px 0; color: var(--c-text-muted); font-size: 13px; }
.gap-list { margin: 0; padding-left: 18px; display: grid; gap: 8px; font-size: 13px; line-height: 1.7; }
.gap-list code { padding: 1px 4px; border-radius: 3px; background: #f2f4f7; font-size: 12px; }
</style>
