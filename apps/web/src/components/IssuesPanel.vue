<script setup>
import { ref } from 'vue'
import OverflowTip from './OverflowTip.vue'
import { useDiagnosisStore } from '../stores/diagnosis.js'

defineProps({
  issues: { type: Array, default: () => [] },
  loading: Boolean,
  total: { type: Number, default: 0 },
  page: { type: Number, default: 1 },
  pageSize: { type: Number, default: 10 }
})
defineEmits(['resolve', 'page-change', 'size-change'])
const selected = ref(null)
const detailVisible = ref(false)

function showDetail(row) {
  selected.value = row
  // ADR-006：查看 issue 详情时写入全局诊断上下文（AI 诊断抽屉可感知）
  if (row?.fingerprint) useDiagnosisStore().setIssue(row.fingerprint)
  detailVisible.value = true
}

function issueNameLabel(issue) {
  const name = issue?.props?.name || issue?.name
  return ({
    click: '点击',
    fetch: '接口请求',
    xhr: '接口请求',
    resource: '资源加载',
    error: '脚本错误',
    unhandledrejection: 'Promise 异常'
  })[String(name || '').toLowerCase()] || name || '其他'
}

function sourceLabel(original, stack) {
  // 优先使用 SourceMap 反解结果（original.source/line/column）；
  // 无 SourceMap 时从 stack 字符串正则解析第一帧（与 EventTable.formatErrorLocation 一致）
  if (original && original.source && original.line) return `${original.source}:${original.line}:${original.column || 0}`
  const match = [...String(stack || '').matchAll(/((?:https?:\/\/|\/)[^():\s]+):(\d+):(\d+)/g)]
    .find(item => !/web-collection-sdk(?:\.[\w-]+)?\.js/i.test(item[1]))
  return match ? `${match[1]}:${match[2]}:${match[3]}` : '-'
}

function issueTraceId(issue) {
  // 优先从 props → original → 事件顶层（聚合表三处都可能保留）取 traceId
  return issue?.props?.traceId || issue?.original?.traceId || issue?.traceId || null
}
</script>

<template>
  <el-card v-loading="loading" shadow="never" class="panel section">
    <template #header>
      <div class="panel-head">
        <h2>错误列表</h2>
        <small>{{ issues.length }} 条</small>
      </div>
    </template>
    <el-table :data="issues" size="small" empty-text="暂无错误">
      <el-table-column label="错误信息" min-width="260">
        <template #default="{ row }">
          <OverflowTip :text="row.message || '-'" />
        </template>
      </el-table-column>
      <el-table-column label="类型" width="120">
        <template #default="{ row }">{{ issueNameLabel(row) }}</template>
      </el-table-column>
      <el-table-column prop="status" label="状态" width="110" />
      <el-table-column label="版本" width="130">
        <template #default="{ row }">
          <OverflowTip :text="row.release || '-'" />
        </template>
      </el-table-column>
      <el-table-column prop="count" label="次数" width="90" />
      <el-table-column v-if="issues.some(row => Number(row.affectedUsers) > 0)" label="用户数" width="90">
        <template #default="{ row }">{{ Number(row.affectedUsers) > 0 ? row.affectedUsers : '' }}</template>
      </el-table-column>
      <el-table-column label="源码位置" min-width="220">
        <template #default="{ row }">
          <OverflowTip :text="sourceLabel(row.original, row.stack)" />
        </template>
      </el-table-column>
      <el-table-column label="Trace" min-width="180">
        <template #default="{ row }">
          <router-link v-if="issueTraceId(row)" :to="`/traces?traceId=${encodeURIComponent(issueTraceId(row))}`">{{ issueTraceId(row) }}</router-link>
          <span v-else>-</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="140" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="showDetail(row)">详情</el-button>
          <el-button v-if="row.status !== 'resolved'" link type="primary" @click="$emit('resolve', row.fingerprint)">
            解决
          </el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-pagination
      v-if="total > pageSize"
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
    <el-drawer v-model="detailVisible" title="错误详情" size="52%">
      <el-descriptions v-if="selected" :column="1" border>
        <el-descriptions-item label="错误类型">{{ issueNameLabel(selected) }}</el-descriptions-item>
        <el-descriptions-item label="错误信息">{{ selected.message || '-' }}</el-descriptions-item>
        <el-descriptions-item label="页面地址">{{ selected.url || '-' }}</el-descriptions-item>
        <el-descriptions-item label="版本">{{ selected.release || '-' }}</el-descriptions-item>
        <el-descriptions-item label="发生次数">{{ selected.count || 0 }}</el-descriptions-item>
        <el-descriptions-item label="首次发生">{{ selected.firstSeen ? new Date(selected.firstSeen).toLocaleString() : '-' }}</el-descriptions-item>
        <el-descriptions-item label="最近发生">{{ selected.lastSeen ? new Date(selected.lastSeen).toLocaleString() : '-' }}</el-descriptions-item>
      </el-descriptions>
      <h3>堆栈</h3>
      <pre>{{ selected?.stack || '未采集到堆栈' }}</pre>
      <h3>附加信息</h3>
      <pre>{{ JSON.stringify(selected?.props || {}, null, 2) }}</pre>
      <h3>操作轨迹</h3>
      <pre>{{ JSON.stringify(selected?.breadcrumbs || [], null, 2) }}</pre>
    </el-drawer>
  </el-card>
</template>

<style scoped>
pre { overflow: auto; padding: 12px; border-radius: 6px; background: #f5f7fa; white-space: pre-wrap; word-break: break-word; }
h3 { margin: 20px 0 8px; }
</style>
