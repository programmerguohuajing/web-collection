<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, pageLoading } from '../../../dashboard.js'
import { useFilterStore } from '../../../stores/filters.js'
import { useAuth } from '../../../composables/useAuth'
import OverflowTip from '../../../components/OverflowTip.vue'
import KpiGrid from '../../../components/KpiGrid.vue'
import { QuestionFilled } from '@element-plus/icons-vue'

/**
 * B3 · 合成监控（主动探针）列表页。
 * 数据全部来自后端真实探测（/api/synthetic*），未跑过显式标注「未跑」不臆造。
 * `synthetic` 能力位 false 的部署：显式提示「当前部署不支持」，不渲染任何写入口。
 * 表格长文本一律 OverflowTip（EP 2.14 禁用原生 show-overflow-tooltip）。
 */
const router = useRouter()
const store = useFilterStore()
const { syntheticEnabled } = useAuth()

const INTERVAL_OPTIONS = [60, 300, 600]
const STATUS_META = {
  success: { label: '成功', tag: 'success' },
  fail: { label: '失败', tag: 'danger' },
  timeout: { label: '超时', tag: 'warning' }
}

const list = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = 20
const loading = ref(false)
const loadError = ref('')
const applications = ref([])
const runningId = ref('')

// —— 新建 / 编辑对话框 ——
const dialogOpen = ref(false)
const saving = ref(false)
const editingId = ref('')
const form = ref(emptyForm())

function emptyForm() {
  return {
    name: '', appId: '', url: '', intervalSeconds: 300, timeoutMs: 10000,
    expectedStatus: 200, keyword: '', latencyThresholdMs: null, failThreshold: 3, enabled: true
  }
}

const kpis = computed(() => {
  const enabledCount = list.value.filter(item => item.enabled).length
  const failing = list.value.filter(item => item.lastStatus === 'fail' || item.lastStatus === 'timeout' || Number(item.consecutiveFailures) > 0).length
  const withAv = list.value.filter(item => item.availability24h != null)
  const avgAv = withAv.length
    ? withAv.reduce((sum, item) => sum + Number(item.availability24h || 0), 0) / withAv.length
    : null
  return [
    { label: '探针总数', value: String(total.value), delta: '已定义', valueClass: 'value-primary' },
    { label: '启用中', value: String(enabledCount), delta: '参与定时探测', valueClass: 'value-success' },
    { label: '异常中', value: String(failing), delta: '失败 / 超时 / 连续失败', valueClass: 'value-danger' },
    { label: '平均可用率(24h)', value: avgAv != null ? `${(avgAv * 100).toFixed(2)}%` : '—', delta: '本页探针均值', valueClass: 'value-purple' }
  ]
})

function statusMeta(item) {
  if (!item.lastRunAt || item.lastStatus === 'unknown') return null
  return STATUS_META[item.lastStatus] || null
}

function availabilityText(item) {
  const rate = Number(item.availability24h)
  return Number.isFinite(rate) ? `${(rate * 100).toFixed(2)}%` : '—'
}

async function load() {
  // BUG-005 修复：能力位关闭时不再发请求（避免 503 噪音）；模板已用 v-if/v-else 只渲染占位提示。
  if (!syntheticEnabled.value) return
  loading.value = true
  loadError.value = ''
  pageLoading.value = true
  try {
    const params = new URLSearchParams({ page: String(page.value), pageSize: String(pageSize) })
    if (store.appId) params.set('appId', store.appId)
    const data = await api(`/api/synthetic?${params}`, { requestKey: 'synthetic:list' })
    list.value = Array.isArray(data?.items) ? data.items : []
    total.value = Number(data?.total ?? list.value.length)
  } catch (error) {
    if (error?.code !== 'ABORT_ERR') loadError.value = error.message || '探针列表加载失败'
    list.value = []
    total.value = 0
  } finally {
    loading.value = false
    pageLoading.value = false
  }
}

