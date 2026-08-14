<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { api, normalizePageResponse, queryFromFilters, pageLoading, refreshVersion, filters } from '../../../dashboard.js'
import { formatDuration } from '../../../utils/format.js'
import TraceTopology from '../../../components/TraceTopology.vue'
import TraceWaterfall from '../../../components/TraceWaterfall.vue'
import DistributedTraceTree from '../../../components/DistributedTraceTree.vue'
import { buildTopologyFromDistributed } from '../../../utils/trace-topology.js'

const traces = ref([])
const pager = reactive({ page: 1, pageSize: 12, total: 0 })
const listLoading = ref(false)
const listError = ref('')
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
    release_name: row.release_name || row.releaseName || row.release || '',
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
    // Keep the detail workbench populated when the trace list has data. This
    // mirrors the design-b split view and avoids an apparently blank topology
    // until the user discovers that a row must be clicked first.
    if (!active.value && traces.value.length) await selectTrace(traces.value[0])
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

function loadForView(view) {
  if (!active.value?.trace_id) return
  if (view === 'topology') loadTopology()
  else if (view === 'waterfall') loadDistributed()
  // 调用树由 DistributedTraceTree 自行拉取
}

watch([activeView, () => active.value?.trace_id], ([view]) => {
  if (active.value?.trace_id) loadForView(view)
})

