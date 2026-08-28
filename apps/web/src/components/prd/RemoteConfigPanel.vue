<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../dashboard.js'

// ---------------- 编辑器状态 ----------------
const activeTab = ref('edit')
// versionKind: 'sdk' 约束 SDK 包版本（sdkVersionMax）；'app' 约束应用 release 版本（appVersionMax）
const scopeForm = reactive({ mode: 'global', appId: '', versionKind: 'sdk', sdkVersionMax: '', appVersionMax: '' })
const configForm = reactive({
  masterSwitch: true,
  sampling: { error: 100, performance: 10, replay: 5, behavior: 100 },
  blockedEventsText: '',
  plugins: { performance: true, error: true, replay: true, behavior: true, exposure: true, trace: true },
  rateLimit: 500
})
const saving = ref(false)
const previewHit = ref(null)

const PLUGIN_ROWS = [
  { key: 'performance', label: 'performance', hint: '' },
  { key: 'error', label: 'error', hint: '' },
  { key: 'replay', label: 'replay', hint: '低端机关闭场景' },
  { key: 'behavior', label: 'behavior', hint: '' },
  { key: 'exposure', label: 'exposure / trace', hint: '' }
]
const SAMPLING_ROWS = [
  { key: 'error', label: '采样率 · 错误' },
  { key: 'performance', label: '采样率 · 性能' },
  { key: 'replay', label: '采样率 · 回放' },
  { key: 'behavior', label: '采样率 · 行为' }
]

async function loadPreview() {
  try {
    const params = new URLSearchParams()
    if (scopeForm.mode === 'app' && scopeForm.appId) params.set('appId', scopeForm.appId)
    if (scopeForm.mode === 'version') {
      if (scopeForm.appId) params.set('appId', scopeForm.appId)
      if (scopeForm.versionKind === 'sdk') {
        if (scopeForm.sdkVersionMax) params.set('sdkVersion', scopeForm.sdkVersionMax)
      } else if (scopeForm.appVersionMax) params.set('appVersion', scopeForm.appVersionMax)
    }
    previewHit.value = await api(`/api/collect-config?${params}`, { requestKey: 'rc:preview' })
  } catch { previewHit.value = null }
}

function fillFromConfig(config) {
  configForm.masterSwitch = (config?.master_switch ?? 'on') !== 'off'
  const rates = config?.sampling || {}
  for (const row of SAMPLING_ROWS) {
    const value = Number(rates[row.key])
    if (Number.isFinite(value)) configForm.sampling[row.key] = Math.round(value * 1000) / 10
  }
  const blocked = config?.blocked_events || []
  configForm.blockedEventsText = blocked.join(', ')
  const plugins = { ...configForm.plugins, ...(config?.plugins || {}) }
  for (const key of Object.keys(plugins)) plugins[key] = plugins[key] !== false
  Object.assign(configForm.plugins, plugins)
  const limit = Number(config?.rate_limits?.per_event_per_user_10min)
  if (Number.isFinite(limit) && limit > 0) configForm.rateLimit = limit
}

function onScopeChange() {
  void loadPreview()
  // 切范围时回填该范围当前生效值作为编辑基线
  if (previewHit.value?.matched && previewHit.value?.config) fillFromConfig(previewHit.value.config)
}

/** 更具体配置冲突提示（FR：最具体者生效，冲突高亮） */
const conflictNote = computed(() => {
  if (!previewHit.value?.matched || !previewHit.value?.scope) return ''
  const scope = previewHit.value.scope
  const bits = []
  if (scope.sdkVersionMax) bits.push(`SDK 版本区间 ≤${scope.sdkVersionMax}`)
  if (scope.appVersionMax) bits.push(`应用版本区间 ≤${scope.appVersionMax}`)
  if (scope.appId) bits.push(scope.appId)
  if (!bits.length) return ''
  return `⚠ 该范围将被「${bits.join(' / ')}」的更具体配置覆盖；保存前请确认命中预期（可用「命中查询」验证）。`
})

