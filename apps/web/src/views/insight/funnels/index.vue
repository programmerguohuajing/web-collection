<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, pageLoading } from '../../../dashboard.js'

const router = useRouter()

// ---------------- 我的漏斗列表 ----------------
const loading = ref(false)
const funnels = ref([])
const report = ref(null)
const reportLoading = ref(false)
// 细分维度切换
const segmentField = ref('')
const WINDOW_OPTIONS = [
  { value: 1800000, label: '30 分钟' },
  { value: 3600000, label: '1 小时' },
  { value: 86400000, label: '24 小时' },
  { value: 604800000, label: '7 天' }
]

async function loadFunnels() {
  loading.value = true
  pageLoading.value = true
  try {
    const data = await api('/api/funnels?pageSize=50', { requestKey: 'funnels:list' })
    funnels.value = Array.isArray(data) ? data : (data?.items || []).map(row => ({ ...row, steps: typeof row.steps_json === 'string' ? JSON.parse(row.steps_json || '[]') : row.steps_json || row.steps || [] }))
  } catch (error) {
    ElMessage.error(error.message || '漏斗列表加载失败')
  } finally {
    loading.value = false
    pageLoading.value = false
  }
}

async function openReport(funnel) {
  reportLoading.value = true
  report.value = null
  try {
    const data = await api(`/api/funnels/${funnel.id}/report`, { requestKey: `funnel:report:${funnel.id}` })
    report.value = data
    const fields = (data.segments || []).map(item => item.field)
    segmentField.value = fields[0] || ''
  } catch (error) {
    ElMessage.error(error.message || '漏斗报告加载失败')
  } finally {
    reportLoading.value = false
  }
}

async function removeFunnel(funnel) {
  const confirmed = await ElMessageBox.confirm(`确定删除漏斗「${funnel.name}」吗？`, '删除漏斗', { type: 'warning' }).then(() => true).catch(() => false)
  if (!confirmed) return
  await api(`/api/funnels/${funnel.id}`, { method: 'DELETE' })
  ElMessage.success('漏斗已删除')
  if (report.value?.meta?.id === funnel.id) report.value = null
  await loadFunnels()
}

// ---------------- 编辑器抽屉 ----------------
const editorOpen = ref(false)
const editorSaving = ref(false)
const eventOptions = ref([])
const editorForm = reactive({
  id: null,
  name: '',
  appId: '',
  windowMs: 1800000,
  dimension: '',
  steps: [
    { eventName: '', constraint: '' },
    { eventName: '', constraint: '' }
  ]
})

async function openEditor(funnel = null) {
  editorOpen.value = true
  Object.assign(editorForm, {
    id: funnel?.id || null,
    name: funnel?.name || '',
    appId: funnel?.app_id || funnel?.appId || '',
    windowMs: Number(funnel?.window_ms ?? funnel?.windowMs ?? 1800000),
    dimension: funnel?.dimension || '',
    steps: normalizeEditorSteps(funnel)
  })
  loadEventNames()
}
function normalizeEditorSteps(funnel) {
  const source = Array.isArray(funnel?.steps) ? funnel.steps : []
  const rows = source.slice(0, 6).map(step => ({
    eventName: typeof step === 'string' ? step : step?.eventName || '',
    constraint: (Array.isArray(step?.filters) ? step.filters : []).map(f => `${f.field}=${f.value}`).join(' & ')
  }))
  while (rows.length < 2) rows.push({ eventName: '', constraint: '' })
  return rows
}

async function loadEventNames() {
  try {
    const data = await api('/api/events/dictionary/names?pageSize=100', { requestKey: 'funnels:eventNames' })
    eventOptions.value = Array.isArray(data) ? data : []
  } catch { eventOptions.value = [] }
}

function addStep() {
  if (editorForm.steps.length >= 6) return ElMessage.warning('最多 6 步')
  editorForm.steps.push({ eventName: '', constraint: '' })
}
function removeStep(index) {
  if (editorForm.steps.length <= 2) return ElMessage.warning('至少保留 2 步')
  editorForm.steps.splice(index, 1)
}

/** 解析 k=v 约束（& 分隔，≤2 组），字段支持 release/browser/device 或 props.xxx */
function parseConstraints(text) {
  return String(text || '').split('&').map(part => part.trim()).filter(Boolean).slice(0, 2).map(part => {
    const [field, ...rest] = part.split('=')
    const value = rest.join('=').trim()
    return field && value ? { field: field.trim(), operator: 'eq', value } : null
  }).filter(Boolean)
}

