<script setup>
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
const barStyle = computed(() => ({ left: `${offset.value}%`, width: `${width.value}%`, background: isError.value ? '#fb7185' : isCritical.value ? '#fbbf24' : color.value }))
const rowStyle = computed(() => ({ '--node-color': color.value, '--node-indent': `${12 + Math.min(props.depth, 8) * 20}px` }))

watch(() => props.expandSignal, () => { expanded.value = props.expandAll })
</script>

<template>
  <div class="trace-node" :class="nodeClass">
    <div class="node-row" :style="rowStyle" role="treeitem" tabindex="0" :aria-expanded="children.length ? expanded : undefined" :aria-selected="selectedId === node.id" @click="emit('select', node)" @keydown.enter="emit('select', node)">
      <div class="node-operation">
        <button v-if="children.length" type="button" class="expand-button" :aria-label="expanded ? '折叠子节点' : '展开子节点'" @click.stop="expanded = !expanded">{{ expanded ? '−' : '+' }}</button>
        <span v-else class="node-junction"></span>
        <span class="service-mark" :style="{ background: color }"></span>
        <div class="node-copy">
          <div class="node-title-line">
            <strong>{{ node.name || 'root' }}</strong>
            <span v-if="isCritical" class="node-badge critical">CRITICAL</span>
            <span v-if="isError" class="node-badge error">ERROR</span>
          </div>
          <div class="node-meta"><span>{{ node.service || 'unknown' }}</span><i>·</i><span>{{ node.kind || 'INTERNAL' }}</span><i>·</i><code>{{ node.id }}</code></div>
        </div>
      </div>
      <div class="node-timeline">
        <div class="timeline-grid"></div>
        <span class="duration-bar" :style="barStyle"><i></i></span>
      </div>
      <div class="node-duration">
        <strong>{{ formatTraceDuration(node.duration) }}</strong>
        <span :class="{ error: isError }">{{ node.status || (isError ? 'ERROR' : 'OK') }}</span>
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
  min-height: 44px;
  background: rgba(9, 21, 36, .42);
  border-bottom: 1px solid rgba(125, 148, 177, .08);
  outline: none;
  cursor: pointer;
  transition: background .16s ease, box-shadow .16s ease;
}
.node-row:hover { z-index: 2; background: rgba(20, 40, 63, .72); box-shadow: inset 2px 0 var(--node-color); }
.node-row:focus-visible { box-shadow: inset 0 0 0 1px #38bdf8; }
.node-selected > .node-row { background: rgba(23, 48, 73, .84); box-shadow: inset 3px 0 var(--node-color); }
.node-error > .node-row { background: rgba(76, 20, 35, .36); }
.node-critical > .node-row { background: rgba(81, 56, 12, .24); }
.node-operation { display: flex; align-items: center; min-width: 0; height: 100%; padding: 0 12px 0 var(--node-indent); border-right: 1px solid rgba(125, 148, 177, .1); }
.expand-button, .node-junction { flex: none; width: 18px; height: 18px; margin-right: 7px; }
.expand-button { display: grid; place-items: center; padding: 0; color: #8ea4bd; background: #11243a; border: 1px solid #28405a; border-radius: 4px; cursor: pointer; font: 12px/1 ui-monospace, monospace; }
.expand-button:hover { color: #5eead4; border-color: #2f6d70; }
.node-junction { position: relative; }
.node-junction::before { position: absolute; top: 8px; left: 4px; width: 10px; height: 1px; content: ""; background: #2a435d; }
.node-junction::after { position: absolute; top: -14px; left: 4px; width: 1px; height: 23px; content: ""; background: #223a53; }
.trace-node:not(.has-depth) > .node-row .node-junction::after { display: none; }
.service-mark { flex: none; width: 3px; height: 24px; margin-right: 9px; border-radius: 3px; box-shadow: 0 0 12px var(--node-color); }
.node-copy { min-width: 0; }
.node-title-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.node-title-line strong { overflow: hidden; color: #dce8f5; font-size: 12px; font-weight: 590; letter-spacing: .005em; text-overflow: ellipsis; white-space: nowrap; }
.node-meta { display: flex; align-items: center; gap: 5px; min-width: 0; margin-top: 3px; color: #667b94; font-size: 9px; text-transform: uppercase; }
.node-meta i { color: #344b64; font-style: normal; }
.node-meta code {
  overflow: hidden;
  color: #526982;
  font: 9px/1 ui-monospace, monospace;
  text-overflow: ellipsis;
  text-transform: none;
  white-space: nowrap;
}
.node-badge { flex: none; padding: 2px 4px; border: 1px solid; border-radius: 3px; font: 700 7px/1 ui-monospace, monospace; letter-spacing: .08em; }
.node-badge.critical { color: #fbbf24; background: rgba(251, 191, 36, .08); border-color: rgba(251, 191, 36, .34); }
.node-badge.error { color: #fb7185; background: rgba(251, 113, 133, .08); border-color: rgba(251, 113, 133, .34); }
.node-timeline { position: relative; align-self: stretch; overflow: hidden; margin: 0 15px; }
.timeline-grid { position: absolute; inset: 0; background: repeating-linear-gradient(90deg, transparent 0, transparent calc(25% - 1px), rgba(109, 131, 158, .1) 25%); }
.duration-bar { position: absolute; top: 50%; min-width: 3px; height: 8px; transform: translateY(-50%); border-radius: 2px; box-shadow: 0 0 10px color-mix(in srgb, var(--node-color) 45%, transparent); opacity: .84; transition: height .16s ease, filter .16s ease; }
.duration-bar i { position: absolute; inset: 2px 1px auto; height: 1px; background: rgba(255,255,255,.48); }
.node-row:hover .duration-bar { height: 12px; filter: brightness(1.14); }
.node-duration { display: grid; justify-items: end; gap: 2px; padding-right: 14px; border-left: 1px solid rgba(125, 148, 177, .1); }
.node-duration strong { color: #cbd9e8; font: 600 10px/1 ui-monospace, monospace; }
.node-duration span { color: #4f997f; font: 700 7px/1 ui-monospace, monospace; letter-spacing: .08em; }
.node-duration span.error { color: #fb7185; }
.is-compact > .node-row { min-height: 32px; }
.is-compact .service-mark { height: 17px; }
.is-compact .node-meta { display: none; }
.is-compact .duration-bar { height: 6px; }
@media (prefers-reduced-motion: reduce) { .node-row, .duration-bar { transition: none; } }
</style>
