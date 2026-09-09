<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAuth } from '../../composables/useAuth'
import OverflowTip from '../../components/OverflowTip.vue'
import MiniLineChart from '../../components/MiniLineChart.vue'
import { getExperiment, getExperimentReport, changeExperimentStatus } from '../../api/experiments.js'

/**
 * A3 · 实验分析（PRD 14）详情/分析页：
 * - 状态操作条（状态机按钮；防打架 409 toast 冲突实验名）；
 * - 变体指标对比表（行=变体：曝光/访客/会话/错误率/目标转化率/相对 control 差值，胜出高亮）；
 * - 「样本量不足」提示条（<100 曝光/变体，只提示不判定，防伪科学）；
 * - 配置比 vs 实际比一致性条形图（漂移 >5pp 标黄）；
 * - 按天曝光时间序列（MiniLineChart 范式）+ 接入代码片段卡（复制按钮）。
 * 页头展示口径说明（README 原则 #3）：cohort=曝光访客、转化窗口 7d、样本阈值 100。
 */
const route = useRoute()
const router = useRouter()
const { experimentsEnabled } = useAuth()

const STATUS_META = {
  draft: { label: '草稿', tag: 'info', plain: true },
  running: { label: '运行中', tag: 'success', plain: false },
  paused: { label: '已暂停', tag: 'warning', plain: false },
  completed: { label: '已完成', tag: 'primary', plain: false },
  archived: { label: '已归档', tag: 'info', plain: true }
}

const experimentId = computed(() => String(route.params.id || ''))
const experiment = ref(null)
const report = ref(null)
const loading = ref(false)
const loadError = ref('')
const statusBusy = ref(false)

const statusMeta = computed(() => STATUS_META[experiment.value?.status] || STATUS_META.draft)
const goal = computed(() => report.value?.goal || { type: 'session_duration', eventName: null, windowDays: 7 })
const goalLabel = computed(() => ({ conversion_event: '目标转化率', error_rate: '错误率', session_duration: '会话时长' })[goal.value.type] || goal.value.type)

const kpis = computed(() => {
  const r = report.value
  return [
    { label: '总曝光', value: String(r?.totalExposures ?? 0), delta: '去重后访客首条曝光', valueClass: 'value-primary' },
    { label: '状态', value: statusMeta.value.label, delta: `流量 ${experiment.value?.trafficPct ?? '-'}% · ${Array.isArray(experiment.value?.variants) ? experiment.value.variants.length : 0} 个变体`, valueClass: 'value-success' },
    { label: '目标指标', value: goalLabel.value, delta: goal.value.type === 'conversion_event' ? `事件 ${goal.value.eventName || '-'} · 窗口 ${goal.value.windowDays}d` : `窗口 ${goal.value.windowDays}d`, valueClass: '' },
    { label: '样本量', value: r?.insufficient?.length ? '不足' : '充足', delta: r?.insufficient?.length ? `${r.insufficient.join(' / ')} < ${r.minSample} 曝光` : `每变体 ≥ ${r?.minSample ?? 100} 曝光`, valueClass: r?.insufficient?.length ? 'value-danger' : 'value-success' }
  ]
})

/** 变体行：目标指标值 + 胜出标记（样本不足的变体不参与胜出判定，防小样本误导）。 */
const metricRows = computed(() => {
  const rows = Array.isArray(report.value?.variants) ? report.value.variants : []
  const best = bestVariantName.value
  return rows.map(row => ({ ...row, isWinner: row.name === best && rows.length > 1 }))
})

/** 胜出判定（口径内最优）：conversion_event 取转化率最高；error_rate 取最低；session_duration 取最短。 */
const bestVariantName = computed(() => {
  const rows = Array.isArray(report.value?.variants) ? report.value.variants : []
  if (!rows.length) return null
  const sampleOk = row => row.exposures >= Number(report.value?.minSample || 100)
  const pick = (getter, better) => {
    const candidates = rows.filter(row => sampleOk(row) && getter(row) != null)
    if (!candidates.length) return null
    return candidates.reduce((a, b) => (better(getter(b), getter(a)) ? b : a)).name
  }
  if (goal.value.type === 'conversion_event') return pick(row => row.conversionRate, (a, b) => a > b)
  if (goal.value.type === 'error_rate') return pick(row => row.errorRate, (a, b) => a < b)
  return pick(row => row.avgDuration, (a, b) => a < b)
})

