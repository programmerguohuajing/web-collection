<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, Plus, Search, Document } from '@element-plus/icons-vue'
import { api } from '../../../dashboard.js'
import { useFilterStore } from '../../../stores/filters.js'

const route = useRoute()
const router = useRouter()
const filterStore = useFilterStore()

const SOURCE_TYPES = ['issue', 'doc', 'feedback', 'runbook']
const TYPE_LABELS = {
  issue: { label: 'issue', color: '#0ea5e9' },
  doc: { label: 'doc', color: '#10b981' },
  feedback: { label: 'feedback', color: '#f59e0b' },
  runbook: { label: 'runbook', color: '#8b5cf6' }
}

const state = reactive({
  loading: false,
  error: '',
  items: [],
  total: 0,
  page: 1,
  pageSize: 50,
  filter: 'all',
  search: '',
  sort: 'updated',
  stats: { total: 0, byType: {}, latestUpdated: null }
})

// 检索命中时记录 score（meta 列表无 score）
const scoreById = ref({})

const statsCards = computed(() => [
  { key: 'total', label: '知识总数', color: '#4f46e5', value: state.stats.total, meta: '已索引来源' },
  ...SOURCE_TYPES.map(t => ({
    key: t,
    label: `${TYPE_LABELS[t].label} 类`,
    color: TYPE_LABELS[t].color,
    value: state.stats.byType[t] || 0,
    meta: { issue: '已解决 issue 沉淀', doc: '文档自动切分', feedback: '用户修正闭环', runbook: '领域排障手册' }[t]
  }))
])

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
      // 语义检索：/kb/search（topK 固定 8，前端再按来源过滤）
      const data = await api(`/api/ai/kb/search?q=${encodeURIComponent(state.search.trim())}${filterStore.appId ? `&appId=${encodeURIComponent(filterStore.appId)}` : ''}`, { requestKey: 'kb:search' })
      const results = (data?.results || []).map(r => ({
        source_type: r.source_type,
        source_id: r.source_id,
        app_id: r.app_id || '',
        updated_at: r.updated_at,
        title: r.metadata?.title || r.source_id,
        excerpt: String(r.text || '').slice(0, 120),
        score: r.score ?? null
      }))
      scoreById.value = Object.fromEntries(results.filter(r => r.score != null).map(r => [r.id || r.source_id, r.score]))
      state.items = results
      state.total = results.length
    } else {
      const params = new URLSearchParams()
      if (state.filter !== 'all') params.set('type', state.filter)
      if (filterStore.appId) params.set('appId', filterStore.appId)
      params.set('page', String(state.page))
      params.set('pageSize', String(state.pageSize))
      const data = await api(`/api/ai/kb/meta?${params}`, { requestKey: 'kb:meta' })
      state.items = (data?.items || []).map(r => ({
        ...r,
        title: r.title || r.source_id,
        excerpt: r.excerpt || '',
        score: null
      }))
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
  // search 结果在前端按来源过滤；meta 已由后端过滤
  if (state.search.trim() && state.filter !== 'all') {
    items = items.filter(i => i.source_type === state.filter)
  }
  const sorted = [...items]
  if (state.sort === 'sim-desc') sorted.sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
  else if (state.sort === 'type') sorted.sort((a, b) => String(a.source_type).localeCompare(String(b.source_type)))
  else sorted.sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0))
  return sorted
})

function setFilter(f) { state.filter = f; state.page = 1; load() }
function setSort(s) { state.sort = s }