// 头部统计
const servicesCount = computed(() => {
  if (topology.value.nodes.length) return topology.value.nodes.length
  const svc = new Set((dist.value.nodes || []).map(n => n.service).filter(Boolean))
  return svc.size || '-'
})

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
  <div class="trace-page">
    <!-- 左侧：链路列表 -->
    <aside class="trace-side">
      <div class="side-search">
        <el-input v-model="filters.traceId" size="default" clearable placeholder="搜索 Trace ID / 页面路径" @keyup.enter="onSearch" @clear="onSearch">
          <template #append><el-button @click="onSearch">搜索</el-button></template>
        </el-input>
      </div>
      <div class="side-list">
        <div v-if="listError" class="side-error">{{ listError }}</div>
        <div
          v-for="t in traces"
          :key="t.trace_id"
          class="trace-item"
          :class="{ active: active?.trace_id === t.trace_id }"
          @click="selectTrace(t)"
        >
          <div class="tid">{{ t.trace_id }}</div>
          <div class="meta">
            <span class="pill dur">{{ formatDuration(t.duration) }}</span>
            <span class="pill">{{ t.span_count }} span</span>
            <span class="pill" :class="t.error_count ? 'err' : 'ok'">{{ t.error_count ? t.error_count + ' 错误' : '正常' }}</span>
          </div>
          <div class="sub">{{ t.url || t.release_name || '—' }}</div>
        </div>
        <el-empty v-if="!listLoading && !traces.length" :image-size="60" description="暂无链路" />
      </div>
      <div v-if="pager.total > 0" class="side-pager">
        <el-pagination background layout="prev, pager, next" :pager-count="5" :current-page="pager.page" :page-size="pager.pageSize" :total="pager.total" @current-change="value => { pager.page = value; load() }" />
      </div>
    </aside>

    <!-- 右侧：链路详情 -->
    <section class="trace-main">
      <template v-if="active">
        <header class="trace-head">
          <div class="th-id"><small>TRACE ID</small>{{ active.trace_id }}</div>
          <div class="stat"><b>{{ formatDuration(active.duration) }}</b><span>总耗时</span></div>
          <div class="stat"><b>{{ active.span_count }}</b><span>Span 数</span></div>
          <div class="stat" :class="{ err: active.error_count }"><b>{{ active.error_count }}</b><span>错误</span></div>
          <div class="stat"><b>{{ servicesCount }}</b><span>涉及服务</span></div>
          <div class="stat"><b>{{ formatDate(active.started_at) }}</b><span>开始时间</span></div>
          <div class="head-spacer"></div>
          <div class="head-btns">
            <el-button size="small" @click="exportTrace">导出</el-button>
            <el-button size="small" @click="shareTrace">分享</el-button>
            <span v-if="shareHint" class="share-hint">{{ shareHint }}</span>
          </div>
        </header>

        <div class="toolbar">
          <div class="tabs">
            <div class="tab" :class="{ active: activeView === 'topology' }" @click="activeView = 'topology'">调用拓扑</div>
            <div class="tab" :class="{ active: activeView === 'tree' }" @click="activeView = 'tree'">调用树</div>
            <div class="tab" :class="{ active: activeView === 'waterfall' }" @click="activeView = 'waterfall'">瀑布图</div>
          </div>
          <div class="tool-sep"></div>
          <div v-show="activeView === 'topology'" class="topo-tools">
            <button class="icon-btn" :class="{ active: layoutMode === 'force' }" @click="setLayout('force')">力导</button>
            <button class="icon-btn" :class="{ active: layoutMode === 'hier' }" @click="setLayout('hier')">分层</button>
            <button class="icon-btn" :class="{ active: layoutMode === 'radial' }" @click="setLayout('radial')">环形</button>
            <button class="icon-btn" @click="fit">适应</button>
            <button class="icon-btn" @click="toggleLegend">图例</button>
          </div>
        </div>

        <div class="canvas">
          <div v-loading="topoLoading" class="view" :class="{ active: activeView === 'topology' }">
            <el-alert v-if="topoError" class="view-error" type="error" :title="topoError" show-icon :closable="false" />
            <el-alert v-else-if="topoNotice" class="view-notice" type="info" :title="topoNotice" show-icon :closable="false" />
            <TraceTopology ref="topoRef" :nodes="topology.nodes" :edges="topology.edges" height="100%" @select="openNodeDetail" />
          </div>
          <div class="view" :class="{ active: activeView === 'tree' }">
            <DistributedTraceTree v-if="activeView === 'tree'" :trace-id="active.trace_id" />
          </div>
          <div class="view" :class="{ active: activeView === 'waterfall' }">
            <el-alert v-if="distError" class="view-error" type="error" :title="distError" show-icon :closable="false" />
            <TraceWaterfall :nodes="dist.nodes" :edges="dist.edges" @select="openSpanDetail" />
          </div>

          <!-- 详情面板 -->
          <aside class="detail" :class="{ open: detail.open }">
            <div class="dh">
              <b>{{ detail.kind === 'node' ? '服务节点' : 'Span 详情' }}</b>
              <button class="close-x" @click="closeDetail">×</button>
            </div>
            <div class="dbody" v-if="detail.data">
              <template v-if="detail.kind === 'node'">
                <div class="kv">
                  <div class="row"><span class="k">名称</span><span class="v">{{ detail.data.label }}</span></div>
                  <div class="row"><span class="k">类型</span><span class="v">{{ detail.data.type }}</span></div>
                  <div class="row"><span class="k">健康度</span><span class="v" :style="{ color: detail.data.err > 0 ? '#ef4444' : (detail.data.p95 > 300 ? '#f59e0b' : '#0ea765') }">{{ detail.data.err > 0 ? '异常' : (detail.data.p95 > 300 ? '缓慢' : '正常') }}</span></div>
                  <div class="row"><span class="k">调用量</span><span class="v">{{ detail.data.calls }}</span></div>
                  <div class="row"><span class="k">P95 延迟</span><span class="v">{{ detail.data.p95 }} ms</span></div>
                  <div class="row"><span class="k">错误数</span><span class="v" :style="{ color: detail.data.err ? '#ef4444' : '' }">{{ detail.data.err }}</span></div>
                </div>
              </template>
              <template v-else>
                <div class="kv">
                  <div class="row"><span class="k">服务</span><span class="v">{{ detail.data.service }}</span></div>
                  <div class="row"><span class="k">操作</span><span class="v">{{ detail.data.name }}</span></div>
                  <div class="row"><span class="k">Span ID</span><span class="v">{{ detail.data.id }}</span></div>
                  <div class="row"><span class="k">状态</span><span class="v" :style="{ color: String(detail.data.status).toUpperCase() === 'ERROR' || Number(detail.data.status) >= 400 ? '#ef4444' : '#0ea765' }">{{ detail.data.status }}</span></div>
                  <div class="row"><span class="k">耗时</span><span class="v">{{ formatDuration(detail.data.duration) }}</span></div>
                  <div class="row"><span class="k">自身耗时</span><span class="v">{{ formatDuration(detail.data.self) }}</span></div>
                </div>
              </template>
            </div>
          </aside>
        </div>
      </template>

      <div v-else class="empty-state">
        <el-empty description="从左侧选择一条链路查看调用拓扑、调用树与瀑布图" />
      </div>
    </section>
  </div>
</template>

<style scoped>
.trace-page { display: grid; grid-template-columns: 300px 1fr; height: calc(100vh - 58px); min-height: 0; }

