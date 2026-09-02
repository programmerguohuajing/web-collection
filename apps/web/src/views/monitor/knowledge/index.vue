<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Refresh, Plus, Search, Document, Edit, Star, Reading, Warning, UploadFilled
} from '@element-plus/icons-vue'
import { api } from '../../../dashboard.js'
import { useFilterStore } from '../../../stores/filters.js'

const route = useRoute()
const router = useRouter()
const filterStore = useFilterStore()

/* ============ 类型 / 设计令牌 ============ */
const TYPE_META = {
  issue:   { label: 'issue',   color: '#0ea5e9' },
  doc:     { label: 'doc',     color: '#10b981' },
  runbook: { label: 'runbook', color: '#8b5cf6' },
  faq:     { label: 'faq',     color: '#f59e0b' },
  feedback:{ label: 'feedback',color: '#f59e0b' }
}
// 治理台筛选用的来源类型（按 PRD 增加 faq）
const SOURCE_TYPES = ['issue', 'doc', 'runbook', 'faq']

const VIS_LABEL = { public: '公开', internal: '内部' }
const STATUS_LABEL = { published: '已发布', draft: '草稿', archived: '已下线' }

/* ============ 角色（仅演示「去 AI_API_KEY 鉴权重做」：浏览免 key，写需管理员） ============ */
const role = ref('admin')
const canWrite = computed(() => role.value === 'admin')

/* ============ 列表状态 ============ */
const state = reactive({
  loading: false,
  error: '',
  items: [],
  total: 0,
  page: 1,
  pageSize: 200,
  filter: 'all',
  vis: 'all',
  status: 'all',
  sort: 'updated',
  search: '',
  stats: { total: 0, byType: {}, latestUpdated: null }
})

/* ============ 统计卡（治理台） ============ */
const statsCards = computed(() => {
  const items = state.items
  const pub = items.filter(i => i.visibility === 'public').length
  const internal = items.filter(i => i.visibility === 'internal').length
  const ai = items.reduce((s, i) => s + (i.quality?.aiCitations || 0), 0)
  return [
    { key: 'total', label: '知识总数', color: '#4f46e5', value: state.stats.total || items.length, meta: '已索引来源（含草稿）' },
    { key: 'public', label: '公开可读', color: '#10b981', value: pub, meta: '帮助中心可见' },
    { key: 'internal', label: '仅内部', color: '#9aa3b2', value: internal, meta: '后台治理' },
    { key: 'ai', label: '被 AI 引用', color: '#f59e0b', value: ai, meta: '诊断命中累计' },
    { key: 'latest', label: '最近更新', color: '#0ea5e9', value: state.stats.latestUpdated ? fmtTime(state.stats.latestUpdated) : '—', meta: '最新一篇' }
  ]
})

/* ============ 数据加载（新端点：/kb/articles 列表 + /kb/search 语义检索） ============ */
function toConsoleItem(r) {
  return {
    id: r.id,
    chunkId: null,
    source_type: r.source_type,
    source_id: r.source_id,
    app: r.app || '-',
    title: r.title || r.source_id,
    excerpt: r.excerpt || String(r.body || '').slice(0, 120),
    updatedAt: Number(r.updatedAt || r.updated_at || 0),
    score: null,
    visibility: r.visibility || 'public',
    status: r.status || 'published',
    version: r.version || 'v1',
    quality: {
      aiCitations: r.quality?.aiCitations ?? r.aiCitations ?? null,
      helpfulRate: r.quality?.helpfulRate ?? r.helpfulRate ?? null,
      feedbackCount: r.quality?.feedbackCount ?? r.feedbackCount ?? 0
    },
    linkedErrors: r.linkedErrors || [],
    body: r.body || null,
    legacy: !!r.legacy
  }
}
function toSearchItem(r) {
  return {
    id: r.source_id,
    chunkId: null,
    source_type: r.source_type,
    source_id: r.source_id,
    app: r.app_id || r.app || '-',
    title: r.metadata?.title || r.source_id,
    excerpt: String(r.text || '').slice(0, 120),
    updatedAt: Number(r.updated_at || 0),
    score: r.score ?? null,
    visibility: r.visibility || 'public',
    status: r.status || 'published',
    version: 'v1',
    quality: { aiCitations: null, helpfulRate: null, feedbackCount: 0 },
    linkedErrors: [],
    body: null,
    legacy: false
  }
}

let searchTimer = null
function onSearchInput() {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { state.page = 1; load() }, 300)
}

async function load() {
  state.loading = true
  state.error = ''
  try {
    const searching = state.search.trim().length > 0
    if (searching) {
      const data = await api(`/api/ai/kb/search?q=${encodeURIComponent(state.search.trim())}${filterStore.appId ? `&appId=${encodeURIComponent(filterStore.appId)}` : ''}`, { requestKey: 'kb:search' })
      // 同一来源多篇 chunk 命中去重，保留最高相似度
      const bySource = new Map()
      for (const r of (data?.results || [])) {
        const sid = r.source_id
        const prev = bySource.get(sid)
        if (!prev || (r.score ?? 0) > (prev.score ?? 0)) bySource.set(sid, r)
      }
      state.items = [...bySource.values()].map(toSearchItem)
      state.total = state.items.length
    } else {
      const params = new URLSearchParams()
      if (state.filter !== 'all') params.set('type', state.filter)
      if (filterStore.appId) params.set('appScope', filterStore.appId)
      params.set('page', String(state.page))
      params.set('pageSize', String(state.pageSize))
      const data = await api(`/api/ai/kb/articles?${params}`, { requestKey: 'kb:articles' })
      state.items = (data?.items || []).map(toConsoleItem)
      state.total = Number(data?.total ?? state.items.length)
    }
  } catch (e) {
    state.error = e?.message || '知识库加载失败'
  } finally {
    state.loading = false
  }
}