async function loadApplications() {
  try {
    const data = await api('/api/applications', { requestKey: 'synthetic:applications' })
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
  form.value = {
    name: row.name || '',
    appId: row.appId || '',
    url: row.url || '',
    intervalSeconds: Number(row.intervalSeconds) || 300,
    timeoutMs: Number(row.timeoutMs) || 10000,
    expectedStatus: Number(row.expectedStatus) || 200,
    keyword: row.keyword || '',
    latencyThresholdMs: row.latencyThresholdMs == null ? null : Number(row.latencyThresholdMs),
    failThreshold: Number(row.failThreshold) || 3,
    enabled: row.enabled !== false
  }
  dialogOpen.value = true
}

async function save() {
  if (!form.value.name.trim()) { ElMessage.warning('请填写探针名称'); return }
  if (!form.value.appId) { ElMessage.warning('请选择应用'); return }
  const url = String(form.value.url || '').trim()
  if (!/^https:\/\//i.test(url)) { ElMessage.warning('探针 URL 仅允许 https 协议'); return }
  if (!INTERVAL_OPTIONS.includes(Number(form.value.intervalSeconds))) { ElMessage.warning('探测间隔仅允许 60 / 300 / 600 秒'); return }
  const timeoutMs = Number(form.value.timeoutMs)
  if (!(timeoutMs >= 1000 && timeoutMs <= 30000)) { ElMessage.warning('超时时间须在 1000–30000 毫秒'); return }
  const body = {
    ...(editingId.value ? { id: editingId.value } : {}),
    name: form.value.name.trim(),
    appId: form.value.appId,
    url,
    intervalSeconds: Number(form.value.intervalSeconds),
    timeoutMs,
    expectedStatus: Number(form.value.expectedStatus) || 200,
    keyword: String(form.value.keyword || '').trim(),
    latencyThresholdMs: form.value.latencyThresholdMs != null && form.value.latencyThresholdMs !== '' ? Number(form.value.latencyThresholdMs) : null,
    failThreshold: Number(form.value.failThreshold) || 3,
    enabled: form.value.enabled !== false
  }
  saving.value = true
  try {
    await api('/api/synthetic', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    ElMessage.success(editingId.value ? '探针已更新' : '探针已创建')
    dialogOpen.value = false
    await load()
  } catch (error) {
    ElMessage.error(error.message || '保存失败')
  } finally {
    saving.value = false
  }
}

/** 启停开关：整字段回传 upsert（saveCheck 为 saveFunnel 风格全量更新）。 */
async function toggleEnabled(row) {
  const next = !row.enabled
  try {
    await api('/api/synthetic', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: row.id,
        appId: row.appId,
        name: row.name,
        url: row.url,
        intervalSeconds: row.intervalSeconds,
        timeoutMs: row.timeoutMs,
        expectedStatus: row.expectedStatus,
        keyword: row.keyword || '',
        latencyThresholdMs: row.latencyThresholdMs ?? null,
        failThreshold: row.failThreshold,
        enabled: next
      })
    })
    ElMessage.success(next ? '探针已启用' : '探针已停用')
    await load()
  } catch (error) {
    ElMessage.error(error.message || '操作失败')
  }
}

