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

function resetTraceData() {
  nodes.value = []
  edges.value = []
  errorSpans.value = []
  criticalPath.value = []
  selectedNode.value = null
}

async function loadDistributedTrace() {
  if (!props.traceId) {
    loadRequestId += 1
    resetTraceData()
    loadError.value = ''
    return
  }
  const requestId = ++loadRequestId
  loading.value = true
  loadError.value = ''
  resetTraceData()
  pageLoading.value = true
  try {
    const data = await api(`/api/traces/${encodeURIComponent(props.traceId)}/distributed`, { requestKey: `trace:distributed:${props.traceId}` })
    if (requestId !== loadRequestId) return
    nodes.value = data.nodes || []
    edges.value = data.edges || []
    errorSpans.value = data.errorSpans || []
    criticalPath.value = data.criticalPath || []
    visibleLimit.value = 120
  } catch (error) {
    if (requestId === loadRequestId && error?.code !== 'ABORT_ERR') loadError.value = error.message || '调用拓扑加载失败，请稍后重试'
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
  <section v-loading="loading" element-loading-text="正在加载调用拓扑" class="distributed-trace" :class="{ 'is-compact': compact }">
    <template v-if="nodes.length">
      <header class="trace-header">
        <div class="trace-title-block">
          <div class="trace-heading-line">
            <h3>调用拓扑</h3>
            <el-tag size="small" :type="errorSpans.length ? 'danger' : 'success'" effect="plain">{{ errorSpans.length ? `${errorSpans.length} 个错误` : '链路正常' }}</el-tag>
          </div>
          <p>按调用层级和时间轴查看完整请求过程</p>
          <div class="trace-id"><span>Trace ID</span><code>{{ traceId }}</code></div>
        </div>
        <div class="trace-metrics">
          <div class="trace-metric"><span>调用节点</span><strong>{{ nodes.length }}</strong></div>
          <div class="trace-metric"><span>涉及服务</span><strong>{{ services.length }}</strong></div>
          <div class="trace-metric" :class="{ danger: errorSpans.length }"><span>错误节点</span><strong>{{ errorSpans.length }}</strong></div>
          <div class="trace-metric primary"><span>总耗时</span><strong>{{ formatTraceDuration(bounds.duration) }}</strong></div>
        </div>
      </header>

      <div class="trace-toolbar">
        <el-input v-model="query" clearable size="small" class="trace-search" aria-label="搜索调用节点" placeholder="搜索操作、服务或 Span ID" />
        <el-radio-group v-model="mode" size="small" aria-label="节点筛选">
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button value="errors">错误</el-radio-button>
          <el-radio-button value="critical">关键路径</el-radio-button>
        </el-radio-group>
        <el-select v-model="service" size="small" class="service-select" aria-label="筛选服务">
          <el-option label="全部服务" value="all" />
          <el-option v-for="item in services" :key="item" :label="item" :value="item" />
        </el-select>
        <div class="toolbar-actions">
          <el-button size="small" :type="compact ? 'primary' : ''" :plain="compact" @click="compact = !compact">{{ compact ? '舒适模式' : '紧凑模式' }}</el-button>
          <el-button size="small" @click="toggleAll">{{ expandAll ? '全部折叠' : '全部展开' }}</el-button>
        </div>
      </div>

      <div class="service-legend">
        <strong>服务</strong>
        <span v-for="item in services" :key="item"><i :style="{ background: serviceColor(item) }"></i>{{ item }}</span>
        <span class="legend-summary legend-critical"><i></i>关键路径 {{ criticalPath.length }}</span>
        <span class="legend-summary legend-error"><i></i>错误 {{ errorSpans.length }}</span>
      </div>

      <div v-if="selectedNode" class="node-inspector">
        <div class="inspector-head">
          <div>
            <span class="inspector-service"><i :style="{ background: serviceColor(selectedNode.service) }"></i>{{ selectedNode.service || 'unknown' }}</span>
            <strong>{{ selectedNode.name || 'root' }}</strong>
          </div>
          <el-button link type="primary" @click="selectedNode = null">收起详情</el-button>
        </div>
        <el-descriptions :column="4" border size="small">
          <el-descriptions-item label="Span ID"><code class="inspector-id">{{ selectedNode.id }}</code></el-descriptions-item>
          <el-descriptions-item label="类型">{{ selectedNode.kind || 'INTERNAL' }}</el-descriptions-item>
          <el-descriptions-item label="状态"><el-tag size="small" :type="selectedNode.hasError || errorSpans.includes(selectedNode.id) ? 'danger' : 'success'">{{ selectedNode.status || (selectedNode.hasError ? 'ERROR' : 'OK') }}</el-tag></el-descriptions-item>
          <el-descriptions-item label="耗时">{{ formatTraceDuration(selectedNode.duration) }}</el-descriptions-item>
        </el-descriptions>
      </div>

      <div v-if="filteredTree.length" class="trace-viewport">
        <div class="trace-grid">
          <div class="timeline-head">
            <div class="operation-heading"><span>服务 / 操作</span><small>显示 {{ visibleCount }} / {{ filteredCount }}</small></div>
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
        <el-button link type="primary" @click="visibleLimit += 120">继续显示 120 个</el-button>
      </div>

      <el-empty v-if="!filteredTree.length" :image-size="72" description="没有匹配的调用节点"><el-button type="primary" plain @click="resetFilters">清除筛选</el-button></el-empty>
    </template>

    <el-result v-else-if="loadError" icon="error" title="调用拓扑加载失败" :sub-title="loadError"><template #extra><el-button type="primary" @click="loadDistributedTrace">重试</el-button></template></el-result>
    <el-empty v-else-if="!loading" :image-size="88" description="当前 Trace 尚未形成可展示的调用关系" />
  </section>
</template>

<style scoped>
.distributed-trace {
  --trace-line: var(--line, #dfe5ec);
  --trace-muted: var(--c-text-muted, #6b7585);
  position: relative;
  min-height: 480px;
  overflow: hidden;
  color: var(--c-text, #1f2733);
  background: var(--c-surface, #fff);
  border: 1px solid var(--trace-line, var(--c-border));
  border-radius: 7px;
}
.trace-header { display: flex; align-items: center; justify-content: space-between; gap: 28px; padding: 18px 20px; border-bottom: 1px solid var(--trace-line, var(--c-border)); }
.trace-title-block { min-width: 260px; }
.trace-heading-line { display: flex; align-items: center; gap: 10px; }
.trace-title-block h3 { margin: 0; color: var(--c-text, #1f2733); font-size: 18px; line-height: 1.3; }
.trace-title-block p { margin: 4px 0 10px; color: var(--trace-muted); font-size: 12px; }
.trace-id { display: flex; align-items: center; gap: 8px; min-width: 0; color: #8994a5; font-size: 11px; }
.trace-id code { display: block; max-width: 360px; overflow: hidden; color: #4b5b70; font: 11px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
.trace-metrics { display: grid; flex: 1; max-width: 650px; grid-template-columns: repeat(4, minmax(100px, 1fr)); background: #fafbfc; border: 1px solid #e7ebf0; border-radius: 7px; }
.trace-metric { position: relative; padding: 12px 16px; border-left: 1px solid #e7ebf0; }
.trace-metric:first-child { border-left: 0; }
.trace-metric span { display: block; color: var(--trace-muted); font-size: 11px; }
.trace-metric strong { display: block; margin-top: 5px; color: #26364d; font-size: 19px; line-height: 1.1; }
.trace-metric.danger strong { color: #ef4444; }
.trace-metric.primary strong { color: var(--c-primary, #4f46e5); }
.trace-toolbar { display: flex; align-items: center; gap: 10px; padding: 12px 14px; background: #fff; border-bottom: 1px solid var(--trace-line); }
.trace-search { flex: 1; min-width: 220px; max-width: 360px; }
.service-select { width: 150px; }
.toolbar-actions { display: flex; gap: 4px; margin-left: auto; }
.service-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; padding: 9px 16px; color: #66758a; background: #fafbfc; border-bottom: 1px solid var(--trace-line); font-size: 11px; }
.service-legend strong { color: #344258; font-size: 11px; }
.service-legend span { display: flex; align-items: center; gap: 5px; }
.service-legend i { width: 8px; height: 8px; border-radius: 50%; }
.service-legend .legend-summary { padding-left: 12px; border-left: 1px solid #dfe5ec; }
.service-legend .legend-critical { margin-left: auto; color: #b45309; }
.service-legend .legend-critical i { background: #f59e0b; }
.service-legend .legend-error { color: #dc2626; }
.service-legend .legend-error i { background: #ef4444; }
.node-inspector { padding: 14px 16px 16px; background: #f8fafc; border-bottom: 1px solid var(--trace-line); }
.inspector-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.inspector-head > div { min-width: 0; }
.inspector-head strong { display: block; overflow: hidden; margin-top: 5px; color: #26364d; font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.inspector-service { display: flex; align-items: center; gap: 7px; color: #718096; font-size: 11px; }
.inspector-service i { width: 8px; height: 8px; border-radius: 50%; }
.inspector-id { color: #4b5b70; font: 11px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; }
.trace-viewport { overflow: auto; max-height: calc(100vh - 370px); min-height: 300px; scrollbar-color: #c5ced9 #f5f7fa; }
.trace-grid { min-width: 860px; }
.timeline-head { position: sticky; z-index: 8; top: 0; display: grid; grid-template-columns: minmax(310px, 38%) 1fr 92px; min-height: 38px; color: #627085; background: #fafbfc; border-bottom: 1px solid #dfe5ec; font-size: 11px; font-weight: 650; }
.operation-heading, .duration-heading { display: flex; align-items: center; padding: 0 16px; }
.operation-heading { justify-content: space-between; border-right: 1px solid #e7ebf0; }
.operation-heading small { color: #8a96a7; font-size: 10px; font-weight: 400; }
.duration-heading { justify-content: flex-end; border-left: 1px solid #e7ebf0; }
.timeline-scale { position: relative; margin: 0 15px; }
.timeline-scale::before { position: absolute; inset: 0; content: ""; background: repeating-linear-gradient(90deg, transparent 0, transparent calc(25% - 1px), #e9edf2 25%); }
.timeline-scale span { position: absolute; top: 13px; color: #8793a4; font: 9px/1 ui-monospace, SFMono-Regular, Consolas, monospace; transform: translateX(-50%); white-space: nowrap; }
.timeline-scale span:first-child { transform: none; }
.timeline-scale span:last-child { transform: translateX(-100%); }
.trace-tree { position: relative; background: #fff; }
.load-more { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 10px 14px; color: #718096; background: #fafbfc; border-top: 1px solid var(--trace-line); font-size: 11px; }
.distributed-trace :deep(.el-loading-mask) { background: rgba(255, 255, 255, .86); }
.distributed-trace :deep(.el-result), .distributed-trace :deep(.el-empty) { min-height: 360px; }
@media (max-width: 900px) {
  .trace-header { display: block; }
  .trace-metrics { max-width: none; margin-top: 18px; }
  .trace-toolbar { flex-wrap: wrap; }
  .trace-search { max-width: none; }
  .toolbar-actions { margin-left: 0; }
}
@media (max-width: 600px) {
  .trace-metrics { grid-template-columns: repeat(2, 1fr); }
  .trace-metric:nth-child(3) { border-left: 0; border-top: 1px solid #e7ebf0; }
  .trace-metric:nth-child(4) { border-top: 1px solid #e7ebf0; }
  .trace-toolbar :deep(.el-radio-group) { order: 4; width: 100%; }
  .trace-toolbar :deep(.el-radio-button) { flex: 1; }
  .trace-toolbar :deep(.el-radio-button__inner) { width: 100%; }
}
</style>
