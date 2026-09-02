<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  Search, Reading, Warning, Star, Document, ThumbsUp, ThumbsDown, Close, Collection
} from '@element-plus/icons-vue'
import { api } from '../../../dashboard.js'
import { useFilterStore } from '../../../stores/filters.js'

const filterStore = useFilterStore()

const TYPE_META = {
  issue:   { label: 'issue',   color: '#0ea5e9' },
  doc:     { label: 'doc',     color: '#10b981' },
  runbook: { label: 'runbook', color: '#8b5cf6' },
  faq:     { label: 'faq',     color: '#f59e0b' },
  feedback:{ label: 'feedback',color: '#f59e0b' }
}

const HELP_CATS = [
  { key: 'all', label: '全部', icon: Collection },
  { key: 'start', label: '入门接入', icon: Reading },
  { key: 'trouble', label: '故障排障', icon: Warning },
  { key: 'best', label: '最佳实践', icon: Star },
  { key: 'faq', label: '常见问题', icon: Document }
]
const CAT_TYPE_MAP = {
  start: ['doc', 'faq'],
  trouble: ['issue', 'runbook'],
  best: ['runbook', 'doc'],
  faq: ['faq']
}

const state = reactive({ loading: false, error: '', items: [], total: 0 })
const helpCat = ref('all')
const helpSearch = ref('')
const helpArticle = ref(null)
const semantic = ref(null) // 语义检索结果（覆盖分类浏览）

const VIS_LABEL = { public: '公开', internal: '内部' }
function pct(x) {
  if (x == null) return null
  const n = Number(x)
  if (!Number.isFinite(n)) return null
  return `${Math.round(n * 100)}%`
}
function fmtTime(ts) {
  if (!ts) return '-'
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return String(ts)
  const d = new Date(n)
  const p = v => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function toArticle(r) {
  return {
    id: r.id,
    source_type: r.source_type,
    source_id: r.source_id,
    title: r.title,
    excerpt: r.excerpt || String(r.body || '').slice(0, 120),
    updatedAt: Number(r.updatedAt || r.updated_at || 0),
    visibility: r.visibility || 'public',
    quality: r.quality || { aiCitations: null, helpfulRate: null, feedbackCount: 0 },
    body: r.body || null,
    legacy: r.legacy || false,
    score: r.score ?? null
  }
}

async function load() {
  state.loading = true
  state.error = ''
  try {
    const data = await api('/api/ai/kb/articles?publicOnly=1&pageSize=200', { requestKey: 'help:list' })
    state.items = (data?.items || []).map(toArticle)
    state.total = Number(data?.total ?? state.items.length)
  } catch (e) {
    state.error = e?.message || '帮助中心加载失败'
  } finally {
    state.loading = false
  }
}

const helpItems = computed(() => {
  const base = semantic.value || state.items
  if (semantic.value) return base // 语义检索结果直接展示
  if (helpCat.value === 'all') return base
  const types = CAT_TYPE_MAP[helpCat.value] || []
  return base.filter(i => types.includes(i.source_type))
})

let searchTimer = null
async function onHelpSearch() {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(async () => {
    const q = helpSearch.value.trim()
    if (!q) { semantic.value = null; return }
    try {
      const data = await api(`/api/ai/kb/search?publicOnly=1&q=${encodeURIComponent(q)}`, { requestKey: 'help:search' })
      const results = (data?.results || []).map(r => toArticle({
        id: r.source_id, source_type: r.source_type, source_id: r.source_id,
        title: r.metadata?.title || r.source_id, body: r.text, updated_at: r.updated_at, score: r.score ?? null
      }))
      semantic.value = results
    } catch {
      semantic.value = null
    }
  }, 300)
}

async function openArticle(item) {
  const a = { ...item }
  if (!a.body) {
    try {
      const data = await api(`/api/ai/kb/article/${encodeURIComponent(item.id)}`, { requestKey: `help:article:${item.id}` })
      a.body = data?.body || ''
      a.quality = data?.quality || a.quality
      a.updatedAt = data?.updatedAt || a.updatedAt
    } catch {
      a.body = a.excerpt || '（暂无正文）'
    }
  }
  helpArticle.value = a
}
function backHelp() { helpArticle.value = null }

const fbDialog = reactive({ open: false, submitting: false, note: '', target: null })
function openFeedback(item) { fbDialog.target = item; fbDialog.note = ''; fbDialog.open = true }
function markHelpful(item, ok) {
  if (ok) ElMessage.success('感谢反馈，已记录为「有用」')
  else openFeedback(item)
}
async function depositFeedback() {
  const t = fbDialog.target
  if (!t) return
  fbDialog.submitting = true
  try {
    await api(`/api/ai/kb/article/${encodeURIComponent(t.id)}/feedback`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ helpful: false, note: fbDialog.note.trim(), deposit: true })
    })
    ElMessage.info('已沉淀为反馈草稿，待专家审核补充进知识')
  } catch (e) {
    ElMessage.warning(`反馈已本地记录，后端接口暂未接入：${e?.message || '接口不存在'}`)
  } finally {
    fbDialog.submitting = false
    fbDialog.open = false
    helpArticle.value = null
  }
}

