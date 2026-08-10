<script setup>
import { computed, ref, watch } from 'vue'
import { api, pageLoading } from '../dashboard.js'

const props = defineProps({
  traceId: { type: String, required: true }
})

const treeData = ref(null)
const nodes = ref([])
const edges = ref([])
const errorSpans = ref([])
const criticalPath = ref([])
const loading = ref(false)

async function loadDistributedTrace() {
  if (!props.traceId) return
  loading.value = true
  pageLoading.value = true
  try {
    const data = await api(`/api/traces/${encodeURIComponent(props.traceId)}/distributed`)
    treeData.value = data.root
    nodes.value = data.nodes || []
    edges.value = data.edges || []
    errorSpans.value = data.errorSpans || []
    criticalPath.value = data.criticalPath || []
  } catch (e) {
    console.error('Failed to load distributed trace:', e)
  } finally {
    loading.value = false
    pageLoading.value = false
  }
}

watch(() => props.traceId, loadDistributedTrace, { immediate: true })

// 构建树形结构
const tree = computed(() => {
  if (!nodes.value.length) return null
  const nodeMap = new Map(nodes.value.map(n => [n.id, { ...n, children: [], depth: 0 }]))

  // 设置每个节点的深度
  function setDepth(nodeId, depth) {
    const node = nodeMap.get(nodeId)
    if (node) {
      node.depth = depth
      const children = getChildren(nodeId)
      children.forEach(child => setDepth(child.id, depth + 1))
    }
  }

  // 找根节点
  const roots = nodes.value.filter(n => {
    const hasParent = edges.value.some(e => e.target === n.id)
    return !hasParent
  })

  roots.forEach(root => setDepth(root.id, 0))

  return roots
})

function getChildren(parentId) {
  return nodes.value.filter(n =>
    edges.value.some(e => e.source === parentId && e.target === n.id)
  )
}

function isError(node) {
  return node.hasError || errorSpans.value.includes(node.id)
}

function isCritical(node) {
  return criticalPath.value.includes(node.id)
}

function formatDuration(ms) {
  if (ms == null) return '-'
  if (ms < 1000) return `${ms.toFixed(1)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function getServiceColor(service) {
  const colors = { frontend: '#409EFF', gateway: '#67C23A', default: '#909399' }
  return colors[service] || colors.default
}

function getNodeClass(node) {
  if (isError(node)) return 'node-error'
  if (isCritical(node)) return 'node-critical'
  return ''
}
</script>

<template>
  <div class="distributed-trace">
    <!-- 摘要 -->
    <div class="trace-summary" v-if="nodes.length">
      <el-tag type="info">共 {{ nodes.length }} 个节点</el-tag>
      <el-tag type="danger" v-if="errorSpans.length">{{ errorSpans.length }} 个错误</el-tag>
      <el-tag type="warning" v-if="criticalPath.length">关键路径</el-tag>
    </div>

    <!-- 调用树 -->
    <div v-if="tree && tree.length" class="trace-tree">
      <template v-for="root in tree" :key="root.id">
        <TraceNode :node="root" :nodes="nodes" :edges="edges" :error-spans="errorSpans" :critical-path="criticalPath" :depth="0" />
      </template>
    </div>

    <!-- 无数据 -->
    <el-empty v-if="!loading && !nodes.length" description="暂无链路数据" />

    <!-- 加载 -->
    <div v-if="loading" class="loading">
      <el-icon class="is-loading"><Loading /></el-icon>
      加载中...
    </div>
  </div>
</template>

<script>
// 递归节点组件
const TraceNode = {
  name: 'TraceNode',
  props: {
    node: { type: Object, required: true },
    nodes: { type: Array, required: true },
    edges: { type: Array, required: true },
    errorSpans: { type: Array, default: () => [] },
    criticalPath: { type: Array, default: () => [] },
    depth: { type: Number, default: 0 }
  },
  setup(props) {
    const children = computed(() =>
      props.nodes.filter(n => props.edges.some(e => e.source === props.node.id && e.target === n.id))
    )
    const isError = computed(() =>
      props.node.hasError || props.errorSpans.includes(props.node.id)
    )
    const isCritical = computed(() =>
      props.criticalPath.includes(props.node.id)
    )
    const formatDuration = (ms) => {
      if (ms == null) return '-'
      if (ms < 1000) return `${ms.toFixed(1)}ms`
      return `${(ms / 1000).toFixed(2)}s`
    }
    const getServiceColor = (service) => {
      const colors = { frontend: '#409EFF', gateway: '#67C23A', default: '#909399' }
      return colors[service] || colors.default
    }
    const getNodeClass = () => {
      if (isError.value) return 'node-error'
      if (isCritical.value) return 'node-critical'
      return ''
    }
    return { children, isError, isCritical, formatDuration, getServiceColor, getNodeClass }
  },
  template: `
    <div class="trace-node" :class="getNodeClass()" :style="{ marginLeft: depth * 20 + 'px' }">
      <div class="node-row">
        <span class="node-indent"></span>
        <span class="node-name">{{ node.name || 'root' }}</span>
        <el-tag size="small" :style="{ backgroundColor: getServiceColor(node.service), borderColor: getServiceColor(node.service), color: '#fff' }">
          {{ node.service }}
        </el-tag>
        <span class="node-duration">{{ formatDuration(node.duration) }}</span>
        <span class="node-id">{{ node.id }}</span>
        <span v-if="isCritical" class="node-badge critical">关键路径</span>
        <span v-if="isError" class="node-badge error">错误</span>
      </div>
      <TraceNode
        v-for="child in children"
        :key="child.id"
        :node="child"
        :nodes="nodes"
        :edges="edges"
        :error-spans="errorSpans"
        :critical-path="criticalPath"
        :depth="depth + 1"
      />
    </div>
  `
}

export { TraceNode }
</script>

<style scoped>
.distributed-trace { padding: 12px; }
.trace-summary { display: flex; gap: 8px; margin-bottom: 16px; }
.trace-tree { font-size: 13px; }
.trace-node { margin: 2px 0; }
.node-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: #fafafa;
  border-radius: 4px;
  border-left: 3px solid #e4e7ed;
}
.node-row:hover { background: #f5f7fa; }
.node-error .node-row { background: #fef0f0; border-left-color: #f56c6c; }
.node-critical .node-row { background: #fdf6ec; border-left-color: #e6a23c; }
.node-indent { width: 8px; }
.node-name { font-weight: 500; color: #303133; }
.node-duration { color: #909399; font-size: 12px; min-width: 60px; }
.node-id { font-family: monospace; font-size: 11px; color: #c0c4cc; }
.node-badge { font-size: 10px; padding: 1px 6px; border-radius: 3px; }
.node-badge.critical { background: #e6a23c; color: #fff; }
.node-badge.error { background: #f56c6c; color: #fff; }
.loading { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 40px; color: #909399; }
</style>