/* 左侧列表 */
.trace-side { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--line, #dfe5ec); background: #fafbfc; }
.side-search { padding: 12px; border-bottom: 1px solid var(--line, #dfe5ec); }
.side-list { flex: 1; overflow-y: auto; padding: 8px; }
.side-error { color: #ef4444; font-size: 12px; padding: 8px; }
.trace-item { padding: 10px 12px; border-radius: 7px; cursor: pointer; border: 1px solid transparent; margin-bottom: 6px; transition: .15s; background: #fff; border-color: #eef1f5; }
.trace-item:hover { border-color: #c9d6e6; }
.trace-item.active { background: #eaf2ff; border-color: #1769e0; box-shadow: inset 3px 0 #1769e0; }
.trace-item .tid { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: #344258; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.trace-item.active .tid { color: #1769e0; }
.trace-item .meta { display: flex; gap: 8px; margin-top: 6px; }
.trace-item .sub { margin-top: 5px; font-size: 11px; color: #8a96a7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pill { padding: 1px 7px; border-radius: 20px; font-size: 10px; border: 1px solid #e2e8f0; color: #627085; }
.pill.dur { color: #344258; }
.pill.err { color: #ef4444; border-color: #f3b6b6; background: #fff7f7; }
.pill.ok { color: #0ea765; border-color: #bfe9d4; background: #f0fbf5; }
.side-pager { padding: 10px; border-top: 1px solid var(--line, #dfe5ec); display: flex; justify-content: center; flex-wrap: wrap; overflow-x: hidden; }

/* 右侧主区 */
.trace-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.trace-head { display: flex; align-items: center; gap: 22px; padding: 14px 20px; border-bottom: 1px solid var(--line, #dfe5ec); background: #fff; flex-wrap: wrap; }
.trace-head .th-id { font-family: ui-monospace, Consolas, monospace; font-size: 13px; color: #172033; min-width: 0; }
.trace-head .th-id small { display: block; color: #8a96a7; font-size: 11px; margin-bottom: 3px; font-family: 'Segoe UI','Microsoft YaHei',sans-serif; }
.stat { display: flex; flex-direction: column; gap: 2px; }
.stat b { font-size: 18px; font-family: ui-monospace, Consolas, monospace; font-weight: 700; color: #172033; }
.stat span { font-size: 11px; color: #8a96a7; }
.stat.err b { color: #ef4444; }
.head-spacer { flex: 1; }
.head-btns { display: flex; align-items: center; gap: 8px; }
.share-hint { font-size: 12px; color: #0ea765; }

.toolbar { display: flex; align-items: center; gap: 14px; padding: 10px 20px; border-bottom: 1px solid var(--line, #dfe5ec); background: #f8fafc; }
.tabs { display: flex; gap: 4px; background: #fff; padding: 4px; border-radius: 10px; border: 1px solid var(--line, #dfe5ec); }
.tab { padding: 7px 14px; border-radius: 7px; cursor: pointer; font-size: 13px; color: #627085; transition: .15s; }
.tab:hover { color: #172033; }
.tab.active { background: #1769e0; color: #fff; box-shadow: 0 4px 12px rgba(23,101,224,.18); }
.tool-sep { width: 1px; height: 22px; background: var(--line, #dfe5ec); }
.topo-tools { display: flex; gap: 6px; }
.icon-btn { background: #fff; border: 1px solid var(--line, #dfe5ec); color: #627085; border-radius: 8px; padding: 6px 11px; cursor: pointer; font-size: 13px; transition: .15s; }
.icon-btn:hover { color: #172033; border-color: #c9d6e6; }
.icon-btn.active { color: #1769e0; border-color: #1769e0; background: #eaf2ff; }

.canvas { position: relative; flex: 1; min-height: 0; overflow: hidden; background: #f5f7fa; }
.view { position: absolute; inset: 0; display: none; }
.view.active { display: block; }
.view-error { margin: 10px; }
.view-notice { position: absolute; top: 10px; left: 10px; right: 10px; z-index: 2; width: auto; }
.empty-state { display: grid; place-items: center; height: 100%; }

/* 详情面板 */
.detail { position: absolute; top: 0; right: 0; width: 320px; height: 100%; background: #fff; border-left: 1px solid var(--line, #dfe5ec); box-shadow: -8px 0 24px rgba(23,32,51,.10); transform: translateX(100%); transition: transform .25s ease; display: flex; flex-direction: column; z-index: 5; }
.detail.open { transform: translateX(0); }
.detail .dh { padding: 14px 16px; border-bottom: 1px solid var(--line, #dfe5ec); display: flex; align-items: center; justify-content: space-between; background: #fafbfc; }
.detail .dh b { font-size: 13px; color: #172033; }
.detail .dbody { flex: 1; overflow-y: auto; padding: 14px 16px; }
.detail .kv .row { display: flex; justify-content: space-between; padding: 7px 0; border-bottom: 1px dashed #eef1f5; font-size: 12.5px; }
.detail .kv .row .k { color: #627085; }
.detail .kv .row .v { font-family: ui-monospace, Consolas, monospace; color: #172033; text-align: right; max-width: 60%; word-break: break-all; }
.close-x { cursor: pointer; color: #8a96a7; border: none; background: none; font-size: 18px; line-height: 1; }
.close-x:hover { color: #172033; }
</style>
