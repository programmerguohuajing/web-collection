<script setup>
import { ref, watch } from 'vue'
import { api } from '../dashboard.js'

const props = defineProps({ rows: Array, appId: String })
const from = ref('')
const to = ref('')
const result = ref(null)
const loading = ref(false)
const loadError = ref('')
let compareRequestId = 0

watch(() => props.rows, (rows) => {
  if (rows?.length >= 2) {
    from.value = rows[rows.length - 1]?.release || ''
    to.value = rows[0]?.release || ''
  } else {
    from.value = ''
    to.value = ''
    result.value = null
    loadError.value = ''
  }
})

async function compare() {
  const requestId = ++compareRequestId
  loadError.value = ''
  if (!from.value || !to.value || from.value === to.value) {
    result.value = null
    loading.value = false
    return
  }
  loading.value = true
  try {
    const data = await api(`/api/analytics/releases/compare?appId=${encodeURIComponent(props.appId || '')}&from=${encodeURIComponent(from.value)}&to=${encodeURIComponent(to.value)}`, {
      requestKey: 'analytics:release-compare',
      timeout: 12000
    })
    if (requestId === compareRequestId) result.value = data
  } catch (error) {
    if (requestId === compareRequestId && error?.code !== 'ABORT_ERR') {
      result.value = null
      loadError.value = error?.message || '版本对比加载失败，请稍后重试'
    }
  } finally {
    if (requestId === compareRequestId) loading.value = false
  }
}

watch(() => [from.value, to.value, props.appId], () => { void compare() }, { deep: true })
</script>

<template>
  <div class="version-compare">
    <div style="display:flex;gap:12px;align-items:center;margin-bottom:16px">
      <el-select v-model="from" placeholder="旧版本" style="width:160px">
        <el-option v-for="r in rows" :key="r.release" :label="r.release" :value="r.release" />
      </el-select>
      <span class="text-muted">→</span>
      <el-select v-model="to" placeholder="新版本" style="width:160px">
        <el-option v-for="r in rows" :key="r.release" :label="r.release" :value="r.release" />
      </el-select>
    </div>

    <el-skeleton v-if="loading" :rows="4" animated />
    <el-alert v-else-if="loadError" type="error" :title="loadError" show-icon :closable="false" class="compare-alert">
      <template #default><el-button link type="primary" @click="compare">重试</el-button></template>
    </el-alert>
    <div v-else-if="result" class="compare-result">
      <el-row :gutter="16">
        <el-col :span="8">
          <el-card shadow="never">
            <template #header><b>错误对比</b></template>
            <div class="compare-metric">
              <div><small>旧版本</small><strong :class="{ 'danger-value': result.errors?.from > (result.errors?.to || 0) }">{{ result.errors?.from || 0 }}</strong></div>
              <div><small>新版本</small><strong :class="{ 'danger-value': result.errors?.to > (result.errors?.from || 0) }">{{ result.errors?.to || 0 }}</strong></div>
              <div><small>增量</small><strong :class="{ 'danger-value': (result.errors?.delta || 0) > 0, 'success-value': (result.errors?.delta || 0) <= 0 }">{{ result.errors?.delta >= 0 ? '+' : '' }}{{ result.errors?.delta || 0 }}</strong></div>
            </div>
          </el-card>
        </el-col>
        <el-col :span="8">
          <el-card shadow="never">
            <template #header><b>受影响用户</b></template>
            <div class="compare-metric">
              <div><small>旧版本</small><strong>{{ result.affectedUsers?.from || 0 }}</strong></div>
              <div><small>新版本</small><strong>{{ result.affectedUsers?.to || 0 }}</strong></div>
              <div><small>增量</small><strong :class="{ 'danger-value': (result.affectedUsers?.delta || 0) > 0, 'success-value': (result.affectedUsers?.delta || 0) <= 0 }">{{ result.affectedUsers?.delta >= 0 ? '+' : '' }}{{ result.affectedUsers?.delta || 0 }}</strong></div>
            </div>
          </el-card>
        </el-col>
        <el-col :span="8">
          <el-card shadow="never">
            <template #header><b>LCP 对比</b></template>
            <div class="compare-metric">
              <div><small>旧版本 P95</small><strong :class="{ 'danger-value': (result.perf?.from?.lcp || 0) < (result.perf?.to?.lcp || 0) }">{{ result.perf?.from?.lcp ? Number(result.perf.from.lcp).toFixed(0) + 'ms' : '-' }}</strong></div>
              <div><small>新版本 P95</small><strong :class="{ 'danger-value': (result.perf?.to?.lcp || 0) > (result.perf?.from?.lcp || 0) }">{{ result.perf?.to?.lcp ? Number(result.perf.to.lcp).toFixed(0) + 'ms' : '-' }}</strong></div>
            </div>
          </el-card>
        </el-col>
      </el-row>
      <el-alert v-if="result.recommendation" type="warning" :title="result.recommendation" style="margin-top:16px" show-icon />
    </div>
    <el-empty v-else description="选择两个版本后自动对比" :image-size="60" />
  </div>
</template>

<style scoped>
.compare-alert { margin-bottom: 12px; }
.compare-metric { display: flex; flex-direction: column; gap: 8px; }
.compare-metric > div { display: flex; justify-content: space-between; align-items: center; }
.compare-metric small { color: #8491a3; }
</style>