async function loadStats() {
  try {
    const data = await api('/api/ai/kb/stats', { requestKey: 'kb:stats' })
    state.stats = {
      total: Number(data?.total ?? 0),
      byType: data?.byType || {},
      latestUpdated: data?.latestUpdated || null
    }
  } catch { /* 统计失败不阻塞列表 */ }
}

const visibleItems = computed(() => {
  let items = state.items
  if (state.vis !== 'all') items = items.filter(i => i.visibility === state.vis)
  if (state.status !== 'all') items = items.filter(i => i.status === state.status)
  if (state.search.trim() && state.filter !== 'all') items = items.filter(i => i.source_type === state.filter)
  const sorted = [...items]
  if (state.sort === 'ai') sorted.sort((a, b) => (b.quality?.aiCitations || 0) - (a.quality?.aiCitations || 0))
  else if (state.sort === 'type') sorted.sort((a, b) => String(a.source_type).localeCompare(String(b.source_type)))
  else sorted.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  return sorted
})

function setFilter(f) { state.filter = f; state.page = 1; load() }
function setVis(v) { state.vis = v }
function setStatus(s) { state.status = s }
function setSort(s) { state.sort = s }

function fmtTime(ts) {
  if (!ts) return '-'
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return String(ts)
  const d = new Date(n)
  const p = v => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function pct(x) {
  if (x == null) return null
  const n = Number(x)
  if (!Number.isFinite(n)) return null
  return `${Math.round(n * 100)}%`
}

/* ============ 详情抽屉（新端点 /kb/article/:id，含遗留来源合成） ============ */
const drawer = reactive({ open: false, loading: false, error: '', article: null })
const canDelete = computed(() => canWrite.value && !!drawer.article?.source_id)

function toArticleDetail(a) {
  return {
    id: a.id,
    chunkId: a.chunkId || null,
    source_type: a.type,
    source_id: a.id,
    app: a.appScope || '-',
    title: a.title,
    excerpt: String(a.body || '').slice(0, 120),
    updatedAt: Number(a.updatedAt || 0),
    visibility: a.visibility || 'internal',
    status: a.status || 'published',
    version: a.version ? `v${a.version}` : 'v1',
    quality: a.quality || { aiCitations: null, helpfulRate: null, feedbackCount: 0 },
    linkedErrors: a.linkedErrors || [],
    body: a.body || '',
    legacy: !!a.legacy
  }
}
function toChunkArticle(item, chunk) {
  return {
    id: item.id,
    chunkId: chunk?.id || item.chunkId || null,
    source_type: item.source_type || chunk?.source_type,
    source_id: item.source_id || chunk?.source_id,
    app: item.app || chunk?.app_id || '-',
    title: item.title || chunk?.source_id,
    excerpt: String(chunk?.text || '').slice(0, 120),
    updatedAt: Number(chunk?.updated_at || 0),
    visibility: item.visibility || 'public',
    status: item.status || 'published',
    version: item.version || 'v1',
    quality: { aiCitations: null, helpfulRate: null, feedbackCount: 0 },
    linkedErrors: [],
    body: chunk?.text || '',
    legacy: true
  }
}

async function openDetail(item) {
  drawer.open = true
  drawer.loading = true
  drawer.error = ''
  drawer.article = null
  const enc = encodeURIComponent
  try {
    if (item.chunkId) {
      const chunk = await api(`/api/ai/kb/chunk/${enc(item.chunkId)}`, { requestKey: `kb:chunk:${item.chunkId}` })
      drawer.article = toChunkArticle(item, chunk)
    } else if (item.source_id || item.source_type) {
      const id = item.source_id || item.id
      const a = await api(`/api/ai/kb/article/${enc(id)}`, { requestKey: `kb:article:${id}` })
      drawer.article = toArticleDetail(a)
    } else {
      // 纯 chunk drill-down（来自 AI 诊断溯源，仅带 chunk id）
      const chunk = await api(`/api/ai/kb/chunk/${enc(item.id)}`, { requestKey: `kb:chunk:${item.id}` })
      drawer.article = toChunkArticle(item, chunk)
    }
  } catch (e) {
    drawer.error = e?.message || '原文加载失败'
  } finally {
    drawer.loading = false
  }
}

async function deleteSource() {
  const a = drawer.article
  const id = a?.source_id || a?.id
  if (!id || !canWrite.value) return
  try {
    await ElMessageBox.confirm(
      `将删除知识「${id}」的全部原文 chunk、向量索引与质量记录，且不可恢复。确认删除？`,
      '删除该知识',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' }
    )
  } catch { return }
  try {
    await api(`/api/ai/kb/article/${encodeURIComponent(id)}`, { method: 'DELETE' })
    ElMessage.success('已删除该知识（含向量索引）')
    drawer.open = false
    await Promise.all([load(), loadStats()])
  } catch (e) {
    ElMessage.error(e?.message || '删除失败')
  }
}

/* ============ 在线编辑抽屉（PRD R4：替代只能删不能改） ============ */
const editDrawer = reactive({ open: false, saving: false, form: null, versionFrom: 'v1', type: 'issue', vis: 'public', status: 'published' })

function openEdit(item) {
  if (!canWrite.value) { ElMessage.warning('只读访客无写权限，需管理员角色'); return }
  const a = item || drawer.article
  if (!a) return
  editDrawer.form = {
    id: a.id,
    chunkId: a.chunkId,
    source_type: a.source_type,
    source_id: a.source_id,
    title: a.title,
    body: a.body || '',
    linkedErrors: (a.linkedErrors || []).join(', '),
    app: a.app
  }
  editDrawer.type = a.source_type
  editDrawer.vis = a.visibility
  editDrawer.status = a.status
  editDrawer.versionFrom = a.version || 'v1'
  editDrawer.open = true
}

async function saveEdit() {
  const f = editDrawer.form
  if (!f.title.trim()) return ElMessage.warning('请填写标题')
  if (!f.body.trim()) return ElMessage.warning('请填写正文')
  editDrawer.saving = true
  const payload = {
    title: f.title.trim(),
    type: editDrawer.type,
    visibility: editDrawer.vis,
    status: editDrawer.status,
    body: f.body,
    linkedErrors: f.linkedErrors.split(',').map(s => s.trim()).filter(Boolean),
    appScope: f.app && f.app !== '-' ? f.app : 'global'
  }
  const id = f.chunkId || f.source_id || f.id
  try {
    // PRD 新接口：PUT /kb/article/:id —— 后端重切分 + 重嵌 + 版本 +1（遗留来源自动升级为可治理 Article）
    await api(`/api/ai/kb/article/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const vnum = parseInt(String(editDrawer.versionFrom).replace(/\D/g, '')) || 1
    const to = 'v' + (vnum + 1)
    ElMessage.success(`已保存并自动重切分 + 重嵌（${editDrawer.versionFrom} → ${to}）`)
    editDrawer.open = false
  } catch (e) {
    ElMessage.warning(`编辑已本地生效，但后端写入接口暂未接入：${e?.message || '接口不存在'}`)
    editDrawer.open = false
  } finally {
    editDrawer.saving = false
    // 本地即时回显（无需等待后端迁移）
    const idx = state.items.findIndex(i => (i.chunkId || i.source_id || i.id) === id)
    if (idx >= 0) {
      const vnum = parseInt(String(editDrawer.versionFrom).replace(/\D/g, '')) || 1
      state.items[idx] = { ...state.items[idx], title: f.title.trim(), body: f.body, source_type: editDrawer.type, visibility: editDrawer.vis, status: editDrawer.status, version: 'v' + (vnum + 1) }
    }
    drawer.open = false
  }
}

/* ============ 新建知识（runbook / doc / faq × 手动/上传/链接） ============ */
const KIND_OPTIONS = [
  { value: 'runbook', label: 'runbook（排障手册）' },
  { value: 'doc', label: 'doc（领域文档）' },
  { value: 'faq', label: 'faq（常见问题）' }
]
const rbDialog = reactive({
  open: false, saving: false, kind: 'runbook', method: 'manual',
  title: '', text: '', url: '', appId: '', visibility: 'internal', fileName: ''
})
function openNew() {
  if (!canWrite.value) { ElMessage.warning('只读访客无写权限，需管理员角色'); return }
  rbDialog.kind = 'runbook'
  rbDialog.method = 'manual'
  rbDialog.title = ''
  rbDialog.text = ''
  rbDialog.url = ''
  rbDialog.appId = filterStore.appId || ''
  rbDialog.visibility = 'internal'
  rbDialog.fileName = ''
  rbDialog.open = true
}
function setMethod(m) { rbDialog.method = m }
function setKind(k) { rbDialog.kind = k }

function onFileChange(ev) {
  const file = ev?.target?.files?.[0]
  if (!file) return
  const okType = /\.(md|markdown|txt)$/i.test(file.name) || /^text\//.test(file.type || '')
  if (!okType) return ElMessage.warning('仅支持 .md / .txt 文本文件')
  if (file.size > 1024 * 1024) return ElMessage.warning('文件超过 1MB 上限')
  const reader = new FileReader()
  reader.onload = () => {
    rbDialog.text = String(reader.result || '')
    rbDialog.fileName = file.name
    if (!rbDialog.title.trim()) rbDialog.title = file.name.replace(/\.(md|markdown|txt)$/i, '')
  }
  reader.readAsText(file)
}

async function submitRunbook() {
  if (rbDialog.method === 'url') {
    if (!rbDialog.url.trim()) return ElMessage.warning('请填写在线链接')
  } else {
    if (!rbDialog.title.trim() || !rbDialog.text.trim()) return ElMessage.warning('请填写标题与正文')
  }
  rbDialog.saving = true
  try {
    // 手动/上传：经 PRD 新接口 /kb/article（统一 Article 模型，自动切分+重嵌）
    // 在线链接：经 /kb/runbook 服务端抓取（仅 runbook/doc）
    if (rbDialog.method === 'url') {
      const sourceType = ['runbook', 'doc'].includes(rbDialog.kind) ? rbDialog.kind : 'runbook'
      await api('/api/ai/kb/runbook', {
        method: 'POST', timeout: 120000,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: rbDialog.title.trim(), url: rbDialog.url.trim(), appId: rbDialog.appId || undefined, sourceType })
      })
    } else {
      await api('/api/ai/kb/article', {
        method: 'POST', timeout: 120000,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: rbDialog.title.trim(),
          type: rbDialog.kind,
          body: rbDialog.text.trim(),
          visibility: rbDialog.visibility,
          appScope: rbDialog.appId || 'global',
          tags: [], linkedErrors: []
        })
      })
    }
    ElMessage.success(rbDialog.method === 'url' ? '已抓取并入库（切分并向量索引中）' : '已入库（切分并向量索引完成）')
    rbDialog.open = false
    state.filter = rbDialog.kind
    await Promise.all([load(), loadStats()])
  } catch (e) {
    ElMessage.error(e?.message || '入库失败')
  } finally {
    rbDialog.saving = false
  }
}

/* ============ 全量重建索引（PRD R6：真正全量） ============ */
const rebuilding = ref(false)
const rbConfirm = ref(false)
function confirmRebuild() {
  if (!canWrite.value) { ElMessage.warning('只读访客无写权限，需管理员角色'); return }
  rbConfirm.value = true
}
async function rebuildIndex() {
  rebuilding.value = true
  rbConfirm.value = false
  try {
    const r = await api('/api/ai/kb/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: false, types: ['issue', 'doc', 'runbook', 'faq', 'feedback'] })
    })
    const byType = r?.byType ? `（${Object.entries(r.byType).map(([k, v]) => `${k}:${v}`).join(' ')}）` : ''
    ElMessage.success(`全量重建完成：覆盖 issue / doc / runbook / faq / feedback ${byType}`)
    await Promise.all([load(), loadStats()])
  } catch (e) {
    ElMessage.error(e?.message || '重建索引失败')
  } finally {
    rebuilding.value = false
  }
}

/* ============ 诊断抽屉溯源跳转 /knowledge?id=<chunkId> ============ */
function goHelp() { router.push('/help') }

onMounted(async () => {
  await Promise.all([load(), loadStats()])
  const chunkId = route.query.id
  const srcType = route.query.type
  const srcId = route.query.source
  if (chunkId) {
    openDetail({ id: chunkId })
  } else if (srcType && srcId) {
    openDetail({ source_type: srcType, source_id: srcId, title: srcId })
  }
  if (chunkId || (srcType && srcId)) {
    router.replace({ path: '/knowledge' })
  }
})
</script>

<template>
  <div class="kb-page">
    <!-- 治理台页头 -->
    <div class="page-header">
      <div>
        <h2>知识中枢 · 治理台</h2>
        <p>一份知识、两端消费：内部在此治理质量，外部帮助中心直接阅读，AI 诊断从同一份知识取数。</p>
      </div>
      <div class="page-actions">
        <span v-if="!canWrite" class="readonly-hint"><el-icon><Warning /></el-icon> 只读访客：免 AI key 浏览，写操作需管理员</span>
        <el-button text :icon="Reading" @click="goHelp">查看帮助中心</el-button>
        <el-select v-model="role" size="default" class="role-select" placeholder="角色">
          <el-option label="管理员（可写）" value="admin" />
          <el-option label="只读访客" value="readonly" />
        </el-select>
        <el-button :icon="Refresh" :loading="rebuilding" @click="confirmRebuild">全量重建索引</el-button>
        <el-button type="primary" :icon="Plus" :disabled="!canWrite" @click="openNew">新建知识</el-button>
      </div>
    </div>

    <!-- 统计概览卡 -->
    <div class="stats-grid">
      <div v-for="card in statsCards" :key="card.key" class="stat-card">
        <div class="stat-label">
          <span class="stat-dot" :style="{ background: card.color }" />{{ card.label }}
        </div>
        <div class="stat-value">{{ card.value }}</div>
        <div class="stat-meta">{{ card.meta }}</div>
      </div>
    </div>

    <div class="two-col">
      <!-- 筛选 -->
      <aside class="filter-panel">
        <div class="filter-title">来源类型</div>
        <button
          v-for="f in [{ key: 'all', label: '全部类型' }, ...SOURCE_TYPES.map(t => ({ key: t, label: t }))]"
          :key="f.key" type="button" class="filter-item" :class="{ active: state.filter === f.key }" @click="setFilter(f.key)"
        >
          <span class="filter-check" />
          {{ f.label }}
          <span class="filter-count">{{ f.key === 'all' ? state.total : (state.stats.byType[f.key] || 0) }}</span>
        </button>
        <div class="filter-divider" />
        <div class="filter-section-label">可见性</div>
        <button v-for="v in ['all', 'public', 'internal']" :key="v" type="button" class="sort-btn" :class="{ active: state.vis === v }" @click="setVis(v)">
          {{ v === 'all' ? '全部' : (v === 'public' ? '公开（帮助中心可读）' : '内部（仅治理）') }}
        </button>
        <div class="filter-divider" />
        <div class="filter-section-label">状态</div>
        <button v-for="s in ['all', 'published', 'draft', 'archived']" :key="s" type="button" class="sort-btn" :class="{ active: state.status === s }" @click="setStatus(s)">
          {{ s === 'all' ? '全部' : STATUS_LABEL[s] }}
        </button>
        <div class="filter-divider" />
        <div class="filter-section-label">排序</div>
        <button v-for="s in [{ key: 'updated', label: '最近更新' }, { key: 'ai', label: 'AI 引用（高→低）' }, { key: 'type', label: '来源类型' }]" :key="s.key" type="button" class="sort-btn" :class="{ active: state.sort === s.key }" @click="setSort(s.key)">
          {{ s.label }}
        </button>
      </aside>

      <!-- 列表 -->
      <section>
        <div class="list-toolbar">
          <div class="search-box">
            <el-icon><Search /></el-icon>
            <input v-model="state.search" placeholder="语义检索知识，如：列表数据未初始化、ChunkLoadError…" @input="onSearchInput" />
          </div>
          <el-tooltip content="相似度为向量检索余弦相似度，越高表示与查询语义越接近" placement="top">
            <el-icon class="sim-help"><Document /></el-icon>
          </el-tooltip>
        </div>

        <el-alert v-if="state.error" type="error" :title="state.error" show-icon class="mb12">
          <el-button size="small" text type="primary" @click="load">重试</el-button>
        </el-alert>

        <div v-if="state.loading" class="loading-row"><el-icon class="is-loading"><Refresh /></el-icon> 加载中…</div>

        <div v-else-if="!visibleItems.length" class="empty-state">
          <h4>{{ state.search ? `没有与「${state.search}」相关的知识` : '该范围下暂无知识' }}</h4>
          <p>{{ state.search ? '换个关键词试试。' : '可全量重建摄取 issue 解法，或新建知识沉淀领域经验。' }}</p>
          <div>
            <el-button size="small" @click="confirmRebuild">全量重建</el-button>
            <el-button size="small" type="primary" :disabled="!canWrite" @click="openNew">新建知识</el-button>
          </div>
        </div>

        <div v-else class="kb-list">
          <div v-for="(item, i) in visibleItems" :key="`${item.source_type}:${item.source_id}:${i}`" class="kb-card" @click="openDetail(item)">
            <div class="kb-bar" :style="{ background: TYPE_META[item.source_type]?.color || '#4f46e5' }" />
            <div class="kb-body">
              <div class="kb-top">
                <span class="kb-tag" :style="{ background: `${TYPE_META[item.source_type]?.color || '#4f46e5'}1a`, color: TYPE_META[item.source_type]?.color || '#4f46e5' }">{{ item.source_type }}</span>
                <span class="kb-title">{{ item.title }}</span>
                <span v-if="item.legacy" class="kb-legacy">遗留</span>
              </div>
              <div v-if="item.excerpt" class="kb-excerpt">{{ item.excerpt }}</div>
              <div class="kb-meta">
                <span>来源 {{ item.source_id }}</span><span class="sep" />
                <span>应用 {{ item.app }}</span><span class="sep" />
                <span>更新 {{ fmtTime(item.updatedAt) }}</span>
              </div>
              <div class="ql-mini">
                <span class="kb-chip" :class="item.visibility === 'public' ? 'pub' : 'int'">{{ VIS_LABEL[item.visibility] || '内部' }}</span>
                <span class="kb-chip" :class="item.status === 'draft' ? 'warn' : (item.status === 'archived' ? 'muted' : 'ok')">{{ STATUS_LABEL[item.status] || '已发布' }}</span>
                <span>AI 引用 <b>{{ item.quality?.aiCitations ?? '—' }}</b></span>
                <span>有用率 <b>{{ pct(item.quality?.helpfulRate) || '—' }}</b></span>
              </div>
            </div>
            <div class="kb-right">
              <div v-if="pct(item.score)" class="kb-sim">
                <div class="sim-track"><div class="sim-fill" :style="{ width: pct(item.score) }" /></div>
                <span class="sim-pct">{{ pct(item.score) }}</span>
              </div>
              <span v-else class="sim-pct muted">—</span>
              <el-button size="small" text type="primary" @click.stop="openDetail(item)">详情 →</el-button>
            </div>
          </div>
        </div>

        <div v-if="!state.search.trim() && state.total > state.page * state.pageSize" class="more-row">
          <el-button text type="primary" :loading="state.loading" @click="state.page++; load()">加载更多</el-button>
        </div>
      </section>
    </div>

    <!-- 详情抽屉 -->
    <el-drawer v-model="drawer.open" :title="drawer.article ? drawer.article.title : '知识详情'" size="min(500px, 94vw)">
      <div v-if="drawer.loading" class="loading-row"><el-icon class="is-loading"><Refresh /></el-icon> 原文加载中…</div>
      <el-alert v-else-if="drawer.error" type="warning" title="该知识已不存在或加载失败" show-icon>
        <div>{{ drawer.error }}</div>
        <div v-if="drawer.article?.source_id" class="err-actions">
          <el-button size="small" text type="danger" :disabled="!canDelete" @click="deleteSource">清理残留来源</el-button>
        </div>
      </el-alert>
      <template v-else-if="drawer.article">
        <div class="detail-grid">
          <span class="k">类型</span><span><el-tag size="small" effect="plain">{{ drawer.article.source_type }}</el-tag></span>
          <span class="k">来源</span><span class="mono">{{ drawer.article.source_id }}</span>
          <span class="k">应用</span><span>{{ drawer.article.app }}</span>
          <span class="k">可见性</span><span>{{ VIS_LABEL[drawer.article.visibility] }}（{{ drawer.article.visibility === 'public' ? '帮助中心可读' : '仅治理' }}）</span>
          <span class="k">状态</span><span>{{ STATUS_LABEL[drawer.article.status] }}</span>
          <span class="k">版本</span><span class="mono">{{ drawer.article.version }}</span>
          <span class="k">更新时间</span><span>{{ fmtTime(drawer.article.updatedAt) }}</span>
        </div>
        <div class="quality-card">
          <h4><el-icon><Star /></el-icon> 质量指标</h4>
          <div class="quality-grid">
            <div class="quality-cell"><div class="qv">{{ drawer.article.quality?.aiCitations ?? '—' }}</div><div class="ql">AI 引用次数</div></div>
            <div class="quality-cell"><div class="qv" :style="{ color: (drawer.article.quality?.helpfulRate ?? 0) >= 0.85 ? '#10b981' : '#f59e0b' }">{{ pct(drawer.article.quality?.helpfulRate) || '—' }}</div><div class="ql">用户有用率</div></div>
            <div class="quality-cell"><div class="qv">{{ drawer.article.quality?.feedbackCount ?? 0 }}</div><div class="ql">反馈条数</div></div>
          </div>
        </div>
        <template v-if="drawer.article.linkedErrors?.length">
          <div class="k linked-label">关联错误</div>
          <div class="linked">
            <span v-for="l in drawer.article.linkedErrors" :key="l" class="kb-chip danger">{{ l }}</span>
          </div>
        </template>
        <h4 class="src-label">原文</h4>
        <pre class="source-code">{{ drawer.article.body }}</pre>
      </template>
      <template #footer>
        <el-button @click="drawer.open = false">关闭</el-button>
        <el-button v-if="drawer.article" :icon="Edit" :disabled="!canWrite" @click="openEdit(drawer.article)">编辑</el-button>
        <el-button v-if="drawer.article" type="danger" plain :loading="drawer.loading" :disabled="!canDelete" @click="deleteSource">删除该知识</el-button>
      </template>
    </el-drawer>

    <!-- 编辑抽屉 -->
    <el-drawer v-model="editDrawer.open" title="编辑知识" size="min(520px, 94vw)" :destroy-on-close="true">
      <template v-if="editDrawer.form">
        <div class="form-row"><label>标题</label><el-input v-model="editDrawer.form.title" /></div>
        <div class="form-row"><label>知识类型</label>
          <div class="seg">
            <button v-for="t in SOURCE_TYPES" :key="t" type="button" :class="{ active: editDrawer.type === t }" @click="editDrawer.type = t">{{ t }}</button>
          </div>
        </div>
        <div class="form-row"><label>可见性</label>
          <div class="seg">
            <button type="button" :class="{ active: editDrawer.vis === 'public' }" @click="editDrawer.vis = 'public'">公开（帮助中心可读）</button>
            <button type="button" :class="{ active: editDrawer.vis === 'internal' }" @click="editDrawer.vis = 'internal'">内部（仅治理）</button>
          </div>
        </div>
        <div class="form-row"><label>状态</label>
          <el-select v-model="editDrawer.status" style="width:100%">
            <el-option label="已发布" value="published" />
            <el-option label="草稿" value="draft" />
            <el-option label="已下线" value="archived" />
          </el-select>
        </div>
        <div class="form-row"><label>正文（Markdown / 纯文本，保存后自动重切分 + 重嵌）</label>
          <el-input v-model="editDrawer.form.body" type="textarea" :rows="9" placeholder="## 现象&#10;## 根因&#10;## 解法" />
        </div>
        <div class="form-row"><label>关联错误（逗号分隔，供 AI 诊断匹配）</label>
          <el-input v-model="editDrawer.form.linkedErrors" placeholder="ChunkLoadError, 白屏" />
        </div>
        <div class="form-row"><label>版本历史</label>
          <div class="ver-list">
            <div class="ver-item cur"><span class="ver-dot" /><span class="vtag">{{ editDrawer.versionFrom }}</span><span>当前</span></div>
            <div class="ver-item"><span class="ver-dot old" /><span class="vtag">prev</span><span>上一版本</span></div>
          </div>
        </div>
      </template>
      <template #footer>
        <el-button @click="editDrawer.open = false">取消</el-button>
        <el-button type="primary" :loading="editDrawer.saving" @click="saveEdit">保存并重新索引</el-button>
      </template>
    </el-drawer>

    <!-- 新建知识 -->
    <el-dialog v-model="rbDialog.open" :title="`新建知识`" width="min(580px, 94vw)">
      <el-form label-position="top">
        <el-form-item label="知识类型">
          <el-radio-group v-model="rbDialog.kind">
            <el-radio-button v-for="k in KIND_OPTIONS" :key="k.value" :value="k.value">{{ k.label }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="来源方式">
          <div class="seg">
            <button type="button" :class="{ active: rbDialog.method === 'manual' }" @click="setMethod('manual')">手动编写</button>
            <button type="button" :class="{ active: rbDialog.method === 'upload' }" @click="setMethod('upload')">上传文件</button>
            <button type="button" :class="{ active: rbDialog.method === 'url' }" @click="setMethod('url')">在线链接</button>
          </div>
        </el-form-item>
        <el-form-item v-if="rbDialog.method !== 'url'" label="标题" required>
          <el-input v-model="rbDialog.title" placeholder="如：生产环境白屏应急排障手册" />
        </el-form-item>
        <el-form-item v-if="rbDialog.method === 'url'" label="在线链接" required>
          <el-input v-model="rbDialog.url" placeholder="https://wiki.example.com/runbooks/white-screen" />
          <p class="form-hint">服务端将抓取公开页面正文并按标题切分入库；仅支持公开可访问的 http(s) 页面，私有页面（需登录）暂不支持。</p>
        </el-form-item>
        <el-form-item v-if="rbDialog.method === 'upload'" label="上传 Markdown / 文本">
          <label class="upload-zone">
            <input type="file" accept=".md,.markdown,.txt,text/plain,text/markdown" hidden @change="onFileChange" />
            <template v-if="rbDialog.fileName"><el-icon><UploadFilled /></el-icon> 已选择：<strong>{{ rbDialog.fileName }}</strong>（点击可重新选择）</template>
            <template v-else><el-icon><UploadFilled /></el-icon> 拖拽或点击选择 .md / .txt 文件（≤1MB），内容将回显在下方正文供校正</template>
          </label>
        </el-form-item>
        <el-form-item label="适用应用（可选，默认 global）">
          <el-select v-model="rbDialog.appId" clearable placeholder="global" style="width:100%">
            <el-option label="app_web_production" value="app_web_production" />
            <el-option label="app_mobile_h5" value="app_mobile_h5" />
          </el-select>
        </el-form-item>
        <el-form-item label="可见性">
          <div class="seg">
            <button type="button" :class="{ active: rbDialog.visibility === 'public' }" @click="rbDialog.visibility = 'public'">公开（帮助中心可读）</button>
            <button type="button" :class="{ active: rbDialog.visibility === 'internal' }" @click="rbDialog.visibility = 'internal'">内部（仅治理）</button>
          </div>
        </el-form-item>
        <el-form-item v-if="rbDialog.method !== 'url'" label="正文（Markdown / 纯文本，按标题自动切分入库）" required>
          <el-input v-model="rbDialog.text" type="textarea" :rows="9" placeholder="## 现象&#10;页面白屏，控制台报 ChunkLoadError&#10;&#10;## 根因&#10;CDN 资源未发布 / 路由懒加载 chunk 404&#10;&#10;## 解法&#10;回滚发布或重新构建并刷新 CDN 缓存" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="rbDialog.open = false">取消</el-button>
        <el-button type="primary" :loading="rbDialog.saving" @click="submitRunbook">{{ rbDialog.method === 'url' ? '抓取并索引' : '入库并索引' }}</el-button>
      </template>
    </el-dialog>

    <!-- 全量重建确认 -->
    <el-dialog v-model="rbConfirm" title="全量重建索引" width="min(460px, 94vw)">
      <p style="font-size:13.5px;color:var(--el-text-color-secondary);margin:0">
        将重新摄取 <b>issue / doc / runbook / faq / feedback</b> 全部类型的知识并重建向量索引（覆盖旧版仅 issue 的范围）。耗时可能较长，确认执行？
      </p>
      <template #footer>
        <el-button @click="rbConfirm = false">取消</el-button>
        <el-button type="primary" :loading="rebuilding" @click="rebuildIndex">重建</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.kb-page { display: flex; flex-direction: column; gap: 16px; }
.page-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.page-header h2 { font-size: 22px; font-weight: 700; margin: 0; }
.page-header p { margin: 4px 0 0; color: var(--el-text-color-secondary); font-size: 14px; }
.page-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }

.role-select { width: 150px; }
.readonly-hint { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #b45309; background: #fef3c7; border: 1px solid #fde68a; padding: 5px 11px; border-radius: 20px; }

/* 统计概览卡 */
.stats-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 14px; }
.stat-card { background: var(--surface, #fff); border: 1px solid var(--el-border-color-lighter); border-radius: 12px; padding: 16px 18px; box-shadow: 0 1px 2px rgba(16,24,40,.04); }
.stat-label { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--el-text-color-secondary); }
.stat-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.stat-value { margin-top: 8px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 26px; font-weight: 700; letter-spacing: -.5px; }
.stat-meta { margin-top: 3px; font-size: 12px; color: var(--el-text-color-placeholder); }

/* 双栏 */
.two-col { display: grid; grid-template-columns: 210px minmax(0, 1fr); gap: 18px; align-items: start; }
.filter-panel { background: var(--surface, #fff); border: 1px solid var(--el-border-color-lighter); border-radius: 12px; padding: 14px; position: sticky; top: 84px; box-shadow: 0 1px 2px rgba(16,24,40,.04); }
.filter-title { font-size: 14px; font-weight: 700; margin-bottom: 10px; }
.filter-item { display: flex; align-items: center; gap: 9px; width: 100%; padding: 8px 10px; border: none; background: none; border-radius: 8px; cursor: pointer; color: var(--el-text-color-regular); font-size: 13.5px; font-weight: 500; text-align: left; font-family: inherit; transition: all .12s ease; }
.filter-item:hover { background: var(--el-fill-color-light); }
.filter-item.active { background: var(--el-color-primary-light-9); color: var(--el-color-primary); }
.filter-check { width: 15px; height: 15px; border-radius: 5px; border: 1.5px solid #cbd2dd; flex-shrink: 0; }
.filter-item.active .filter-check { background: var(--el-color-primary); border-color: var(--el-color-primary); }
.filter-count { margin-left: auto; font-size: 12px; color: var(--el-text-color-placeholder); font-family: ui-monospace, Menlo, Consolas, monospace; }
.filter-divider { height: 1px; background: var(--el-border-color-extra-light); margin: 12px 0; }
.filter-section-label { font-size: 12px; font-weight: 600; color: var(--el-text-color-secondary); margin-bottom: 6px; }
.sort-btn { display: block; width: 100%; text-align: left; padding: 7px 10px; border: none; background: transparent; border-radius: 8px; cursor: pointer; color: var(--el-text-color-regular); font-size: 13px; font-family: inherit; transition: background .12s ease; }
.sort-btn:hover { background: var(--el-fill-color-light); }
.sort-btn.active { background: var(--el-color-primary-light-9); color: var(--el-color-primary); font-weight: 600; }

/* 列表工具栏 / 搜索框 */
.list-toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.search-box { flex: 1; display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 12px; border: 1px solid var(--el-border-color); border-radius: 10px; background: var(--surface, #fff); }
.search-box:focus-within { border-color: var(--el-color-primary); box-shadow: 0 0 0 3px rgba(79,70,229,.15); }
.search-box .el-icon { color: var(--el-text-color-placeholder); }
.search-box input { flex: 1; border: none; outline: none; background: transparent; font-size: 13.5px; color: var(--el-text-color-primary); font-family: inherit; }
.sim-help { color: var(--el-text-color-placeholder); cursor: help; }

/* 知识卡 */
.kb-list { display: flex; flex-direction: column; gap: 10px; }
.kb-card { position: relative; display: flex; align-items: stretch; gap: 14px; background: var(--surface, #fff); border: 1px solid var(--el-border-color-lighter); border-radius: 12px; padding: 13px 16px 13px 18px; cursor: pointer; box-shadow: 0 1px 2px rgba(16,24,40,.04); transition: all .15s ease; }
.kb-card:hover { box-shadow: 0 1px 2px rgba(16,24,40,.04), 0 6px 20px rgba(16,24,40,.08); border-color: #c8cdf5; transform: translateY(-1px); }
.kb-bar { position: absolute; left: 0; top: 13px; bottom: 13px; width: 4px; border-radius: 0 4px 4px 0; }
.kb-body { flex: 1; min-width: 0; }
.kb-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.kb-tag { padding: 1px 8px; border-radius: 6px; font-size: 11.5px; font-weight: 600; line-height: 1.7; white-space: nowrap; }
.kb-title { font-size: 14.5px; font-weight: 600; word-break: break-word; }
.kb-legacy { padding: 1px 7px; border-radius: 6px; font-size: 11px; font-weight: 600; color: #9aa3b2; background: rgba(154,163,178,.16); }
.kb-excerpt { margin-top: 3px; font-size: 12.5px; color: var(--el-text-color-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-meta { display: flex; align-items: center; gap: 8px; margin-top: 5px; color: var(--el-text-color-placeholder); font-size: 12px; flex-wrap: wrap; word-break: break-all; }
.kb-meta .sep { width: 3px; height: 3px; border-radius: 50%; background: currentColor; opacity: .5; }
.kb-right { display: flex; flex-direction: column; align-items: flex-end; justify-content: space-between; gap: 6px; min-width: 120px; flex-shrink: 0; }
.kb-sim { display: flex; align-items: center; gap: 8px; }
.sim-track { width: 60px; height: 5px; border-radius: 3px; background: var(--el-fill-color); overflow: hidden; }
.sim-fill { height: 100%; border-radius: 3px; background: linear-gradient(90deg, #8b5cf6, #0ea5e9); }
.sim-pct { font-size: 12px; font-weight: 600; color: var(--el-text-color-secondary); font-family: ui-monospace, Menlo, Consolas, monospace; }
.sim-pct.muted { color: var(--el-text-color-placeholder); }

/* 质量迷你条 / 芯片 */
.ql-mini { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; font-size: 11.5px; color: var(--el-text-color-placeholder); align-items: center; }
.ql-mini b { color: var(--el-text-color-regular); font-weight: 600; }
.kb-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 9px; border-radius: 20px; font-size: 11.5px; font-weight: 600; }
.kb-chip.pub { color: #10b981; background: rgba(16,185,129,.12); }
.kb-chip.int { color: var(--el-text-color-secondary); background: rgba(154,163,178,.16); }
.kb-chip.ok { color: #10b981; background: rgba(16,185,129,.12); }
.kb-chip.warn { color: #f59e0b; background: rgba(245,158,11,.12); }
.kb-chip.muted { color: var(--el-text-color-placeholder); background: rgba(154,163,178,.16); }
.kb-chip.danger { color: #ef4444; background: rgba(239,68,68,.12); }

.empty-state { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 52px 20px; background: var(--surface, #fff); border: 1.5px dashed var(--el-border-color); border-radius: 12px; gap: 6px; }
.empty-state h4 { margin: 0; font-size: 15px; }
.empty-state p { margin: 0 0 12px; font-size: 13px; color: var(--el-text-color-placeholder); max-width: 320px; }
.loading-row { display: flex; align-items: center; gap: 8px; padding: 28px 0; color: var(--el-text-color-secondary); justify-content: center; }
.more-row { display: flex; justify-content: center; margin-top: 12px; }
.mb12 { margin-bottom: 12px; }

/* 详情 / 编辑内容 */
.detail-grid { display: grid; grid-template-columns: 72px 1fr; gap: 8px 12px; font-size: 13px; }
.detail-grid .k { color: var(--el-text-color-placeholder); }
.detail-grid .mono { font-family: ui-monospace, Menlo, Consolas, monospace; word-break: break-all; }
.src-label { margin: 16px 0 8px; font-size: 14px; }
.source-code { background: #0f172a; color: #e2e8f0; padding: 15px 17px; border-radius: 10px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px; line-height: 1.68; white-space: pre-wrap; word-break: break-word; max-height: 46vh; overflow-y: auto; margin: 0; }
.quality-card { background: var(--el-fill-color-light); border: 1px solid var(--el-border-color-extra-light); border-radius: 11px; padding: 14px; margin-bottom: 14px; }
.quality-card h4 { margin: 0 0 10px; font-size: 13.5px; font-weight: 700; display: flex; align-items: center; gap: 7px; }
.quality-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.quality-cell { text-align: center; }
.quality-cell .qv { font-size: 20px; font-weight: 700; font-family: ui-monospace, Menlo, Consolas, monospace; }
.quality-cell .ql { font-size: 11.5px; color: var(--el-text-color-placeholder); }
.linked-label { color: var(--el-text-color-placeholder); font-size: 12px; margin-bottom: 2px; }
.linked { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.ver-list { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
.ver-item { display: flex; align-items: center; gap: 10px; font-size: 12.5px; padding: 8px 10px; border: 1px solid var(--el-border-color-extra-light); border-radius: 9px; background: var(--el-fill-color-light); }
.ver-item .vtag { font-family: ui-monospace, Menlo, Consolas, monospace; font-weight: 700; color: var(--el-color-primary); }
.ver-item.cur { border-color: var(--el-color-primary); }
.ver-dot { width: 8px; height: 8px; border-radius: 50%; background: #10b981; flex-shrink: 0; }
.ver-dot.old { background: var(--el-text-color-placeholder); }
.form-row { margin-bottom: 14px; }
.form-row > label { display: block; font-size: 13px; font-weight: 600; color: var(--el-text-color-primary); margin-bottom: 6px; }
.form-hint { font-size: 12px; color: var(--el-text-color-placeholder); margin: 6px 0 0; line-height: 1.5; }
.seg { display: inline-flex; gap: 2px; padding: 3px; background: var(--el-fill-color-light); border-radius: 9px; flex-wrap: wrap; }
.seg button { border: none; background: transparent; padding: 7px 15px; border-radius: 7px; font-size: 13px; font-weight: 500; color: var(--el-text-color-regular); cursor: pointer; transition: all .12s; font-family: inherit; }
.seg button:hover { color: var(--el-color-primary); }
.seg button.active { background: var(--el-fill-color-blank, #fff); color: var(--el-color-primary); font-weight: 600; box-shadow: 0 1px 2px rgba(16,24,40,.08); }
.upload-zone { display: flex; align-items: center; gap: 8px; width: 100%; border: 1.5px dashed var(--el-border-color); border-radius: 10px; padding: 20px; text-align: center; color: var(--el-text-color-placeholder); font-size: 13px; cursor: pointer; transition: all .15s; line-height: 1.6; justify-content: center; }
.upload-zone:hover { border-color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.err-actions { margin-top: 8px; }

@media (max-width: 1180px) {
  .stats-grid { grid-template-columns: repeat(2, 1fr); }
  .two-col { grid-template-columns: 1fr; }
  .filter-panel { position: static; }
}
@media (max-width: 760px) {
  .stats-grid { grid-template-columns: 1fr; }
}
</style>
