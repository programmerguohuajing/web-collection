<script setup>
defineProps({
  issues: { type: Array, default: () => [] },
  loading: Boolean,
  total: { type: Number, default: 0 },
  page: { type: Number, default: 1 },
  pageSize: { type: Number, default: 10 }
})
defineEmits(['resolve', 'page-change', 'size-change'])

function issueNameLabel(name) {
  return ({
    click: '点击',
    fetch: '接口请求',
    xhr: '接口请求',
    resource: '资源加载',
    error: '脚本错误',
    unhandledrejection: 'Promise 异常'
  })[name] || '其他'
}

function sourceLabel(original) {
  return original ? `${original.source}:${original.line}:${original.column}` : '-'
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
          <span class="table-ellipsis" :title="row.message || '-'">{{ row.message || '-' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="类型" width="120">
        <template #default="{ row }">{{ issueNameLabel(row.name) }}</template>
      </el-table-column>
      <el-table-column prop="status" label="状态" width="110" />
      <el-table-column label="版本" width="130">
        <template #default="{ row }">
          <span class="table-ellipsis" :title="row.release || '-'">{{ row.release || '-' }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="count" label="次数" width="90" />
      <el-table-column v-if="issues.some(row => Number(row.affectedUsers) > 0)" label="用户数" width="90">
        <template #default="{ row }">{{ Number(row.affectedUsers) > 0 ? row.affectedUsers : '' }}</template>
      </el-table-column>
      <el-table-column label="源码位置" min-width="220">
        <template #default="{ row }">
          <span class="table-ellipsis" :title="sourceLabel(row.original)">{{ sourceLabel(row.original) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="100" fixed="right">
        <template #default="{ row }">
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
  </el-card>
</template>
