<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { onBeforeRouteLeave } from 'vue-router'
import { Refresh } from '@element-plus/icons-vue'
import { api, pageLoading } from '../../../dashboard.js'

const PROVIDERS = [
  { key: 'local', title: '本地模型 (Ollama)', hint: 'Cloudflare 部署下 local 通道不可达内网地址，仅自托管/本地开发可用' },
  { key: 'domestic', title: '国内模型', hint: '' },
  { key: 'overseas', title: '海外模型', hint: '海外通道发送前自动 PII 脱敏' }
]
const API_FORMATS = [
  { value: 'openai-chat', label: 'OpenAI Chat Completions', baseHint: 'https://api.deepseek.com/v1' },
  { value: 'anthropic-messages', label: 'Anthropic Messages', baseHint: 'https://api.anthropic.com' },
  { value: 'openai-responses', label: 'OpenAI Responses API', baseHint: 'https://api.openai.com/v1' },
  { value: 'gemini-generatecontent', label: 'Gemini generateContent', baseHint: 'https://generativelanguage.googleapis.com' }
]
const ORDER_OPTIONS = [
  { value: 'local', label: '本地' },
  { value: 'domestic', label: '国内' },
  { value: 'overseas', label: '海外' },
  { value: 'workers-ai', label: 'Workers AI' }
]
const WORKERS_AI_MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/qwen/qwen2.5-coder-32b-instruct',
  '@cf/meta/llama-3.1-8b-instruct'
]

function emptyForm() {
  return {
    modelOrder: ['local', 'domestic', 'overseas'],
    modelFallback: true,
    timeoutMs: 30000,
    workersAiModel: WORKERS_AI_MODELS[0],
    providers: Object.fromEntries(PROVIDERS.map(p => [p.key, { baseUrl: '', modelName: '', apiFormat: 'openai-chat', apiKey: '' }]))
  }
}

const aiForm = reactive(emptyForm())
const aiLoading = ref(false)
const aiSaving = ref(false)
const aiTesting = ref(false)
const aiTestResults = ref(null)
const effectiveSource = ref({})
const modelOptions = reactive({ local: [], domestic: [], overseas: [] })
const modelsLoading = reactive({ local: false, domestic: false, overseas: false })
const initialSnapshot = ref('')

const sourceLabels = { db: '数据库配置', env: '环境变量', default: '默认值', none: '未设置' }

function comparable(form) {
  return JSON.stringify({
    modelOrder: [...form.modelOrder].sort(),
    modelFallback: form.modelFallback,
    timeoutMs: form.timeoutMs,
    workersAiModel: form.workersAiModel,
    providers: Object.fromEntries(PROVIDERS.map(({ key }) => {
      const p = form.providers[key]
      return [key, { baseUrl: p.baseUrl.trim(), modelName: p.modelName.trim(), apiFormat: p.apiFormat }]
    }))
  })
}

const aiDirty = computed(() => initialSnapshot.value !== '' && comparable(aiForm) !== initialSnapshot.value)

const timeoutSec = computed({
  get: () => Math.round(aiForm.timeoutMs / 1000),
  set: v => { if (Number.isFinite(v) && v > 0) aiForm.timeoutMs = v * 1000 }
})

const sourceWarnings = computed(() => {
  const out = []
  const src = effectiveSource.value || {}
  if (src.timeoutMs && src.timeoutMs !== 'db') out.push(`超时当前生效值为${sourceLabels[src.timeoutMs]}`)
  if (src.modelOrder === 'env') out.push('路由顺序当前生效值为环境变量')
  return out
})

function fillForm(data = {}) {
  aiForm.modelOrder = String(data.modelOrder || 'local,domestic,overseas').split(',').map(s => s.trim()).filter(Boolean)
  aiForm.modelFallback = data.modelFallback !== false
  aiForm.timeoutMs = Number(data.timeoutMs) > 0 ? Number(data.timeoutMs) : 30000
  aiForm.workersAiModel = data.workersAiModel || WORKERS_AI_MODELS[0]
  for (const { key } of PROVIDERS) {
    const remote = data.providers?.[key] || {}
    aiForm.providers[key].baseUrl = remote.baseUrl || ''
    aiForm.providers[key].modelName = remote.modelName || ''
    aiForm.providers[key].apiFormat = remote.apiFormat || 'openai-chat'
    aiForm.providers[key].apiKey = ''
    // 已存的模型名不在远程列表里也要有对应 option，否则 el-select 重挂载后显示为空
    if (remote.modelName && !modelOptions[key].includes(remote.modelName)) {
      modelOptions[key] = [remote.modelName, ...modelOptions[key]]
    }
  }
  effectiveSource.value = data.effectiveSource || {}
  initialSnapshot.value = comparable(aiForm)
}

