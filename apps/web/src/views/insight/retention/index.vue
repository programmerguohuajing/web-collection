<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api, pageLoading } from '../../../dashboard.js'
import { useFilterStore } from '../../../stores/filters.js'

const store = useFilterStore()

const DAY_MS = 86400000
const RANGE_OPTIONS = [
  { label: '近 7 天', value: 7 },
  { label: '近 14 天', value: 14 },
  { label: '近 30 天', value: 30 },
  { label: '近 90 天', value: 90 }
]

const days = ref(30)
const offsetsText = ref('0,1,2,3,7,14,30')
const data = ref(null)

const offsets = computed(() => data.value?.offsets || [])
const rows = computed(() => data.value?.items || [])
const average = computed(() => data.value?.average || [])
const caliber = computed(() => data.value?.caliber || '')

/** 留存率着色：按 0~1 映射底色透明度，越高越深 */
function cellStyle(rate) {
  if (!rate) return {}
  const alpha = Math.min(0.72, 0.08 + rate * 0.64)
  return { background: `rgba(124, 58, 237, ${alpha.toFixed(3)})`, color: rate > 0.5 ? '#fff' : '#e9d5ff' }
}

function percent(rate) {
  if (rate === undefined || rate === null) return '-'
  return `${(Number(rate) * 100).toFixed(1)}%`
}

async function load() {
  const end = Date.now()
  const start = end - days.value * DAY_MS
  const params = new URLSearchParams({
    startTime: String(start),
    endTime: String(end),
    page: '1',
    pageSize: '100'
  })
  if (store.appId) params.set('appId', store.appId)
  if (offsetsText.value.trim()) params.set('offsets', offsetsText.value.trim())

  pageLoading.value = true
  try {
    data.value = await api(`/api/analytics/retention?${params.toString()}`, { requestKey: 'insight:retention' })
  } catch (err) {
    ElMessage.error(err?.message || '留存数据加载失败')
  } finally {
    pageLoading.value = false
  }
}

onMounted(load)
watch([days, () => store.appId], load)
</script>

<template>
  <div class="page">
    <el-card shadow="never" class="section panel">
      <template #header>
        <div class="panel-head">
          <b>留存 / 同期群分析</b>
          <div class="head-actions">
            <el-select v-model="days" size="small" style="width: 120px">
              <el-option v-for="item in RANGE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
            <el-input v-model="offsetsText" size="small" placeholder="留存天数，如 1,3,7,30" style="width: 200px" />
            <el-button size="small" type="primary" @click="load">查询</el-button>
          </div>
        </div>
      </template>

      <el-alert v-if="caliber" type="info" :closable="false" show-icon class="caliber">
        <template #title>统计口径</template>
        {{ caliber }}
      </el-alert>

      <el-empty v-if="!rows.length" description="暂无留存数据（请确认时间范围内有 PV 事件）" />

      <template v-else>
        <el-table :data="rows" size="small" border stripe :default-sort="{ prop: 'cohortDay', order: 'ascending' }">
          <el-table-column prop="cohortDate" label="首访日期" width="120" />
          <el-table-column prop="size" label="群规模" width="90" align="right">
            <template #default="{ row }">
              <!-- 样本量警告用原生 title（EP 2.14 红线：表格内禁用未统一定位的 el-tooltip） -->
              <span v-if="row.sampleNote" class="sample-warn" :title="row.sampleNote">{{ row.size }}</span>
              <span v-else>{{ row.size }}</span>
            </template>
          </el-table-column>
          <el-table-column label="窗口" width="80" align="center">
            <template #default="{ row }">
              <el-tag :type="row.complete ? 'success' : 'warning'" size="small">
                {{ row.complete ? '成熟' : '未成熟' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column
            v-for="offset in offsets"
            :key="offset"
            :label="offset === 0 ? '首访日' : `第 ${offset} 日`"
            align="center"
            min-width="86"
          >
            <template #default="{ row }">
              <div class="cell" :style="cellStyle((row.retention.find(r => r.day === offset) || {}).rate)">
                {{ percent((row.retention.find(r => r.day === offset) || {}).rate) }}
              </div>
            </template>
          </el-table-column>
        </el-table>

        <el-card v-if="average.length" shadow="never" class="section panel avg-panel">
          <template #header><div class="panel-head"><b>整体平均留存（按群规模加权）</b></div></template>
          <div class="avg-row">
            <div v-for="item in average" :key="item.day" class="avg-item">
              <div class="avg-label">{{ item.day === 0 ? '首访日' : `第 ${item.day} 日` }}</div>
              <div class="avg-value">{{ percent(item.rate) }}</div>
              <div class="avg-sub">{{ item.users }} 人</div>
            </div>
          </div>
        </el-card>
      </template>
    </el-card>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 12px; }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.head-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.caliber { margin-bottom: 12px; }
.caliber :deep(.el-alert__title) { font-weight: 600; }
.cell { padding: 2px 6px; border-radius: 4px; font-variant-numeric: tabular-nums; }
.sample-warn { color: #e6a23c; cursor: help; border-bottom: 1px dashed #e6a23c; }
.avg-panel { margin-top: 12px; }
.avg-row { display: flex; flex-wrap: wrap; gap: 10px; }
.avg-item {
  flex: 1 1 110px; text-align: center; padding: 10px 6px;
  border: 1px solid var(--el-border-color-lighter); border-radius: 6px;
}
.avg-label { font-size: 12px; color: var(--el-text-color-secondary); }
.avg-value { font-size: 20px; font-weight: 600; margin: 4px 0; color: #7c3aed; }
.avg-sub { font-size: 12px; color: var(--el-text-color-secondary); }
</style>
