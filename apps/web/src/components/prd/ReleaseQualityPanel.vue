<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api, queryFromFilters } from '../../dashboard.js'
import { useFilterStore } from '../../stores/filters.js'

const store = useFilterStore()
const loading = ref(false)
const dim = ref('release')
const data = ref(null)
const compareDrawer = ref(false)
const comparing = ref(false)
const compareForm = reactive({ a: '', b: '' })
const compareResult = ref(null)
// 面板内应用选择（与顶栏全局筛选联动；无账号/多应用部署下避免歧义）
const appOptions = ref([])

async function load() {
  loading.value = true
  try {
    // 未选应用时默认取「近期有实际上报」的第一个应用：
    // 复用发布列表接口（带 events 计数），避免落到只有登记没有数据的脏应用上。
    if (!store.appId) {
      const releasesData = await api('/api/analytics/releases?page=1&pageSize=50', { requestKey: 'rq:recent' }).catch(() => [])
      const rows = Array.isArray(releasesData) ? releasesData : releasesData?.items || []
      const activeAppId = rows.find(row => Number(row.events || 0) > 0 && (row.app_id || row.appId))?.app_id || rows.find(row => row.app_id || row.appId)?.app_id
      if (activeAppId) store.appId = String(activeAppId)
    }
    const params = new URLSearchParams(queryFromFilters({ dim: dim.value }, ['appId', 'release', 'startTime', 'endTime']))
    const result = await api(`/api/releases/quality?${params}`, { requestKey: 'rq:list' })
    data.value = result
    // 应用选项（全量列表，供手动切换）
    if (!appOptions.value.length) {
      const apps = await api('/api/applications', { requestKey: 'rq:apps' }).catch(() => [])
      const list = Array.isArray(apps) ? apps : apps?.items || []
      appOptions.value = list.map(item => ({ id: item.app_id || item.appId, count: Number(item.release_count || item.releaseCount || 0) }))
    }
    // 默认选中最新两个版本供对比
    const versions = (result?.items || []).map(item => item.version)
    if (!compareForm.a) compareForm.a = versions[0] || ''
    if (!compareForm.b) compareForm.b = versions[1] || ''
  } catch (error) {
    ElMessage.error(error.message || '版本质量加载失败')
    data.value = null
  } finally {
    loading.value = false
  }
}

const kpis = computed(() => {
  const summary = data.value?.summary || {}
  return [
    { label: '在线版本数', value: summary.versions ?? '-', cls: 'primary' },
    { label: '观察期 / 回滚', value: `${summary.watching ?? '-'} / ${summary.rollback ?? '-'}`, cls: Number(summary.rollback) > 0 ? 'danger' : 'warning' },
    { label: '建议收敛', value: summary.converge ?? '-', cls: '' },
    { label: '基线 错误/千会话', value: data.value?.baseline?.errorsPerKSession ?? '-', cls: 'success' }
  ]
})

function errorCellClass(row) {
  const baseline = data.value?.baseline?.errorsPerKSession
  if (baseline != null && row.errorsPerKSession != null && row.errorsPerKSession > baseline * 1.2) return 'cell-danger'
  return ''
}
function latencyLabel(value) {
  const ms = Number(value)
  if (!Number.isFinite(ms)) return '-'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}
const watchNotes = computed(() => (data.value?.items || [])
  .filter(item => ['rollback', 'watch'].includes(item.status))
  .map(item => `${item.version}：错误/千会话 ${item.errorsPerKSession ?? '-'}${data.value?.baseline?.errorsPerKSession != null ? `（基线 ${data.value.baseline.errorsPerKSession}）` : ''}，状态「${item.statusLabel}」`))

async function openCompare() {
  if (!compareForm.a || !compareForm.b) return ElMessage.warning('请选择 A / B 两个版本')
  compareDrawer.value = true
  comparing.value = true
  compareResult.value = null
  try {
    const params = new URLSearchParams(queryFromFilters({ a: compareForm.a, b: compareForm.b }, ['appId']))
    compareResult.value = await api(`/api/releases/quality/compare?${params}`, { requestKey: 'rq:compare' })
  } catch (error) {
    ElMessage.error(error.message || '对比加载失败')
  } finally {
    comparing.value = false
  }
}
function deltaTag(item) {
  return item.delta === 'new' ? { text: '新增', type: 'danger' } : item.delta === 'gone' ? { text: '消失', type: 'info' } : { text: '持平', type: 'info' }
}
const maxTrendUsers = () => Math.max(1, ...(compareResult.value?.trend || []).map(row => Math.max(row.a, row.b)))

onMounted(load)
defineExpose({ reload: load })
</script>