async function loadAi() {
  aiLoading.value = true
  pageLoading.value = true
  try {
    fillForm(await api('/api/ai/settings', { requestKey: 'ai-settings:load' }))
  } catch (e) {
    if (e?.code !== 'ABORT_ERR') ElMessage.error(e.message || 'AI 设置加载失败')
  } finally {
    aiLoading.value = false
    pageLoading.value = false
  }
}

async function testAi() {
  aiTesting.value = true
  aiTestResults.value = null
  try {
    const body = JSON.parse(JSON.stringify(aiForm))
    body.modelOrder = body.modelOrder.join(',')
    const data = await api('/api/ai/settings/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    aiTestResults.value = data.results || {}
  } catch (e) {
    ElMessage.error(e.message || '测试请求失败')
  } finally {
    aiTesting.value = false
  }
}

async function saveAi() {
  aiSaving.value = true
  try {
    const body = JSON.parse(JSON.stringify(aiForm))
    body.modelOrder = body.modelOrder.join(',')
    const saved = await api('/api/ai/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    ElMessage.success('AI 配置已保存并即时生效')
    fillForm(saved)
  } catch (e) {
    ElMessage.error(e.message || '保存失败')
  } finally {
    aiSaving.value = false
  }
}

async function fetchModels(key) {
  modelsLoading[key] = true
  try {
    const p = aiForm.providers[key]
    const data = await api('/api/ai/settings/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: key, baseUrl: p.baseUrl.trim(), apiKey: p.apiKey, apiFormat: p.apiFormat })
    })
    if (!data.ok) {
      ElMessage.error(data.error || '获取模型列表失败')
    } else {
      modelOptions[key] = data.models || []
      if (!data.models?.length) ElMessage.warning('上游返回空列表')
    }
  } catch (e) {
    ElMessage.error(e.message || '获取模型列表失败')
  } finally {
    modelsLoading[key] = false
  }
}

onBeforeRouteLeave(async () => {
  if (!aiDirty.value) return true
  try {
    await ElMessageBox.confirm('当前有未保存的修改，确定离开吗？', '提示', { type: 'warning', confirmButtonText: '离开', cancelButtonText: '留下' })
    return true
  } catch {
    return false
  }
})

onMounted(loadAi)
</script>

<template>
  <div class="ai-settings" v-loading="aiLoading">
    <el-alert v-for="(w, i) in sourceWarnings" :key="i" class="section" type="warning" :title="`⚠ ${w}`" :closable="false" show-icon />

    <el-card shadow="never" class="panel section">
      <template #header><div class="panel-head"><div><h2>全局设置</h2><small>路由顺序按选择顺序生效；兜底在全部通道失败后追加 Workers AI</small></div></div></template>
      <el-form label-position="top" class="ai-form">
        <el-form-item label="路由顺序">
          <el-select v-model="aiForm.modelOrder" multiple placeholder="选择顺序即路由顺序">
            <el-option v-for="o in ORDER_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
          <small>当前生效：{{ sourceLabels[effectiveSource.modelOrder] || '-' }}</small>
        </el-form-item>
        <el-form-item label="超时时间" class="timeout-item">
          <div class="inline-row">
            <el-input-number v-model="timeoutSec" :min="5" :max="120" :step="1" />
            <span class="field-suffix">秒</span>
          </div>
          <small>诊断 prompt 较长，建议 ≥15s；&gt;60s 可能触发平台限制（存库为毫秒）</small>
        </el-form-item>
        <el-form-item label="Workers AI 兜底">
          <div class="switch-row">
            <el-switch v-model="aiForm.modelFallback" />
            <small>所有配置通道失败后自动使用 Workers AI（质量较低但保证可用）</small>
          </div>
        </el-form-item>
        <el-form-item label="兜底模型">
          <el-select v-model="aiForm.workersAiModel" filterable allow-create default-first-option>
            <el-option v-for="m in WORKERS_AI_MODELS" :key="m" :label="m" :value="m" />
          </el-select>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card v-for="{ key, title, hint } in PROVIDERS" :key="key" shadow="never" class="panel section provider-card">
      <template #header><div class="panel-head"><div><h2>{{ title }}</h2><small>{{ hint || ' ' }}</small></div></div></template>
      <el-form label-position="top" class="ai-form">
        <el-form-item label="接口格式">
          <el-select v-model="aiForm.providers[key].apiFormat">
            <el-option v-for="f in API_FORMATS" :key="f.value" :label="f.label" :value="f.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="服务地址">
          <el-input v-model="aiForm.providers[key].baseUrl" :placeholder="API_FORMATS.find(f => f.value === aiForm.providers[key].apiFormat)?.baseHint" clearable />
          <small>当前生效：{{ sourceLabels[effectiveSource[`providers.${key}.baseUrl`]] || '-' }}</small>
        </el-form-item>
        <el-form-item label="模型名称">
          <div class="model-row">
            <el-select v-model="aiForm.providers[key].modelName" filterable allow-create default-first-option placeholder="手输或点右侧获取模型">
              <el-option v-for="m in modelOptions[key]" :key="m" :label="m" :value="m" />
            </el-select>
            <el-button :icon="Refresh" :loading="modelsLoading[key]" @click="fetchModels(key)">获取模型</el-button>
          </div>
          <small>当前生效：{{ sourceLabels[effectiveSource[`providers.${key}.modelName`]] || '-' }}</small>
        </el-form-item>
        <el-form-item label="API Key">
          <el-input v-model="aiForm.providers[key].apiKey" type="password" show-password autocomplete="new-password"
            :placeholder="(effectiveSource[`providers.${key}.apiKey`] === 'none') ? '未设置' : '留空保持现有 Key 不变'" />
          <small v-if="effectiveSource[`providers.${key}.apiKey`] !== 'none'">已配置（{{ sourceLabels[effectiveSource[`providers.${key}.apiKey`]] }}），留空则不修改</small>
        </el-form-item>
      </el-form>
    </el-card>

    <div class="actions section">
      <el-button :loading="aiTesting" @click="testAi">测试连接</el-button>
      <el-button type="primary" :loading="aiSaving" :disabled="!aiDirty" @click="saveAi">{{ aiDirty ? '保存配置' : '无改动' }}</el-button>
    </div>

    <div v-if="aiTestResults" class="test-results section">
      <template v-for="(r, name) in aiTestResults" :key="name">
        <el-tag :type="r.ok ? 'success' : 'danger'" effect="plain">
          {{ r.ok ? `✓ ${name} ${r.latencyMs}ms` : `✗ ${name} ${r.error}` }}
        </el-tag>
      </template>
    </div>
  </div>
</template>

<style scoped>
.ai-settings { display: grid; gap: 4px; max-width: 860px; }
.ai-form .el-form-item small { display: block; margin-top: 6px; color: var(--c-text-muted); line-height: 1.45; }
.ai-form .el-select, .ai-form .el-input-number { width: 100%; }
.inline-row { display: flex; align-items: center; gap: 8px; }
.inline-row .el-input-number { width: 140px; flex: none; }
.timeout-item :deep(.el-form-item__content) { flex-wrap: nowrap; align-items: center; gap: 12px; }
.timeout-item small { margin-top: 0 !important; }
.switch-row { display: flex; align-items: center; gap: 12px; }
.switch-row small { margin-top: 0 !important; }
.panel-head h2 { margin: 0; font-size: 16px; }
.panel-head small { color: var(--c-text-muted); }
.model-row { display: flex; gap: 8px; width: 100%; }
.model-row .el-select { flex: 1; width: auto; }
.actions { display: flex; gap: 12px; }
.test-results { display: flex; flex-wrap: wrap; gap: 8px; }
.field-suffix { margin-left: 8px; color: var(--c-text-muted); }
@media (max-width: 720px) { .model-row { flex-direction: column; } }
</style>
