<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, pageLoading } from '../../../dashboard.js'
import { useFilterStore } from '../../../stores/filters.js'
import { useAuth } from '../../../composables/useAuth'
import OverflowTip from '../../../components/OverflowTip.vue'
import KpiGrid from '../../../components/KpiGrid.vue'

/**
 * B2 · SLO / 错误预算 列表页（Next Horizon B2）。
 * 数据全部来自后端真实聚合（/api/slo*），缺失快照显式标注「未计算」不臆造。
 * `slo` 能力位 false 的部署：显式提示「当前部署不支持」，不渲染任何写入口。
 * 表格长文本一律 OverflowTip（EP 2.14 禁用原生 show-overflow-tooltip）。
 */
const router = useRouter()
const store = useFilterStore()
const { sloEnabled } = useAuth()

const SLI_LABELS = { error_rate: '错误率', availability: '可用性', latency_threshold: '时延达标' }
const STATUS_META = {
  healthy: { label: '达标', tag: 'success' },
  warning: { label: '预算过半', tag: 'warning' },
  burnt: { label: '预算耗尽', tag: 'danger' }
}

const list = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = 20
const loading = ref(false)
const loadError = ref('')
const applications = ref([])

// —— 新建 / 编辑对话框 ——
const dialogOpen = ref(false)
const saving = ref(false)
const editingId = ref('')
const form = ref(emptyForm())

function emptyForm() {
  return {
    name: '', appId: '', objectivePercent: 99.9, windowDays: 30,
    sliType: 'error_rate', release: '',
    thresholds: { lcp: 2500, fcp: 1800, cls: 0.1, inp: 200 }
  }
}

const kpis = computed(() => {
  const withSnap = list.value.filter(item => item.latestBudget)
  const healthy = withSnap.filter(item => item.latestBudget.status === 'healthy').length
  const alerting = withSnap.filter(item => item.latestBudget.status !== 'healthy').length
  const avgGood = withSnap.length
    ? withSnap.reduce((sum, item) => sum + Number(item.latestBudget.goodRatio || 0), 0) / withSnap.length
    : 0
  return [
    { label: 'SLO 总数', value: String(total.value), delta: '已定义', valueClass: 'value-primary' },
    { label: '达标中', value: String(healthy), delta: 'healthy', valueClass: 'value-success' },
    { label: '告警中', value: String(alerting), delta: 'warning / burnt', valueClass: 'value-danger' },
    { label: '平均达标率', value: withSnap.length ? `${(avgGood * 100).toFixed(3)}%` : '—', delta: '最新快照', valueClass: 'value-purple' }
  ]
})

function statusMeta(item) {
  const status = item?.latestBudget?.status
  return STATUS_META[status] || null
}

function budgetRemaining(item) {
  const used = Number(item?.latestBudget?.budgetUsed)
  if (!Number.isFinite(used)) return null
  return `${(Math.max(0, 1 - used) * 100).toFixed(1)}%`
}

async function load() {
  loading.value = true
  loadError.value = ''
  pageLoading.value = true
  try {
    const params = new URLSearchParams({ page: String(page.value), pageSize: String(pageSize) })
    if (store.appId) params.set('appId', store.appId)
    const data = await api(`/api/slo?${params}`, { requestKey: 'slo:list' })
    list.value = Array.isArray(data?.items) ? data.items : []
    total.value = Number(data?.total ?? list.value.length)
  } catch (error) {
    if (error?.code !== 'ABORT_ERR') loadError.value = error.message || 'SLO 列表加载失败'
    list.value = []
    total.value = 0
  } finally {
    loading.value = false
    pageLoading.value = false
  }
}

async function loadApplications() {
  try {
    const data = await api('/api/applications', { requestKey: 'slo:applications' })
    const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : []
    applications.value = items.map(item => ({
      appId: item.app_id || item.appId || '',
      name: item.name || item.appName || item.app_id || item.appId || ''
    })).filter(item => item.appId)
  } catch { /* 选择器数据缺失不阻塞列表 */ }
}

function openCreate() {
  editingId.value = ''
  form.value = emptyForm()
  if (!form.value.appId && store.appId) form.value.appId = store.appId
  dialogOpen.value = true
}