<template>
  <div>
    <div class="caliber-note">
      <span class="ci">◈</span>
      <div><b>口径</b>：采用用户 = 区间去重 user_id；错误/千会话 = errors×1000/会话数；异常会话率 = 含≥1错误会话/总会话；上报延迟 = received_at − ts。基线 = 会话数 ≥10 的其他版本按会话数加权平均；会话数 &lt;10 的版本标记「数据不足」。</div>
    </div>

    <div class="quality-head">
      <el-select v-model="store.appId" size="small" style="width: 220px" placeholder="选择应用" @change="load">
        <el-option v-for="item in appOptions" :key="item.id" :label="`${item.id}（${item.count} 版本）`" :value="item.id" />
      </el-select>
      <el-radio-group v-model="dim" size="small" @change="load">
        <el-radio-button value="release">按 App 版本</el-radio-button>
        <el-radio-button value="sdk">按 SDK 版本</el-radio-button>
      </el-radio-group>
      <el-button type="primary" size="small" @click="openCompare">A/B 对比</el-button>
    </div>

    <template v-if="data">
      <div class="prd-kpis">
        <div v-for="kpi in kpis" :key="kpi.label" class="prd-kpi">
          <span class="k-label">{{ kpi.label }}</span>
          <span class="k-value" :class="kpi.cls">{{ kpi.value }}</span>
        </div>
      </div>

      <el-card shadow="never" class="section panel">
        <template #header><b>版本质量总览</b><small style="margin-left: 8px">默认按采用用户降序 · 近 7 天</small></template>
        <el-table :data="data.items" border v-loading="loading" empty-text="暂无版本数据（需先在顶栏选择应用）">
          <el-table-column label="版本" min-width="160">
            <template #default="{ row }"><b>{{ row.version }}</b></template>
          </el-table-column>
          <el-table-column label="采用用户" width="110" align="right"><template #default="{ row }">{{ row.users.toLocaleString() }}</template></el-table-column>
          <el-table-column label="会话数" width="110" align="right"><template #default="{ row }">{{ row.sessions.toLocaleString() }}</template></el-table-column>
          <el-table-column label="错误/千会话" width="130" align="right">
            <template #default="{ row }"><span :class="errorCellClass(row)">{{ row.errorsPerKSession ?? '—' }}</span></template>
          </el-table-column>
          <el-table-column label="异常会话率" width="120" align="right">
            <template #default="{ row }">{{ row.abnormalSessionRate != null ? `${(row.abnormalSessionRate * 100).toFixed(1)}%` : '—' }}</template>
          </el-table-column>
          <el-table-column label="上报延迟" width="100" align="right"><template #default="{ row }">{{ latencyLabel(row.reportLatencyP75) }}</template></el-table-column>
          <el-table-column label="LCP P75" width="100" align="right"><template #default="{ row }">{{ row.perf?.lcpP75 ? `${row.perf.lcpP75}ms` : '—' }}</template></el-table-column>
          <el-table-column label="状态" width="130">
            <template #default="{ row }">
              <span class="status-pill" :class="row.status === 'insufficient' ? 'converge' : row.status"><span class="dot" />{{ row.statusLabel }}</span>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <div v-if="watchNotes.length" class="ai-result">
        <h4>✸ 观察期告警</h4>
        <ul><li v-for="note in watchNotes" :key="note">{{ note }}，建议复核发版内容{{ note.includes('建议回滚') ? '或回滚' : '' }}。</li></ul>
        <div class="ai-actions"><el-button size="small" type="danger" plain @click="openCompare">查看 A/B 对比</el-button></div>
      </div>
    </template>
    <el-alert v-else-if="!loading" type="info" title="请在顶栏选择应用后查看版本质量" :closable="false" />

    <!-- A/B 对比抽屉 -->
    <el-drawer v-model="compareDrawer" title="A/B 版本对比" size="560px">
      <div class="compare-select">
        <el-select v-model="compareForm.a" style="flex: 1" placeholder="版本 A">
          <el-option v-for="item in data?.items || []" :key="item.version" :label="`A：${item.version}`" :value="item.version" />
        </el-select>
        <el-select v-model="compareForm.b" style="flex: 1" placeholder="版本 B">
          <el-option v-for="item in data?.items || []" :key="item.version" :label="`B：${item.version}`" :value="item.version" />
        </el-select>
        <el-button type="primary" :loading="comparing" @click="openCompare">对比</el-button>
      </div>
      <div v-loading="comparing">
        <template v-if="compareResult">
          <h4 style="margin: 14px 0 8px; font-size: 13px">错误 Top10（A={{ compareForm.a }} / B={{ compareForm.b }}）</h4>
          <el-table :data="compareResult.errors" size="small" border empty-text="两版本均无错误记录">
            <el-table-column prop="name" label="错误名" min-width="180" show-overflow-tooltip />
            <el-table-column label="A" width="80" align="right"><template #default="{ row }">{{ row.aCount }}</template></el-table-column>
            <el-table-column label="B" width="80" align="right"><template #default="{ row }">{{ row.bCount }}</template></el-table-column>
            <el-table-column label="差异" width="90"><template #default="{ row }"><el-tag :type="deltaTag(row).type" size="small">{{ deltaTag(row).text }}</el-tag></template></el-table-column>
          </el-table>

          <h4 style="margin: 14px 0 8px; font-size: 13px">性能指标 P75</h4>
          <div class="kv">
            <div v-for="metric in ['lcp', 'inp', 'fcp']" :key="metric" class="row">
              <span class="k">{{ metric.toUpperCase() }}</span>
              <span class="v">A {{ compareResult.perf?.a?.[metric] ?? '-' }}ms · B {{ compareResult.perf?.b?.[metric] ?? '-' }}ms</span>
            </div>
          </div>

          <h4 style="margin: 14px 0 8px; font-size: 13px">近 14 天采用趋势（日活用户）</h4>
          <div class="dist-bar" v-for="row in compareResult.trend.slice(-7)" :key="row.day">
            <span class="db-label">{{ row.day.slice(5) }}</span>
            <div class="db-track">
              <div class="db-fill" :style="{ width: `${Math.round(Math.max(row.a, row.b) / maxTrendUsers() * 100)}%`, opacity: row.a >= row.b ? 1 : 0.45 }" />
            </div>
            <span class="db-val">A{{ row.a }} / B{{ row.b }}</span>
          </div>
        </template>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.quality-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; gap: 10px; flex-wrap: wrap; }
.cell-danger { color: var(--c-danger); font-weight: 700; }
.compare-select { display: flex; gap: 8px; margin-bottom: 6px; }
</style>
