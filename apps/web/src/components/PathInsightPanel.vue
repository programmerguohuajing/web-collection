<script setup>
import { computed, reactive, ref } from 'vue'
import { api } from '../dashboard.js'
import { useFilterStore } from '../stores/filters.js'
import AnalyticsChart from './AnalyticsChart.vue'
import { ElMessage } from 'element-plus'

const store = useFilterStore()

const props = defineProps({
  insights: { type: Array, default: () => [] }
})
const emit = defineEmits(['changed'])
const form = reactive({ startPath: '', endPath: '', maxDepth: 5, minUsers: 1 })
const result = ref(null)
const loading = ref(false)
const saving = ref(false)
const removing = ref(false)
const loadError = ref('')
const saveName = ref('')
const selectedId = ref(null)
const selectedNode = ref(null)
let runRequestId = 0
const resultHasData = computed(() => Boolean(result.value && (
  (Array.isArray(result.value.nodes) && result.value.nodes.length) ||
  (Array.isArray(result.value.edges) && result.value.edges.length)
)))
const selectedEdges = computed(() => selectedNode.value
  ? (result.value?.edges || []).filter(item => item.source === selectedNode.value.id || item.target === selectedNode.value.id)
  : result.value?.edges || [])

function requestBody() {
  const [selectedStart, selectedEnd] = store.range || []
  return {
    ...form,
    appId: store.appId || form.appId || '',
    release: store.release || form.release || '',
    startTime: selectedStart || form.startTime,
    endTime: selectedEnd || form.endTime
  }
}

async function run() {
  const requestId = ++runRequestId
  loadError.value = ''
  loading.value = true
  try {
    const data = await api('/api/analytics/paths/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody()),
      requestKey: 'analytics:path-insight-query',
      timeout: 15000
    })
    if (requestId === runRequestId) {
      result.value = data
      selectedNode.value = null
    }
  } catch (error) {
    if (requestId === runRequestId && error?.code !== 'ABORT_ERR') {
      result.value = null
      selectedNode.value = null
      loadError.value = error?.message || '路径分析加载失败，请稍后重试'
    }
  } finally {
    if (requestId === runRequestId) loading.value = false
  }
}

async function save() {
  if (!saveName.value.trim()) return
  saving.value = true
  try {
    await api(selectedId.value ? `/api/analytics/insights/${selectedId.value}` : '/api/analytics/insights', {
      method: selectedId.value ? 'PUT' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: saveName.value, kind: 'path', definition: requestBody() }),
      requestKey: 'analytics:path-insight-save',
      timeout: 12000
    })
    ElMessage.success('分析已保存')
    emit('changed')
  } catch (error) {
    if (error?.code !== 'ABORT_ERR') ElMessage.error(error?.message || '分析保存失败，请稍后重试')
  } finally {
    saving.value = false
  }
}

async function remove() {
  if (!selectedId.value) return
  removing.value = true
  try {
    await api(`/api/analytics/insights/${selectedId.value}`, {
      method: 'DELETE',
      requestKey: 'analytics:path-insight-remove',
      timeout: 12000
    })
    selectedId.value = null
    saveName.value = ''
    ElMessage.success('分析已删除')
    emit('changed')
  } catch (error) {
    if (error?.code !== 'ABORT_ERR') ElMessage.error(error?.message || '分析删除失败，请稍后重试')
  } finally {
    removing.value = false
  }
}

function selectSaved(id) {
  const item = props.insights.find(insight => insight.id === id)
  if (!item) return
  Object.assign(form, item.definition)
  saveName.value = item.name
  void run()
}

function nodeLabel(id) {
  return result.value?.nodes?.find(item => item.id === id)?.label || id
}
</script>

<template>
  <el-space wrap class="section">
    <el-select v-model="selectedId" clearable placeholder="打开已保存路径" style="width:220px" @change="selectSaved">
      <el-option v-for="item in insights.filter(item => item.kind === 'path')" :key="item.id" :label="item.name" :value="item.id" />
    </el-select>
    <el-input v-model="saveName" placeholder="路径分析名称" style="width:200px" />
    <el-button :loading="saving" :disabled="!saveName" @click="save">保存分析</el-button>
    <el-button v-if="selectedId" type="danger" plain :loading="removing" :disabled="saving" @click="remove">删除</el-button>
  </el-space>
  <el-alert v-if="loadError" type="error" :title="loadError" show-icon :closable="false" class="panel-alert">
    <template #default><el-button link type="primary" @click="run">重试</el-button></template>
  </el-alert>
  <el-form inline>
    <el-form-item label="起始页面"><el-input v-model="form.startPath" clearable placeholder="留空表示任意页面" /></el-form-item>
    <el-form-item label="结束页面"><el-input v-model="form.endPath" clearable placeholder="留空表示任意页面" /></el-form-item>
    <el-form-item label="最大深度"><el-input-number v-model="form.maxDepth" :min="2" :max="8" /></el-form-item>
    <el-form-item label="最少用户"><el-input-number v-model="form.minUsers" :min="1" /></el-form-item>
    <el-form-item><el-button type="primary" :loading="loading" @click="run">分析路径</el-button></el-form-item>
  </el-form>
  <el-alert v-if="result && !resultHasData" type="info" title="当前筛选条件暂无路径数据" show-icon :closable="false" class="panel-alert" />
  <template v-else-if="result">
    <el-alert v-if="selectedNode" :title="`已选择：第 ${selectedNode.step + 1} 步 ${selectedNode.label}`" type="info" show-icon closable @close="selectedNode=null" />
    <AnalyticsChart kind="path" :result="result" @select-node="selectedNode=$event" />
    <el-table :data="selectedEdges" border empty-text="没有满足条件的页面转移">
      <el-table-column label="来源页面" min-width="240"><template #default="{ row }">{{ nodeLabel(row.source) }}</template></el-table-column>
      <el-table-column label="目标页面" min-width="240"><template #default="{ row }">{{ nodeLabel(row.target) }}</template></el-table-column>
      <el-table-column prop="users" label="用户数" width="100" />
      <el-table-column prop="sessions" label="会话数" width="100" />
    </el-table>
  </template>
</template>
