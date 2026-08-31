<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useRouter } from 'vue-router'
import { api, normalizePageResponse, pageLoading } from '../../../dashboard.js'

const router = useRouter()
const activeTab = ref('apps')
const applications = ref([])
const loading = ref(false)
const loadError = ref('')
const dialogOpen = ref(false)
const saving = ref(false)
const form = reactive({ name: '', platform: 'web', endpoint: '', description: '' })
const ingest = reactive({ errors: true, sampleRate: 100, batchSize: 30, flushInterval: 60000, replay: false })
const rules = reactive({ regression: true, highErrorRate: true, slowPage: false })

const activeLabel = computed(() => ({ apps: '项目管理', ingest: '采样与上报', alerts: '告警规则', members: '成员权限', retention: '数据留存' })[activeTab.value])

function normalize(row = {}) {
  return {
    ...row,
    id: row.id || row.app_id || row.appId || row.name,
    name: row.name || row.appName || row.app_id || row.appId || '-',
    appKey: row.app_key || row.appKey || row.app_id || row.appId || '-',
    enabled: row.enabled !== false,
    events: Number(row.events || row.event_count || 0)
  }
}

async function load() {
  loading.value = true
  loadError.value = ''
  pageLoading.value = true
  try {
    const data = await api('/api/applications', { requestKey: 'settings:applications' })
    applications.value = normalizePageResponse(data).items.map(normalize)
  } catch (error) {
    if (error?.code !== 'ABORT_ERR') {
      applications.value = []
      loadError.value = error.message || '应用列表加载失败'
    }
  } finally {
    loading.value = false
    pageLoading.value = false
  }
}

function openCreate() {
  Object.assign(form, { name: '', platform: 'web', endpoint: '', description: '' })
  dialogOpen.value = true
}

async function createApplication() {
  if (!form.name.trim()) {
    ElMessage.warning('请填写应用名称')
    return
  }
  saving.value = true
  try {
    await api('/api/applications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: form.name.trim(), platform: form.platform, endpoint: form.endpoint.trim(), description: form.description.trim() })
    })
    dialogOpen.value = false
    ElMessage.success('应用已创建')
    await load()
  } catch (error) {
    ElMessage.error(error.message || '应用创建失败')
  } finally {
    saving.value = false
  }
}

function configure(row) {
  router.push({ path: '/governance', query: { appId: row.id || row.appKey } })
}

function saveIngest() {
  ElMessage.success(`${activeLabel.value}设置已保存`)
}

onMounted(load)
</script>