async function submitFunnel() {
  const name = editorForm.name.trim()
  const steps = editorForm.steps.map(step => ({ eventName: step.eventName.trim(), filters: parseConstraints(step.constraint) })).filter(step => step.eventName)
  if (!name) return ElMessage.warning('请输入漏斗名称')
  if (steps.length < 2) return ElMessage.warning('至少需要两个步骤事件')
  // 提交前校验：阻断停滞（近 7 日无上报）事件——选了也跑不出数据，对用户无价值
  const blocked = editorForm.steps.filter(step => {
    const opt = eventOptions.value.find(o => o.name === step.eventName)
    return opt && opt.health === 'stalled'
  })
  if (blocked.length) {
    return ElMessage.warning(`下列事件已停滞 7 日以上，跑不出漏斗数据：${blocked.map(s => s.eventName).join('、')}（请到「事件字典」登记或调整）`)
  }
  editorSaving.value = true
  try {
    await api('/api/funnels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: editorForm.id, name, appId: editorForm.appId || undefined, steps, windowMs: editorForm.windowMs, dimension: editorForm.dimension || undefined, createdBy: 'admin' })
    })
    editorOpen.value = false
    ElMessage.success('漏斗已保存')
    await loadFunnels()
  } catch (error) {
    ElMessage.error(error.message || '漏斗保存失败')
  } finally {
    editorSaving.value = false
  }
}

const TEMPLATES = [
  { name: '注册转化', icon: '⚿', color: 'var(--cat-pv)', steps: ['pv', 'click', 'submit_phone', 'signup_success'] },
  { name: '下单转化', icon: '🛒', color: 'var(--cat-perf)', steps: ['view_product', 'add_cart', 'submit_order', 'pay_success'] },
  { name: '表单完成', icon: '📝', color: 'var(--c-warning)', steps: ['form_enter', 'form_fill', 'form_submit'] }
]
function useTemplate(template) {
  Object.assign(editorForm, { id: null, name: template.name, windowMs: 1800000, dimension: '', steps: template.steps.map(name => ({ eventName: name, constraint: '' })) })
  editorOpen.value = true
  loadEventNames()
}

// ---------------- 报告渲染 ----------------
const maxStepUsers = computed(() => Math.max(1, ...(report.value?.steps || []).map(step => step.users)))
const currentSegment = computed(() => (report.value?.segments || []).find(item => item.field === segmentField.value))
function barWidth(users) { return `${Math.max(6, Math.round(Number(users) / maxStepUsers.value * 100))}%` }
function formatWindow(ms) {
  const found = WINDOW_OPTIONS.find(option => option.value === Number(ms))
  return found?.label || (ms ? `${Math.round(ms / 60000)} 分钟` : '不限')
}
function jumpJourney(sessionId) {
  router.push(`/journey?type=session&value=${encodeURIComponent(sessionId)}`)
}

onMounted(loadFunnels)
</script>

