<script setup>
import { computed } from 'vue'

defineOptions({ name: 'DistributedTraceNode' })

const props = defineProps({
  node: { type: Object, required: true },
  errorSpans: { type: Array, default: () => [] },
  criticalPath: { type: Array, default: () => [] },
  ancestorIds: { type: Array, default: () => [] }
})

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

function formatDuration(value) {
  const duration = Number(value)
  if (!Number.isFinite(duration)) return '-'
  if (duration < 1000) return `${duration.toFixed(1)}ms`
  return `${(duration / 1000).toFixed(2)}s`
}

function getServiceColor(service) {
  const colors = { frontend: '#409EFF', gateway: '#67C23A', default: '#909399' }
  return colors[service] || colors.default
}

const nodeClass = computed(() => ({
  'node-error': isError.value,
  'node-critical': !isError.value && isCritical.value
}))
</script>

<template>
  <div class="trace-node" :class="nodeClass">
    <div class="node-row">
      <span class="node-name">{{ node.name || 'root' }}</span>
      <el-tag
        size="small"
        :style="{
          backgroundColor: getServiceColor(node.service),
          borderColor: getServiceColor(node.service),
          color: '#fff'
        }"
      >
        {{ node.service || 'unknown' }}
      </el-tag>
      <span class="node-duration">{{ formatDuration(node.duration) }}</span>
      <span class="node-id">{{ node.id }}</span>
      <span v-if="isCritical" class="node-badge critical">关键路径</span>
      <span v-if="isError" class="node-badge error">错误</span>
    </div>

    <div v-if="children.length" class="trace-children">
      <DistributedTraceNode
        v-for="child in children"
        :key="child.id"
        :node="child"
        :error-spans="errorSpans"
        :critical-path="criticalPath"
        :ancestor-ids="nextAncestorIds"
      />
    </div>
  </div>
</template>

<style scoped>
.trace-node { margin: 2px 0; }
.trace-children { margin-left: 20px; }
.node-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 6px 10px;
  background: #fafafa;
  border-radius: 4px;
  border-left: 3px solid #e4e7ed;
}
.node-row:hover { background: #f5f7fa; }
.node-error > .node-row { background: #fef0f0; border-left-color: #f56c6c; }
.node-critical > .node-row { background: #fdf6ec; border-left-color: #e6a23c; }
.node-name { font-weight: 500; color: #303133; }
.node-duration { color: #909399; font-size: 12px; min-width: 60px; }
.node-id {
  overflow: hidden;
  min-width: 100px;
  color: #c0c4cc;
  font-family: monospace;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.node-badge { flex: none; font-size: 10px; padding: 1px 6px; border-radius: 3px; }
.node-badge.critical { background: #e6a23c; color: #fff; }
.node-badge.error { background: #f56c6c; color: #fff; }
</style>
