<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { Download, RefreshRight, Search, Select, Share } from '@element-plus/icons-vue'
import { api, normalizePageResponse, queryFromFilters, pageLoading, refreshVersion, filters } from '../../../dashboard.js'
import { useDiagnosisStore } from '../../../stores/diagnosis.js'
import { formatDuration } from '../../../utils/format.js'
import TraceTopology from '../../../components/TraceTopology.vue'
import TraceWaterfall from '../../../components/TraceWaterfall.vue'
import DistributedTraceTree from '../../../components/DistributedTraceTree.vue'
import RequestResponsePanel from '../../../components/RequestResponsePanel.vue'
import { buildTopologyFromDistributed } from '../../../utils/trace-topology.js'
import OverflowTip from '../../../components/OverflowTip.vue'

const traces = ref([])
const pager = reactive({ page: 1, pageSize: 12, total: 0 })
const listLoading = ref(false)
const listError = ref('')
const tracePickerOpen = ref(false)
let listRequestId = 0

const active = ref(null)
const activeView = ref('topology') // topology | tree | waterfall

// 拓扑（服务级）
const topology = ref({ nodes: [], edges: [] })
const topoLoading = ref(false)
const topoError = ref('')
const topoNotice = ref('')
let topoRequestId = 0

// 分布式 trace（用于瀑布图）
const dist = ref({ nodes: [], edges: [] })
const distLoading = ref(false)
const distError = ref('')
let distRequestId = 0

// 详情面板
const detail = reactive({ open: false, kind: '', data: null })

// 前端请求 / 响应
const reqEvents = ref([])
const reqLoading = ref(false)
const reqError = ref('')
let reqRequestId = 0

const topoRef = ref(null)
const layoutMode = ref('force')

function numberOr(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}
function formatDate(value, withTime = true) {
  const ts = numberOr(value)
  if (!ts) return '-'
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? '-' : (withTime ? d.toLocaleString() : d.toLocaleTimeString())
}

function normalizeTrace(row = {}) {
  return {
    ...row,
    trace_id: row.trace_id || row.traceId || '',
    started_at: numberOr(row.started_at ?? row.startedAt ?? row.ts),
    duration: numberOr(row.duration ?? row.duration_ms ?? row.durationMs),
    span_count: numberOr(row.span_count ?? row.spanCount),
    error_count: numberOr(row.error_count ?? row.errorCount),
    app_id: row.app_id || row.appId || '',
    release_name: row.release_name || row.releaseName || row.release || '',
    environment: row.environment || row.env || '生产环境',
    url: row.url || row.path || ''
  }
}

async function load() {
  const requestId = ++listRequestId
  listLoading.value = true
  listError.value = ''
  pageLoading.value = true
  try {
    const data = await api(`/api/traces?${queryFromFilters({ page: pager.page, pageSize: pager.pageSize })}`, { requestKey: 'traces:list' })
    if (requestId !== listRequestId) return
    const normalized = normalizePageResponse(data, pager)
    traces.value = normalized.items.map(normalizeTrace)
    Object.assign(pager, normalized)
    // Keep the three-card detail view populated when the trace list has data,
    // while retaining the picker drawer for switching traces.
    const activeInPage = traces.value.some(trace => trace.trace_id === active.value?.trace_id)
    if ((!active.value || !activeInPage) && traces.value.length) await selectTrace(traces.value[0])
  } catch (error) {
    if (requestId === listRequestId && error?.code !== 'ABORT_ERR') listError.value = error.message || '链路列表加载失败'
  } finally {
    if (requestId === listRequestId) {
      listLoading.value = false
      pageLoading.value = false
    }
  }
}

function onSearch() {
  pager.page = 1
  void load()
}

