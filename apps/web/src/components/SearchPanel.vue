<script setup>
import { computed, ref } from 'vue'
import { filters, resetPages } from '../dashboard.js'
import { useFilterStore } from '../stores/filters.js'

const props = defineProps({
  fields: { type: Array, default: () => [] }
})
const emit = defineEmits(['search'])

const store = useFilterStore()
const searching = ref(false)
const globalFieldNames = ['appId', 'release', 'range']
const visibleFields = computed(() => props.fields)

const fieldMap = {
  traceId: { label: 'Trace ID' },
  range: { label: '时间' },
  release: { label: '版本' },
  path: { label: 'URL / path' },
  userId: { label: '用户 ID' },
  userName: { label: '用户名' },
  userPhone: { label: '手机号' },
  keyword: { label: '关键字' },
  type: { label: '事件类型' },
  status: { label: '错误状态' }
}

function search() {
  resetPages()
  emit('search')
}

function reset() {
  for (const name of visibleFields.value) {
    if (name === 'range') store.range = []
    else if (name === 'release' || name === 'appId') store[name] = ''
    else filters.value[name] = ''
  }
  search()
}
</script>

<template>
  <el-card v-if="visibleFields.length" shadow="never" class="query-card">
    <el-form class="ruoyi-query" label-width="82px" @submit.prevent="search">
      <el-form-item v-for="name in visibleFields" :key="name" :label="fieldMap[name]?.label">
        <el-date-picker v-if="name === 'range'" v-model="store.range" type="datetimerange" value-format="x" range-separator="至" start-placeholder="开始时间" end-placeholder="结束时间" />
        <el-select v-else-if="name === 'type'" v-model="filters.type" placeholder="请选择" clearable>
          <el-option label="错误" value="error" />
          <el-option label="性能" value="perf" />
          <el-option label="行为" value="behavior" />
          <el-option label="埋点" value="track" />
        </el-select>
        <el-select v-else-if="name === 'status'" v-model="filters.status" placeholder="请选择" clearable>
          <el-option label="Open" value="open" />
          <el-option label="Resolved" value="resolved" />
          <el-option label="Regression" value="regression" />
        </el-select>
        <el-input v-else-if="name === 'release'" v-model="store.release" placeholder="全部版本" clearable />
        <el-input v-else v-model="filters[name]" :placeholder="`请输入${fieldMap[name]?.label || ''}`" clearable />
      </el-form-item>
      <el-form-item class="query-actions">
        <el-button type="primary" :loading="searching" @click="search">查询</el-button>
        <el-button @click="reset">重置</el-button>
      </el-form-item>
    </el-form>
  </el-card>
</template>
