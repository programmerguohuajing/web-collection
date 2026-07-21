<script setup>
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { eventPager, filters, issuePager, queryFromFilters, refresh, replayPager } from '../dashboard.js'

const props = defineProps({
  fields: { type: Array, default: () => [] }
})

const route = useRoute()
const router = useRouter()
const searching = ref(false)

const fieldMap = {
  range: { label: '时间范围' },
  appId: { label: '应用' },
  release: { label: '版本' },
  path: { label: 'URL / path' },
  userId: { label: '用户 ID' },
  userName: { label: '用户名' },
  userPhone: { label: '手机号' },
  keyword: { label: '关键字' },
  type: { label: '事件类型' },
  status: { label: '错误状态' }
}

async function search() {
  searching.value = true
  try {
    eventPager.value.page = 1
    issuePager.value.page = 1
    replayPager.value.page = 1
    await router.replace(`${route.path}?${queryFromFilters({}, props.fields)}`)
    await refresh()
  } finally {
    searching.value = false
  }
}

async function reset() {
  for (const name of props.fields) filters.value[name] = name === 'range' ? [] : ''
  await search()
}
</script>

<template>
  <el-card v-if="fields.length" shadow="never" class="query-card">
    <el-form class="ruoyi-query" label-width="82px" @submit.prevent="search">
      <el-form-item v-for="name in fields" :key="name" :label="fieldMap[name]?.label">
        <el-date-picker
          v-if="name === 'range'"
          v-model="filters.range"
          type="datetimerange"
          value-format="x"
          start-placeholder="开始"
          end-placeholder="结束"
        />
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
        <el-input v-else v-model="filters[name]" :placeholder="`请输入${fieldMap[name]?.label || ''}`" clearable />
      </el-form-item>
      <el-form-item class="query-actions">
        <el-button type="primary" :loading="searching" @click="search">查询</el-button>
        <el-button @click="reset">重置</el-button>
      </el-form-item>
    </el-form>
  </el-card>
</template>