async function queryHit() {
  await loadPreview()
  if (previewHit.value?.matched) {
    fillFromConfig(previewHit.value.config)
    ElMessage.success(`命中 config_version ${previewHit.value.configVersion || '-'}，已回填当前生效值`)
  } else {
    ElMessage.info('该范围无自定义配置，将使用内置默认全开')
  }
}

async function saveConfig() {
  if (scopeForm.mode === 'app' && !scopeForm.appId.trim()) return ElMessage.warning('应用模式下请填写 App ID')
  if (scopeForm.mode === 'version') {
    const ceiling = scopeForm.versionKind === 'sdk' ? scopeForm.sdkVersionMax : scopeForm.appVersionMax
    if (!String(ceiling || '').trim()) return ElMessage.warning('版本区间模式请填写版本上界')
  }
  if (!configForm.masterSwitch) {
    try {
      await ElMessageBox.prompt('采集总开关关闭将大幅影响观测能力。请输入「确认关闭」以继续：', '高危操作确认', {
        confirmButtonText: '确认关闭',
        cancelButtonText: '取消',
        inputPattern: /^确认关闭$/,
        inputErrorMessage: '请输入「确认关闭」'
      })
    } catch { return }
  }
  let blocked = String(configForm.blockedEventsText || '').split(/[,，\n]/).map(item => item.trim()).filter(Boolean)
  blocked = [...new Set(blocked)]
  const payload = {
    scope: scopeForm.mode === 'global' ? {} : {
      ...(scopeForm.appId.trim() ? { appId: scopeForm.appId.trim() } : {}),
      ...(scopeForm.mode === 'version'
        ? (scopeForm.versionKind === 'sdk'
          ? { sdkVersionMax: scopeForm.sdkVersionMax.trim() }
          : { appVersionMax: scopeForm.appVersionMax.trim() })
        : {})
    },
    config: {
      masterSwitch: configForm.masterSwitch ? 'on' : 'off',
      sampling: Object.fromEntries(Object.entries(configForm.sampling).map(([key, value]) => [key, Math.max(0, Math.min(100, Number(value))) / 100])),
      blockedEvents: blocked,
      plugins: { ...configForm.plugins },
      rateLimits: { per_event_per_user_10min: Math.max(1, Math.floor(Number(configForm.rateLimit) || 500)) }
    },
    operator: 'admin'
  }
  saving.value = true
  try {
    const result = await api('/api/collect-config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    ElMessage.success(`配置已保存，新 config_version = ${result?.configVersion}`)
    await Promise.all([loadHistory(), loadStats(), loadPreview()])
  } catch (error) {
    ElMessage.error(error.message || '配置保存失败')
  } finally {
    saving.value = false
  }
}

// ---------------- 变更历史 ----------------
const history = ref([])
async function loadHistory() {
  try {
    const data = await api('/api/collect-config/history', { requestKey: 'rc:history' })
    history.value = Array.isArray(data) ? data : []
  } catch { history.value = [] }
}
function scopeLabel(scope) {
  if (!scope || !Object.keys(scope).length) return '全局'
  const bits = []
  if (scope.appId) bits.push(scope.appId)
  if (scope.platform) bits.push(scope.platform)
  if (scope.sdkVersionMax) bits.push(`SDK≤${scope.sdkVersionMax}`)
  if (scope.appVersionMax) bits.push(`App≤${scope.appVersionMax}`)
  return bits.join(' / ') || '全局'
}
async function rollback(item) {
  const confirmed = await ElMessageBox.confirm(`回滚到历史 #${item.id}（${item.action} · ${scopeLabel(item.scope)}）？将生成一条新配置。`, '回滚确认', { type: 'warning' }).then(() => true).catch(() => false)
  if (!confirmed) return
  try {
    const result = await api('/api/collect-config/rollback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ historyId: item.id, operator: 'admin' }) })
    ElMessage.success(`已回滚，新 config_version = ${result?.configVersion}`)
    await Promise.all([loadHistory(), loadStats()])
  } catch (error) {
    ElMessage.error(error.message || '回滚失败')
  }
}
const ACTION_ICONS = { create: '✅', update: '🔧', rollback: '↺' }

// ---------------- 命中统计 ----------------
const stats = ref(null)
async function loadStats() {
  try { stats.value = await api('/api/collect-config/stats', { requestKey: 'rc:stats' }) } catch { stats.value = null }
}
const maxDistSessions = () => Math.max(1, ...(stats.value?.distribution || []).map(row => row.sessions))

onMounted(async () => {
  await Promise.all([loadPreview(), loadHistory(), loadStats()])
})
</script>

<template>
  <div>
    <div class="caliber-note">
      <span class="ci">◈</span>
      <div><b>失效安全</b>：SDK 启动 + 每 5 分钟拉取 <code>GET /sdk-config</code>（ETag 304 免传输）。拉取失败/超时 3s/响应非法 → 沿用上次；从未拉到 → 内置默认全开。<b>绝不因配置系统故障停采。</b></div>
    </div>

    <el-card shadow="never" class="section panel">
      <el-tabs v-model="activeTab">
        <!-- 配置编辑器 -->
        <el-tab-pane label="配置编辑器" name="edit">
          <div class="cfg-scope">
            <el-select v-model="scopeForm.mode" style="width: 170px" @change="onScopeChange">
              <el-option label="全局默认" value="global" />
              <el-option label="指定应用" value="app" />
              <el-option label="版本区间 ≤" value="version" />
            </el-select>
            <el-input v-if="scopeForm.mode !== 'global'" v-model="scopeForm.appId" placeholder="App ID（可留空=全部应用）" style="width: 200px" @change="onScopeChange" />
            <!-- SDK 版本 = SDK 包自身版本；应用版本 = 接入方业务的 release 版本，二者独立维度 -->
            <template v-if="scopeForm.mode === 'version'">
              <el-select v-model="scopeForm.versionKind" style="width: 150px" @change="onScopeChange">
                <el-option label="SDK 版本 ≤" value="sdk" />
                <el-option label="应用版本 ≤" value="app" />
              </el-select>
              <el-input v-if="scopeForm.versionKind === 'sdk'" v-model="scopeForm.sdkVersionMax" placeholder="SDK 版本上界，如 0.3.0" style="width: 200px" @change="onScopeChange" />
              <el-input v-else v-model="scopeForm.appVersionMax" placeholder="应用 release 上界，如 1.2.0" style="width: 200px" @change="onScopeChange" />
            </template>
            <el-tag type="info" size="small">最具体者生效：版本区间 &gt; 应用 &gt; 全局</el-tag>
            <el-tooltip content="SDK 版本 = SDK 包自身版本（0.3.0），随依赖升级变化；应用版本 = 你业务的 release（1.2.0），由 createEys({ release }) 上报。二者独立。" placement="top">
              <el-tag type="warning" size="small" style="cursor: help">两个版本维度？</el-tag>
            </el-tooltip>
            <el-button size="small" @click="queryHit">命中查询</el-button>
          </div>
          <div v-if="conflictNote" class="conflict-note">{{ conflictNote }}</div>

          <div class="cfg-block">
            <h4>🔴 L3 · 采集总开关与采样</h4>
            <div class="cfg-row">
              <span class="cr-k">采集总开关<small>off 时仅错误事件保留止血通道</small></span>
              <el-switch v-model="configForm.masterSwitch" />
            </div>
            <div v-for="row in SAMPLING_ROWS" :key="row.key" class="cfg-row">
              <span class="cr-k">{{ row.label }}</span>
              <el-input-number v-model="configForm.sampling[row.key]" :min="0" :max="100" :step="5" size="small" style="width: 130px" />
            </div>
          </div>

          <div class="cfg-block">
            <h4>⛔ L1 · 事件拉黑（采样前精确匹配丢弃）</h4>
            <div class="cfg-row">
              <span class="cr-k">blocked_events<small>事件名列表，逗号分隔</small></span>
              <el-input v-model="configForm.blockedEventsText" placeholder='如 content_exposed, debug_trace' style="max-width: 320px" />
            </div>
          </div>

          <div class="cfg-block">
            <h4>🧩 L2 · 插件开关（热生效）</h4>
            <div v-for="row in PLUGIN_ROWS" :key="row.key" class="cfg-row">
              <span class="cr-k">{{ row.label }}<small v-if="row.hint">{{ row.hint }}</small></span>
              <el-switch v-model="configForm.plugins[row.key]" />
            </div>
          </div>

          <div class="cfg-block">
            <h4>🛡 上限保护（SDK 端执行）</h4>
            <div class="cfg-row">
              <span class="cr-k">单设备单类事件 / 10min<small>滑动窗口随页面生命周期重建</small></span>
              <el-input-number v-model="configForm.rateLimit" :min="1" :max="100000" size="small" style="width: 130px" />
            </div>
          </div>

          <el-button type="primary" :loading="saving" @click="saveConfig">保存配置</el-button>
        </el-tab-pane>

        <!-- 变更历史 -->
        <el-tab-pane label="变更历史" name="history">
          <div v-if="history.length" class="history">
            <div v-for="item in history" :key="item.id" class="h-item">
              <div class="h-rail"><div class="h-dot" /><div class="h-line" /></div>
              <div class="h-body">
                <div class="h-top">
                  <span class="h-act">{{ ACTION_ICONS[item.action] || '•' }} {{ item.action }} · {{ scopeLabel(item.scope) }}</span>
                  <span class="h-time">{{ new Date(Number(item.createdAt)).toLocaleString() }} · {{ item.operator }} · v{{ item.id }}</span>
                </div>
                <div v-if="item.diff" class="h-diff">{{ item.diff }}</div>
                <el-button size="small" text type="primary" style="margin-top: 4px" @click="rollback(item)">↺ 回滚到此版</el-button>
              </div>
            </div>
          </div>
          <el-empty v-else description="暂无变更记录" />
        </el-tab-pane>

        <!-- 命中统计 -->
        <el-tab-pane label="命中统计" name="hit">
          <template v-if="stats">
            <div class="prd-kpis">
              <div class="prd-kpi"><span class="k-label">当前 config_version</span><span class="k-value primary">{{ stats.currentVersion }}</span><span class="k-foot">audit 最大 id，单调递增</span></div>
              <div class="prd-kpi"><span class="k-label">自定义配置范围</span><span class="k-value">{{ stats.customScopeCount }}</span><span class="k-foot">非全局 scope 数</span></div>
              <div class="prd-kpi"><span class="k-label">近 24h 活跃会话</span><span class="k-value success">{{ stats.distribution.reduce((sum, row) => sum + Number(row.sessions), 0).toLocaleString() }}</span><span class="k-foot">按上报 config_version 归并</span></div>
              <div class="prd-kpi"><span class="k-label">限流策略</span><span class="k-value">IP 令牌桶</span><span class="k-foot">30 次 / 10s / IP</span></div>
            </div>
            <el-card shadow="never">
              <template #header><b>各版本会话分布（按 SDK 上报的 config_version）</b></template>
              <div v-for="row in stats.distribution" :key="row.version" class="dist-bar">
                <span class="db-label" :title="row.version">{{ row.version }}</span>
                <div class="db-track"><div class="db-fill" :style="{ width: `${Math.round(row.sessions / maxDistSessions() * 100)}%` }" /></div>
                <span class="db-val">{{ Number(row.sessions).toLocaleString() }}</span>
              </div>
              <el-empty v-if="!stats.distribution.length" description="近 24h 无携带 config_version 的事件（旧 SDK 未上报属正常）" :image-size="60" />
            </el-card>
          </template>
          <el-empty v-else description="统计数据加载中或不可用" />
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </div>
</template>

<style scoped>
.cfg-scope { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; }
</style>
