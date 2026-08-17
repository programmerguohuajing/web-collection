<script setup>
import { ArrowRight } from '@element-plus/icons-vue'
import { computed, ref, watch } from 'vue'
import { formatTraceDuration, serviceColor } from '../utils/distributed-trace.js'

defineOptions({ name: 'DistributedTraceNode' })

const props = defineProps({
  node: { type: Object, required: true },
  errorSpans: { type: Array, default: () => [] },
  criticalPath: { type: Array, default: () => [] },
  ancestorIds: { type: Array, default: () => [] },
  traceStart: { type: Number, default: 0 },
  traceDuration: { type: Number, default: 1 },
  depth: { type: Number, default: 0 },
  compact: { type: Boolean, default: false },
  expandSignal: { type: Number, default: 0 },
  expandAll: { type: Boolean, default: true },
  selectedId: { type: String, default: '' }
})
const emit = defineEmits(['select'])
const expanded = ref(true)

const isError = computed(() =>
  props.node.hasError || props.errorSpans.includes(props.node.id)
)
const isCritical = computed(() =>
  props.criticalPath.includes(props.node.id)
)
const nextAncestorIds = computed(() => [...props.ancestorIds, props.node.id])
const children = computed(() =>
  (props.node.children || []).filter(child => !nextAncestorIds.value.includes(child.id))
)

const nodeClass = computed(() => ({
  'node-error': isError.value,
  'node-critical': !isError.value && isCritical.value,
  'node-selected': props.selectedId === props.node.id,
  'is-compact': props.compact,
  'has-depth': props.depth > 0
}))
const color = computed(() => serviceColor(props.node.service))
const offset = computed(() => {
  const start = Number(props.node.startTs)
  return Number.isFinite(start) ? Math.max(0, Math.min(100, (start - props.traceStart) / Math.max(1, props.traceDuration) * 100)) : 0
})
const width = computed(() => {
  const raw = Number(props.node.duration) / Math.max(1, props.traceDuration) * 100
  return Math.max(0.7, Math.min(100 - offset.value, Number.isFinite(raw) ? raw : 0.7))
})
const barStyle = computed(() => ({
  left: `${offset.value}%`,
  width: `${width.value}%`,
  background: isError.value ? '#ef4444' : isCritical.value ? '#f59e0b' : color.value
}))
const rowStyle = computed(() => ({
  '--node-color': color.value,
  '--node-indent': `${12 + Math.min(props.depth, 8) * 22}px`
}))
const statusText = computed(() => props.node.status || (isError.value ? 'ERROR' : 'OK'))

watch(() => props.expandSignal, () => { expanded.value = props.expandAll })
</script>

<template>
  <div class="trace-node" :class="nodeClass">
    <div
      class="node-row"
      :style="rowStyle"
      role="treeitem"
      tabindex="0"
      :aria-expanded="children.length ? expanded : undefined"
      :aria-selected="selectedId === node.id"
      @click="emit('select', node)"
      @keydown.enter="emit('select', node)"
    >
      <div class="node-operation">
        <span class="node-junction" aria-hidden="true"></span>
        <button v-if="children.length" type="button" class="expand-button" :aria-label="expanded ? '折叠子节点' : '展开子节点'" @click.stop="expanded = !expanded">
          <el-icon :class="{ expanded }"><ArrowRight /></el-icon>
        </button>
        <span v-else class="expand-placeholder"></span>
        <span class="service-dot" :style="{ background: color }"></span>
        <div class="node-copy">
          <div class="node-title-line">
            <strong>{{ node.name || 'root' }}</strong>
            <span v-if="isCritical" class="node-badge critical">关键</span>
            <span v-if="isError" class="node-badge error">错误</span>
          </div>
          <div class="node-meta"><span>{{ node.service || 'unknown' }}</span><i>·</i><span>{{ node.kind || 'INTERNAL' }}</span><i>·</i><code>{{ node.id }}</code></div>
        </div>
      </div>
      <div class="node-timeline">
        <div class="timeline-grid"></div>
        <span class="duration-bar" :style="barStyle"></span>
      </div>
      <div class="node-duration">
        <strong>{{ formatTraceDuration(node.duration) }}</strong>
        <span class="node-status" :class="{ error: isError }">{{ statusText }}</span>
      </div>
    </div>

    <div v-if="children.length && expanded" class="trace-children" role="group">
      <DistributedTraceNode
        v-for="child in children"
        :key="child.id"
        :node="child"
        :error-spans="errorSpans"
        :critical-path="criticalPath"
        :ancestor-ids="nextAncestorIds"
        :trace-start="traceStart"
        :trace-duration="traceDuration"
        :depth="depth + 1"
        :compact="compact"
        :expand-signal="expandSignal"
        :expand-all="expandAll"
        :selected-id="selectedId"
        @select="emit('select', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.trace-node { position: relative; }