/** 配置比 vs 实际比条形图数据（双条：配置 vs 实际；漂移 >5pp 标黄）。 */
const driftRows = computed(() => {
  const rows = Array.isArray(report.value?.actual) ? report.value.actual : []
  const maxPct = Math.max(1, ...rows.flatMap(row => [Number(row.configPct) || 0, Number(row.actualPct) || 0]))
  return rows.map(row => ({ ...row, maxPct }))
})

/** 按天曝光时间序列：每变体一条线（day → 曝光数）。 */
const dailySeries = computed(() => {
  const items = Array.isArray(report.value?.daily) ? report.value.daily : []
  if (!items.length) return []
  const byVariant = new Map()
  for (const item of items) {
    if (!byVariant.has(item.variant)) byVariant.set(item.variant, [])
    byVariant.get(item.variant).push([Number(item.day) * 86400000, Number(item.exposures) || 0])
  }
  const colors = ['#409EFF', '#67C23A', '#E6A23C', '#F56C6C']
  return [...byVariant.entries()].map(([variant, data], index) => ({
    name: variant,
    axis: 'left',
    color: colors[index % colors.length],
    data: [...data].sort((a, b) => a[0] - b[0])
  }))
})

/** 接入代码片段（PRD P1-4：getVariant 调用 + 分支模板，降低接入成本）。 */
const snippet = computed(() => {
  const key = experiment.value?.key || 'your-experiment-key'
  return `// 业务代码消费示例（SDK 通用原语，不含实验语义）
const variant = eys.getVariant('${key}')
if (variant === null) {
  // 未入组（流量占比外）→ 现状逻辑
} else if (variant === 'control') {
  // 对照组：现状逻辑
} else {
  // treatment：新方案逻辑
}`
})

const snippetCopied = ref(false)
async function copySnippet() {
  try {
    await navigator.clipboard.writeText(snippet.value)
    snippetCopied.value = true
    setTimeout(() => { snippetCopied.value = false }, 2000)
    ElMessage.success('代码片段已复制')
  } catch {
    ElMessage.error('复制失败，请手动选择复制')
  }
}

async function load() {
  if (!experimentId.value) return
  loading.value = true
  loadError.value = ''
  try {
    const [detail, reportData] = await Promise.all([
      getExperiment(experimentId.value),
      getExperimentReport(experimentId.value)
    ])
    experiment.value = detail || null
    report.value = reportData || null
  } catch (error) {
    if (error?.code !== 'ABORT_ERR') loadError.value = error.message || '实验详情加载失败'
  } finally {
    loading.value = false
  }
}

/** 状态迁移（服务端状态机校验；防打架 409 错误文案含冲突实验名，直接 toast）。 */
async function changeStatus(status, confirmText) {
  if (!experiment.value) return
  if (confirmText) {
    try { await ElMessageBox.confirm(confirmText, '操作确认', { type: 'warning' }) } catch { return }
  }
  statusBusy.value = true
  try {
    await changeExperimentStatus(experiment.value.id, status)
    ElMessage.success(`已置为 ${STATUS_META[status]?.label || status}`)
    await load()
  } catch (error) {
    ElMessage.error(error.message || '状态迁移失败')
  } finally {
    statusBusy.value = false
  }
}

function fmtPct(value) {
  return value == null ? '—' : `${(Number(value) * 100).toFixed(2)}%`
}

function fmtDiff(value) {
  if (value == null) return '—'
  const pct = (Number(value) * 100).toFixed(1)
  return `${Number(value) >= 0 ? '+' : ''}${pct}%`
}

onMounted(load)
</script>