function openEdit(row) {
  editingId.value = row.id
  const cfg = row.sliConfig || {}
  form.value = {
    name: row.name || '',
    appId: row.appId || '',
    objectivePercent: Number((Number(row.objective) * 100).toFixed(4)),
    windowDays: Number(row.windowDays) || 30,
    sliType: row.sliType || 'error_rate',
    release: cfg.release || '',
    thresholds: {
      lcp: cfg.thresholds?.lcp ?? 2500,
      fcp: cfg.thresholds?.fcp ?? 1800,
      cls: cfg.thresholds?.cls ?? 0.1,
      inp: cfg.thresholds?.inp ?? 200
    }
  }
  dialogOpen.value = true
}

async function save() {
  if (!form.value.name.trim()) { ElMessage.warning('请填写 SLO 名称'); return }
  if (!form.value.appId) { ElMessage.warning('请选择应用'); return }
  const objective = Number(form.value.objectivePercent) / 100
  if (!(objective > 0 && objective < 1)) { ElMessage.warning('目标须在 0~100% 之间（不含边界）'); return }
  const sliConfig = {}
  if (form.value.release.trim()) sliConfig.release = form.value.release.trim()
  if (form.value.sliType === 'latency_threshold') sliConfig.thresholds = { ...form.value.thresholds }
  saving.value = true
  try {
    const body = {
      ...(editingId.value ? { id: editingId.value } : {}),
      name: form.value.name.trim(),
      appId: form.value.appId,
      objective,
      windowDays: Number(form.value.windowDays),
      sliType: form.value.sliType,
      sliConfig
    }
    await api('/api/slo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    ElMessage.success(editingId.value ? 'SLO 已更新' : 'SLO 已创建')
    dialogOpen.value = false
    await load()
  } catch (error) {
    ElMessage.error(error.message || '保存失败')
  } finally {
    saving.value = false
  }
}

async function computeNow(row) {
  try {
    await api(`/api/slo/${row.id}/compute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    ElMessage.success('已触发立即计算')
    await load()
  } catch (error) {
    ElMessage.error(error.message || '计算失败')
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`确定删除 SLO「${row.name}」？其全部快照将一并删除。`, '删除确认', { type: 'warning' })
  } catch { return }
  try {
    await api(`/api/slo/${row.id}`, { method: 'DELETE' })
    ElMessage.success('已删除')
    await load()
  } catch (error) {
    ElMessage.error(error.message || '删除失败')
  }
}

watch(() => store.appId, () => { page.value = 1; load() })

onMounted(async () => {
  await load()
  loadApplications()
})
</script>

<template>
  <div class="slo-page">
    <el-alert
      v-if="!sloEnabled"
      class="section"
      type="info"
      :closable="false"
      show-icon
      title="当前部署未开启 SLO 能力（capability: slo）"
      description="SLO / 错误预算功能需要后端开启 slo 能力位后使用；本页当前为只读占位，不会发起写操作。"
    />
    <template v-else>
      <KpiGrid :items="kpis" />
      <el-alert v-if="loadError" class="section" type="error" :title="loadError" show-icon />

      <section class="section">
        <div class="section-head">
          <div>
            <h2>SLO 列表</h2>
            <div class="sub">错误目标 · 窗口 · 错误预算消耗（快照约 5 分钟刷新）</div>
          </div>
          <el-button type="primary" @click="openCreate">＋ 新建 SLO</el-button>
        </div>

        <el-table :data="list" v-loading="loading" row-key="id">
          <el-table-column label="名称" min-width="180">
            <template #default="{ row }"><OverflowTip :text="row.name" /></template>
          </el-table-column>
          <el-table-column label="应用" min-width="140">
            <template #default="{ row }"><OverflowTip :text="row.appId || '-'" /></template>
          </el-table-column>
          <el-table-column label="目标" width="100">
            <template #default="{ row }">{{ (row.objective * 100).toFixed(2) }}%</template>
          </el-table-column>
          <el-table-column label="窗口" width="80">
            <template #default="{ row }">{{ row.windowDays }} 天</template>
          </el-table-column>
          <el-table-column label="SLI" width="100">
            <template #default="{ row }">{{ SLI_LABELS[row.sliType] || row.sliType }}</template>
          </el-table-column>
          <el-table-column label="达标率" width="110">
            <template #default="{ row }">
              <span v-if="row.latestBudget">{{ (row.latestBudget.goodRatio * 100).toFixed(3) }}%</span>
              <span v-else class="muted">未计算</span>
            </template>
          </el-table-column>
          <el-table-column label="预算剩余" width="110">
            <template #default="{ row }">
              <span v-if="budgetRemaining(row)">{{ budgetRemaining(row) }}</span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag v-if="statusMeta(row)" :type="statusMeta(row).tag" effect="light">{{ statusMeta(row).label }}</el-tag>
              <el-tag v-else type="info" effect="plain">无快照</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="230" fixed="right">
            <template #default="{ row }">
              <el-button text type="primary" @click="router.push(`/slo/${row.id}`)">详情</el-button>
              <el-button text @click="computeNow(row)">立即计算</el-button>
              <el-button text @click="openEdit(row)">编辑</el-button>
              <el-button text type="danger" @click="remove(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>

        <el-pagination
          v-if="total > pageSize"
          class="pager"
          layout="prev, pager, next"
          :total="total"
          :page-size="pageSize"
          :current-page="page"
          @current-change="value => { page = value; load() }"
        />
      </section>

      <el-dialog v-model="dialogOpen" :title="editingId ? '编辑 SLO' : '新建 SLO'" width="560px">
        <el-form label-width="110px">
          <el-form-item label="名称" required>
            <el-input v-model="form.name" maxlength="80" placeholder="如：核心页面可用性" />
          </el-form-item>
          <el-form-item label="应用" required>
            <el-select v-model="form.appId" filterable placeholder="选择应用" style="width: 100%">
              <el-option v-for="app in applications" :key="app.appId" :label="app.name" :value="app.appId" />
            </el-select>
          </el-form-item>
          <el-form-item label="目标 SLO">
            <el-input-number v-model="form.objectivePercent" :min="0.001" :max="99.999" :step="0.001" :precision="3" style="width: 200px" />
            <span class="form-hint">%（窗口内允许的失败预算 = 1 − 目标）</span>
          </el-form-item>
          <el-form-item label="窗口">
            <el-select v-model="form.windowDays" style="width: 200px">
              <el-option label="28 天" :value="28" />
              <el-option label="30 天" :value="30" />
            </el-select>
            <span class="form-hint">事件仅保留 30 天，>30d 无法计算</span>
          </el-form-item>
          <el-form-item label="SLI 信号">
            <el-select v-model="form.sliType" style="width: 260px">
              <el-option label="错误率（error / pv）" value="error_rate" />
              <el-option label="可用性（fetch/xhr 状态≥400）" value="availability" />
              <el-option label="时延达标（Web Vitals 阈值）" value="latency_threshold" />
            </el-select>
          </el-form-item>
          <template v-if="form.sliType === 'latency_threshold'">
            <el-form-item label="LCP 阈值"><el-input-number v-model="form.thresholds.lcp" :min="100" :step="100" style="width: 180px" /><span class="form-hint">ms，超过计为坏样本</span></el-form-item>
            <el-form-item label="FCP 阈值"><el-input-number v-model="form.thresholds.fcp" :min="100" :step="100" style="width: 180px" /><span class="form-hint">ms</span></el-form-item>
            <el-form-item label="CLS 阈值"><el-input-number v-model="form.thresholds.cls" :min="0.01" :step="0.01" :precision="2" style="width: 180px" /></el-form-item>
            <el-form-item label="INP 阈值"><el-input-number v-model="form.thresholds.inp" :min="50" :step="50" style="width: 180px" /><span class="form-hint">ms</span></el-form-item>
          </template>
          <el-form-item label="版本过滤">
            <el-input v-model="form.release" placeholder="可选：仅统计指定 release" clearable />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="dialogOpen = false">取消</el-button>
          <el-button type="primary" :loading="saving" @click="save">保存</el-button>
        </template>
      </el-dialog>
    </template>
  </div>
</template>

<style scoped>
.section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.section-head h2 { margin: 0; font-size: 16px; }
.section-head .sub { color: var(--el-text-color-secondary); font-size: 12px; margin-top: 2px; }
.muted { color: var(--el-text-color-secondary); }
.form-hint { margin-left: 10px; color: var(--el-text-color-secondary); font-size: 12px; }
.pager { margin-top: 12px; justify-content: flex-end; }
</style>
