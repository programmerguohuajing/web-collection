<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { filters, queryFromFilters, refreshAll, resetPages } from '../dashboard.js'

const props = defineProps({
  fields: { type: Array, default: () => [] }
})

const route = useRoute()
const router = useRouter()
const searching = ref(false)
const globalFields = ['range', 'appId', 'release', 'keyword']
const visibleFields = computed(() => props.fields.filter(name => !globalFields.includes(name)))
const queryFields = computed(() => [...new Set([...globalFields, ...props.fields])])

const fieldMap = {
  path: { label: 'URL / path' },
  userId: { label: '用户 ID' },
  userName: { label: '用户名' },
  userPhone: { label: '手机号' },
  type: { label: '事件类型' },
  status: { label: '错误状态' }
}

async function search() {
  searching.value = true
  try {
    resetPages()
    const query = Object.fromEntries(new URLSearchParams(queryFromFilters({}, queryFields.value)))
    const target = router.resolve({ path: route.path, query })
    if (target.fullPath === route.fullPath) await refreshAll()
    else await router.replace({ path: route.path, query })
  } finally {
    searching.value = false
  }
}

async function reset() {
  for (const name of visibleFields.value) filters.value[name] = ''
  await search()
}
</script>

<template>
  <el-card v-if="visibleFields.length" shadow="never" class="query-card">
    <el-form class="ruoyi-query" label-width="82px" @submit.prevent="search">
      <el-form-item v-for="name in visibleFields" :key="name" :label="fieldMap[name]?.label">
        <el-select v-if="name === 'type'" v-model="filters.type" placeholder="请选择" clearable>
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
        <el-input v-else v-model="filters[name]" :placeholder="`请输入${fieldMap[name]?.label || ''}`" clearable />
      </el-form-item>
      <el-form-item class="query-actions">
        <el-button type="primary" :loading="searching" @click="search">查询</el-button>
        <el-button @click="reset">重置</el-button>
      </el-form-item>
    </el-form>
  </el-card>
</template>