<template>
  <div class="experiment-detail">
    <div class="detail-head">
      <el-button text @click="router.push('/experiments')">← 返回列表</el-button>
      <div class="head-main" v-if="experiment">
        <h2><OverflowTip :text="experiment.name" /></h2>
        <div class="sub">
          <span class="sub-key"><OverflowTip :text="`key: ${experiment.key}`" /></span>
          · 流量 {{ experiment.trafficPct }}%
          <el-tag :type="statusMeta.tag" :plain="statusMeta.plain" effect="light" size="small" class="head-tag">
            {{ statusMeta.label }}
          </el-tag>
        </div>
      </div>
      <div class="head-actions" v-if="experiment">
        <el-button v-if="experiment.status === 'draft' || experiment.status === 'paused'" type="success" :loading="statusBusy"
          @click="changeStatus('running', experiment.status === 'paused' ? `恢复运行实验「${experiment.name}」？若同 key 已有运行中实验将返回冲突。` : '')">启动</el-button>
        <el-button v-if="experiment.status === 'running'" type="warning" :loading="statusBusy" @click="changeStatus('paused')">暂停</el-button>
        <el-button v-if="experiment.status === 'running' || experiment.status === 'paused'" :loading="statusBusy"
          @click="changeStatus('completed', `结束实验「${experiment.name}」？结束后停止分流与曝光。`)">完成</el-button>
        <el-button v-if="experiment.status === 'completed'" type="warning" :loading="statusBusy"
          @click="changeStatus('archived', `归档实验「${experiment.name}」？归档后仅可查看与删除。`)">归档</el-button>
      </div>
    </div>

    <el-alert
      v-if="!experimentsEnabled"
      class="section"
      type="info"
      :closable="false"
      show-icon
      title="当前部署不支持实验分析（capability: experiments）"
      description="Worker 部署需设置 EXPERIMENTS_ENABLED=1 后使用。"
    />
    <el-alert v-if="loadError" class="section" type="error" :title="loadError" show-icon />

    <template v-if="experimentsEnabled && experiment && report">
      <section class="section kpi-row">
        <el-card v-for="item in kpis" :key="item.label" shadow="never" class="kpi-card">
          <div class="kpi-label">{{ item.label }}</div>
          <div class="kpi-value" :class="item.valueClass">{{ item.value }}</div>
          <div class="kpi-delta">{{ item.delta }}</div>
        </el-card>
      </section>

      <el-alert class="section" type="info" :closable="false" show-icon
        :title="`统计口径：cohort=曝光访客（anonymousId 去重首条）；错误率=曝光会话中含 error 事件占比；${goalLabel}窗口 ${goal.windowDays} 天；样本阈值每变体 ${report.minSample} 曝光；不做显著性判定`" />

      <el-alert v-if="report.insufficient.length" class="section" type="warning" show-icon :closable="false"
        :title="`样本量不足：${report.insufficient.join(' / ')} 曝光数 < ${report.minSample}，暂勿下结论`" />

      <section class="section">
        <div class="block-head">
          <h3>变体指标对比</h3>
          <span class="muted">行=变体（control=对照组）；胜出高亮为口径内最优（样本不足不参与判定），非统计显著</span>
        </div>
        <el-table :data="metricRows" v-loading="loading">
          <el-table-column label="变体" width="140">
            <template #default="{ row }">
              <span :class="{ 'winner-name': row.isWinner }">{{ row.name }}</span>
              <el-tag v-if="row.name === 'control'" size="small" effect="plain" class="row-tag">对照</el-tag>
              <el-tag v-if="row.isWinner" size="small" type="success" effect="light" class="row-tag">胜出</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="曝光数" width="100" prop="exposures" />
          <el-table-column label="访客数" width="100" prop="visitors" />
          <el-table-column label="会话数" width="100" prop="sessions" />
          <el-table-column label="错误率" width="110">
            <template #default="{ row }">{{ fmtPct(row.errorRate) }}</template>
          </el-table-column>
          <el-table-column label="目标转化率" width="120">
            <template #default="{ row }">
              <span>{{ goal.type === 'conversion_event' ? fmtPct(row.conversionRate) : (row.avgDuration != null ? `${row.avgDuration}ms` : '—') }}</span>
            </template>
          </el-table-column>
          <el-table-column label="相对 control" min-width="120">
            <template #default="{ row }">
              <span :class="{ 'diff-pos': row.diffVsControl != null && row.diffVsControl > 0, 'diff-neg': row.diffVsControl != null && row.diffVsControl < 0 }">
                {{ fmtDiff(row.diffVsControl) }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="配置占比" width="100">
            <template #default="{ row }">{{ row.configPct }}%</template>
          </el-table-column>
        </el-table>
      </section>

      <section class="section">
        <div class="block-head">
          <h3>配置比 vs 实际比</h3>
          <span class="muted">用曝光数据反验实际分流比；漂移 &gt;5pp 标黄（监控闭环替代强一致裁决）</span>
        </div>
        <div v-if="driftRows.length" class="drift-list">
          <div v-for="row in driftRows" :key="row.variant" class="drift-row">
            <div class="drift-name"><OverflowTip :text="row.variant" /></div>
            <div class="drift-bars">
              <div class="bar-track">
                <div class="bar bar-config" :style="{ width: `${(row.configPct / row.maxPct) * 100}%` }"></div>
                <span class="bar-label">配置 {{ row.configPct }}%</span>
              </div>
              <div class="bar-track">
                <div class="bar" :class="row.drift ? 'bar-drift' : 'bar-actual'" :style="{ width: `${(row.actualPct / row.maxPct) * 100}%` }"></div>
                <span class="bar-label">实际 {{ row.actualPct }}%</span>
              </div>
            </div>
            <el-tag v-if="row.drift" type="warning" effect="plain" size="small">漂移</el-tag>
          </div>
        </div>
        <el-empty v-else description="暂无曝光数据" :image-size="80" />
      </section>

      <section class="section">
        <div class="block-head">
          <h3>按天曝光时间序列</h3>
          <span class="muted">各变体每日曝光数（保留期随 events 30d 口径）</span>
        </div>
        <MiniLineChart v-if="dailySeries.length" :series="dailySeries" height="260px" :axis-names="{ left: '曝光数' }" />
        <el-empty v-else description="暂无曝光数据 — 实验 running 且 SDK 消费 getVariant 后开始积累" :image-size="80" />
      </section>

      <section class="section">
        <div class="block-head">
          <h3>接入代码片段</h3>
          <el-button size="small" :type="snippetCopied ? 'success' : 'primary'" @click="copySnippet">
            {{ snippetCopied ? '已复制' : '复制' }}
          </el-button>
        </div>
        <pre class="snippet"><code>{{ snippet }}</code></pre>
      </section>
    </template>
  </div>
</template>

<style scoped>
.detail-head { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 8px; }
.head-main { flex: 1; min-width: 0; }
.head-main h2 { margin: 0; font-size: 18px; }
.head-main .sub { color: var(--el-text-color-secondary); font-size: 12px; margin-top: 4px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sub-key { min-width: 0; max-width: 420px; }
.head-tag { margin-left: 4px; }
.block-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; }
.block-head h3 { margin: 0; font-size: 15px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.kpi-card :deep(.el-card__body) { padding: 14px 16px; }
.kpi-label { color: var(--el-text-color-secondary); font-size: 12px; }
.kpi-value { font-size: 22px; font-weight: 600; margin-top: 4px; }
.kpi-delta { color: var(--el-text-color-secondary); font-size: 12px; margin-top: 4px; }
.value-primary { color: var(--el-color-primary); }
.value-success { color: var(--el-color-success); }
.value-danger { color: var(--el-color-danger); }
.value-purple { color: #9254de; }
.winner-name { font-weight: 600; color: var(--el-color-success); }
.row-tag { margin-left: 6px; }
.diff-pos { color: var(--el-color-success); }
.diff-neg { color: var(--el-color-danger); }
.drift-list { display: flex; flex-direction: column; gap: 10px; }
.drift-row { display: flex; align-items: center; gap: 12px; }
.drift-name { width: 140px; flex-shrink: 0; }
.drift-bars { flex: 1; display: flex; flex-direction: column; gap: 4px; }
.bar-track { position: relative; height: 16px; background: var(--el-fill-color-light); border-radius: 4px; overflow: hidden; }
.bar { height: 100%; border-radius: 4px; min-width: 2px; }
.bar-config { background: var(--el-color-info-light-3); }
.bar-actual { background: var(--el-color-primary-light-5); }
.bar-drift { background: var(--el-color-warning-light-3); }
.bar-label { position: absolute; left: 8px; top: 0; line-height: 16px; font-size: 10px; color: var(--el-text-color-secondary); }
.snippet { margin: 0; padding: 14px; background: var(--el-fill-color-darker, #1e1e1e); color: #d4d4d4; border-radius: 6px; font-size: 12px; line-height: 1.6; overflow-x: auto; }
</style>