<template>
  <div>
    <div class="page-heading">
      <div>
        <h1>漏斗分析</h1>
        <p>任意 2~6 个事件序列自定义漏斗，验证设计的转化流程；流失样本一键跳转用户链路，交叉定位流失原因。</p>
      </div>
      <el-button type="primary" @click="openEditor()">＋ 新建漏斗</el-button>
    </div>

    <div class="caliber-note">
      <span class="ci">◈</span>
      <div><b>口径</b>：用户按 user_id 去重（缺失时按 device_id 兜底）；步骤须在窗口内按时间严格递增匹配；属性约束取事件字段；步骤下拉直接展示字典健康状态。</div>
    </div>

    <!-- 预置模板 -->
    <div class="tpl-grid">
      <div v-for="template in TEMPLATES" :key="template.name" class="tpl-card" @click="useTemplate(template)">
        <div class="tpl-top"><span class="tpl-ico" :style="{ background: template.color }">{{ template.icon }}</span><span class="tpl-tag">模板</span></div>
        <h3>{{ template.name }}</h3>
        <p>{{ template.steps.join(' → ') }}</p>
      </div>
    </div>

    <!-- 我的漏斗 -->
    <el-card shadow="never" class="section panel">
      <template #header><div class="panel-head"><b>我的漏斗</b><small style="margin-left: 8px">共 {{ funnels.length }} 个</small></div></template>
      <el-table :data="funnels" border v-loading="loading" empty-text="暂无漏斗，点击右上角新建">
        <el-table-column label="名称" min-width="200"><template #default="{ row }"><b>{{ row.name }}</b></template></el-table-column>
        <el-table-column label="步骤数" width="90" align="center"><template #default="{ row }">{{ (row.steps || []).length }}</template></el-table-column>
        <el-table-column label="转化窗口" width="110" align="center"><template #default="{ row }">{{ formatWindow(row.window_ms) }}</template></el-table-column>
        <el-table-column label="创建人" width="120"><template #default="{ row }">{{ row.created_by || '—' }}</template></el-table-column>
        <el-table-column label="更新时间" width="170">
          <template #default="{ row }">{{ row.updated_at ? new Date(Number(row.updated_at)).toLocaleString() : '-' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="210">
          <template #default="{ row }">
            <el-button link type="primary" @click="openReport(row)">查看报告</el-button>
            <el-button link type="primary" @click="openEditor(row)">编辑</el-button>
            <el-button link type="danger" @click="removeFunnel(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 漏斗报告 -->
    <div v-if="report" v-loading="reportLoading">
      <div class="prd-kpis">
        <div class="prd-kpi"><span class="k-label">进入用户</span><span class="k-value primary">{{ Number(report.meta.users).toLocaleString() }}</span><span class="k-foot">user_id 去重</span></div>
        <div class="prd-kpi"><span class="k-label">总转化率</span><span class="k-value success">{{ (report.meta.overallRate * 100).toFixed(1) }}%</span><span class="k-foot">窗口 {{ formatWindow(report.meta.windowMs) }}</span></div>
        <div class="prd-kpi"><span class="k-label">完成用户</span><span class="k-value">{{ Number(report.meta.converted).toLocaleString() }}</span><span class="k-foot">走完全部步骤</span></div>
        <div class="prd-kpi"><span class="k-label">流失用户</span><span class="k-value danger">{{ Number(report.lossInsight.lostUsers).toLocaleString() }}</span><span class="k-foot">{{ report.lossInsight.withErrorRate != null ? `流失中 ${(report.lossInsight.withErrorRate * 100).toFixed(0)}% 遇错` : '-' }}</span></div>
      </div>

      <el-card shadow="never" class="section panel">
        <template #header>
          <div class="panel-head">
            <b>转化漏斗 · {{ report.meta.name }}</b>
            <el-select v-model="segmentField" size="small" style="width: 140px" clearable placeholder="细分维度">
              <el-option v-for="segment in report.segments" :key="segment.field" :label="segment.field" :value="segment.field" />
            </el-select>
          </div>
        </template>
        <div class="funnel">
          <template v-for="(step, index) in report.steps" :key="step.idx">
            <div v-if="index > 0 && step.lost > 0" class="funnel-drop">↓ 流失 {{ Number(step.lost).toLocaleString() }}（{{ ((1 - step.rate) * 100).toFixed(1) }}%）</div>
            <div class="funnel-step">
              <div class="funnel-bar-wrap">
                <div class="funnel-bar" :class="`s${Math.min(6, step.idx)}`" :style="{ width: barWidth(step.users) }">
                  {{ step.event }} {{ Number(step.users).toLocaleString() }}
                  <span class="funnel-meta">{{ index === 0 ? '100%' : `${(step.rate * 100).toFixed(1)}%` }}</span>
                </div>
              </div>
            </div>
          </template>
        </div>

        <!-- 细分 -->
        <div v-if="currentSegment?.items?.length" style="margin-top: 16px">
          <el-table :data="currentSegment.items.sort((a, b) => b.entered - a.entered).slice(0, 8)" size="small" border>
            <el-table-column prop="name" :label="segmentField" min-width="160" />
            <el-table-column label="进入" width="110" align="right"><template #default="{ row }">{{ Number(row.entered).toLocaleString() }}</template></el-table-column>
            <el-table-column label="转化" width="110" align="right"><template #default="{ row }">{{ Number(row.converted).toLocaleString() }}</template></el-table-column>
            <el-table-column label="转化率" width="110" align="right"><template #default="{ row }">{{ (row.overallRate * 100).toFixed(1) }}%</template></el-table-column>
          </el-table>
        </div>

        <!-- 流失洞察 -->
        <div v-if="report.lossInsight.lostUsers > 0" class="ai-result" style="margin-top: 16px">
          <h4>✸ 流失洞察</h4>
          <ul>
            <li v-if="report.lossInsight.withErrorRate != null">流失用户中 <b>{{ (report.lossInsight.withErrorRate * 100).toFixed(0) }}%</b> 在流程中遇到过 JS 错误{{ report.lossInsight.topError ? `（末次操作：${report.lossInsight.topError}）` : '' }}。</li>
            <li v-else>流失用户未集中遇到错误，更可能是自然流失或页面体验问题。</li>
          </ul>
          <div class="ai-actions">
            <el-button size="small" type="primary" :disabled="!report.lossInsight.sampleSessionIds?.length" @click="jumpJourney(report.lossInsight.sampleSessionIds[0])">↗ 跳用户链路（抽样首条）</el-button>
          </div>
        </div>
      </el-card>
    </div>

    <!-- 编辑器抽屉 -->
    <el-drawer v-model="editorOpen" :title="editorForm.id ? '编辑漏斗' : '＋ 新建漏斗'" size="480px">
      <el-form label-width="86px">
        <el-form-item label="名称"><el-input v-model="editorForm.name" maxlength="40" placeholder="如下单转化" /></el-form-item>
        <el-form-item label="应用 ID"><el-input v-model="editorForm.appId" placeholder="留空=全部应用" /></el-form-item>
      </el-form>
      <div style="font-size: 13px; font-weight: 650; margin-bottom: 8px">步骤（2~6 步，数据源 = 事件字典）</div>
      <div v-for="(step, index) in editorForm.steps" :key="index" class="step-row">
        <el-tag :type="['primary', 'success', 'warning', 'danger', 'info', 'primary'][index % 6]" size="small" style="flex: none">{{ index + 1 }}</el-tag>
        <el-select v-model="step.eventName" filterable allow-create default-first-option placeholder="选择或输入事件名" style="flex: 1">
          <el-option v-for="option in eventOptions" :key="option.name" :value="option.name" :label="`${option.name}（${({ healthy: '🟢 健康', fluctuating: '🟡 波动', incomplete: '🟠 缺失', stalled: '🔴 停滞' })[option.health] || option.health}）`" :disabled="option.health === 'stalled'" />
        </el-select>
        <el-input v-model="step.constraint" placeholder="约束 k=v" style="width: 130px; flex: none" />
        <el-button link type="danger" @click="removeStep(index)">删</el-button>
      </div>
      <el-button size="small" style="margin-top: 8px" @click="addStep">＋ 加一步</el-button>
      <el-form label-width="86px" style="margin-top: 12px">
        <el-form-item label="转化窗口">
          <el-select v-model="editorForm.windowMs" style="width: 100%">
            <el-option v-for="option in WINDOW_OPTIONS" :key="option.value" :label="option.label" :value="option.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="细分维度">
          <el-select v-model="editorForm.dimension" clearable style="width: 100%" placeholder="无">
            <el-option label="浏览器 browser" value="browser" />
            <el-option label="平台 device" value="device" />
            <el-option label="版本 release" value="release" />
          </el-select>
        </el-form-item>
      </el-form>
      <div class="node-jumps">
        <el-button type="primary" :loading="editorSaving" @click="submitFunnel">保存</el-button>
        <el-button @click="editorOpen = false">取消</el-button>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.tpl-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-bottom: 16px; }
.tpl-card { padding: 16px; border: 1px solid var(--c-border); border-radius: 12px; background: var(--c-surface); cursor: pointer; transition: all 140ms ease; }
.tpl-card:hover { box-shadow: var(--sh-md); transform: translateY(-2px); border-color: #cfd3f7; }
.tpl-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.tpl-ico { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 9px; font-size: 15px; }
.tpl-tag { padding: 2px 7px; border-radius: 6px; background: var(--c-primary-soft); color: var(--c-primary); font-size: 10px; font-weight: 700; }
.tpl-card h3 { margin: 0 0 4px; font-size: 14px; }
.tpl-card p { margin: 0; color: var(--c-text-muted); font-size: 11.5px; line-height: 1.5; overflow-wrap: anywhere; }
.step-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
@media (max-width: 1180px) { .tpl-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 760px) { .tpl-grid { grid-template-columns: 1fr; } }
</style>
