<script setup>
import { computed, ref, watch } from 'vue'
import { api, pageLoading } from '../dashboard.js'
import { buildTraceTree, countTraceNodes, filterTraceTree, formatTraceDuration, getTraceBounds, limitTraceTree, serviceColor } from '../utils/distributed-trace.js'
import DistributedTraceNode from './DistributedTraceNode.vue'

const props = defineProps({
  traceId: { type: String, required: true }
})

const nodes = ref([])
const edges = ref([])
const errorSpans = ref([])
const criticalPath = ref([])
const loading = ref(false)
const loadError = ref('')
const query = ref('')
const mode = ref('all')
const service = ref('all')
const compact = ref(false)
const visibleLimit = ref(120)
const selectedNode = ref(null)
const expandSignal = ref(0)
const expandAll = ref(true)
let loadRequestId = 0

async function loadDistributedTrace() {
  if (!props.traceId) {
    loadRequestId += 1
    nodes.value = []
    edges.value = []
    errorSpans.value = []
    criticalPath.value = []
    loadError.value = ''
    return
  }
  const requestId = ++loadRequestId
  loading.value = true
  loadError.value = ''
  pageLoading.value = true
  try {
    const data = await api(`/api/traces/${encodeURIComponent(props.traceId)}/distributed`, { requestKey: `trace:distributed:${props.traceId}` })
    if (requestId !== loadRequestId) return
    nodes.value = data.nodes || []
    edges.value = data.edges || []
    errorSpans.value = data.errorSpans || []
    criticalPath.value = data.criticalPath || []
    selectedNode.value = null
    visibleLimit.value = 120
  } catch (e) {
    if (requestId === loadRequestId && e?.code !== 'ABORT_ERR') loadError.value = e.message || '调用拓扑加载失败，请稍后重试'
  } finally {
    if (requestId === loadRequestId) {
      loading.value = false
      pageLoading.value = false
    }
  }
}

watch(() => props.traceId, loadDistributedTrace, { immediate: true })

const tree = computed(() => buildTraceTree(nodes.value, edges.value))
const services = computed(() => [...new Set(nodes.value.map(node => node.service || 'unknown'))].sort())
const bounds = computed(() => getTraceBounds(nodes.value))
const filteredTree = computed(() => filterTraceTree(tree.value, {
  query: query.value,
  mode: mode.value,
  service: service.value,
  errorSpans: errorSpans.value,
  criticalPath: criticalPath.value
}))
const filteredCount = computed(() => countTraceNodes(filteredTree.value))
const visibleTree = computed(() => limitTraceTree(filteredTree.value, visibleLimit.value))
const visibleCount = computed(() => countTraceNodes(visibleTree.value))
const ticks = computed(() => [0, 0.25, 0.5, 0.75, 1].map(ratio => ({ ratio, label: formatTraceDuration(bounds.value.duration * ratio) })))

watch([query, mode, service], () => { visibleLimit.value = 120 })

function toggleAll() {
  expandAll.value = !expandAll.value
  expandSignal.value++
}

function resetFilters() {
  query.value = ''
  mode.value = 'all'
  service.value = 'all'
}
</script>