function fmtTime(ts) {
  if (!ts) return '-'
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return String(ts)
  const d = new Date(n)
  const p = v => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function pct(score) {
  if (score == null) return null
  const n = Number(score)
  if (!Number.isFinite(n)) return null
  return `${Math.round(n * 100)}%`
}

// ── 详情抽屉 ────────────────────────────────────────
const drawer = reactive({ open: false, loading: false, error: '', chunk: null })

async function openDetail(item) {
  drawer.open = true
  drawer.loading = true
  drawer.error = ''
  drawer.chunk = null
  try {
    // 列表项只有 source 维度，先取该来源下最新 chunk；从诊断抽屉跳转带 chunk id 时直接取
    const id = item.id || item.chunkId
    if (id) {
      drawer.chunk = await api(`/api/ai/kb/chunk/${encodeURIComponent(id)}`, { requestKey: `kb:chunk:${id}` })
    } else {
      const list = await api(`/api/ai/kb/search?q=${encodeURIComponent(item.title || item.source_id)}&appId=${encodeURIComponent(item.app_id || '')}`, { requestKey: `kb:locate:${item.source_id}` })
      const hit = (list?.results || []).find(r => r.source_type === item.source_type && r.source_id === item.source_id)
        || (list?.results || [])[0]
      if (!hit) throw new Error('未定位到该知识的原文 chunk')
      drawer.chunk = await api(`/api/ai/kb/chunk/${encodeURIComponent(hit.id)}`, { requestKey: `kb:chunk:${hit.id}` })
    }
  } catch (e) {
    drawer.error = e?.message || '原文加载失败'
  } finally {
    drawer.loading = false
  }
}

async function deleteSource() {
  const c = drawer.chunk
  if (!c?.source_type || !c?.source_id) return
  try {
    await ElMessageBox.confirm(
      `将删除来源「${c.source_id}」的全部知识 chunk 与向量索引，且不可恢复。确认删除？`,
      '删除该来源',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' }
    )
  } catch { return }
  try {
    await api(`/api/ai/kb/source?type=${encodeURIComponent(c.source_type)}&id=${encodeURIComponent(c.source_id)}`, { method: 'DELETE' })
    ElMessage.success('已删除该来源（含向量索引）')
    drawer.open = false
    await Promise.all([load(), loadStats()])
  } catch (e) {
    ElMessage.error(e?.message || '删除失败')
  }
}

// ── 重建索引（仅 issue 类）──────────────────────────
const rebuilding = ref(false)
async function rebuildIndex() {
  try {
    await ElMessageBox.confirm(
      '将重新摄取「已解决 issue」类知识（doc / feedback / runbook 不在重建范围）。确认执行？',
      '重建索引',
      { confirmButtonText: '重建', cancelButtonText: '取消', type: 'info' }
    )
  } catch { return }
  rebuilding.value = true
  try {
    const r = await api('/api/ai/kb/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: false })
    })
    ElMessage.success(`issue 类索引重建完成：新增 ${r?.ingested ?? 0} 条，跳过 ${r?.skipped ?? 0} 条`)
    await Promise.all([load(), loadStats()])
  } catch (e) {
    ElMessage.error(e?.message || '重建索引失败')
  } finally {
    rebuilding.value = false
  }
}

// ── 新建 runbook（手动编写 / 上传文件 / 在线链接）────────────────
const rbDialog = reactive({ open: false, saving: false, method: 'manual', title: '', text: '', appId: '', url: '', fileName: '' })
function openRunbook() {
  rbDialog.method = 'manual'
  rbDialog.title = ''
  rbDialog.text = ''
  rbDialog.appId = filterStore.appId || ''
  rbDialog.url = ''
  rbDialog.fileName = ''
  rbDialog.open = true
}
function setMethod(m) { rbDialog.method = m }

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
  // url 模式：标题可留空（服务端用 host 兜底）
  if (rbDialog.method === 'url') {
    if (!rbDialog.url.trim()) return ElMessage.warning('请填写在线链接')
  } else {
    if (!rbDialog.title.trim() || !rbDialog.text.trim()) return ElMessage.warning('请填写标题与正文')
  }
  rbDialog.saving = true
  try {
    const payload = {
      title: rbDialog.title.trim(),
      appId: rbDialog.appId || undefined
    }
    if (rbDialog.method === 'url') payload.url = rbDialog.url.trim()
    else payload.text = rbDialog.text.trim()
    const r = await api('/api/ai/kb/runbook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
    ElMessage.success(`runbook 已入库并进入检索（切分 ${r?.ingested ?? 1} 块）`)
    rbDialog.open = false
    state.filter = 'runbook'
    await Promise.all([load(), loadStats()])
  } catch (e) {
    ElMessage.error(e?.message || 'runbook 入库失败')
  } finally {
    rbDialog.saving = false
  }
}