/** 立即探测：同步执行单次，返回本次结果 toast。 */
async function runNow(row) {
  runningId.value = row.id
  try {
    const data = await api(`/api/synthetic/${row.id}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const result = data?.result
    if (result?.ok) {
      ElMessage.success(`探测成功：HTTP ${result.status_code ?? '-'} · ${result.latency_ms ?? '-'}ms${result.latency_exceeded ? '（超时延阈值）' : ''}`)
    } else {
      ElMessage.error(`探测失败：${result?.error || result?.outcome || '未知原因'}`)
    }
    await load()
  } catch (error) {
    ElMessage.error(error.message || '探测失败')
  } finally {
    runningId.value = ''
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`确定删除探针「${row.name}」？其全部探测结果将一并删除。`, '删除确认', { type: 'warning' })
  } catch { return }
  try {
    await api(`/api/synthetic/${row.id}`, { method: 'DELETE' })
    ElMessage.success('已删除')
    await load()
  } catch (error) {
    ElMessage.error(error.message || '删除失败')
  }
}

watch(() => store.appId, () => { page.value = 1; load() })

onMounted(async () => {
  // BUG-005：能力位关闭时整页不发任何请求（load/loadApplications 双守卫）。
  if (!syntheticEnabled.value) return
  await load()
  loadApplications()
})
</script>

<template>
  <div class="synthetic-page">
    <div class="page-heading">
      <h1>合成监控<el-tooltip content="当前部署不支持合成监控（capability: synthetic）。主动拨测功能需要后端开启 synthetic 能力位后使用（Worker 部署需设置 SYNTHETIC_ENABLED=1）；本页当前为只读占位，不会发起写操作。" placement="top"><el-icon class="help-icon"><QuestionFilled /></el-icon></el-tooltip></h1>
    </div>
    <template v-if="syntheticEnabled">
      <KpiGrid :items="kpis" />
      <el-alert v-if="loadError" class="section" type="error" :title="loadError" show-icon />

      <section class="section">
        <div class="section-head">
          <div>
            <h2>探针列表</h2>
            <div class="sub">HTTP(S) 主动拨测 · 分钟级间隔 · 连续失败告警（复用告警中心通道）</div>
          </div>
          <el-button type="primary" @click="openCreate">＋ 新建探针</el-button>
        </div>

        <el-table :data="list" v-loading="loading" row-key="id">
          <el-table-column label="名称" min-width="160">
            <template #default="{ row }"><OverflowTip :text="row.name" /></template>
          </el-table-column>
          <el-table-column label="URL" min-width="240">
            <template #default="{ row }"><OverflowTip :text="row.url || '-'" /></template>
          </el-table-column>
          <el-table-column label="间隔" width="80">
            <template #default="{ row }">{{ row.intervalSeconds }}s</template>
          </el-table-column>
          <el-table-column label="最近状态" width="100">
            <template #default="{ row }">
              <el-tag v-if="statusMeta(row)" :type="statusMeta(row).tag" effect="light">{{ statusMeta(row).label }}</el-tag>
              <el-tag v-else type="info" effect="plain">未跑</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="连续失败" width="90">
            <template #default="{ row }">
              <span :class="{ 'fail-count': Number(row.consecutiveFailures) > 0 }">{{ row.consecutiveFailures }}</span>
            </template>
          </el-table-column>
          <el-table-column label="可用率(24h)" width="110">
            <template #default="{ row }">{{ availabilityText(row) }}</template>
          </el-table-column>
          <el-table-column label="启用" width="80">
            <template #default="{ row }">
              <el-switch :model-value="row.enabled" @change="toggleEnabled(row)" />
            </template>
          </el-table-column>
          <el-table-column label="操作" width="250" fixed="right">
            <template #default="{ row }">
              <el-button text type="primary" @click="router.push(`/synthetic/${row.id}`)">详情</el-button>
              <el-button text :loading="runningId === row.id" @click="runNow(row)">立即探测</el-button>
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

      <el-dialog v-model="dialogOpen" :title="editingId ? '编辑探针' : '新建探针'" width="600px">
        <el-form label-width="110px">
          <el-form-item label="名称" required>
            <el-input v-model="form.name" maxlength="80" placeholder="如：支付接口拨测" />
          </el-form-item>
          <el-form-item label="应用" required>
            <el-select v-model="form.appId" filterable placeholder="选择应用" style="width: 100%">
              <el-option v-for="app in applications" :key="app.appId" :label="app.name" :value="app.appId" />
            </el-select>
          </el-form-item>
          <el-form-item label="URL" required>
            <el-input v-model="form.url" maxlength="512" placeholder="https://api.example.com/health" />
            <div class="form-hint-line">仅允许 https 协议；禁止指向内网/保留地址（SSRF 防护）</div>
          </el-form-item>
          <el-form-item label="探测间隔">
            <el-select v-model="form.intervalSeconds" style="width: 200px">
              <el-option label="60 秒" :value="60" />
              <el-option label="300 秒" :value="300" />
              <el-option label="600 秒" :value="600" />
            </el-select>
          </el-form-item>
          <el-form-item label="超时">
            <el-input-number v-model="form.timeoutMs" :min="1000" :max="30000" :step="1000" style="width: 200px" />
            <span class="form-hint">ms（1000–30000）</span>
          </el-form-item>
          <el-form-item label="期望状态码">
            <el-input-number v-model="form.expectedStatus" :min="100" :max="599" style="width: 200px" />
          </el-form-item>
          <el-form-item label="关键词断言">
            <el-input v-model="form.keyword" maxlength="256" placeholder="可选：响应体需包含该关键词（不落库）" clearable />
          </el-form-item>
          <el-form-item label="时延阈值">
            <el-input-number v-model="form.latencyThresholdMs" :min="1" :step="100" style="width: 200px" placeholder="可选" />
            <span class="form-hint">ms，超过记 latency_exceeded（不计失败）；留空不判定</span>
          </el-form-item>
          <el-form-item label="告警阈值">
            <el-input-number v-model="form.failThreshold" :min="1" :max="100" style="width: 200px" />
            <span class="form-hint">连续失败 N 次触发告警（≤3 次记 critical）</span>
          </el-form-item>
          <el-form-item label="启用">
            <el-switch v-model="form.enabled" />
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
.form-hint-line { color: var(--el-text-color-secondary); font-size: 12px; margin-top: 4px; line-height: 1.4; }
.fail-count { color: var(--el-color-danger); font-weight: 600; }
.pager { margin-top: 12px; justify-content: flex-end; }
</style>