.trace-children { position: relative; }
.node-row {
  position: relative;
  display: grid;
  grid-template-columns: minmax(310px, 38%) 1fr 92px;
  align-items: center;
  min-width: 0;
  min-height: 50px;
  background: #fff;
  border-bottom: 1px solid #edf0f4;
  outline: none;
  cursor: pointer;
  transition: background .16s ease, box-shadow .16s ease;
}
.node-row:hover { z-index: 2; background: #f7f9fc; box-shadow: inset 3px 0 var(--node-color); }
.node-row:focus-visible { box-shadow: inset 0 0 0 2px rgba(79, 70, 229, .35); }
.node-selected > .node-row { background: #eef0fe; box-shadow: inset 3px 0 var(--c-primary, #4f46e5); }
.node-error > .node-row { background: #fff7f7; }
.node-error > .node-row:hover { background: #fff1f2; }
.node-critical > .node-row { background: #fffbeb; }
.node-critical > .node-row:hover { background: #fff7db; }
.node-operation { display: flex; align-items: center; min-width: 0; height: 100%; padding: 0 12px 0 var(--node-indent); border-right: 1px solid #edf0f4; }
.node-junction { position: relative; flex: none; width: 16px; height: 24px; margin-right: 3px; }
.node-junction::before { position: absolute; top: 12px; left: 0; width: 16px; height: 1px; content: ""; background: #cbd5e1; }
.node-junction::after { position: absolute; top: -26px; left: 0; width: 1px; height: 39px; content: ""; background: #cbd5e1; }
.trace-node:not(.has-depth) > .node-row .node-junction { visibility: hidden; }
.expand-button, .expand-placeholder { flex: none; width: 20px; height: 20px; margin-right: 7px; }
.expand-button { display: grid; place-items: center; padding: 0; color: #66758a; background: #fff; border: 1px solid #cfd7e3; border-radius: 4px; cursor: pointer; }
.expand-button:hover { color: var(--c-primary, #4f46e5); border-color: #a5b4fc; background: #eef0fe; }
.expand-button .el-icon { transition: transform .16s ease; }
.expand-button .el-icon.expanded { transform: rotate(90deg); }
.service-dot { flex: none; width: 8px; height: 8px; margin-right: 9px; border-radius: 50%; }
.node-copy { min-width: 0; }
.node-title-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.node-title-line strong { overflow: hidden; color: #25364d; font-size: 12px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.node-meta { display: flex; align-items: center; gap: 5px; min-width: 0; margin-top: 4px; color: #718096; font-size: 10px; }
.node-meta i { color: #a6b0bf; font-style: normal; }
.node-meta code { overflow: hidden; color: #8995a6; font: 9px/1 ui-monospace, SFMono-Regular, Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
.node-badge { flex: none; padding: 2px 5px; border: 1px solid; border-radius: 4px; font-size: 9px; font-weight: 600; line-height: 1; }
.node-badge.critical { color: #b45309; background: #fffbeb; border-color: #f5d48b; }
.node-badge.error { color: #dc2626; background: #fff1f2; border-color: #fecdd3; }
.node-timeline { position: relative; align-self: stretch; overflow: hidden; margin: 0 15px; }
.timeline-grid { position: absolute; inset: 0; background: repeating-linear-gradient(90deg, transparent 0, transparent calc(25% - 1px), #eef1f5 25%); }
.duration-bar { position: absolute; top: 50%; min-width: 3px; height: 8px; transform: translateY(-50%); border-radius: 4px; opacity: .9; transition: height .16s ease, opacity .16s ease; }
.node-row:hover .duration-bar { height: 11px; opacity: 1; }
.node-duration { display: grid; justify-items: end; gap: 4px; padding-right: 14px; border-left: 1px solid #edf0f4; }
.node-duration strong { color: #344258; font: 600 10px/1 ui-monospace, SFMono-Regular, Consolas, monospace; }
.node-status { padding: 2px 6px; color: #0f766e; background: #ecfdf5; border: 1px solid #bbf7d0; border-radius: 4px; font-size: 8px; font-weight: 650; line-height: 1; }
.node-status.error { color: #dc2626; background: #fff1f2; border-color: #fecdd3; }
.is-compact > .node-row { min-height: 36px; }
.is-compact .node-meta { display: none; }
.is-compact .duration-bar { height: 6px; }
@media (prefers-reduced-motion: reduce) {
  .node-row, .duration-bar, .expand-button .el-icon { transition: none; }
}
</style>