<template>
  <section class="distributed-trace" :class="{ 'is-compact': compact }">
    <template v-if="nodes.length">
      <header class="trace-hero">
        <div class="trace-title-block">
          <div class="trace-eyebrow"><span class="live-dot"></span>DISTRIBUTED TRACE</div>
          <h3>调用拓扑</h3>
          <code>{{ traceId }}</code>
        </div>
        <div class="trace-metrics">
          <div class="trace-metric"><span>节点</span><strong>{{ nodes.length }}</strong><small>SPANS</small></div>
          <div class="trace-metric"><span>服务</span><strong>{{ services.length }}</strong><small>SERVICES</small></div>
          <div class="trace-metric" :class="{ danger: errorSpans.length }"><span>错误</span><strong>{{ errorSpans.length }}</strong><small>ERRORS</small></div>
          <div class="trace-metric accent"><span>时间窗</span><strong>{{ formatTraceDuration(bounds.duration) }}</strong><small>WINDOW</small></div>
        </div>
      </header>

      <div class="trace-toolbar">
        <label class="trace-search">
          <span>⌕</span>
          <input v-model="query" aria-label="搜索调用节点" placeholder="搜索操作、服务或 Span ID" />
          <button v-if="query" type="button" aria-label="清空搜索" @click="query = ''">×</button>
        </label>
        <div class="mode-switch" role="group" aria-label="节点筛选">
          <button v-for="item in [{ value: 'all', label: '全部' }, { value: 'errors', label: '错误' }, { value: 'critical', label: '关键路径' }]" :key="item.value" type="button" :class="{ active: mode === item.value }" @click="mode = item.value">{{ item.label }}</button>
        </div>
        <select v-model="service" class="service-select" aria-label="筛选服务">
          <option value="all">全部服务</option>
          <option v-for="item in services" :key="item" :value="item">{{ item }}</option>
        </select>
        <div class="toolbar-actions">
          <button type="button" :class="{ active: compact }" @click="compact = !compact">{{ compact ? '舒适' : '紧凑' }}</button>
          <button type="button" @click="toggleAll">{{ expandAll ? '全部折叠' : '全部展开' }}</button>
        </div>
      </div>

      <div class="service-legend">
        <span v-for="item in services" :key="item"><i :style="{ background: serviceColor(item) }"></i>{{ item }}</span>
        <span class="legend-critical"><i></i>关键路径 {{ criticalPath.length }}</span>
        <span class="legend-error"><i></i>错误 {{ errorSpans.length }}</span>
      </div>

      <div v-if="selectedNode" class="node-inspector">
        <button type="button" aria-label="关闭节点详情" @click="selectedNode = null">×</button>
        <div class="inspector-service"><i :style="{ background: serviceColor(selectedNode.service) }"></i>{{ selectedNode.service || 'unknown' }}</div>
        <strong>{{ selectedNode.name || 'root' }}</strong>
        <dl>
          <div><dt>Span ID</dt><dd>{{ selectedNode.id }}</dd></div>
          <div><dt>类型</dt><dd>{{ selectedNode.kind || 'INTERNAL' }}</dd></div>
          <div><dt>状态</dt><dd :class="{ error: selectedNode.hasError || errorSpans.includes(selectedNode.id) }">{{ selectedNode.status || 'UNSET' }}</dd></div>
          <div><dt>耗时</dt><dd>{{ formatTraceDuration(selectedNode.duration) }}</dd></div>
        </dl>
      </div>

      <div v-if="filteredTree.length" class="trace-viewport">
        <div class="trace-grid">
          <div class="timeline-head">
            <div class="operation-heading"><span>服务 / 操作</span><small>{{ visibleCount }} / {{ filteredCount }} 节点</small></div>
            <div class="timeline-scale">
              <span v-for="tick in ticks" :key="tick.ratio" :style="{ left: `${tick.ratio * 100}%` }">{{ tick.label }}</span>
            </div>
            <div class="duration-heading">耗时</div>
          </div>
          <div class="trace-tree" role="tree" aria-label="分布式调用树">
            <DistributedTraceNode
              v-for="root in visibleTree"
              :key="root.id"
              :node="root"
              :error-spans="errorSpans"
              :critical-path="criticalPath"
              :trace-start="bounds.start"
              :trace-duration="bounds.duration"
              :compact="compact"
              :expand-signal="expandSignal"
              :expand-all="expandAll"
              :selected-id="selectedNode?.id"
              @select="selectedNode = $event"
            />
          </div>
        </div>
      </div>

      <div v-if="visibleCount < filteredCount" class="load-more">
        <span>为保持大规模 Trace 流畅，当前显示 {{ visibleCount }} / {{ filteredCount }} 个节点</span>
        <button type="button" @click="visibleLimit += 120">继续显示 120 个</button>
      </div>

      <div v-if="!filteredTree.length" class="filter-empty">
        <span>⌁</span><strong>没有匹配的调用节点</strong><p>换一个关键词，或清除当前筛选条件。</p>
        <button type="button" @click="resetFilters">清除筛选</button>
      </div>
    </template>

    <div v-if="!loading && loadError" class="trace-empty trace-error">
      <div class="empty-orbit"><span></span><i></i></div>
      <strong>调用拓扑加载失败</strong>
      <p>{{ loadError }}</p>
      <button type="button" @click="loadDistributedTrace">重试</button>
    </div>

    <div v-if="!loading && !loadError && !nodes.length" class="trace-empty">
      <div class="empty-orbit"><span></span><i></i></div>
      <strong>暂无链路数据</strong>
      <p>当前 Trace 尚未形成可展示的调用关系。</p>
    </div>

    <div v-if="loading" class="loading">
      <span class="loader-ring"></span>
      <div><strong>正在重建调用拓扑</strong><small>解析 Span 关系与关键路径…</small></div>
    </div>
  </section>
