<script setup>
import { reactive, ref, watch } from 'vue'
import { api, filters } from '../dashboard.js'
import AnalyticsChart from './AnalyticsChart.vue'

const props = defineProps({
  eventNames: { type: Array, default: () => [] },
  insights: { type: Array, default: () => [] }
})
const emit = defineEmits(['changed'])
const form = reactive({ eventName: '', measure: 'events', interval: 'auto', breakdown: '', filters: [] })
const result = ref(null)
const properties = ref([])
const loading = ref(false)
const saveName = ref('')
const selectedId = ref(null)
const chartType = ref('line')

function requestBody() {
  const [selectedStart, selectedEnd] = filters.value.range || []
  return {
    ...form,
    appId: filters.value.appId || form.appId || '',
    release: filters.value.release || form.release || '',
    startTime: selectedStart || form.startTime,
    endTime: selectedEnd || form.endTime,
    filters: form.filters.filter(item => item.field && (item.operator === 'exists' || item.value !== '')).map(item => ({
      ...item,
      value: item.operator === 'in' ? String(item.value).split(',').map(value => value.trim()).filter(Boolean) : item.value
    }))
  }
}

async function loadProperties() {
  properties.value = form.eventName
    ? await api(`/api/analytics/event-properties?eventName=${encodeURIComponent(form.eventName)}${filters.value.appId ? `&appId=${encodeURIComponent(filters.value.appId)}` : ''}`)
    : []
}

async function run() {
  if (!form.eventName) return
  loading.value = true
  try {
    result.value = await api('/api/analytics/insights/query', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(requestBody())
    })
  } finally { loading.value = false }
}

function addFilter() {
  if (form.filters.length < 8) form.filters.push({ field: '', operator: 'eq', value: '' })
}

async function save() {
  if (!saveName.value.trim() || !form.eventName) return
  await api(selectedId.value ? `/api/analytics/insights/${selectedId.value}` : '/api/analytics/insights', {
    method: selectedId.value ? 'PUT' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: saveName.value, kind: 'eventTrend', definition: requestBody() })
  })
  await emit('changed')
}

async function remove() {
  if (!selectedId.value) return
  await api(`/api/analytics/insights/${selectedId.value}`, { method: 'DELETE' })
  selectedId.value = null
  saveName.value = ''
  await emit('changed')
}

function selectSaved(id) {
  const item = props.insights.find(insight => insight.id === id)
  if (!item) return
  Object.assign(form, item.definition, { filters: (item.definition.filters || []).map(filter => ({ ...filter, value: Array.isArray(filter.value) ? filter.value.join(',') : filter.value || '' })) })
  saveName.value = item.name
  loadProperties()
  run()
}

watch(() => form.eventName, loadProperties)
</script>

<template>
  <el-space wrap class="section">
    <el-select v-model="selectedId" clearable placeholder="打开已保存分析" style="width:220px" @change="selectSaved">
      <el-option v-for="item in insights.filter(item => item.kind === 'eventTrend')" :key="item.id" :label="item.name" :value="item.id" />
    </el-select>
    <el-input v-model="saveName" placeholder="分析名称" style="width:200px" />
    <el-button :disabled="!saveName || !form.eventName" @click="save">保存分析</el-button>
    <el-button v-if="selectedId" type="danger" plain @click="remove">删除</el-button>
  </el-space>

  <el-form inline class="insight-form">
    <el-form-item label="事件">
      <el-select v-model="form.eventName" filterable style="width:220px"><el-option v-for="item in eventNames" :key="item.name" :label="`${item.name}（${item.count}）`" :value="item.name" /></el-select>
    </el-form-item>
    <el-form-item label="指标"><el-select v-model="form.measure" style="width:130px"><el-option label="事件数" value="events" /><el-option label="用户数" value="users" /><el-option label="会话数" value="sessions" /></el-select></el-form-item>
    <el-form-item label="粒度"><el-select v-model="form.interval" style="width:120px"><el-option label="自动" value="auto" /><el-option label="小时" value="hour" /><el-option label="天" value="day" /><el-option label="周" value="week" /></el-select></el-form-item>
    <el-form-item label="拆分">
      <el-select v-model="form.breakdown" clearable style="width:180px">
        <el-option label="版本" value="release" /><el-option label="页面" value="path" /><el-option label="浏览器" value="browser" /><el-option label="设备" value="device" />
        <el-option v-for="item in properties" :key="item.name" :label="`属性：${item.name}`" :value="`props.${item.name}`" />
      </el-select>
    </el-form-item>
    <el-form-item><el-button type="primary" :loading="loading" @click="run">分析</el-button></el-form-item>
  </el-form>

  <div v-for="(filter, index) in form.filters" :key="index" class="filter-row">
    <el-select v-model="filter.field" filterable placeholder="过滤字段">
      <el-option label="版本" value="release" /><el-option label="页面" value="path" /><el-option label="浏览器" value="browser" /><el-option label="设备" value="device" />
      <el-option v-for="item in properties" :key="item.name" :label="`属性：${item.name}`" :value="`props.${item.name}`" />
    </el-select>
    <el-select v-model="filter.operator"><el-option label="等于" value="eq" /><el-option label="属于集合" value="in" /><el-option label="已设置" value="exists" /></el-select>
    <el-input v-if="filter.operator !== 'exists'" v-model="filter.value" :placeholder="filter.operator === 'in' ? '多个值用逗号分隔' : '过滤值'" />
    <el-button link type="danger" @click="form.filters.splice(index, 1)">移除</el-button>
  </div>
  <el-button link type="primary" @click="addFilter">+ 添加过滤条件</el-button>

  <template v-if="result">
    <el-space class="chart-actions"><el-radio-group v-model="chartType"><el-radio-button value="line">折线图</el-radio-button><el-radio-button value="bar">柱状图</el-radio-button></el-radio-group></el-space>
    <AnalyticsChart kind="trend" :result="result" :chart-type="chartType" />
    <el-table :data="result.table" border>
      <el-table-column label="时间" width="190"><template #default="{ row }">{{ new Date(row.bucket).toLocaleString() }}</template></el-table-column>
      <el-table-column prop="series" label="拆分值" min-width="180" />
      <el-table-column prop="value" label="数值" width="120" />
    </el-table>
  </template>
</template>

<style scoped>
.filter-row { display: grid; grid-template-columns: 220px 150px 1fr 60px; gap: 8px; margin-bottom: 8px; }
.chart-actions { display: flex; justify-content: flex-end; margin-top: 10px; }
</style>