// ── 诊断抽屉溯源跳转 /knowledge?id=<chunkId> ─────────
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
    <div class="page-header">
      <div>
        <h2>知识库</h2>
        <p>浏览、检索并治理 AI 诊断所依赖的知识；支持重建索引与注入 runbook。</p>
      </div>
      <div class="page-actions">
        <el-button :icon="Refresh" :loading="rebuilding" @click="rebuildIndex">重建索引</el-button>
        <el-button type="primary" :icon="Plus" @click="openRunbook">新建 runbook</el-button>
      </div>
    </div>

    <!-- 统计概览卡 -->
    <div class="stats-grid">
      <div v-for="card in statsCards" :key="card.key" class="stat-card">
        <div class="stat-label">
          <span class="stat-dot" :style="{ background: card.color }" />{{ card.label }}
        </div>
        <div class="stat-value">{{ card.value.toLocaleString() }}</div>
        <div class="stat-meta">
          {{ card.meta }}<template v-if="card.key === 'total' && state.stats.latestUpdated"> · 最近更新 {{ fmtTime(state.stats.latestUpdated) }}</template>
        </div>
      </div>
    </div>

    <div class="two-col">
      <!-- 来源筛选 -->
      <aside class="filter-panel">
        <div class="filter-title">来源筛选</div>
        <button
          v-for="f in [{ key: 'all', label: '全部来源' }, ...SOURCE_TYPES.map(t => ({ key: t, label: t }))]"
          :key="f.key"
          type="button"
          class="filter-item"
          :class="{ active: state.filter === f.key }"
          @click="setFilter(f.key)"
        >
          <span class="filter-check" />
          {{ f.label }}
          <span class="filter-count">{{ f.key === 'all' ? state.stats.total : (state.stats.byType[f.key] || 0) }}</span>
        </button>
        <div class="filter-divider" />
        <div class="filter-section-label">排序</div>
        <button
          v-for="s in [
            { key: 'updated', label: '最近更新' },
            { key: 'sim-desc', label: '相似度（高→低）' },
            { key: 'type', label: '来源类型' }
          ]"
          :key="s.key"
          type="button"
          class="sort-btn"
          :class="{ active: state.sort === s.key }"
          @click="setSort(s.key)"
        >{{ s.label }}</button>
      </aside>

      <!-- 列表 -->
      <section>
        <div class="list-toolbar">
          <div class="search-box">
            <el-icon><Search /></el-icon>
            <input
              v-model="state.search"
              placeholder="语义检索知识，如：列表数据未初始化、ChunkLoadError…"
              @input="onSearchInput"
            >
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
          <h4>{{ state.search ? `没有与「${state.search}」相关的知识` : '该来源下暂无知识' }}</h4>
          <p>{{ state.search ? '换个关键词试试。' : '可重建索引摄取 issue 解法，或新建 runbook 沉淀领域经验。' }}</p>
          <div>
            <el-button size="small" @click="rebuildIndex">重建索引</el-button>
            <el-button size="small" type="primary" @click="openRunbook">新建 runbook</el-button>
          </div>
        </div>

        <div v-else class="kb-list">
          <div v-for="(item, i) in visibleItems" :key="`${item.source_type}:${item.source_id}:${i}`" class="kb-card" @click="openDetail(item)">
            <div class="kb-bar" :style="{ background: TYPE_LABELS[item.source_type]?.color || '#4f46e5' }" />
            <div class="kb-body">
              <div class="kb-top">
                <span
                  class="kb-tag"
                  :style="{ background: `${TYPE_LABELS[item.source_type]?.color || '#4f46e5'}1a`, color: TYPE_LABELS[item.source_type]?.color || '#4f46e5' }"
                >{{ item.source_type }}</span>
                <span class="kb-title">{{ item.title }}</span>
              </div>
              <div v-if="item.excerpt" class="kb-excerpt">{{ item.excerpt }}</div>
              <div class="kb-meta">
                <span>来源 {{ item.source_id }}</span>
                <span class="sep" />
                <span>应用 {{ item.app_id || '-' }}</span>
                <span class="sep" />
                <span>更新 {{ fmtTime(item.updated_at) }}</span>
              </div>
            </div>
            <div class="kb-right">
              <div v-if="pct(item.score)" class="kb-sim">
                <div class="sim-track"><div class="sim-fill" :style="{ width: pct(item.score) }" /></div>
                <span class="sim-pct">{{ pct(item.score) }}</span>
              </div>
              <span v-else class="sim-pct muted">—</span>
              <el-button size="small" text type="primary" @click.stop="openDetail(item)">查看原文 →</el-button>
            </div>
          </div>
        </div>

        <div v-if="!state.search.trim() && state.total > state.page * state.pageSize" class="more-row">
          <el-button text type="primary" :loading="state.loading" @click="state.page++; load()">加载更多</el-button>
        </div>
      </section>
    </div>

    <!-- 详情抽屉 -->
    <el-drawer v-model="drawer.open" title="知识详情" size="min(480px, 92vw)">
      <div v-if="drawer.loading" class="loading-row"><el-icon class="is-loading"><Refresh /></el-icon> 原文加载中…</div>
      <el-alert v-else-if="drawer.error" type="warning" title="该知识已不存在或加载失败" :description="drawer.error" show-icon />
      <template v-else-if="drawer.chunk">
        <div class="detail-grid">
          <span class="k">类型</span><span><el-tag size="small" effect="plain">{{ drawer.chunk.source_type }}</el-tag></span>
          <span class="k">来源</span><span class="mono">{{ drawer.chunk.source_id }}</span>
          <span class="k">应用</span><span>{{ drawer.chunk.app_id || '-' }}</span>
          <span class="k">更新时间</span><span>{{ fmtTime(drawer.chunk.updated_at) }}</span>
        </div>
        <h4 class="src-label">原文</h4>
        <pre class="source-code">{{ drawer.chunk.text }}</pre>
      </template>
      <template #footer>
        <el-button @click="drawer.open = false">关闭</el-button>
        <el-button v-if="drawer.chunk" type="danger" plain :loading="drawer.loading" @click="deleteSource">删除该来源</el-button>
      </template>
    </el-drawer>

    <!-- 新建 runbook -->
    <el-dialog v-model="rbDialog.open" title="新建 runbook（排障手册）" width="min(560px, 94vw)">
      <el-form label-position="top">
        <el-form-item label="来源方式">
          <div class="src-method">
            <button type="button" class="src-method-btn" :class="{ active: rbDialog.method === 'manual' }" @click="setMethod('manual')">手动编写</button>
            <button type="button" class="src-method-btn" :class="{ active: rbDialog.method === 'upload' }" @click="setMethod('upload')">上传文件</button>
            <button type="button" class="src-method-btn" :class="{ active: rbDialog.method === 'url' }" @click="setMethod('url')">在线链接</button>
          </div>
        </el-form-item>

        <el-form-item v-if="rbDialog.method !== 'url'" label="标题" required>
          <el-input v-model="rbDialog.title" placeholder="如：生产环境白屏应急排障手册" />
        </el-form-item>
        <el-form-item v-if="rbDialog.method === 'url'" label="在线链接" required>
          <el-input v-model="rbDialog.url" placeholder="https://wiki.example.com/runbooks/white-screen 或公开文档页" />
          <p class="form-hint">服务端将抓取页面正文并按标题切分入库；仅支持公开可访问的 http(s) 页面（30s 超时、1MB 上限，瞬时失败自动重试一次），私有页面（需登录的 Confluence/Notion）暂不支持。若反复超时，可改用「上传文件」方式。</p>
        </el-form-item>
        <el-form-item v-if="rbDialog.method === 'upload'" label="上传 Markdown / 文本">
          <label class="upload-zone">
            <input type="file" accept=".md,.markdown,.txt,text/plain,text/markdown" hidden @change="onFileChange">
            <template v-if="rbDialog.fileName">
              已选择：<strong>{{ rbDialog.fileName }}</strong>（点击可重新选择）
            </template>
            <template v-else>拖拽或点击选择 .md / .txt 文件（≤1MB），内容将回显在下方正文供校正</template>
          </label>
        </el-form-item>
        <el-form-item label="适用应用（可选，默认 global）">
          <el-select v-model="rbDialog.appId" clearable placeholder="global" style="width:100%">
            <el-option label="app_web_production" value="app_web_production" />
            <el-option label="app_mobile_h5" value="app_mobile_h5" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="rbDialog.method !== 'url'" label="正文（Markdown / 纯文本，按标题自动切分入库）" required>
          <el-input
            v-model="rbDialog.text"
            type="textarea"
            :rows="10"
            placeholder="## 现象&#10;页面白屏，控制台报 ChunkLoadError&#10;&#10;## 根因&#10;CDN 资源未发布 / 路由懒加载 chunk 404&#10;&#10;## 解法&#10;回滚发布或重新构建并刷新 CDN 缓存"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="rbDialog.open = false">取消</el-button>
        <el-button type="primary" :loading="rbDialog.saving" @click="submitRunbook">{{ rbDialog.method === 'url' ? '抓取并索引' : '上传并索引' }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.kb-page { display: flex; flex-direction: column; gap: 20px; }
.page-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.page-header h2 { font-size: 22px; font-weight: 700; margin: 0; }
.page-header p { margin: 4px 0 0; color: var(--el-text-color-secondary); font-size: 14px; }
.page-actions { display: flex; gap: 10px; }

.stats-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 14px; }
.stat-card { background: var(--surface, #fff); border: 1px solid var(--el-border-color-lighter); border-radius: 12px; padding: 16px 18px; box-shadow: 0 1px 2px rgba(16,24,40,.04); }
.stat-label { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--el-text-color-secondary); }
.stat-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.stat-value { margin-top: 8px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 26px; font-weight: 700; letter-spacing: -.5px; }
.stat-meta { margin-top: 3px; font-size: 12px; color: var(--el-text-color-placeholder); }

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

.list-toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.search-box { flex: 1; display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 12px; border: 1px solid var(--el-border-color); border-radius: 10px; background: var(--surface, #fff); }
.search-box:focus-within { border-color: var(--el-color-primary); box-shadow: 0 0 0 3px rgba(79,70,229,.15); }
.search-box input { flex: 1; border: none; outline: none; background: transparent; font-size: 13.5px; color: var(--el-text-color-primary); font-family: inherit; }
.sim-help { color: var(--el-text-color-placeholder); cursor: help; }

.kb-list { display: flex; flex-direction: column; gap: 10px; }
.kb-card { position: relative; display: flex; align-items: stretch; gap: 14px; background: var(--surface, #fff); border: 1px solid var(--el-border-color-lighter); border-radius: 12px; padding: 13px 16px 13px 18px; cursor: pointer; box-shadow: 0 1px 2px rgba(16,24,40,.04); transition: all .15s ease; }
.kb-card:hover { box-shadow: 0 1px 2px rgba(16,24,40,.04), 0 6px 20px rgba(16,24,40,.08); border-color: #c8cdf5; transform: translateY(-1px); }
.kb-bar { position: absolute; left: 0; top: 13px; bottom: 13px; width: 4px; border-radius: 0 4px 4px 0; }
.kb-body { flex: 1; min-width: 0; }
.kb-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.kb-tag { padding: 1px 8px; border-radius: 6px; font-size: 11.5px; font-weight: 600; line-height: 1.7; }
.kb-title { font-size: 14.5px; font-weight: 600; word-break: break-word; }
.kb-excerpt { margin-top: 3px; font-size: 12.5px; color: var(--el-text-color-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-meta { display: flex; align-items: center; gap: 8px; margin-top: 5px; color: var(--el-text-color-placeholder); font-size: 12px; flex-wrap: wrap; word-break: break-all; }
.sep { width: 3px; height: 3px; border-radius: 50%; background: currentColor; opacity: .5; }
.kb-right { display: flex; flex-direction: column; align-items: flex-end; justify-content: space-between; gap: 6px; min-width: 120px; flex-shrink: 0; }
.kb-sim { display: flex; align-items: center; gap: 8px; }
.sim-track { width: 60px; height: 5px; border-radius: 3px; background: var(--el-fill-color); overflow: hidden; }
.sim-fill { height: 100%; border-radius: 3px; background: linear-gradient(90deg, #6366f1, #0ea5e9); }
.sim-pct { font-size: 12px; font-weight: 600; color: var(--el-text-color-secondary); font-family: ui-monospace, Menlo, Consolas, monospace; }
.sim-pct.muted { color: var(--el-text-color-placeholder); }

.empty-state { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 52px 20px; background: var(--surface, #fff); border: 1.5px dashed var(--el-border-color); border-radius: 12px; gap: 6px; }
.empty-state h4 { margin: 0; font-size: 15px; }
.empty-state p { margin: 0 0 12px; font-size: 13px; color: var(--el-text-color-placeholder); max-width: 320px; }
.loading-row { display: flex; align-items: center; gap: 8px; padding: 28px 0; color: var(--el-text-color-secondary); justify-content: center; }
.more-row { display: flex; justify-content: center; margin-top: 12px; }
.mb12 { margin-bottom: 12px; }

.detail-grid { display: grid; grid-template-columns: 80px 1fr; gap: 8px 12px; font-size: 13px; }
.detail-grid .k { color: var(--el-text-color-placeholder); }
.detail-grid .mono { font-family: ui-monospace, Menlo, Consolas, monospace; word-break: break-all; }
.src-label { margin: 16px 0 8px; font-size: 14px; }
.source-code { background: #0f172a; color: #e2e8f0; padding: 15px 17px; border-radius: 10px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px; line-height: 1.68; white-space: pre-wrap; word-break: break-word; max-height: 46vh; overflow-y: auto; margin: 0; }

@media (max-width: 1100px) {
  .stats-grid { grid-template-columns: repeat(2, 1fr); }
  .two-col { grid-template-columns: 1fr; }
  .filter-panel { position: static; }
}
@media (max-width: 720px) { .stats-grid { grid-template-columns: 1fr; } }

.src-method { display: inline-flex; gap: 2px; padding: 3px; background: var(--el-fill-color-light); border-radius: 9px; }
.src-method-btn { border: none; background: transparent; padding: 7px 16px; border-radius: 7px; font-size: 13px; font-weight: 500; color: var(--el-text-color-regular); cursor: pointer; transition: all .12s ease; font-family: inherit; }
.src-method-btn:hover { color: var(--el-text-color-primary); }
.src-method-btn.active { background: var(--surface, #fff); color: var(--el-color-primary); font-weight: 600; box-shadow: 0 1px 2px rgba(16,24,40,.08); }
.upload-zone { display: block; width: 100%; border: 1.5px dashed #cdd3df; border-radius: 10px; padding: 22px; text-align: center; color: var(--el-text-color-placeholder); font-size: 13px; cursor: pointer; transition: all .15s ease; line-height: 1.6; }
.upload-zone:hover { border-color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.form-hint { font-size: 12px; color: var(--el-text-color-placeholder); margin: 6px 0 0; line-height: 1.5; }
</style>