async function selectTrace(row) {
  const trace = normalizeTrace(row)
  if (!trace.trace_id.trim()) return
  active.value = trace
  // ADR-006：选中 trace 写入全局诊断上下文（AI 诊断抽屉可感知）
  useDiagnosisStore().setTrace(trace.trace_id)
  tracePickerOpen.value = false
  closeDetail()
}

async function loadTopology() {
  if (!active.value?.trace_id) return
  const traceId = active.value.trace_id
  const requestId = ++topoRequestId
  topoLoading.value = true
  topoError.value = ''
  topoNotice.value = ''
  topology.value = { nodes: [], edges: [] }
  dist.value = { nodes: [], edges: [] }
  distError.value = ''
  let distributedError = null
  try {
    const data = await api(`/api/traces/${encodeURIComponent(traceId)}/distributed`, { requestKey: `traces:topology:${traceId}` })
    if (requestId !== topoRequestId) return
    const distributed = {
      nodes: Array.isArray(data?.nodes) ? data.nodes : [],
      edges: Array.isArray(data?.edges) ? data.edges : []
    }
    const result = buildTopologyFromDistributed(distributed)
    dist.value = distributed
    if (result.nodes.length) {
      topology.value = result
      if (!result.edges.length) topoNotice.value = `该 Trace 目前只有 ${result.nodes.length} 个采集节点，暂无上下游调用关系。`
      topoLoading.value = false
      return
    }
    topology.value = result
    topoNotice.value = '该 Trace 没有可用于生成调用拓扑的 Span 数据。'
    topoLoading.value = false
    return
  } catch (error) {
    if (error?.code === 'ABORT_ERR' || requestId !== topoRequestId) {
      if (requestId === topoRequestId) topoLoading.value = false
      return
    }
    distributedError = error
  }

  try {
    const data = await api(`/api/traces/${encodeURIComponent(traceId)}/topology`, { requestKey: `traces:topology-fallback:${traceId}` })
    if (requestId !== topoRequestId) return
    const result = {
      nodes: Array.isArray(data?.nodes) ? data.nodes : [],
      edges: Array.isArray(data?.edges) ? data.edges : []
    }
    topology.value = result
    if (!result.nodes.length) {
      topoNotice.value = '该 Trace 没有可用于生成调用拓扑的 Span 数据。'
    } else if (!result.edges.length) {
      topoNotice.value = `该 Trace 目前只有 ${result.nodes.length} 个采集节点，暂无上下游调用关系。`
    } else if (distributedError) {
      topoNotice.value = 'Span 明细接口不可用，当前展示服务端聚合拓扑。'
    }
  } catch (error) {
    if (requestId === topoRequestId && error?.code !== 'ABORT_ERR') {
      topoError.value = distributedError?.message || error.message || '调用拓扑加载失败'
    }
  } finally {
    if (requestId === topoRequestId) topoLoading.value = false
  }
}

async function loadDistributed() {
  if (!active.value?.trace_id) return
  const requestId = ++distRequestId
  distLoading.value = true
  distError.value = ''
  dist.value = { nodes: [], edges: [] }
  try {
    const data = await api(`/api/traces/${encodeURIComponent(active.value.trace_id)}/distributed`, { requestKey: `traces:distributed:${active.value.trace_id}` })
    if (requestId !== distRequestId) return
    dist.value = { nodes: data?.nodes || [], edges: data?.edges || [] }
  } catch (error) {
    if (requestId === distRequestId && error?.code !== 'ABORT_ERR') distError.value = error.message || 'Span 数据加载失败'
  } finally {
    if (requestId === distRequestId) distLoading.value = false
  }
}

async function loadReqEvents() {
  if (!active.value?.trace_id) return
  const traceId = active.value.trace_id
  const requestId = ++reqRequestId
  reqLoading.value = true
  reqError.value = ''
  try {
    const data = await api(`/api/traces/${encodeURIComponent(traceId)}?pageSize=1000`, { requestKey: `traces:reqres:${traceId}` })
    if (requestId !== reqRequestId) return
    reqEvents.value = Array.isArray(data?.items) ? data.items : []
  } catch (error) {
    if (requestId === reqRequestId && error?.code !== 'ABORT_ERR') reqError.value = error.message || '请求 / 响应加载失败'
  } finally {
    if (requestId === reqRequestId) reqLoading.value = false
  }
}

