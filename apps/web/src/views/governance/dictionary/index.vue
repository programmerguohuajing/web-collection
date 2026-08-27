<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api, pageLoading, queryFromFilters, toList } from '../../../dashboard.js'
import { useFilterStore } from '../../../stores/filters.js'

const store = useFilterStore()
const loading = ref(false)
const loadError = ref('')
const items = ref([])
const pager = reactive({ page: 1, pageSize: 20, total: 0 })
const toolbar = reactive({ q: '', health: '', source: '' })

const HEALTH_OPTIONS = [
  { value: '', label: '全部健康' },
  { value: 'healthy', label: '🟢 健康' },
  { value: 'fluctuating', label: '🟡 波动' },
  { value: 'incomplete', label: '🟠 字段缺失' },
  { value: 'stalled', label: '🔴 停滞' }
]
const SOURCE_OPTIONS = [
  { value: '', label: '全部来源' },
  { value: 'auto', label: '自动采集' },
  { value: 'manual', label: '手动埋点' }
]
const unregisteredCount = ref(0)

// ---------------- 详情抽屉 ----------------
const drawer = ref(false)
const detail = ref(null)
const detailLoading = ref(false)
// 登记含义对话框
const registerDialog = ref(false)
const registerForm = reactive({ name: '', description: '', owner: '', tags: '' })

async function load() {
  loading.value = true
  loadError.value = ''
  pageLoading.value = true
  try {
    const params = new URLSearchParams(queryFromFilters({ page: pager.page, pageSize: pager.pageSize }, ['appId', 'release', 'startTime', 'endTime']))
    if (toolbar.q) params.set('q', toolbar.q.trim())
    if (toolbar.health) params.set('health', toolbar.health)
    if (toolbar.source) params.set('source', toolbar.source)
    const data = await api(`/api/events/dictionary?${params}`, { requestKey: 'dictionary:list' })
    items.value = Array.isArray(data?.items) ? data.items : toList(data)
    pager.total = Number(data?.total || items.value.length)
    unregisteredCount.value = Number(data?.unregisteredCount || 0)
  } catch (error) {
    if (error?.code !== 'ABORT_ERR') {
      loadError.value = error.message || '事件字典加载失败'
      items.value = []
      pager.total = 0
    }
  } finally {
    loading.value = false
    pageLoading.value = false
  }
}

function onSearch() { pager.page = 1; void load() }

function openRegister(name = '') {
  Object.assign(registerForm, { name, description: '', owner: '', tags: '' })
  registerDialog.value = true
}

function sourceLabel(value) {
  return value === 'auto' ? '自动采集' : '手动埋点'
}
function formatTime(ts) {
  if (!ts) return '-'
  const diff = Date.now() - Number(ts)
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return `${Math.floor(diff / 86400000)} 天前`
}

async function openDetail(row) {
  drawer.value = true
  detailLoading.value = true
  detail.value = null
  try {
    const params = new URLSearchParams()
    if (store.appId) params.set('appId', store.appId)
    detail.value = await api(`/api/events/dictionary/${encodeURIComponent(row.name)}?${params}`, { requestKey: `dictionary:${row.name}` })
    Object.assign(registerForm, {
      name: row.name,
      description: detail.value.description || '',
      owner: detail.value.owner || '',
      tags: (detail.value.tags || []).join(',')
    })
  } catch (error) {
    ElMessage.error(error.message || '事件详情加载失败')
    drawer.value = false
  } finally {
    detailLoading.value = false
  }
}