</template>

<style scoped>
.distributed-trace {
  --trace-bg: #07111f;
  --trace-panel: #0b1728;
  --trace-panel-2: #0e1c30;
  --trace-line: rgba(148, 163, 184, .16);
  --trace-muted: #8292a9;
  position: relative;
  min-height: 560px;
  overflow: hidden;
  color: #dbe7f5;
  background:
    radial-gradient(circle at 88% -10%, rgba(45, 212, 191, .14), transparent 32%),
    radial-gradient(circle at 2% 32%, rgba(56, 189, 248, .08), transparent 26%),
    var(--trace-bg);
  border: 1px solid #14243a;
  border-radius: 14px;
  box-shadow: 0 18px 50px rgba(3, 10, 20, .16), inset 0 1px rgba(255, 255, 255, .03);
  font-family: "IBM Plex Sans", "Noto Sans SC", sans-serif;
}
.trace-hero { display: flex; align-items: stretch; justify-content: space-between; gap: 28px; padding: 22px 24px 18px; border-bottom: 1px solid var(--trace-line); }
.trace-title-block { min-width: 230px; }
.trace-eyebrow { display: flex; align-items: center; gap: 8px; color: #65d9cd; font: 700 10px/1.2 ui-monospace, monospace; letter-spacing: .18em; }
.live-dot { width: 7px; height: 7px; background: #2dd4bf; border-radius: 50%; box-shadow: 0 0 0 4px rgba(45, 212, 191, .1), 0 0 16px #2dd4bf; animation: trace-pulse 2.4s ease-in-out infinite; }
.trace-title-block h3 { margin: 8px 0 3px; color: #f3f8ff; font-size: 22px; letter-spacing: -.03em; }
.trace-title-block code { display: block; max-width: 350px; overflow: hidden; color: #667991; font: 11px/1.4 ui-monospace, monospace; text-overflow: ellipsis; white-space: nowrap; }
.trace-metrics { display: grid; flex: 1; max-width: 680px; grid-template-columns: repeat(4, minmax(100px, 1fr)); }
.trace-metric { position: relative; padding: 2px 20px; border-left: 1px solid var(--trace-line); }
.trace-metric span, .trace-metric small { display: block; color: #6f829c; font-size: 10px; letter-spacing: .08em; }
.trace-metric strong { display: block; margin: 4px 0 2px; color: #edf6ff; font: 650 22px/1.1 ui-monospace, monospace; }
.trace-metric.danger strong { color: #fb7185; }
.trace-metric.accent strong { color: #5eead4; }
.trace-toolbar { display: flex; align-items: center; gap: 10px; padding: 12px 16px; background: rgba(7, 17, 31, .72); border-bottom: 1px solid var(--trace-line); backdrop-filter: blur(14px); }
.trace-search { display: flex; align-items: center; flex: 1; min-width: 210px; max-width: 390px; height: 34px; padding: 0 10px; color: #70849e; background: #091524; border: 1px solid #1a2c43; border-radius: 8px; transition: .2s ease; }
.trace-search:focus-within { border-color: rgba(45, 212, 191, .7); box-shadow: 0 0 0 3px rgba(45, 212, 191, .08); }
.trace-search input { width: 100%; margin-left: 7px; color: #dce8f6; background: transparent; border: 0; outline: 0; font-size: 12px; }
.trace-search input::placeholder { color: #53657c; }
.trace-search button { color: #7890aa; background: none; border: 0; cursor: pointer; }
.mode-switch { display: flex; padding: 3px; background: #091524; border: 1px solid #172a41; border-radius: 8px; }
.mode-switch button, .toolbar-actions button { height: 26px; padding: 0 10px; color: #7f92aa; background: transparent; border: 0; border-radius: 5px; cursor: pointer; font-size: 11px; transition: .18s ease; }
.mode-switch button:hover, .toolbar-actions button:hover { color: #dce8f6; background: #12233a; }
.mode-switch button.active { color: #c9fff7; background: rgba(45, 212, 191, .14); box-shadow: inset 0 0 0 1px rgba(45, 212, 191, .24); }
.service-select { height: 34px; min-width: 120px; padding: 0 30px 0 10px; color: #a7b8cb; background: #091524; border: 1px solid #172a41; border-radius: 8px; outline: 0; font-size: 11px; }
.service-select option { background: #0b1728; }
.toolbar-actions { display: flex; gap: 4px; margin-left: auto; }
.toolbar-actions button { height: 32px; border: 1px solid #172a41; }
.toolbar-actions button.active { color: #5eead4; border-color: rgba(45, 212, 191, .35); }
.service-legend { display: flex; flex-wrap: wrap; gap: 14px; padding: 8px 18px; color: #6f829a; border-bottom: 1px solid var(--trace-line); font-size: 10px; }
.service-legend span { display: flex; align-items: center; gap: 5px; }
.service-legend i { width: 7px; height: 7px; border-radius: 2px; box-shadow: 0 0 8px currentColor; }
.service-legend .legend-critical { margin-left: auto; color: #d7a949; }
.service-legend .legend-critical i { background: #fbbf24; }
.service-legend .legend-error { color: #e87386; }
.service-legend .legend-error i { background: #fb7185; }
.trace-viewport { overflow: auto; max-height: calc(100vh - 345px); min-height: 310px; scrollbar-color: #28405b #091524; }
.trace-grid { min-width: 860px; }
.timeline-head { position: sticky; z-index: 8; top: 0; display: grid; grid-template-columns: minmax(310px, 38%) 1fr 92px; min-height: 36px; color: #647992; background: rgba(9, 21, 36, .96); border-bottom: 1px solid #1a2c43; font: 9px/1 ui-monospace, monospace; letter-spacing: .08em; backdrop-filter: blur(12px); }
.operation-heading, .duration-heading { display: flex; align-items: center; padding: 0 16px; }
.operation-heading { justify-content: space-between; border-right: 1px solid var(--trace-line); }
.operation-heading small { color: #445972; font-size: 9px; }
.duration-heading { justify-content: flex-end; border-left: 1px solid var(--trace-line); }
.timeline-scale { position: relative; margin: 0 15px; }
.timeline-scale::before { position: absolute; inset: 0; content: ""; background: repeating-linear-gradient(90deg, transparent 0, transparent calc(25% - 1px), rgba(109, 131, 158, .13) 25%); }
.timeline-scale span { position: absolute; top: 13px; transform: translateX(-50%); white-space: nowrap; }
.timeline-scale span:first-child { transform: none; }
.timeline-scale span:last-child { transform: translateX(-100%); }
.trace-tree { position: relative; background-image: linear-gradient(rgba(255,255,255,.014) 1px, transparent 1px); background-size: 100% 38px; }
.node-inspector { position: absolute; z-index: 20; top: 148px; right: 16px; width: min(310px, calc(100% - 32px)); padding: 16px; background: rgba(11, 23, 40, .96); border: 1px solid #28425f; border-radius: 12px; box-shadow: 0 18px 50px rgba(0,0,0,.45); backdrop-filter: blur(18px); animation: inspector-in .2s ease-out; }
.node-inspector > button { position: absolute; top: 9px; right: 10px; color: #71859e; background: none; border: 0; cursor: pointer; font-size: 18px; }
.inspector-service { display: flex; align-items: center; gap: 7px; color: #859ab3; font: 10px/1 ui-monospace, monospace; text-transform: uppercase; }
.inspector-service i { width: 8px; height: 8px; border-radius: 2px; }
.node-inspector > strong { display: block; margin: 8px 24px 14px 0; color: #f2f7fd; font-size: 15px; }
.node-inspector dl { display: grid; gap: 7px; margin: 0; }
.node-inspector dl div { display: grid; grid-template-columns: 62px minmax(0, 1fr); gap: 8px; }
.node-inspector dt { color: #61758e; font-size: 10px; }
.node-inspector dd { overflow: hidden; margin: 0; color: #acbed1; font: 10px/1.35 ui-monospace, monospace; text-overflow: ellipsis; white-space: nowrap; }
.node-inspector dd.error { color: #fb7185; }
.load-more { display: flex; align-items: center; justify-content: center; gap: 14px; padding: 13px; color: #61758e; background: #091524; border-top: 1px solid var(--trace-line); font-size: 11px; }
.load-more button, .filter-empty button { padding: 6px 12px; color: #5eead4; background: rgba(45, 212, 191, .08); border: 1px solid rgba(45, 212, 191, .28); border-radius: 6px; cursor: pointer; }
.filter-empty, .trace-empty { display: grid; place-items: center; align-content: center; min-height: 340px; padding: 40px; text-align: center; }
.filter-empty > span { color: #2dd4bf; font-size: 36px; }
.filter-empty strong, .trace-empty strong { margin-top: 10px; color: #d9e7f6; }
.filter-empty p, .trace-empty p { margin: 6px 0 14px; color: #61758e; font-size: 12px; }
.loading { display: flex; align-items: center; justify-content: center; gap: 14px; min-height: 420px; color: #d6e5f3; }
.loading div { display: grid; gap: 4px; }
.loading small { color: #60758e; }
.loader-ring { width: 28px; height: 28px; border: 2px solid #18314a; border-top-color: #2dd4bf; border-radius: 50%; animation: spin 1s linear infinite; }
.empty-orbit { position: relative; width: 58px; height: 58px; border: 1px solid #1f3b55; border-radius: 50%; }
.empty-orbit::after { position: absolute; inset: 11px; content: ""; border: 1px dashed #294864; border-radius: 50%; }
.empty-orbit span, .empty-orbit i { position: absolute; width: 8px; height: 8px; border-radius: 50%; }
.empty-orbit span { top: -4px; left: 25px; background: #2dd4bf; box-shadow: 0 0 14px #2dd4bf; }
.empty-orbit i { right: 5px; bottom: 7px; background: #38bdf8; }
@keyframes trace-pulse { 50% { opacity: .45; transform: scale(.82); } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes inspector-in { from { opacity: 0; transform: translateY(-6px) scale(.98); } }
@media (max-width: 900px) {
  .trace-hero { display: block; }
  .trace-metrics { max-width: none; margin-top: 18px; }
  .trace-toolbar { flex-wrap: wrap; }
  .trace-search { max-width: none; }
  .toolbar-actions { margin-left: 0; }
}
@media (max-width: 600px) {
  .trace-metrics { grid-template-columns: repeat(2, 1fr); gap: 14px 0; }
  .trace-metric:nth-child(3) { border-left: 0; }
  .mode-switch { order: 4; width: 100%; }
  .mode-switch button { flex: 1; }
}
@media (prefers-reduced-motion: reduce) { .live-dot, .loader-ring, .node-inspector { animation: none; } }
</style>