watch(() => active.value?.trace_id, traceId => {
  if (traceId) { loadTopology(); loadReqEvents() }
})

watch(activeView, view => {
  if (view === 'waterfall' && active.value?.trace_id) loadDistributed()
})

// 头部统计
const servicesCount = computed(() => {
  if (topology.value.nodes.length) return topology.value.nodes.length
  const svc = new Set((dist.value.nodes || []).map(n => n.service).filter(Boolean))
  return svc.size || '-'
})

const overviewItems = computed(() => {
  if (!active.value) return []
  return [
    { label: '应用', value: active.value.app_id || '未记录' },
    { label: '版本', value: active.value.release_name || '未记录' },
    { label: '环境', value: active.value.environment || '生产环境' },
    { label: '开始时间', value: formatDate(active.value.started_at) },
    { label: '总耗时', value: formatDuration(active.value.duration), mono: true },
    { label: 'Span 数', value: active.value.span_count, mono: true },
    { label: '错误数', value: active.value.error_count, mono: true, danger: active.value.error_count > 0 },
    { label: '涉及服务', value: servicesCount.value, mono: true }
  ]
})

const spanRows = computed(() => {
  const nodes = [...(dist.value.nodes || [])].sort((a, b) => numberOr(a.startTs ?? a.start_ts) - numberOr(b.startTs ?? b.start_ts))
  const start = nodes.length ? numberOr(nodes[0].startTs ?? nodes[0].start_ts) : 0
  return nodes.map(node => ({
    ...node,
    id: node.id || node.spanId || node.span_id || '',
    service: node.service || node.serviceName || node.service_name || 'unknown',
    operation: node.name || node.operationName || node.operation_name || '未命名操作',
    startOffset: Math.max(0, numberOr(node.startTs ?? node.start_ts) - start),
    durationValue: numberOr(node.duration ?? node.duration_ms),
    error: isSpanError(node)
  }))
})

const activeViewLabel = computed(() => ({ topology: '调用拓扑', tree: '调用树', waterfall: '瀑布图' }[activeView.value]))

function isSpanError(span = {}) {
  return Boolean(span.hasError) || String(span.status || span.statusCode || '').toUpperCase() === 'ERROR' || Number(span.status || span.statusCode) >= 400
}

// 详情面板
function openNodeDetail(node) {
  detail.kind = 'node'
  detail.data = node
  detail.open = true
}
function openSpanDetail(span) {
  const children = (dist.value.edges || [])
    .filter(e => e.source === span.id)
    .map(e => (dist.value.nodes || []).find(n => n.id === e.target))
    .filter(Boolean)
  const self = Math.max(0, Number(span.duration || 0) - children.reduce((a, c) => a + Number(c.duration || 0), 0))
  detail.kind = 'span'
  detail.data = { ...span, self }
  detail.open = true
}
function closeDetail() { detail.open = false }

// 工具栏
function setLayout(mode) {
  layoutMode.value = mode
  topoRef.value?.setLayout(mode)
}
function fit() { topoRef.value?.fit() }
function toggleLegend() { topoRef.value?.toggleLegend() }

