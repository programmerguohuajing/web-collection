<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { api, pageLoading } from '../../../dashboard.js'

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

// 构建树形结构用于渲染
const tree = computed(() => {
  if (!nodes.value.length) return null
  const nodeMap = new Map(nodes.value.map(n => [n.id, { ...n, children: [] }]))
  const rootNodes = []
  for (const node of nodes.value) {
    const parent = edges.value.find(e => e.target === node.id)
    if (parent) {
      const parentNode = nodeMap.get(parent.source)
      if (parentNode) parentNode.children.push(nodeMap.get(node.id))
    } else {
      rootNodes.push(nodeMap.get(node.id))
    }
  }
  return rootNodes[0] || null
})

function getStatusType(node) {
  if (node.hasError || errorSpans.value.includes(node.id)) return 'danger'
  if (criticalPath.value.includes(node.id)) return 'warning'
  return ''
}

function formatDuration(ms) {
  if (ms == null) return '-'
  if (ms < 1000) return `${ms.toFixed(1)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function getServiceColor(service) {
  const colors = {
    frontend: '#409EFF',
    gateway: '#67C23A',
    default: '#909399'
  }
  return colors[service] || colors.default
}
</script>

<template>
  <div class="distributed-trace">
    <!-- 摘要信息 -->
    <div class="trace-summary" v-if="nodes.length">
      <el-tag type="info">共 {{ nodes.length }} 个节点</el-tag>
      <el-tag type="danger" v-if="errorSpans.length">错误 {{ errorSpans.length }} 个</el-tag>
      <el-tag type="warning" v-if="criticalPath.length">关键路径 {{ criticalPath.length }} 层</el-tag>
    </div>

    <!-- 调用树 -->
    <div class="trace-tree" v-if="tree">
      <div class="tree-node" :class="{ 'is-error': getStatusType(tree) === 'danger', 'is-critical': getStatusType(tree) === 'warning' }">
        <div class="node-content">
          <div class="node-info">
            <span class="node-name">{{ tree.name || 'root' }}</span>
            <el-tag size="small" :style="{ backgroundColor: getServiceColor(tree.service), borderColor: getServiceColor(tree.service) }">
              {{ tree.service }}
            </el-tag>
            <span class="node-duration">{{ formatDuration(tree.duration) }}</span>
          </div>
          <div class="node-id">{{ tree.id }}</div>
        </div>
        <div class="node-children">
          <template v-for="child in tree.children" :key="child.id">
            <TreeNode :node="child" :error-spans="errorSpans" :critical-path="criticalPath" :depth="1" />
          </template>
        </div>
      </div>
    </div>

    <!-- 无数据 -->
    <el-empty v-if="!loading && !nodes.length" description="暂无链路数据" />

    <!-- 加载状态 -->
    <div class="loading" v-if="loading">
      <el-icon class="is-loading"><Loading /></el-icon>
      加载中...
    </div>
  </div>
</template>

<script>
// 递归渲染子节点
const TreeNode = {
  name: 'TreeNode',
  props: {
    node: { type: Object, required: true },
    errorSpans: { type: Array, default: () => [] },
    criticalPath: { type: Array, default: () => [] },
    depth: { type: Number, default: 0 }
  },
  setup(props) {
    function getStatusType(node) {
      if (props.errorSpans.includes(node.id)) return 'danger'
      if (props.criticalPath.includes(node.id)) return 'warning'
      return ''
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

    return { getStatusType, formatDuration, getServiceColor }
  },
  template: `
    <div class="tree-node" :class="{ 'is-error': getStatusType(node) === 'danger', 'is-critical': getStatusType(node) === 'warning' }" :style="{ marginLeft: depth * 24 + 'px' }">
      <div class="node-content">
        <div class="node-info">
          <span class="node-name">{{ node.name || 'span' }}</span>
          <el-tag size="small" :style="{ backgroundColor: getServiceColor(node.service), borderColor: getServiceColor(node.service), color: '#fff' }">
            {{ node.service }}
          </el-tag>
          <span class="node-duration">{{ formatDuration(node.duration) }}</span>
        </div>
        <div class="node-id">{{ node.id }}</div>
      </div>
      <div class="node-children" v-if="node.children?.length">
        <TreeNode v-for="child in node.children" :key="child.id" :node="child" :error-spans="errorSpans" :critical-path="criticalPath" :depth="depth + 1" />
      </div>
    </div>
  `
}

export { TreeNode }
</script>

<style scoped>
.distributed-trace {
  padding: 16px;
}
.trace-summary {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}
.trace-tree {
  font-size: 13px;
}
.tree-node {
  padding: 8px 12px;
  margin: 4px 0;
  border-left: 2px solid #e4e7ed;
  background: #fafafa;
  border-radius: 4px;
  transition: all 0.2s;
}
.tree-node:hover {
  background: #f5f7fa;
}
.tree-node.is-error {
  border-left-color: #f56c6c;
  background: #fef0f0;
}
.tree-node.is-critical {
  border-left-color: #e6a23c;
  background: #fdf6ec;
}
.node-content {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.node-info {
  display: flex;
  align-items: center;
  gap: 8px;
}
.node-name {
  font-weight: 500;
  color: #303133;
}
.node-duration {
  color: #909399;
  font-size: 12px;
}
.node-id {
  font-family: monospace;
  font-size: 11px;
  color: #c0c4cc;
}
.node-children {
  margin-top: 4px;
}
.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #909399;
  padding: 40px;
}
</style>
