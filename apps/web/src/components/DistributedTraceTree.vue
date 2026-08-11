<script setup>
import { computed, ref, watch } from 'vue'
import { api, pageLoading } from '../dashboard.js'
import DistributedTraceNode from './DistributedTraceNode.vue'

const props = defineProps({
  traceId: { type: String, required: true }
})

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

// 一次性将节点和边组装成树，避免递归组件在每层重复扫描全部边。
const tree = computed(() => {
  if (!nodes.value.length) return []
  const nodeMap = new Map(nodes.value.map(node => [node.id, { ...node, children: [] }]))
  const childIds = new Set()
  const linkedEdges = new Set()

  for (const edge of edges.value) {
    const parent = nodeMap.get(edge.source)
    const child = nodeMap.get(edge.target)
    const edgeKey = `${edge.source}->${edge.target}`
    if (!parent || !child || parent === child || linkedEdges.has(edgeKey)) continue
    parent.children.push(child)
    childIds.add(child.id)
    linkedEdges.add(edgeKey)
  }

  const roots = [...nodeMap.values()].filter(node => !childIds.has(node.id))
  return roots.length ? roots : [...nodeMap.values()]
})
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
      <DistributedTraceNode
        v-for="root in tree"
        :key="root.id"
        :node="root"
        :error-spans="errorSpans"
        :critical-path="criticalPath"
      />
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

<style scoped>
.distributed-trace { padding: 12px; }
.trace-summary { display: flex; gap: 8px; margin-bottom: 16px; }
.trace-tree { font-size: 13px; }
.loading { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 40px; color: #909399; }
</style>
