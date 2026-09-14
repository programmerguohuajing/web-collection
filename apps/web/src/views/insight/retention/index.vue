<script setup>
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api, pageLoading, queryFromFilters, refreshVersion } from '../../../dashboard.js'
import { useFilterStore } from '../../../stores/filters.js'
import { QuestionFilled } from '@element-plus/icons-vue'

const store = useFilterStore()

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
  // 时间范围统一沿用顶部全局筛选（store.range → startTime/endTime，走 queryFromFilters）；页内不再自带时间选择器。
  const params = new URLSearchParams(queryFromFilters({ page: '1', pageSize: '100' }, ['appId', 'page', 'pageSize']))
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

// 顶部全局条件（含时间范围）切换时 refreshVersion 自增，统一在此重载。
watch(refreshVersion, load, { immediate: true })
</script>

<template>
  <div class="page">
    <el-card shadow="never" class="section panel">
      <template #header>
        <div class="panel-head">
          <b>留存 / 同期群分析<el-tooltip :content="caliber || '统计口径：按首访日期分组计算留存率'" placement="top"><el-icon class="help-icon"><QuestionFilled /></el-icon></el-tooltip></b>
          <div class="head-actions">
            <el-input v-model="offsetsText" size="small" placeholder="留存天数，如 1,3,7,30" style="width: 200px" />
            <el-button size="small" type="primary" @click="load">查询</el-button>
            <span class="range-hint">时间范围沿用顶部全局筛选 · {{ store.rangeLabel }}</span>
          </div>
        </div>
      </template>

      <el-empty v-if="!rows.length" description="暂无留存数据（请确认时间范围内有 PV 事件）" />

      <template v-else>
        <el-table :data="rows" size="small" border stripe :default-sort="{ prop: 'cohortDay', order: 'ascending' }">
          <el-table-column prop="cohortDate" label="首访日期" width="130" cell-class-name="nowrap-cell" />
          <el-table-column prop="size" label="群规模" width="90" align="right">
            <template #default="{ row }">
              <!-- 样本量警告用原生 title（EP 2.14 红线：表格内禁用未统一定位的 el-tooltip） -->
              <span v-if="row.sampleNote" class="sample-warn" :title="row.sampleNote">{{ row.size }}</span>
              <span v-else>{{ row.size }}</span>
            </template>
          </el-table-column>
          <el-table-column label="窗口" width="100" align="center" cell-class-name="window-cell">
            <template #default="{ row }">
              <el-tag :type="row.complete ? 'success' : 'warning'" size="small" class="window-tag">
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
.range-hint { color: var(--c-text-muted); font-size: 12px; }
.caliber { margin-bottom: 12px; }
.caliber :deep(.el-alert__title) { font-weight: 600; }
.cell { padding: 2px 6px; border-radius: 4px; font-variant-numeric: tabular-nums; }
.sample-warn { color: #e6a23c; cursor: help; border-bottom: 1px dashed #e6a23c; }
/* 首访日期：禁止换行（.el-table .cell 默认 word-break: break-all 会把日期拆行） */
:deep(.el-table .cell.nowrap-cell) { white-space: nowrap; word-break: keep-all; }
/* 窗口列：tag 不截断、不显示省略号 */
:deep(.el-table .cell.window-cell) { overflow: visible; text-overflow: clip; white-space: nowrap; }
:deep(.el-table .cell.window-cell .el-tag) { white-space: nowrap; max-width: none; overflow: visible; text-overflow: clip; }
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