async function submitRegister() {
  try {
    await api(`/api/events/dictionary/${encodeURIComponent(registerForm.name)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        description: registerForm.description,
        owner: registerForm.owner,
        tags: registerForm.tags.split(/[,，]/).map(item => item.trim()).filter(Boolean)
      })
    })
    registerDialog.value = false
    ElMessage.success('事件含义已登记')
    drawer.value = false
    await load()
  } catch (error) {
    ElMessage.error(error.message || '登记失败')
  }
}

const maxTrend = () => Math.max(1, ...(detail.value?.trend || []).map(item => item.count))
function trendStyle(count) {
  return { height: `${Math.max(3, Math.round(Number(count) / maxTrend() * 100))}%`, background: 'var(--c-primary-light-5)' }
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-heading">
      <div>
        <h1>事件字典</h1>
        <p>自动发现并登记所有线上事件，形成可检索字典；每个事件给出可解释的健康判定，并作为 AI 知识源。</p>
      </div>
      <el-button type="primary" @click="openRegister()">＋ 登记含义</el-button>
    </div>

    <div class="caliber-note">
      <span class="ci">◈</span>
      <div><b>口径</b>：统计基于 events 表按事件名聚合（近 7 日窗口）。健康规则优先级：<b>🔴 停滞 &gt; 🟠 字段缺失 &lt;95% &gt; 🟡 波动 ±50% &gt; 🟢 健康</b>；字段完整率为最近 ≤200 条样本统计。规则常量 M1 写死。</div>
    </div>

    <el-card shadow="never" class="section panel">
      <div class="dict-toolbar">
        <el-input v-model="toolbar.q" placeholder="搜索事件名…" clearable style="width: 240px" @keyup.enter="onSearch" @clear="onSearch" />
        <el-select v-model="toolbar.source" style="width: 130px" @change="onSearch">
          <el-option v-for="item in SOURCE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
        <el-select v-model="toolbar.health" style="width: 140px" @change="onSearch">
          <el-option v-for="item in HEALTH_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
        <el-button type="primary" plain @click="onSearch">查询</el-button>
        <div style="flex: 1" />
        <span v-if="unregisteredCount > 0" class="health stalled"><span class="dot" />未登记 {{ unregisteredCount }} 项</span>
      </div>

      <el-alert v-if="loadError" type="error" :title="loadError" show-icon :closable="false" style="margin-bottom: 10px">
        <template #default><el-button link type="primary" @click="load">重试</el-button></template>
      </el-alert>

      <el-table :data="items" border v-loading="loading" empty-text="暂无事件数据" row-class-name="dict-row" @row-click="openDetail">
        <el-table-column label="事件名" min-width="220">
          <template #default="{ row }">
            <b>{{ row.name }}</b>
            <el-tag v-if="!row.registered" type="danger" size="small" style="margin-left: 6px">未登记</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="来源" width="100">
          <template #default="{ row }">{{ sourceLabel(row.source) }}</template>
        </el-table-column>
        <el-table-column prop="type" label="触发类型" width="110" />
        <el-table-column label="近 7 日上报量" width="150" align="right">
          <template #default="{ row }">{{ Number(row.count7d || 0).toLocaleString() }}</template>
        </el-table-column>
        <el-table-column label="近 24h" width="110" align="right">
          <template #default="{ row }">{{ Number(row.count24h || 0).toLocaleString() }}</template>
        </el-table-column>
        <el-table-column label="最近上报" width="120">
          <template #default="{ row }">{{ formatTime(row.lastSeenAt) }}</template>
        </el-table-column>
        <el-table-column label="字段完整率" width="130" align="right">
          <template #default="{ row }">
            <span v-if="row.fieldCompleteness">{{ Math.round((row.fieldCompleteness.overall ?? 0) * 100) }}%</span>
            <span v-else>—</span>
          </template>
        </el-table-column>
        <el-table-column label="健康" width="140">
          <template #default="{ row }">
            <span class="health" :class="row.health"><span class="dot" />{{ ({ healthy: '🟢 健康', fluctuating: '🟡 波动', incomplete: '🟠 字段缺失', stalled: '🔴 停滞' })[row.health] || row.health }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="verdict" label="判定" min-width="200" show-overflow-tooltip />
      </el-table>
      <el-pagination class="pager" background layout="sizes, prev, pager, next, total" :current-page="pager.page" :page-size="pager.pageSize" :page-sizes="[20, 50, 100]" :total="pager.total" @current-change="value => { pager.page = value; load() }" @size-change="value => { pager.page = 1; pager.pageSize = value; load() }" />
    </el-card>

    <!-- 详情抽屉 -->
    <el-drawer v-model="drawer" :title="`事件详情 · ${detail?.name || ''}`" size="480px">
      <div v-loading="detailLoading">
        <template v-if="detail">
          <div class="kv">
            <div class="row"><span class="k">首次上报</span><span class="v">{{ detail.firstSeenAt ? new Date(detail.firstSeenAt).toLocaleDateString() : '-' }}</span></div>
            <div class="row"><span class="k">负责人</span><span class="v">{{ detail.owner || '未登记' }}</span></div>
            <div class="row"><span class="k">说明</span><span class="v">{{ detail.description || '未登记' }}</span></div>
          </div>

          <div style="margin: 16px 0 6px; font-size: 13px; font-weight: 650">近 30 天趋势</div>
          <div class="trend-bars">
            <i v-for="(point, index) in detail.trend" :key="index" :style="trendStyle(point.count)" :title="`${point.day}: ${point.count}`" />
          </div>

          <div v-if="detail.errors?.length" style="margin: 16px 0 6px; font-size: 13px; font-weight: 650">关联错误 Top3</div>
          <div v-for="item in detail.errors" :key="item.label" class="dist-bar">
            <span class="db-label" :title="item.label">{{ item.label }}</span>
            <div class="db-track"><div class="db-fill" :style="{ width: `${Math.round(item.count / Math.max(...detail.errors.map(x => x.count)) * 100)}%` }" /></div>
            <span class="db-val">{{ item.count }}</span>
          </div>

          <div style="margin: 16px 0 6px; font-size: 13px; font-weight: 650">样例事件</div>
          <pre v-for="(sample, index) in detail.samples.slice(0, 2)" :key="index" class="kv-json" style="margin-bottom: 8px">{{ JSON.stringify({ ts: sample.ts, path: sample.path, props: sample.props, context: sample.context }, null, 2) }}</pre>

          <div class="node-jumps">
            <el-button size="small" type="primary" @click="openRegister(detail.name)">登记含义</el-button>
            <el-button size="small" @click="drawer = false">关闭</el-button>
          </div>
        </template>
      </div>
    </el-drawer>

    <!-- 登记含义 -->
    <el-dialog v-model="registerDialog" title="登记事件含义" width="480px">
      <el-form label-width="80px">
        <el-form-item label="事件名"><el-input v-model="registerForm.name" placeholder="如 trade_order_completed" /></el-form-item>
        <el-form-item label="含义说明"><el-input v-model="registerForm.description" type="textarea" :rows="3" placeholder="该事件在什么时机由什么行为触发" /></el-form-item>
        <el-form-item label="负责人"><el-input v-model="registerForm.owner" placeholder="如 产品·李" /></el-form-item>
        <el-form-item label="标签"><el-input v-model="registerForm.tags" placeholder="逗号分隔，如 交易,核心" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="registerDialog = false">取消</el-button>
        <el-button type="primary" @click="submitRegister">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.dict-toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.trend-bars { display: flex; gap: 4px; align-items: flex-end; height: 90px; }
.trend-bars i { flex: 1; min-height: 3px; border-radius: 3px 3px 0 0; transition: height 200ms ease; }
:deep(.dict-row) { cursor: pointer; }
</style>
