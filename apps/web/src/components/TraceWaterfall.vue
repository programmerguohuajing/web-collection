<script setup>
import { computed } from 'vue'
import { buildTraceTree, getTraceBounds, formatTraceDuration, serviceColor } from '../utils/distributed-trace.js'

const props = defineProps({
  // 分布式 trace 节点：{ id, name, service, kind, startTs, duration, status, hasError }
  nodes: { type: Array, default: () => [] },
  // 父子边：{ source, target }
  edges: { type: Array, default: () => [] },
  emptyText: { type: String, default: '暂无 Span 数据' }
})
const emit = defineEmits(['select'])

const tree = computed(() => buildTraceTree(props.nodes || [], props.edges || []))
const bounds = computed(() => getTraceBounds(props.nodes || []))

const ticks = computed(() => [0, 0.25, 0.5, 0.75, 1].map(ratio => ({
  ratio,
  label: formatTraceDuration(bounds.value.duration * ratio)
})))

// 扁平化为带层级的可见行（带缩进）
const rows = computed(() => {
  const out = []
  function visit(list, depth) {
    list.forEach(node => {
      out.push({ node, depth })
      if (node.children && node.children.length) visit(node.children, depth + 1)
    })
  }
  visit(tree.value, 0)
  return out
})

function barLeft(node) {
  const start = Number(node.startTs) || 0
  return ((start - bounds.value.start) / bounds.value.duration) * 100
}
function barWidth(node) {
  const duration = Math.max(0, Number(node.duration) || 0)
  return Math.max(1.2, (duration / bounds.value.duration) * 100)
}
function barColor(node) {
  if (node.hasError || String(node.status).toUpperCase() === 'ERROR' || Number(node.status) >= 400) return '#ef4444'
  return serviceColor(node.service)
}
function durationText(node) {
  return formatTraceDuration(node.duration)
}
function isError(node) {
  return node.hasError || String(node.status).toUpperCase() === 'ERROR' || Number(node.status) >= 400
}
</script>

<template>
  <div class="waterfall">
    <div v-if="!nodes.length" class="wf-empty"><el-empty :image-size="72" :description="emptyText" /></div>
    <template v-else>
      <div class="wf-head">
        <div class="op-heading"><span>服务 · 操作</span></div>
        <div class="wf-axis">
          <span v-for="t in ticks" :key="t.ratio" :style="{ left: t.ratio * 100 + '%' }">{{ t.label }}</span>
        </div>
        <div class="dur-heading">耗时</div>
      </div>
      <div class="wf-body">
        <div
          v-for="row in rows"
          :key="row.node.id"
          class="wf-row"
          :style="{ paddingLeft: 12 + row.depth * 18 + 'px' }"
          @click="emit('select', row.node)"
        >
          <div class="sp-name">
            <span class="svc" :style="{ color: serviceColor(row.node.service), borderColor: serviceColor(row.node.service) + '55' }">{{ (row.node.service || 'unknown').split('-')[0] }}</span>
            <span class="op">{{ row.node.name }}</span>
            <span v-if="isError(row.node)" class="err-dot" title="错误"></span>
          </div>
          <div class="wf-track">
            <div class="wf-bar" :style="{ left: barLeft(row.node) + '%', width: barWidth(row.node) + '%', background: barColor(row.node) }"
                 :title="row.node.name + ' · ' + Math.round(Number(row.node.startTs) - bounds.start) + '–' + Math.round(Number(row.node.startTs) - bounds.start + Number(row.node.duration)) + 'ms'"></div>
          </div>
          <div class="dur" :class="{ err: isError(row.node) }">{{ durationText(row.node) }}</div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.waterfall { height: 100%; overflow-y: auto; background: #fff; border: 1px solid var(--line, #dfe5ec); border-radius: 7px; }
.wf-empty { display: grid; place-items: center; min-height: 320px; }
.wf-head { display: grid; grid-template-columns: minmax(280px, 1fr) 1fr 90px; align-items: center; padding: 10px 14px; color: #627085; font-size: 11px; font-weight: 650; border-bottom: 1px solid var(--line, #dfe5ec); position: sticky; top: 0; background: #fafbfc; z-index: 2; }
.op-heading { border-right: 1px solid #e7ebf0; }
.dur-heading { text-align: right; border-left: 1px solid #e7ebf0; padding-right: 14px; }
.wf-axis { position: relative; margin: 0 15px; height: 22px; }
.wf-axis::before { position: absolute; inset: 0; content: ""; background: repeating-linear-gradient(90deg, transparent 0, transparent calc(25% - 1px), #e9edf2 25%); }
.wf-axis span { position: absolute; top: 4px; color: #8793a4; font: 9px/1 ui-monospace, Consolas, monospace; transform: translateX(-50%); white-space: nowrap; }
.wf-axis span:first-child { transform: none; }
.wf-axis span:last-child { transform: translateX(-100%); }
.wf-body { padding: 4px 0; }
.wf-row { display: grid; grid-template-columns: minmax(280px, 1fr) 1fr 90px; align-items: center; padding: 6px 14px; border-bottom: 1px solid #f0f3f7; cursor: pointer; transition: background .12s; }
.wf-row:hover { background: #f8fafc; }
.sp-name { display: flex; align-items: center; gap: 8px; min-width: 0; font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; }
.sp-name .svc { color: #409eff; font-family: 'Segoe UI','Microsoft YaHei',sans-serif; font-size: 11px; padding: 1px 7px; border-radius: 5px; background: #f0f4fa; border: 1px solid #dfe5ec; white-space: nowrap; }
.sp-name .op { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.err-dot { width: 7px; height: 7px; border-radius: 50%; background: #ef4444; flex: none; }
.wf-track { position: relative; height: 18px; }
.wf-bar { position: absolute; top: 4px; bottom: 4px; border-radius: 4px; min-width: 2px; }
.wf-row:hover .wf-bar { outline: 1px solid rgba(23,32,51,.15); }
.dur { font-family: ui-monospace, Consolas, monospace; font-size: 12px; text-align: right; color: #172033; }
.dur.err { color: #ef4444; }
</style>
