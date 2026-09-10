<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useFilterStore } from '../../stores/filters.js'
import { useAuth } from '../../composables/useAuth'
import OverflowTip from '../../components/OverflowTip.vue'
import KpiGrid from '../../components/KpiGrid.vue'
import { listExperiments, saveExperiment, changeExperimentStatus, deleteExperiment } from '../../api/experiments.js'

/**
 * A3 · 实验分析（PRD 14）列表页：KpiGrid + 实验表 + 新建/编辑抽屉表单。
 * - 能力位 false：显式「当前部署不支持实验分析」占位，不静默隐藏（渲染只读占位，不发起写操作）；
 * - 表格长文本一律 OverflowTip（EP 2.14 红线，禁用原生 show-overflow-tooltip）；
 * - 状态机：draft → running → paused ⇄ running → completed → archived；防打架 409 toast 冲突实验名。
 */
const router = useRouter()
const store = useFilterStore()
const { experimentsEnabled } = useAuth()

const STATUS_META = {
  draft: { label: '草稿', tag: 'info', plain: true },
  running: { label: '运行中', tag: 'success', plain: false },
  paused: { label: '已暂停', tag: 'warning', plain: false },
  completed: { label: '已完成', tag: 'primary', plain: false },
  archived: { label: '已归档', tag: 'info', plain: true }
}
const GOAL_LABELS = {
  conversion_event: '目标转化率',
  error_rate: '错误率',
  session_duration: '会话时长'
}

const list = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = 20
const loading = ref(false)
const loadError = ref('')
const applications = ref([])

// —— 新建 / 编辑抽屉 ——
const drawerOpen = ref(false)
const saving = ref(false)
const editingId = ref('')
const editingRunning = ref(false)
const keyManuallyEdited = ref(false)
const form = ref(emptyForm())

function emptyForm() {
  return {
    name: '', key: '', appId: '', description: '',
    trafficPct: 100,
    variants: [{ name: 'control', weight: 50 }, { name: 'treatment_b', weight: 50 }],
    goalType: 'conversion_event', goalEventName: '', goalWindowDays: 7
  }
}

const kpis = computed(() => {
  const runningCount = list.value.filter(item => item.status === 'running').length
  const totalExposures = list.value.reduce((sum, item) => sum + Number(item.exposureCount || 0), 0)
  const exposures7d = list.value.reduce((sum, item) => sum + Number(item.exposureCount7d || 0), 0)
  return [
    { label: '实验总数', value: String(total.value), delta: '本应用已定义', valueClass: 'value-primary' },
    { label: '运行中', value: String(runningCount), delta: '同 key 仅允许一个 running', valueClass: 'value-success' },
    { label: '累计曝光', value: String(totalExposures), delta: 'experiment_exposures 去重后', valueClass: '' },
    { label: '近 7 天曝光', value: String(exposures7d), delta: '与 events 保留期口径对齐', valueClass: 'value-purple' }
  ]
})

function statusMeta(status) {
  return STATUS_META[status] || STATUS_META.draft
}

function goalLabel(item) {
  return GOAL_LABELS[item.goalMetric?.type] || item.goalMetric?.type || '—'
}