// 导出 / 分享（轻量）
function exportTrace() {
  if (!active.value) return
  const payload = {
    trace_id: active.value.trace_id,
    meta: active.value,
    topology: topology.value,
    distributed: dist.value
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `trace-${active.value.trace_id}.json`
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
async function shareTrace() {
  if (!active.value) return
  const url = `${location.origin}${location.pathname}?traceId=${encodeURIComponent(active.value.trace_id)}`
  try {
    await navigator.clipboard.writeText(url)
    // 简单反馈：借助全局 alert 不合适，这里用临时状态
    shareHint.value = '链接已复制'
    setTimeout(() => { shareHint.value = '' }, 1800)
  } catch {
    shareHint.value = '复制失败'
    setTimeout(() => { shareHint.value = '' }, 1800)
  }
}
const shareHint = ref('')

onMounted(load)
watch(refreshVersion, () => { pager.page = 1; void load() })
</script>

<template>
  <section class="trace-design-page">
    <header class="trace-page-head">
      <div class="trace-heading">
        <div class="trace-title-row">
          <h1>链路追踪</h1>
          <el-tag v-if="active" :type="active.error_count ? 'danger' : 'success'" effect="light" round>
            {{ active.error_count ? `${active.error_count} 个错误` : '调用正常' }}
          </el-tag>
        </div>
        <div class="trace-breadcrumb">
          <span>Trace</span>
          <i>/</i>
          <strong>{{ active?.trace_id || '尚未选择' }}</strong>
          <small>{{ active?.url || '选择一条链路查看完整调用过程' }}</small>
        </div>
      </div>
      <div class="trace-page-actions">
        <el-button :icon="Select" @click="tracePickerOpen = true">选择 Trace</el-button>
        <el-button :icon="RefreshRight" :loading="listLoading || topoLoading || distLoading" @click="load">刷新</el-button>
        <el-button :icon="Download" :disabled="!active" @click="exportTrace">导出</el-button>
        <el-button :icon="Share" :disabled="!active" @click="shareTrace">分享</el-button>
        <span v-if="shareHint" class="share-hint">{{ shareHint }}</span>
      </div>
    </header>

    <template v-if="active">
      <el-card class="trace-card trace-overview-card" shadow="never">
        <template #header>
          <div class="card-head">
            <div>
              <h2>Trace 概览</h2>
              <p>调用入口、执行状态与核心链路指标</p>
            </div>
            <span class="trace-start">{{ formatDate(active.started_at) }}</span>
          </div>
        </template>

        <div class="trace-entry">
          <div>
            <span class="entry-label">TRACE ID</span>
            <code>{{ active.trace_id }}</code>
          </div>
          <div>
            <span class="entry-label">入口 URL / 页面</span>
            <span class="entry-url" :title="active.url || '未记录'">{{ active.url || '未记录' }}</span>
          </div>
        </div>

        <div class="overview-grid">
          <div v-for="item in overviewItems" :key="item.label" class="overview-item" :class="{ danger: item.danger }">
            <span>{{ item.label }}</span>
            <strong :class="{ mono: item.mono }">{{ item.value }}</strong>
          </div>
        </div>
      </el-card>

      <el-card class="trace-card trace-visual-card" shadow="never">
        <template #header>
          <div class="visual-head">
            <div>
              <h2>调用拓扑</h2>
              <p>{{ activeViewLabel }} · 按真实 Span 还原服务调用关系</p>
            </div>
            <div class="visual-actions">
              <div class="segmented" role="tablist" aria-label="链路视图">
                <button type="button" :class="{ active: activeView === 'topology' }" @click="activeView = 'topology'">拓扑</button>
                <button type="button" :class="{ active: activeView === 'tree' }" @click="activeView = 'tree'">调用树</button>
                <button type="button" :class="{ active: activeView === 'waterfall' }" @click="activeView = 'waterfall'">瀑布图</button>
              </div>
              <div v-if="activeView === 'topology'" class="topo-tools">
                <button type="button" :class="{ active: layoutMode === 'force' }" @click="setLayout('force')">力导</button>
                <button type="button" :class="{ active: layoutMode === 'hier' }" @click="setLayout('hier')">分层</button>
                <button type="button" :class="{ active: layoutMode === 'radial' }" @click="setLayout('radial')">环形</button>
                <button type="button" @click="fit">适应</button>
                <button type="button" @click="toggleLegend">图例</button>
              </div>
            </div>
          </div>
        </template>

        <div class="trace-visual-body">
          <div v-show="activeView === 'topology'" v-loading="topoLoading" class="trace-view">
            <el-alert v-if="topoError" class="view-message" type="error" :title="topoError" show-icon :closable="false" />
            <el-alert v-else-if="topoNotice" class="view-message" type="info" :title="topoNotice" show-icon :closable="false" />
            <TraceTopology ref="topoRef" :nodes="topology.nodes" :edges="topology.edges" height="100%" @select="openNodeDetail" />
          </div>
          <div v-if="activeView === 'tree'" class="trace-view tree-view">
            <DistributedTraceTree :trace-id="active.trace_id" />
          </div>
          <div v-if="activeView === 'waterfall'" v-loading="distLoading" class="trace-view waterfall-view">
            <el-alert v-if="distError" class="view-message" type="error" :title="distError" show-icon :closable="false" />
            <TraceWaterfall :nodes="dist.nodes" :edges="dist.edges" @select="openSpanDetail" />
          </div>
        </div>
      </el-card>

      <el-card class="trace-card trace-spans-card" shadow="never">
        <template #header>
          <div class="card-head">
            <div>
              <h2>Span 时间线 / 明细</h2>
              <p>按开始时间排序，点击任意 Span 查看完整执行信息</p>
            </div>
            <span class="span-total">{{ spanRows.length }} 个 Span</span>
          </div>
        </template>

        <el-table
          v-loading="topoLoading || distLoading"
          :data="spanRows"
          row-key="id"
          empty-text="当前 Trace 暂无 Span 明细"
          class="span-table"
          @row-click="openSpanDetail"
        >
          <el-table-column label="服务 / 操作" min-width="250">
            <template #default="{ row }">
              <div class="span-operation" :class="{ error: row.error }">
                <span class="span-status-dot"></span>
                <div>
                  <strong>{{ row.service }}</strong>
                  <small>{{ row.operation }}</small>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="Span ID" min-width="190">
            <template #default="{ row }"><code class="span-id"><OverflowTip :text="row.id || '-'" /></code></template>
          </el-table-column>
          <el-table-column label="开始时间" width="130">
            <template #default="{ row }">+ {{ formatDuration(row.startOffset) }}</template>
          </el-table-column>
          <el-table-column label="耗时" width="120">
            <template #default="{ row }"><strong class="span-duration">{{ formatDuration(row.durationValue) }}</strong></template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="row.error ? 'danger' : 'success'" effect="light" size="small">
                {{ row.error ? '错误' : '正常' }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <RequestResponsePanel
        :events="reqEvents"
        :loading="reqLoading"
        :error="reqError"
      />
    </template>

    <el-card v-else class="trace-card trace-empty-card" shadow="never">
      <el-empty :description="listError || '暂无可展示的链路数据'">
        <el-button type="primary" :icon="Select" @click="tracePickerOpen = true">选择 Trace</el-button>
      </el-empty>
    </el-card>

    <el-drawer v-model="tracePickerOpen" title="选择 Trace" size="min(440px, 92vw)" class="trace-picker">
      <div class="picker-search">
        <el-input v-model="filters.traceId" clearable placeholder="搜索 Trace ID / 页面路径" :prefix-icon="Search" @keyup.enter="onSearch" @clear="onSearch" />
        <el-button type="primary" :icon="Search" :loading="listLoading" @click="onSearch">搜索</el-button>
      </div>
      <el-alert v-if="listError" type="error" :title="listError" show-icon :closable="false" />
      <div v-loading="listLoading" class="picker-list">
        <button
          v-for="trace in traces"
          :key="trace.trace_id"
          type="button"
          class="trace-picker-item"
          :class="{ active: active?.trace_id === trace.trace_id }"
          @click="selectTrace(trace)"
        >
          <span class="picker-item-top">
            <code>{{ trace.trace_id }}</code>
            <el-tag :type="trace.error_count ? 'danger' : 'success'" effect="light" size="small">
              {{ trace.error_count ? `${trace.error_count} 错误` : '正常' }}
            </el-tag>
          </span>
          <span class="picker-item-meta">
            <span>{{ formatDuration(trace.duration) }}</span>
            <span>{{ trace.span_count }} Span</span>
            <span>{{ formatDate(trace.started_at) }}</span>
          </span>
          <small>{{ trace.url || trace.release_name || '未记录入口页面' }}</small>
        </button>
        <el-empty v-if="!listLoading && !traces.length" :image-size="72" description="没有匹配的 Trace" />
      </div>
      <div v-if="pager.total > 0" class="picker-pager">
        <el-pagination
          background
          layout="prev, pager, next"
          :pager-count="5"
          :current-page="pager.page"
          :page-size="pager.pageSize"
          :total="pager.total"
          @current-change="value => { pager.page = value; load() }"
        />
      </div>
    </el-drawer>

    <el-drawer v-model="detail.open" :title="detail.kind === 'node' ? '服务节点' : 'Span 详情'" size="min(420px, 92vw)" @closed="closeDetail">
      <el-descriptions v-if="detail.data" :column="1" border class="detail-descriptions">
        <template v-if="detail.kind === 'node'">
          <el-descriptions-item label="名称">{{ detail.data.label || '-' }}</el-descriptions-item>
          <el-descriptions-item label="类型">{{ detail.data.type || '-' }}</el-descriptions-item>
          <el-descriptions-item label="健康度">
            <el-tag :type="detail.data.err > 0 ? 'danger' : (detail.data.p95 > 300 ? 'warning' : 'success')" effect="light">
              {{ detail.data.err > 0 ? '异常' : (detail.data.p95 > 300 ? '缓慢' : '正常') }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="调用量">{{ detail.data.calls ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="P95 延迟">{{ detail.data.p95 ?? '-' }} ms</el-descriptions-item>
          <el-descriptions-item label="错误数">{{ detail.data.err ?? 0 }}</el-descriptions-item>
        </template>
        <template v-else>
          <el-descriptions-item label="服务">{{ detail.data.service || '-' }}</el-descriptions-item>
          <el-descriptions-item label="操作">{{ detail.data.operation || detail.data.name || '-' }}</el-descriptions-item>
          <el-descriptions-item label="Span ID"><code>{{ detail.data.id || '-' }}</code></el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="isSpanError(detail.data) ? 'danger' : 'success'" effect="light">
              {{ isSpanError(detail.data) ? '错误' : '正常' }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="耗时">{{ formatDuration(detail.data.durationValue ?? detail.data.duration) }}</el-descriptions-item>
          <el-descriptions-item label="自身耗时">{{ formatDuration(detail.data.self) }}</el-descriptions-item>
        </template>
      </el-descriptions>
    </el-drawer>
  </section>
</template>

<style scoped>
.trace-design-page {
  display: grid;
  gap: 16px;
  min-width: 0;
}

.trace-page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding: 2px 2px 4px;
}

.trace-heading { min-width: 0; }
.trace-title-row { display: flex; align-items: center; gap: 12px; }
.trace-title-row h1 { margin: 0; color: #171826; font-size: 20px; line-height: 1.35; font-weight: 700; }
.trace-breadcrumb { display: flex; align-items: center; gap: 8px; min-width: 0; margin-top: 7px; color: #8a91a3; font-size: 12px; }
.trace-breadcrumb i { color: #c1c5d0; font-style: normal; }
.trace-breadcrumb strong { max-width: 280px; overflow: hidden; color: #4f46e5; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
.trace-breadcrumb small { max-width: 420px; overflow: hidden; color: #9ba1b1; text-overflow: ellipsis; white-space: nowrap; }
.trace-page-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.trace-page-actions :deep(.el-button + .el-button) { margin-left: 0; }
.share-hint { color: #16a34a; font-size: 12px; white-space: nowrap; }

.trace-card { min-width: 0; border-color: #e8e9ef; border-radius: 14px; }
.trace-card :deep(.el-card__header) { padding: 18px 22px; border-bottom-color: #eceef3; }
.trace-card :deep(.el-card__body) { padding: 22px; }
.card-head,
.visual-head { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
.card-head h2,
.visual-head h2 { margin: 0; color: #202132; font-size: 15px; line-height: 1.4; font-weight: 700; }
.card-head p,
.visual-head p { margin: 4px 0 0; color: #8b91a2; font-size: 12px; }
.trace-start,
.span-total { flex: none; color: #858c9d; font-size: 12px; }

.trace-entry {
  display: grid;
  grid-template-columns: minmax(260px, .8fr) minmax(320px, 1.2fr);
  gap: 16px;
  padding: 16px 18px;
  border: 1px solid #e8e9f0;
  border-radius: 12px;
  background: #fafafd;
}
.trace-entry > div { display: grid; gap: 7px; min-width: 0; }
.entry-label { color: #9298a8; font-size: 11px; font-weight: 600; letter-spacing: .04em; }
.trace-entry code { overflow: hidden; color: #3730a3; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.entry-url { overflow: hidden; color: #3c4051; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.overview-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; margin-top: 18px; overflow: hidden; border: 1px solid #eceef3; border-radius: 12px; background: #eceef3; }
.overview-item { display: grid; gap: 8px; min-height: 76px; padding: 15px 17px; background: #fff; }
.overview-item span { color: #9298a8; font-size: 11px; }
.overview-item strong { overflow: hidden; color: #292b3b; font-size: 13px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.overview-item strong.mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 15px; }
.overview-item.danger strong { color: #dc2626; }

.visual-head { align-items: flex-start; }
.visual-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; flex-wrap: wrap; }
.segmented { display: inline-flex; gap: 2px; padding: 3px; border: 1px solid #e2e4eb; border-radius: 9px; background: #f5f6f9; }
.segmented button,
.topo-tools button { min-height: 30px; border: 0; border-radius: 7px; background: transparent; color: #707789; font: inherit; font-size: 12px; cursor: pointer; transition: background-color .16s ease, color .16s ease, box-shadow .16s ease; }
.segmented button { padding: 0 12px; }
.segmented button:hover,
.topo-tools button:hover { color: #4f46e5; }
.segmented button.active { background: #fff; color: #4f46e5; box-shadow: 0 1px 4px rgba(31, 35, 48, .1); font-weight: 650; }
.topo-tools { display: flex; gap: 3px; padding-left: 10px; border-left: 1px solid #e5e7ed; }
.topo-tools button { padding: 0 9px; border: 1px solid transparent; }
.topo-tools button.active { border-color: #c9c5fb; background: #efefff; color: #4f46e5; }
.trace-visual-card :deep(.el-card__body) { padding: 0; }
.trace-visual-body { position: relative; min-height: 520px; overflow: hidden; border-radius: 0 0 14px 14px; background-color: #fafbfe; background-image: radial-gradient(circle, #dfe2ec 1px, transparent 1px); background-size: 18px 18px; }
.trace-view { position: relative; min-width: 0; height: 520px; overflow: auto; }
.tree-view,
.waterfall-view { background: rgba(255, 255, 255, .94); }
.view-message { position: absolute; top: 14px; right: 14px; left: 14px; z-index: 3; width: auto; }
.tree-view :deep(.distributed-trace) { min-height: 100%; border: 0; border-radius: 0; box-shadow: none; }

.trace-spans-card :deep(.el-card__body) { padding: 0; }
.span-table { width: 100%; cursor: pointer; }
.span-table :deep(.el-table__header th) { height: 44px; background: #fafafd; color: #777e90; font-size: 12px; font-weight: 650; }
.span-table :deep(.el-table__row:hover > td) { background: #f7f7ff !important; }
.span-operation { display: flex; align-items: center; gap: 11px; min-width: 0; }
.span-operation > div { display: grid; gap: 3px; min-width: 0; }
.span-operation strong,
.span-operation small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.span-operation strong { color: #303243; font-size: 12.5px; }
.span-operation small { color: #8c93a4; font-size: 11px; }
.span-status-dot { width: 8px; height: 8px; flex: none; border: 2px solid #a6a2ef; border-radius: 50%; background: #f0efff; box-shadow: 0 0 0 4px #f5f4ff; }
.span-operation.error .span-status-dot { border-color: #f87171; background: #fee2e2; box-shadow: 0 0 0 4px #fef2f2; }
.span-operation.error strong { color: #dc2626; }
.span-id { color: #656b7c; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; }
.span-duration { color: #3c4051; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
.trace-empty-card :deep(.el-card__body) { display: grid; min-height: 360px; place-items: center; }

.picker-search { display: grid; grid-template-columns: 1fr auto; gap: 8px; margin-bottom: 14px; }
.picker-list { display: grid; gap: 8px; min-height: 240px; margin-top: 14px; }
.trace-picker-item { display: grid; gap: 9px; width: 100%; padding: 13px 14px; border: 1px solid #e6e8ef; border-radius: 11px; background: #fff; text-align: left; cursor: pointer; transition: border-color .16s ease, background-color .16s ease, box-shadow .16s ease; }
.trace-picker-item:hover { border-color: #bbb7f4; background: #fbfaff; }
.trace-picker-item.active { border-color: #8179ec; background: #f7f6ff; box-shadow: 0 0 0 2px rgba(79, 70, 229, .08); }
.picker-item-top,
.picker-item-meta { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.picker-item-top code { min-width: 0; overflow: hidden; color: #343648; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.picker-item-meta { justify-content: flex-start; color: #737a8c; font-size: 11px; }
.picker-item-meta span + span::before { margin-right: 10px; color: #c2c6d0; content: '·'; }
.trace-picker-item small { overflow: hidden; color: #959baa; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.picker-pager { display: flex; justify-content: center; padding-top: 16px; }
.detail-descriptions code { color: #4f46e5; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; word-break: break-all; }

@media (max-width: 1100px) {
  .trace-page-head,
  .card-head,
  .visual-head { align-items: flex-start; flex-direction: column; }
  .trace-page-actions,
  .visual-actions { justify-content: flex-start; }
  .trace-entry { grid-template-columns: 1fr; }
  .overview-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .trace-visual-body,
  .trace-view { min-height: 500px; height: 500px; }
}

@media (max-width: 720px) {
  .trace-breadcrumb { align-items: flex-start; flex-wrap: wrap; }
  .trace-breadcrumb small { flex-basis: 100%; max-width: 100%; }
  .trace-page-actions { width: 100%; }
  .trace-page-actions :deep(.el-button) { flex: 1 1 auto; }
  .trace-card :deep(.el-card__header),
  .trace-card :deep(.el-card__body) { padding: 16px; }
  .trace-visual-card :deep(.el-card__body),
  .trace-spans-card :deep(.el-card__body) { padding: 0; }
  .trace-entry { padding: 14px; }
  .overview-item { min-height: 70px; padding: 13px; }
  .visual-actions { width: 100%; }
  .segmented { width: 100%; }
  .segmented button { flex: 1; padding: 0 8px; }
  .topo-tools { width: 100%; padding: 8px 0 0; border-top: 1px solid #e5e7ed; border-left: 0; overflow-x: auto; }
  .topo-tools button { flex: 1 0 auto; }
  .trace-visual-body,
  .trace-view { min-height: 460px; height: 460px; }
}
</style>
