<script setup>
import { formatDuration, formatErrorLocation, readableText } from '../utils/format.js'

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

function typeLabel(row) {
  if (row.type === 'behavior') return ({ click: '点击', pv: '页面访问', page_leave: '页面离开', route: '路由切换', replaceState: '路由切换', pushState: '路由切换', popstate: '路由切换', scroll: '滚动', exposure: '曝光' })[row.name] || '行为'
  return ({ track: '埋点', perf: '性能', performance: '性能', error: '错误', replay: '回放' })[row.type] || '其他'
}

function userLabel(row) {
  const value = row.userName || row.userId || row.userPhone || row.user || row.username || row.account || row.accountName || row.memberName || row.nickname || ''
  return value == null || value === 'null' ? '' : value
}

function nameLabel(row) {
  if (row.type === 'error') return readableText(row.message, row.name)
  const raw = row.name || row.message || row.metric || '-'
  const labels = {
    click: '点击',
    track: '埋点',
    pv: '页面访问',
    pageview: '页面访问',
    page_leave: '页面离开',
    scroll: '滚动',
    stay: '停留',
    exposure: '曝光',
    route: '路由切换',
    replaceState: '路由切换',
    pushState: '路由切换',
    popstate: '路由切换',
    fetch: '接口请求',
    xhr: '接口请求',
    websocket: 'WebSocket',
    sse: 'SSE',
    resource: '资源加载',
    error: '脚本错误',
    unhandledrejection: 'Promise 异常',
    inp: '交互延迟',
    lcp: '最大内容渲染',
    cls: '布局偏移',
    fcp: '首次内容渲染',
    fid: '首次输入延迟',
    ttfb: '首字节时间',
    longtask: '长任务',
    white_screen: '首页白屏时间',
    blank_screen_rate: '白屏率',
    first_screen: '首屏完成时间',
    route_render: '路由切换渲染',
    data_ready: '页面数据就绪',
    dom_ready: 'DOM Ready',
    page_load: '页面完全加载',
    js_boot: 'JavaScript 初始化',
    tbt: '总阻塞时间',
    resource_failure_rate: '资源加载失败率',
    slow_api_rate: '慢接口率',
    dns: 'DNS 查询',
    tcp: 'TCP 连接',
    tls: 'TLS 握手',
    request: '服务端响应',
    download: 'HTML 下载',
    cache_hit_rate: '缓存命中率',
    redirect: '重定向耗时',
    redirect_count: '重定向次数'
  }
  if (row.type === 'behavior' && row.props) {
    const tag = String(row.props.tag || row.props.elementType || '').toUpperCase()
    const name = row.props.elementLabel || row.props.text || row.props.ariaLabel || row.props.alt || row.props.title || row.props.name || row.props.id || ''
    const normalizedName = String(name).trim().toUpperCase()
    if (name && normalizedName !== tag && !genericElementLabels.has(normalizedName)) return `点击：${name}`
  }
  return labels[raw] || raw
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
        <el-table-column label="时间" width="180">
          <template #default="{ row }">{{ new Date(row.ts).toLocaleString() }}</template>
        </el-table-column>
        <el-table-column label="类型" width="100">
          <template #default="{ row }">{{ typeLabel(row) }}</template>
        </el-table-column>
        <el-table-column :label="props.title?.includes('错误') ? '错误信息' : '名称'" min-width="220">
          <template #default="{ row }"><span class="table-ellipsis" :title="nameLabel(row)">{{ nameLabel(row) }}</span></template>
        </el-table-column>
        <el-table-column v-if="props.title?.includes('错误')" label="源码位置" min-width="220">
          <template #default="{ row }"><span class="table-ellipsis" :title="formatErrorLocation(row)">{{ formatErrorLocation(row) }}</span></template>
        </el-table-column>
        <el-table-column label="页面" min-width="240">
          <template #default="{ row }"><span class="table-ellipsis" :title="row.path || row.url || '-'">{{ row.path || row.url || '-' }}</span></template>
        </el-table-column>
        <el-table-column v-if="props.showUser" label="用户" min-width="150">
          <template #default="{ row }"><span class="table-ellipsis" :title="userLabel(row)">{{ userLabel(row) }}</span></template>
        </el-table-column>
        <el-table-column label="版本" width="120">
          <template #default="{ row }"><span class="table-ellipsis" :title="row.release || '-'">{{ row.release || '-' }}</span></template>
        </el-table-column>
      </template>
      <template v-else>
        <el-table-column :label="title.includes('资源') ? '资源' : '接口'" min-width="260">
          <template #default="{ row }"><span class="table-ellipsis" :title="row.name">{{ row.name }}</span></template>
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
