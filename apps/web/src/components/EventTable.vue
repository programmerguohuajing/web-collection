<script setup>
import OverflowTip from './OverflowTip.vue'
import { behaviorDetailLabel, eventNameLabel, formatDuration, formatErrorLocation, metricLabel, readableText } from '../utils/format.js'

const genericElementLabels = new Set(['A', 'BUTTON', 'DIV', 'IMG', 'INPUT', 'SELECT', 'SPAN', 'TEXTAREA', 'UNI-BUTTON', 'UNI-IMAGE'])

const props = defineProps({
  title: String,
  rows: { type: Array, default: () => [] },
  stream: Boolean,
  loading: Boolean,
  total: { type: Number, default: 0 },
  page: { type: Number, default: 1 },
  pageSize: { type: Number, default: 10 },
  showUser: { type: Boolean, default: true }
})
defineEmits(['page-change', 'size-change'])
const behaviorTable = props.title?.includes('行为')
const performanceTable = props.title?.includes('性能')

function typeLabel(row) {
  if (row.type === 'behavior') return ({ click: '点击', pv: '页面访问', page_leave: '页面离开', route: '路由切换', replaceState: '路由切换', pushState: '路由切换', hashchange: '路由切换', popstate: '路由切换', scroll: '滚动', exposure: '曝光' })[row.name] || '行为'
  return ({ track: '埋点', perf: '性能', performance: '性能', error: '错误', replay: '回放' })[row.type] || '其他'
}

function userLabel(row) {
  const value = row.userName || row.userId || row.userPhone || row.user || row.username || row.account || row.accountName || row.memberName || row.nickname || ''
  return value == null || value === 'null' ? '' : value
}

function nameLabel(row) {
  if (row.type === 'error') return readableText(row.message, row.name)
  const raw = row.name || row.message || row.metric || '-'
  // metric 优先（性能事件名通常与上报的 metric 同名），fallback 到 event 名
  const translated = metricLabel(raw) !== '-' ? metricLabel(raw) : eventNameLabel(raw)
  if (row.type === 'behavior' && row.props) {
    const tag = String(row.props.tag || row.props.elementType || '').toUpperCase()
    const name = row.props.elementLabel || row.props.text || row.props.ariaLabel || row.props.alt || row.props.title || row.props.name || row.props.id || ''
    const normalizedName = String(name).trim().toUpperCase()
    if (name && normalizedName !== tag && !genericElementLabels.has(normalizedName)) return `点击：${name}`
  }
  return translated !== raw && translated !== '-' ? translated : raw
}

function requestLabel(row, field) {
  if (!['fetch', 'xhr'].includes(row.metric)) return '-'
  const value = row.props?.[field]
  return value == null || value === '' ? '-' : value
}

function statusType(status) {
  const value = Number(status)
  return value >= 500 ? 'danger' : value >= 400 ? 'warning' : value >= 200 ? 'success' : 'info'
}
</script>

<template>
  <el-card v-loading="loading" shadow="never" class="panel section">
    <template #header>
      <div class="panel-head">
        <h2>{{ title }}</h2>
        <small>{{ rows.length }} 条</small>
      </div>
    </template>
    <el-table :data="rows" size="small" empty-text="暂无数据">
      <template v-if="stream">
        <el-table-column label="时间" :width="behaviorTable ? 180 : 200" cell-class-name="time-cell">
          <template #default="{ row }">{{ new Date(row.ts).toLocaleString() }}</template>
        </el-table-column>
        <el-table-column label="类型" width="100" cell-class-name="no-ellipsis">
          <template #default="{ row }">
            <el-tag v-if="behaviorTable" size="small" effect="plain">{{ typeLabel(row) }}</el-tag>
            <template v-else>{{ typeLabel(row) }}</template>
          </template>
        </el-table-column>
        <el-table-column :label="props.title?.includes('错误') ? '错误信息' : behaviorTable ? '详情' : '名称'" :min-width="behaviorTable ? 180 : 220">
          <template #default="{ row }">
            <OverflowTip :text="behaviorTable ? behaviorDetailLabel(row) : nameLabel(row)" />
          </template>
        </el-table-column>
        <el-table-column v-if="performanceTable" label="请求地址" min-width="300">
          <template #default="{ row }"><OverflowTip :text="requestLabel(row, 'url')" /></template>
        </el-table-column>
        <el-table-column v-if="performanceTable" label="方法" width="90">
          <template #default="{ row }">{{ requestLabel(row, 'method') }}</template>
        </el-table-column>
        <el-table-column v-if="performanceTable" label="状态码" width="90">
          <template #default="{ row }">
            <el-tag v-if="requestLabel(row, 'status') !== '-'" size="small" effect="plain" :type="statusType(requestLabel(row, 'status'))">{{ requestLabel(row, 'status') }}</el-tag>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column v-if="props.title?.includes('错误')" label="源码位置" min-width="220">
          <template #default="{ row }"><OverflowTip :text="formatErrorLocation(row)" /></template>
        </el-table-column>
        <el-table-column label="页面" :min-width="behaviorTable ? 200 : 240">
          <template #default="{ row }"><OverflowTip :text="row.path || row.url || '-'" /></template>
        </el-table-column>
        <el-table-column v-if="props.showUser" label="用户" :min-width="behaviorTable ? 130 : 150">
          <template #default="{ row }"><OverflowTip :text="userLabel(row)" /></template>
        </el-table-column>
        <el-table-column label="版本" width="120">
          <template #default="{ row }"><OverflowTip :text="row.release || '-'" /></template>
        </el-table-column>
      </template>
      <template v-else>
        <el-table-column :label="title.includes('资源') ? '资源' : '接口'" min-width="260">
          <template #default="{ row }"><OverflowTip :text="row.name" /></template>
        </el-table-column>
        <el-table-column prop="count" label="次数" width="90" />
        <el-table-column label="平均" width="100"><template #default="{ row }">{{ formatDuration(row.avg) }}</template></el-table-column>
        <el-table-column label="P75" width="100"><template #default="{ row }">{{ formatDuration(row.p75) }}</template></el-table-column>
      </template>
    </el-table>
    <el-pagination
      v-if="total > 0"
      class="pager"
      background
      layout="sizes, prev, pager, next, total"
      :current-page="page"
      :page-size="pageSize"
      :page-sizes="[10, 20, 50, 100]"
      :total="total"
      @current-change="$emit('page-change', $event)"
      @size-change="$emit('size-change', $event)"
    />
  </el-card>
</template>

<style scoped>
:deep(.el-table .cell.no-ellipsis) { overflow: visible; text-overflow: clip; white-space: normal; }
</style>