<template>
  <div class="settings-layout">
    <el-tabs v-model="activeTab" tab-position="left" class="settings-tabs">
      <el-tab-pane label="项目管理" name="apps" />
      <el-tab-pane label="采样与上报" name="ingest" />
      <el-tab-pane label="告警规则" name="alerts" />
      <el-tab-pane label="成员权限" name="members" />
      <el-tab-pane label="数据留存" name="retention" />
    </el-tabs>

    <div class="settings-content">

  <template v-if="activeTab === 'apps'">
    <el-card shadow="never" class="panel section">
      <template #header>
        <div class="panel-head"><div><h2>应用管理</h2><small>管理接入项目与 SDK Key</small></div><el-button type="primary" @click="openCreate">新建应用</el-button></div>
      </template>
      <el-alert v-if="loadError" class="table-error" type="error" :title="loadError" :closable="false" show-icon><template #default><el-button link type="primary" @click="load">重试</el-button></template></el-alert>
      <el-table :data="applications" v-loading="loading" empty-text="暂无应用数据">
        <el-table-column prop="name" label="应用名称" min-width="220" />
        <el-table-column prop="appKey" label="SDK Key" min-width="220" />
        <el-table-column label="状态" width="110"><template #default="{ row }"><el-tag class="status-tag" :type="row.enabled ? 'success' : 'info'" effect="plain">{{ row.enabled ? '启用' : '暂停' }}</el-tag></template></el-table-column>
        <el-table-column label="今日事件" width="130"><template #default="{ row }">{{ row.events.toLocaleString() }}</template></el-table-column>
        <el-table-column label="操作" width="120"><template #default="{ row }"><el-button link type="primary" @click="configure(row)">配置</el-button></template></el-table-column>
      </el-table>
    </el-card>
  </template>

  <template v-else-if="activeTab === 'ingest'">
    <el-card shadow="never" class="panel settings-form-card section">
      <template #header><div class="panel-head"><div><h2>采样与上报</h2><small>控制采集成本与数据完整性</small></div><el-button type="primary" @click="saveIngest">保存设置</el-button></div></template>
      <el-form label-position="top" class="settings-form">
        <el-form-item label="错误全量上报">
          <div class="ingest-row">
            <el-switch v-model="ingest.errors" />
            <small class="hint">关闭后将按采样率上报，避免高频噪音淹没关键错误</small>
          </div>
        </el-form-item>
        <el-form-item label="性能数据采样率">
          <div class="ingest-row">
            <el-input-number v-model="ingest.sampleRate" :min="0" :max="100" />
            <span class="field-suffix">%</span>
            <small class="hint">按百分比采样 Web Vitals 与资源加载</small>
          </div>
        </el-form-item>
        <el-form-item label="批量上报大小（batchSize）">
          <div class="ingest-row">
            <el-input-number v-model="ingest.batchSize" :min="1" :max="200" />
            <small class="hint">达到该条数立即 flush 上报</small>
          </div>
        </el-form-item>
        <el-form-item label="上报间隔（flushInterval）">
          <div class="ingest-row">
            <el-input-number v-model="ingest.flushInterval" :min="1000" :step="1000" />
            <span class="field-suffix">ms</span>
            <small class="hint">当前 {{ Math.round(ingest.flushInterval / 1000) }}s，抑制碎片化小批量</small>
          </div>
        </el-form-item>
        <el-form-item label="会话回放录制">
          <div class="ingest-row">
            <el-switch v-model="ingest.replay" />
            <small class="hint">录制用户操作用于排障（请遵守合规与脱敏策略）</small>
          </div>
        </el-form-item>
      </el-form>
    </el-card>
  </template>

  <template v-else-if="activeTab === 'alerts'">
    <el-card shadow="never" class="panel settings-form-card section">
      <template #header><div class="panel-head"><div><h2>告警规则</h2><small>定义需要关注的回归与异常阈值</small></div><el-button type="primary" @click="saveIngest">保存设置</el-button></div></template>
      <el-form label-position="top" class="settings-form">
        <el-form-item label="错误回归"><el-switch v-model="rules.regression" /><small>检测已解决问题再次出现</small></el-form-item>
        <el-form-item label="错误率异常"><el-switch v-model="rules.highErrorRate" /><small>错误率超过基线时通知</small></el-form-item>
        <el-form-item label="页面加载变慢"><el-switch v-model="rules.slowPage" /><small>Core Web Vitals P95 超过阈值时通知</small></el-form-item>
      </el-form>
    </el-card>
  </template>

  <template v-else>
    <el-card shadow="never" class="panel settings-placeholder section">
      <el-empty :description="`${activeLabel}功能即将开放`" />
    </el-card>
  </template>

    </div>
  </div>

  <el-dialog v-model="dialogOpen" title="新建应用" width="min(560px, calc(100vw - 32px))" destroy-on-close>
    <el-form label-position="top" class="settings-form">
      <el-form-item label="应用名称" required><el-input v-model="form.name" placeholder="例如：螃蟹交易平台" /></el-form-item>
      <el-form-item label="平台"><el-select v-model="form.platform"><el-option label="Web（H5）" value="web" /><el-option label="微信小程序" value="miniprogram" /><el-option label="React Native" value="react-native" /><el-option label="uni-app" value="uni-app" /><el-option label="Taro" value="taro" /></el-select></el-form-item>
      <el-form-item label="上报域名"><el-input v-model="form.endpoint" placeholder="https://collect.example.com" /></el-form-item>
      <el-form-item label="描述"><el-input v-model="form.description" type="textarea" :rows="3" /></el-form-item>
    </el-form>
    <template #footer><el-button @click="dialogOpen = false">取消</el-button><el-button type="primary" :loading="saving" @click="createApplication">创建应用</el-button></template>
  </el-dialog>
</template>

<style scoped>
.settings-layout { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 20px; align-items: start; }
.settings-tabs { min-width: 0; }
.settings-tabs :deep(.el-tabs__header.is-left) { width: 100%; margin-right: 0; }
.settings-tabs :deep(.el-tabs__nav-wrap.is-left::after) { display: none; }
.settings-tabs :deep(.el-tabs__active-bar.is-left) { display: none; }
.settings-tabs :deep(.el-tabs__item.is-left) { justify-content: flex-start; height: 40px; padding: 0 12px; color: var(--c-text-muted); border-radius: 8px; }
.settings-tabs :deep(.el-tabs__item.is-left:hover) { color: var(--c-text); background: var(--c-surface-3); }
.settings-tabs :deep(.el-tabs__item.is-left.is-active) { color: var(--c-primary); font-weight: 600; background: var(--c-primary-soft); }
.settings-tabs :deep(.el-tabs__content) { display: none; }
.settings-content { min-width: 0; }
.settings-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 24px; }
.settings-form .el-form-item { position: relative; margin-bottom: 20px; }
.settings-form .el-form-item small { display: block; margin-top: 6px; line-height: 1.45; }
.settings-form .el-select { width: 100%; }
.field-suffix { margin-left: 0; color: var(--c-text-muted); white-space: nowrap; }
.ingest-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.ingest-row .hint { color: var(--c-text-muted); font-size: 12px; line-height: 1.5; flex: 1 1 auto; min-width: 160px; }
.status-tag { max-width: none !important; overflow: visible !important; }
.status-tag :deep(.el-tag__content) { overflow: visible !important; white-space: nowrap; }
.settings-placeholder { min-height: 280px; display: grid; place-items: center; }
@media (max-width: 900px) { .settings-layout { grid-template-columns: 150px minmax(0, 1fr); gap: 14px; } }
@media (max-width: 720px) {
  .settings-layout { grid-template-columns: 1fr; }
  .settings-tabs :deep(.el-tabs__nav) { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; }
  .settings-tabs :deep(.el-tabs__item.is-left) { justify-content: center; }
  .settings-form { grid-template-columns: 1fr; }
}
</style>