function inlineMd(s) { return String(s).replace(/`([^`]+)`/g, '<code>$1</code>') }
function renderMd(md) {
  const lines = String(md || '').split('\n')
  let html = '', list = []
  const flush = () => { if (list.length) { html += '<ul>' + list.map(l => `<li>${inlineMd(l)}</li>`).join('') + '</ul>'; list = [] } }
  for (const line of lines) {
    if (/^### /.test(line)) { flush(); html += `<h3>${inlineMd(line.slice(4))}</h3>` }
    else if (/^## /.test(line)) { flush(); html += `<h3>${inlineMd(line.slice(3))}</h3>` }
    else if (/^- /.test(line)) { list.push(line.slice(2)) }
    else if (line.trim() === '') { flush() }
    else { flush(); html += `<p>${inlineMd(line)}</p>` }
  }
  flush()
  return html
}

onMounted(load)
</script>

<template>
  <div class="help-page">
    <div class="page-header">
      <div>
        <h2>帮助中心</h2>
        <p>面向开发者与终端用户的可读知识库。同一份知识由内部治理台维护，这里只展示已公开的解决方案与接入指南。</p>
      </div>
    </div>

    <div v-if="!helpArticle" class="help-hero">
      <div>
        <h3>遇到问题？先搜搜看</h3>
        <p>如「白屏怎么办」「ChunkLoadError 怎么处理」「如何接入 SDK」。</p>
      </div>
      <div class="search-box hero-search">
        <el-icon><Search /></el-icon>
        <input v-model="helpSearch" placeholder="搜索问题，如：白屏怎么办？" @input="onHelpSearch" />
      </div>
    </div>

    <template v-if="!helpArticle">
      <div v-if="state.error" class="empty-state">
        <h4>帮助中心加载失败</h4>
        <p>{{ state.error }}</p>
        <el-button size="small" @click="load">重试</el-button>
      </div>
      <div v-else-if="state.loading" class="loading-row"><el-icon class="is-loading"><Search /></el-icon> 加载中…</div>
      <div v-else-if="!helpItems.length" class="empty-state">
        <h4>{{ semantic ? '没有匹配的公开文章' : '该分类下暂无公开知识' }}</h4>
        <p>{{ semantic ? '换个关键词试试。' : '内部知识需先在治理台设为「公开」。' }}</p>
      </div>
      <div v-else class="help-cols">
        <aside class="cat-list">
          <button v-for="c in HELP_CATS" :key="c.key" type="button" class="cat-item" :class="{ active: helpCat === c.key && !semantic }" @click="helpCat = c.key; semantic = null">
            <el-icon><component :is="c.icon" /></el-icon>{{ c.label }}
          </button>
          <div v-if="semantic" class="sem-hint"><el-icon><Search /></el-icon> 语义检索结果</div>
        </aside>
        <section>
          <div class="help-grid">
            <div v-for="a in helpItems" :key="a.id" class="help-card" @click="openArticle(a)">
              <h4>
                <span class="kb-tag" :style="{ background: `${TYPE_META[a.source_type]?.color || '#4f46e5'}1a`, color: TYPE_META[a.source_type]?.color || '#4f46e5' }">{{ a.source_type }}</span>
                {{ a.title }}
              </h4>
              <p>{{ a.excerpt }}</p>
              <div class="hm">
                <span>{{ VIS_LABEL[a.visibility] }}</span>
                <span v-if="a.quality?.helpfulRate != null">有用率 {{ pct(a.quality.helpfulRate) }}</span>
                <span v-if="a.quality?.aiCitations">被 AI 引用 {{ a.quality.aiCitations }} 次</span>
                <span v-if="a.score != null" class="sim">相关度 {{ pct(a.score) }}</span>
              </div>
            </div>
          </div>
        </section>
      </div>
    </template>

    <div v-else class="help-reader">
      <el-button text :icon="Close" class="back-btn" @click="backHelp">返回帮助中心</el-button>
      <div class="help-card reader-card">
        <div class="reader">
          <h2>{{ helpArticle.title }}</h2>
          <div class="rmeta">
            <span class="kb-tag" :style="{ background: `${TYPE_META[helpArticle.source_type]?.color || '#4f46e5'}1a`, color: TYPE_META[helpArticle.source_type]?.color || '#4f46e5' }">{{ helpArticle.source_type }}</span>
            <span>来源 {{ helpArticle.source_id }}</span>
            <span>更新 {{ fmtTime(helpArticle.updatedAt) }}</span>
            <span>{{ VIS_LABEL[helpArticle.visibility] }}</span>
          </div>
          <div class="md" v-html="renderMd(helpArticle.body)" />
          <div class="feedback-bar">
            <span class="ft">这条对你有帮助吗？</span>
            <el-button class="fb-btn up" :icon="ThumbsUp" @click="markHelpful(helpArticle, true)">有用</el-button>
            <el-button class="fb-btn down" :icon="ThumbsDown" @click="markHelpful(helpArticle, false)">没用</el-button>
          </div>
        </div>
      </div>
    </div>

    <el-dialog v-model="fbDialog.open" title="这条没帮到你？" width="min(480px, 94vw)">
      <p style="font-size:13.5px;color:var(--el-text-color-secondary);margin:0 0 12px">
        可一键沉淀为<strong>反馈草稿</strong>，待专家审核后补充进知识，避免别人再踩同样的坑。
      </p>
      <el-input v-model="fbDialog.note" type="textarea" :rows="4" placeholder="补充说明（可选），例如：期望看到 CDN 刷新的具体命令…" />
      <template #footer>
        <el-button @click="fbDialog.open = false">取消</el-button>
        <el-button type="primary" :loading="fbDialog.submitting" @click="depositFeedback">沉淀为反馈草稿</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.help-page { display: flex; flex-direction: column; gap: 16px; }
.page-header h2 { font-size: 22px; font-weight: 700; margin: 0; }
.page-header p { margin: 4px 0 0; color: var(--el-text-color-secondary); font-size: 14px; }
.help-hero { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; background: linear-gradient(120deg, var(--el-color-primary-light-9), var(--surface, #fff)); border: 1px solid var(--el-border-color-lighter); border-radius: 14px; padding: 20px 24px; }
.help-hero h3 { margin: 0; font-size: 19px; font-weight: 800; }
.help-hero p { margin: 5px 0 0; color: var(--el-text-color-secondary); font-size: 13px; max-width: 560px; }
.search-box { display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 12px; border: 1px solid var(--el-border-color); border-radius: 10px; background: var(--surface, #fff); }
.search-box:focus-within { border-color: var(--el-color-primary); box-shadow: 0 0 0 3px rgba(79,70,229,.15); }
.search-box .el-icon { color: var(--el-text-color-placeholder); }
.search-box input { flex: 1; border: none; outline: none; background: transparent; font-size: 13.5px; color: var(--el-text-color-primary); font-family: inherit; }
.hero-search { flex: 0 0 360px; }

.help-cols { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 18px; align-items: start; }
.cat-list { background: var(--surface, #fff); border: 1px solid var(--el-border-color-lighter); border-radius: 12px; padding: 10px; position: sticky; top: 84px; box-shadow: 0 1px 2px rgba(16,24,40,.04); }
.cat-item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 11px; border: none; background: transparent; border-radius: 9px; color: var(--el-text-color-regular); font-size: 13.5px; font-weight: 500; text-align: left; cursor: pointer; transition: .12s; font-family: inherit; }
.cat-item .el-icon { font-size: 16px; }
.cat-item:hover { background: var(--el-fill-color-light); color: var(--el-color-primary); }
.cat-item.active { background: var(--el-color-primary-light-9); color: var(--el-color-primary); font-weight: 600; }
.sem-hint { display: flex; align-items: center; gap: 6px; margin-top: 10px; padding: 8px 11px; font-size: 12px; color: var(--el-text-color-placeholder); border-top: 1px solid var(--el-border-color-extra-light); }

.help-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.help-card { background: var(--surface, #fff); border: 1px solid var(--el-border-color-lighter); border-radius: 12px; padding: 15px 17px; cursor: pointer; box-shadow: 0 1px 2px rgba(16,24,40,.04); transition: all .15s; }
.help-card:hover { box-shadow: 0 1px 2px rgba(16,24,40,.04), 0 6px 20px rgba(16,24,40,.08); border-color: #c8cdf5; transform: translateY(-1px); }
.help-card h4 { margin: 0 0 6px; font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.help-card p { margin: 0; font-size: 12.5px; color: var(--el-text-color-secondary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.help-card .hm { margin-top: 9px; display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--el-text-color-placeholder); flex-wrap: wrap; }
.help-card .hm .sim { color: var(--el-color-primary); font-weight: 600; }
.kb-tag { padding: 1px 8px; border-radius: 6px; font-size: 11.5px; font-weight: 600; line-height: 1.7; white-space: nowrap; }

.reader-card { cursor: default; }
.reader h2 { margin: 0 0 4px; font-size: 22px; font-weight: 800; }
.reader .rmeta { display: flex; align-items: center; gap: 10px; color: var(--el-text-color-placeholder); font-size: 12.5px; margin-bottom: 14px; flex-wrap: wrap; }
.help-reader .back-btn { margin-bottom: 12px; }
.md :deep(h3) { font-size: 16px; font-weight: 700; margin: 18px 0 6px; }
.md :deep(p) { margin: 0 0 10px; font-size: 14px; line-height: 1.7; color: var(--el-text-color-primary); }
.md :deep(ul) { margin: 0 0 12px; padding-left: 20px; }
.md :deep(li) { margin: 3px 0; font-size: 14px; line-height: 1.6; }
.md :deep(code) { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px; background: var(--el-fill-color); padding: 1px 6px; border-radius: 5px; }
.feedback-bar { display: flex; align-items: center; gap: 12px; margin-top: 18px; padding: 14px 16px; border: 1px solid var(--el-border-color); border-radius: 12px; background: var(--el-fill-color-light); }
.feedback-bar .ft { font-size: 13.5px; font-weight: 600; }
.fb-btn.up:hover, .fb-btn.up:focus { color: #10b981; border-color: #10b981; }
.fb-btn.down:hover, .fb-btn.down:focus { color: #ef4444; border-color: #ef4444; }

.empty-state { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 52px 20px; background: var(--surface, #fff); border: 1.5px dashed var(--el-border-color); border-radius: 12px; gap: 6px; }
.empty-state h4 { margin: 0; font-size: 15px; }
.empty-state p { margin: 0 0 12px; font-size: 13px; color: var(--el-text-color-placeholder); max-width: 320px; }
.loading-row { display: flex; align-items: center; gap: 8px; padding: 28px 0; color: var(--el-text-color-secondary); justify-content: center; }

@media (max-width: 1180px) {
  .help-cols { grid-template-columns: 1fr; }
  .cat-list { position: static; }
}
@media (max-width: 760px) {
  .help-grid { grid-template-columns: 1fr; }
  .hero-search { flex: 1 1 100%; }
}
</style>