/** key slug：name → 小写连字符（创建时自动生成，可手改）。 */
function slugify(text) {
  const slug = String(text || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  return slug || 'exp-'
}

function onNameInput() {
  if (!keyManuallyEdited.value) form.value.key = slugify(form.value.name)
}

const variantsWeightTotal = computed(() => form.value.variants.reduce((sum, item) => sum + (Number(item.weight) || 0), 0))

function addVariant() {
  if (form.value.variants.length >= 4) return
  form.value.variants.push({ name: '', weight: Math.max(0, 100 - variantsWeightTotal.value) })
}

function removeVariant(index) {
  // control 固定首行禁删（PRD P0-2）
  if (index === 0 || form.value.variants.length <= 2) return
  form.value.variants.splice(index, 1)
}

async function load() {
  // BUG-005 修复：能力位关闭时不再发请求（避免 503 噪音）；模板已用 v-if/v-else 只渲染占位提示。
  if (!experimentsEnabled.value) return
  if (!store.appId) {
    list.value = []
    total.value = 0
    loadError.value = '请先在顶部选择应用（实验按应用维度管理）'
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    const data = await listExperiments({ appId: store.appId, page: page.value, pageSize })
    list.value = Array.isArray(data?.items) ? data.items : []
    total.value = Number(data?.total ?? list.value.length)
  } catch (error) {
    if (error?.code !== 'ABORT_ERR') loadError.value = error.message || '实验列表加载失败'
    list.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

async function loadApplications() {
  try {
    const { api } = await import('../../dashboard.js')
    const data = await api('/api/applications', { requestKey: 'experiment:applications' })
    const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : []
    applications.value = items.map(item => ({
      appId: item.app_id || item.appId || '',
      name: item.name || item.appName || item.app_id || item.appId || ''
    })).filter(item => item.appId)
  } catch { /* 选择器数据缺失不阻塞列表 */ }
}

function openCreate() {
  editingId.value = ''
  editingRunning.value = false
  keyManuallyEdited.value = false
  form.value = emptyForm()
  if (!form.value.appId && store.appId) form.value.appId = store.appId
  drawerOpen.value = true
}

function openEdit(row) {
  editingId.value = row.id
  editingRunning.value = row.status === 'running'
  keyManuallyEdited.value = true
  form.value = {
    name: row.name || '',
    key: row.key || '',
    appId: row.appId || store.appId || '',
    description: row.description || '',
    trafficPct: Number(row.trafficPct ?? 100),
    variants: Array.isArray(row.variants) && row.variants.length
      ? row.variants.map(item => ({ name: item.name, weight: Number(item.weight) || 0 }))
      : emptyForm().variants,
    goalType: row.goalMetric?.type || 'conversion_event',
    goalEventName: row.goalMetric?.eventName || row.goalMetric?.event_name || '',
    goalWindowDays: Number(row.goalMetric?.windowDays || row.goalMetric?.window_days || 7)
  }
  drawerOpen.value = true
}

async function save() {
  if (!form.value.name.trim()) { ElMessage.warning('请填写实验名称'); return }
  if (!form.value.appId) { ElMessage.warning('请选择应用'); return }
  if (!/^[a-z0-9_-]{2,64}$/.test(form.value.key)) { ElMessage.warning('key 须匹配 ^[a-z0-9_-]{2,64}$'); return }
  if (variantsWeightTotal.value <= 0) { ElMessage.warning('变体权重合计必须大于 0'); return }
  if (form.value.goalType === 'conversion_event' && !form.value.goalEventName.trim()) {
    ElMessage.warning('目标指标为转化事件时必须填写事件名')
    return
  }
  const body = {
    ...(editingId.value ? { id: editingId.value } : {}),
    appId: form.value.appId,
    key: form.value.key,
    name: form.value.name.trim(),
    description: String(form.value.description || '').trim(),
    trafficPct: Number(form.value.trafficPct),
    variants: form.value.variants.map(item => ({ name: String(item.name).trim(), weight: Number(item.weight) || 0 })),
    goalMetric: {
      type: form.value.goalType,
      ...(form.value.goalType === 'conversion_event' ? { eventName: form.value.goalEventName.trim() } : {}),
      windowDays: Number(form.value.goalWindowDays) || 7
    }
  }
  saving.value = true
  try {
    await saveExperiment(body)
    ElMessage.success(editingId.value ? '实验已更新' : '实验已创建（draft，启动后开始分流）')
    drawerOpen.value = false
    await load()
  } catch (error) {
    ElMessage.error(error.message || '保存失败')
  } finally {
    saving.value = false
  }
}

/** 状态机操作（服务端校验 + 防打架 409 返回冲突实验名）。 */
async function changeStatus(row, status, confirmText) {
  if (confirmText) {
    try { await ElMessageBox.confirm(confirmText, '操作确认', { type: 'warning' }) } catch { return }
  }
  try {
    await changeExperimentStatus(row.id, status)
    ElMessage.success(`实验「${row.name}」已置为 ${statusMeta(status).label}`)
    await load()
  } catch (error) {
    // 防打架 409：服务端错误文案含冲突实验名/key
    ElMessage.error(error.message || '状态迁移失败')
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`确定物理删除实验「${row.name}」？其全部曝光记录将一并删除且不可恢复。`, '删除确认', { type: 'warning' })
  } catch { return }
  try {
    await deleteExperiment(row.id)
    ElMessage.success('已删除')
    await load()
  } catch (error) {
    ElMessage.error(error.message || '删除失败')
  }
}

watch(() => store.appId, () => { page.value = 1; load() })

onMounted(() => {
  // BUG-005：能力位关闭时整页不发任何请求（load/loadApplications 双守卫）。
  if (!experimentsEnabled.value) return
  load()
  loadApplications()
})
</script>

<template>
  <div class="experiment-page">
    <el-alert
      v-if="!experimentsEnabled"
      class="section"
      type="info"
      :closable="false"
      show-icon
      title="当前部署不支持实验分析（capability: experiments）"
      description="A/B 实验平台需要后端开启 experiments 能力位后使用（Worker 部署需设置 EXPERIMENTS_ENABLED=1）；本页当前为只读占位，不会发起写操作。"
    />
    <template v-else>
      <KpiGrid :items="kpis" />
      <el-alert v-if="loadError" class="section" type="warning" :title="loadError" show-icon :closable="false" />

      <section class="section">
        <div class="section-head">
          <div>
            <h2>实验列表</h2>
            <div class="sub">一致性哈希分桶（anonymousId）· 同 key 全局仅一个 running · 状态机留痕</div>
          </div>
          <el-button type="primary" @click="openCreate">＋ 新建实验</el-button>
        </div>

        <el-table :data="list" v-loading="loading" row-key="id">
          <el-table-column label="名称" min-width="150">
            <template #default="{ row }"><OverflowTip :text="row.name" /></template>
          </el-table-column>
          <el-table-column label="key" min-width="130">
            <template #default="{ row }"><OverflowTip :text="row.key" /></template>
          </el-table-column>
          <el-table-column label="状态" width="96">
            <template #default="{ row }">
              <el-tag :type="statusMeta(row.status).tag" :plain="statusMeta(row.status).plain" effect="light">
                {{ statusMeta(row.status).label }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="流量" width="76">
            <template #default="{ row }">{{ row.trafficPct }}%</template>
          </el-table-column>
          <el-table-column label="变体数" width="76">
            <template #default="{ row }">{{ Array.isArray(row.variants) ? row.variants.length : 0 }}</template>
          </el-table-column>
          <el-table-column label="曝光数" width="96">
            <template #default="{ row }">{{ row.exposureCount ?? 0 }}</template>
          </el-table-column>
          <el-table-column label="目标指标" width="110">
            <template #default="{ row }">{{ goalLabel(row) }}</template>
          </el-table-column>
          <el-table-column label="开始时间" width="160">
            <template #default="{ row }">
              <span v-if="row.startedAt">{{ new Date(Number(row.startedAt)).toLocaleString() }}</span>
              <span v-else class="muted">未开始</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="290" fixed="right">
            <template #default="{ row }">
              <el-button text type="primary" @click="router.push(`/experiments/${row.id}`)">详情</el-button>
              <el-button v-if="row.status === 'draft' || row.status === 'paused'" text type="success"
                @click="changeStatus(row, 'running', row.status === 'paused' ? `恢复运行实验「${row.name}」？若同 key 已有运行中实验将返回冲突。` : '')">启动</el-button>
              <el-button v-if="row.status === 'running'" text type="warning" @click="changeStatus(row, 'paused')">暂停</el-button>
              <el-button v-if="row.status === 'running' || row.status === 'paused'" text
                @click="changeStatus(row, 'completed', `结束实验「${row.name}」？结束后停止分流与曝光。`)">完成</el-button>
              <el-button v-if="row.status === 'completed'" text type="warning"
                @click="changeStatus(row, 'archived', `归档实验「${row.name}」？归档后仅可查看与删除。`)">归档</el-button>
              <el-button text :disabled="row.status === 'running'" @click="openEdit(row)">编辑</el-button>
              <el-button v-if="row.status === 'archived'" text type="danger" @click="remove(row)">删除</el-button>
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

      <el-drawer v-model="drawerOpen" :title="editingId ? '编辑实验' : '新建实验'" size="560px">
        <el-form label-width="100px">
          <el-form-item label="应用" required>
            <el-select v-model="form.appId" filterable placeholder="选择应用" style="width: 100%" :disabled="editingRunning">
              <el-option v-for="app in applications" :key="app.appId" :label="app.name" :value="app.appId" />
            </el-select>
          </el-form-item>
          <el-form-item label="名称" required>
            <el-input v-model="form.name" maxlength="80" placeholder="如：结算按钮改版" :disabled="editingRunning" @input="onNameInput" />
          </el-form-item>
          <el-form-item label="key" required>
            <el-input v-model="form.key" maxlength="64" placeholder="checkout-button"
              :disabled="editingRunning || Boolean(editingId)" @input="keyManuallyEdited = true" />
            <div class="form-hint-line">业务分支消费键：eys.getVariant('key')；小写字母/数字/_/-，2~64 字符；创建后不可改</div>
          </el-form-item>
          <el-form-item label="说明">
            <el-input v-model="form.description" type="textarea" :rows="2" maxlength="512" :disabled="editingRunning" />
          </el-form-item>

          <el-divider content-position="left">变体管理（必含 control）</el-divider>
          <div v-for="(item, index) in form.variants" :key="index" class="variant-row">
            <el-input v-model="item.name" maxlength="32" :placeholder="index === 0 ? 'control' : 'treatment_b'"
              :disabled="index === 0 || editingRunning" class="variant-name">
              <template #prepend v-if="index === 0">对照组</template>
            </el-input>
            <el-input-number v-model="item.weight" :min="0" :max="100" :step="10" class="variant-weight" :disabled="editingRunning" />
            <el-button v-if="index > 0" text type="danger" :disabled="form.variants.length <= 2 || editingRunning" @click="removeVariant(index)">删</el-button>
          </div>
          <div class="variant-footer">
            <el-button text type="primary" :disabled="form.variants.length >= 4 || editingRunning" @click="addVariant">＋ 添加变体</el-button>
            <span :class="{ 'weight-warn': variantsWeightTotal <= 0 }">权重合计 {{ variantsWeightTotal }}（按比例归一化分桶）</span>
          </div>

          <el-divider content-position="left">分流与目标</el-divider>
          <el-form-item label="流量占比">
            <el-slider v-model="form.trafficPct" :min="0" :max="100" :step="5" show-input :disabled="editingRunning" />
            <div class="form-hint-line">参与实验的访客占比；未分配部分不参与实验（走默认逻辑）</div>
          </el-form-item>
          <el-form-item label="目标指标" required>
            <el-radio-group v-model="form.goalType" :disabled="editingRunning">
              <el-radio value="conversion_event">目标转化率</el-radio>
              <el-radio value="error_rate">错误率</el-radio>
              <el-radio value="session_duration">会话时长</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item v-if="form.goalType === 'conversion_event'" label="事件名" required>
            <el-input v-model="form.goalEventName" maxlength="160" placeholder="如：checkout_submit" :disabled="editingRunning" />
            <div class="form-hint-line">曝光后 {{ form.goalWindowDays }} 天窗口内出现该事件的访客占比（cohort=曝光访客）</div>
          </el-form-item>
          <el-form-item label="转化窗口">
            <el-input-number v-model="form.goalWindowDays" :min="1" :max="365" :disabled="editingRunning" />
            <span class="form-hint">天（曝光后窗口）</span>
          </el-form-item>
          <el-alert v-if="editingRunning" type="warning" :closable="false" show-icon
            title="running 状态的实验不可修改定义（需先暂停 → 编辑 → 启动），否则服务端返回 409。" />
        </el-form>
        <template #footer>
          <el-button @click="drawerOpen = false">取消</el-button>
          <el-button type="primary" :loading="saving" @click="save">保存</el-button>
        </template>
      </el-drawer>
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
.pager { margin-top: 12px; justify-content: flex-end; }
.variant-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; padding: 0 12px; }
.variant-name { flex: 1; }
.variant-weight { width: 130px; }
.variant-footer { display: flex; align-items: center; justify-content: space-between; padding: 0 12px 8px; color: var(--el-text-color-secondary); font-size: 12px; }
.weight-warn { color: var(--el-color-danger); }
</style>
