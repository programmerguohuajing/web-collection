<script setup>
import { computed, ref } from 'vue'
import { formatDuration } from '../utils/format.js'
import OverflowTip from './OverflowTip.vue'

/**
 * 前端请求 / 响应查看器
 * 数据来源：调用方传入该 trace 下的全部 events（来自 /api/traces/:traceId），
 * 本组件筛选 metric ∈ {fetch, xhr, fetch_body, xhr_body} 并关联展示。
 */
const props = defineProps({
  events: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' }
})

const REQ_METRICS = ['fetch', 'xhr']
const BODY_METRICS = ['fetch_body', 'xhr_body']

// 过滤 UI 状态
const keyword = ref('')
const methodFilter = ref('ALL')
const statusFilter = ref('ALL')

const methodOptions = ['ALL', 'GET', 'POST', 'PUT', 'DELETE']
const statusOptions = [
  { value: 'ALL', label: '全部状态' },
  { value: 'ERROR', label: '≥400' },
  { value: 'OK', label: '2xx' }
]

// 关联主事件(fetch/xhr)与正文事件(fetch_body/xhr_body)，按 URL 关联
const merged = computed(() => {
  const list = Array.isArray(props.events) ? props.events : []
  const bodyByUrl = new Map()
  for (const ev of list) {
    if (BODY_METRICS.includes(ev.metric) && ev.props?.url) {
      bodyByUrl.set(ev.props.url, ev) // 后到的覆盖先到的（同 URL 多请求取最后一个，v1 简化）
    }
  }
  const rows = []
  const consumedBodyUrls = new Set()
  for (const ev of list) {
    if (!REQ_METRICS.includes(ev.metric)) continue
    const url = ev.props?.url
    const body = url ? bodyByUrl.get(url) : undefined
    if (body) consumedBodyUrls.add(url)
    rows.push({ main: ev, body, url, method: ev.props?.method || (body?.props?.method) || 'GET' })
  }
  // 未被主事件覆盖的孤立正文事件（如仅采样到 body 而无 timing）
  for (const [url, body] of bodyByUrl) {
    if (consumedBodyUrls.has(url)) continue
    rows.push({ main: null, body, url, method: body.props?.method || 'GET' })
  }
  return rows
})

const filteredRows = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return merged.value.filter(r => {
    if (kw && !(r.url || '').toLowerCase().includes(kw)) return false
    if (methodFilter.value !== 'ALL' && (r.method || '').toUpperCase() !== methodFilter.value) return false
    if (statusFilter.value !== 'ALL') {
      const s = Number(r.body?.props?.status ?? r.main?.props?.status)
      if (statusFilter.value === 'ERROR' && !(s >= 400)) return false
      if (statusFilter.value === 'OK' && !(s >= 200 && s < 300)) return false
    }
    return true
  })
})

const summary = computed(() => {
  const rows = merged.value
  const total = rows.length
  const errorCount = rows.filter(r => Number(r.body?.props?.status ?? r.main?.props?.status) >= 400).length
  const durations = rows.map(r => Number(r.main?.value)).filter(v => Number.isFinite(v))
  const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0
  const withBody = rows.filter(r => (r.body?.props?.responseBody ?? '').trim()).length
  return { total, errorCount, avg, withBody }
})

function statusType(status) {
  const v = Number(status)
  if (!Number.isFinite(v) || !v) return 'info'
  if (v >= 500) return 'danger'
  if (v >= 400) return 'warning'
  if (v >= 200) return 'success'
  return 'info'
}
function timeLabel(ts) {
  const n = Number(ts)
  if (!n) return '-'
  const d = new Date(n)
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleTimeString()
}
function shortUrl(url = '') {
  try { return new URL(url, location.href).pathname + new URL(url, location.href).search } catch { return url }
}
function hasBody(r) {
  return Boolean((r.body?.props?.responseBody ?? '').trim())
}
function rowKey(r) {
  return `${r.url}|${r.main?.ts ?? ''}|${r.body?.ts ?? ''}`
}

// 详情抽屉
const detail = ref(null)
const drawerOpen = ref(false)
function openDetail(row) {
  detail.value = row
  drawerOpen.value = true
}
function closeDetail() { drawerOpen.value = false }

function isTruncated(text = '') {
  return text.includes('[TRUNCATED]')
}
function bodyStats(r) {
  const status = r.body?.props?.status ?? r.main?.props?.status
  const duration = r.main?.value
  const size = r.main?.props?.responseSize
  const ttfb = r.main?.props?.ttfb
  const dns = r.main?.props?.dns
  const tcp = r.main?.props?.tcp
  const sampled = r.body?.props?.bodySampled
  return { status, duration, size, ttfb, dns, tcp, sampled }
}

// 安全的 JSON 高亮（先整体转义，再包裹 span，杜绝 XSS）
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
function highlightJson(value) {
  let json
  try { json = JSON.stringify(value, null, 2) } catch { json = String(value) }
  if (json == null) json = 'null'
  const esc = escapeHtml(json)
  return esc.replace(
    /(&quot;(?:\\.|[^&]|&(?!quot;))*?&quot;(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = 'num'
      if (/^&quot;/.test(match)) cls = /:$/.test(match) ? 'key' : 'str'
      return `<span class="${cls}">${match}</span>`
    }
  )
}
function prettyBody(text) {
  if (!text) return ''
  // 尝试美化（若本身是 JSON 字符串）
  try {
    const parsed = JSON.parse(text)
    return highlightJson(parsed)
  } catch {
    return escapeHtml(text)
  }
}
</script>

<template>
  <el-card class="rr-card" shadow="never">
    <template #header>
      <div class="card-head">
        <div>
          <h2>前端请求 / 响应</h2>
          <p>该会话采集到的接口调用与响应正文 · 需开启 requestBodySampling 才有响应内容</p>
        </div>
        <span class="rr-count tag info">{{ summary.total }} 条</span>
      </div>
    </template>

    <el-alert v-if="error" type="error" :title="error" show-icon :closable="false" class="rr-error" />
    <template v-else>
      <!-- 统计 -->
      <div class="chips">
        <div class="chip"><span class="k">总请求</span><span class="v">{{ summary.total }}</span></div>
        <div class="chip"><span class="k">错误响应</span><span class="v" :class="summary.errorCount ? 'danger' : ''">{{ summary.errorCount }}</span></div>
        <div class="chip"><span class="k">平均耗时</span><span class="v">{{ summary.avg }}<span class="unit"> ms</span></span></div>
        <div class="chip"><span class="k">含响应正文</span><span class="v ok">{{ summary.withBody }}</span></div>
      </div>

      <!-- 工具栏 -->
      <div class="toolbar">
        <div class="search">
          <span>🔍</span>
          <input v-model="keyword" placeholder="按接口路径搜索，如 /api/order" />
        </div>
        <div class="seg">
          <button v-for="m in methodOptions" :key="m" :class="{ active: methodFilter === m }" @click="methodFilter = m">
            {{ m === 'ALL' ? '全部' : m }}
          </button>
        </div>
        <div class="seg">
          <button v-for="s in statusOptions" :key="s.value" :class="{ active: statusFilter === s.value }" @click="statusFilter = s.value">
            {{ s.label }}
          </button>
        </div>
      </div>

      <!-- 列表 -->
      <el-table
        v-loading="loading"
        :data="filteredRows"
        :row-key="rowKey"
        empty-text="当前 Trace 暂无前端请求事件"
        class="rr-table"
        @row-click="openDetail"
      >
        <el-table-column label="时间" width="92">
          <template #default="{ row }"><span class="mono muted">{{ timeLabel(row.main?.ts ?? row.body?.ts) }}</span></template>
        </el-table-column>
        <el-table-column label="接口" min-width="280">
          <template #default="{ row }"><OverflowTip :text="shortUrl(row.url)" class="mono url" /></template>
        </el-table-column>
        <el-table-column label="方法" width="76">
          <template #default="{ row }"><span class="method">{{ row.method }}</span></template>
        </el-table-column>
        <el-table-column label="状态" width="84">
          <template #default="{ row }">
            <el-tag v-if="(row.body?.props?.status ?? row.main?.props?.status)" :type="statusType(row.body?.props?.status ?? row.main?.props?.status)" effect="light" size="small">
              {{ row.body?.props?.status ?? row.main?.props?.status }}
            </el-tag>
            <span v-else class="muted">-</span>
          </template>
        </el-table-column>
        <el-table-column label="耗时" width="92">
          <template #default="{ row }"><span class="mono">{{ row.main?.value != null ? formatDuration(row.main.value) : '-' }}</span></template>
        </el-table-column>
        <el-table-column label="响应正文" width="96">
          <template #default="{ row }">
            <span v-if="hasBody(row)" class="has-body"><span class="dot"></span>有</span>
            <span v-else class="has-body no"><span class="dot"></span>—</span>
          </template>
        </el-table-column>
      </el-table>
      <div class="legend">点击任意一行查看「请求 + 响应」详情。状态 ≥400 的响应默认强制采集正文；2xx 仅在 requestBodySampling 命中采样时采集。</div>
    </template>

    <!-- 详情抽屉 -->
    <el-drawer v-model="drawerOpen" :title="detail ? '请求 / 响应详情' : ''" size="min(540px, 94vw)" @closed="closeDetail">
      <template v-if="detail">
        <div class="meta">
          <div class="m"><span class="k">状态码</span><span class="v" :style="{ color: (detail.body?.props?.status ?? detail.main?.props?.status) >= 400 ? '#dc2626' : '#16a34a' }">{{ (detail.body?.props?.status ?? detail.main?.props?.status) || '-' }}</span></div>
          <div class="m"><span class="k">耗时</span><span class="v">{{ detail.main?.value != null ? detail.main.value + ' ms' : '-' }}</span></div>
          <div class="m"><span class="k">响应大小</span><span class="v">{{ detail.main?.props?.responseSize ? detail.main.props.responseSize + ' B' : '-' }}</span></div>
          <div class="m"><span class="k">采样</span><span class="v">{{ detail.body?.props?.bodySampled ? '命中' : (detail.body ? '错误强制' : '未采集') }}</span></div>
        </div>

        <!-- 请求 -->
        <div class="section">
          <div class="section-title"><span class="bar"></span>请求 Request <span class="tag info">{{ detail.method }}</span></div>
          <pre class="code" v-html="highlightJson({ url: detail.url, method: detail.method, requestBody: detail.body?.props?.requestBody ?? null })" />
          <div v-if="detail.body" class="notice sensitive"><span class="ic">ⓘ</span><span>请求头中的 token / authorization 等凭据字段已在采集层与服务端脱敏，不会原样存储。</span></div>
        </div>

        <!-- 响应 -->
        <div class="section">
          <div class="section-title"><span class="bar"></span>响应 Response <span class="tag">{{ (detail.body?.props?.status ?? detail.main?.props?.status) || '-' }}</span></div>
          <div class="timing" v-if="detail.main">
            <div class="t" v-if="detail.main.props?.ttfb != null"><span class="k">TTFB</span><span class="v">{{ detail.main.props.ttfb }} ms</span></div>
            <div class="t" v-if="detail.main.props?.dns != null"><span class="k">DNS</span><span class="v">{{ detail.main.props.dns }} ms</span></div>
            <div class="t" v-if="detail.main.props?.tcp != null"><span class="k">TCP</span><span class="v">{{ detail.main.props.tcp }} ms</span></div>
          </div>
          <pre v-if="hasBody(detail)" class="code" v-html="prettyBody(detail.body.props.responseBody)" />
          <el-empty v-else description="未采集到响应正文（requestBodySampling 未开启，或该请求未命中采样 / 非文本响应）" :image-size="64" />
          <div v-if="hasBody(detail) && isTruncated(detail.body.props.responseBody)" class="notice trunc"><span class="ic">⚠</span><span>响应正文超过客户端 2KB 或服务端 1KB 上限已截断（标记 [TRUNCATED]）。完整内容请调大 requestBodySampling 对应阈值。</span></div>
        </div>
      </template>
    </el-drawer>
  </el-card>
</template>

<style scoped>
.rr-card { min-width: 0; border-color: #e8e9ef; border-radius: 14px; }
.rr-card :deep(.el-card__header) { padding: 18px 22px; border-bottom-color: #eceef3; }
.rr-card :deep(.el-card__body) { padding: 18px 22px; }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.card-head h2 { margin: 0; color: #202132; font-size: 15px; font-weight: 700; }
.card-head p { margin: 4px 0 0; color: #8b91a2; font-size: 12px; }
.rr-error { margin-bottom: 12px; }

.chips { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; }
.chip { display: flex; flex-direction: column; gap: 4px; min-width: 104px; padding: 11px 14px; border: 1px solid #eceef3; border-radius: 11px; background: #fafafd; }
.chip .k { font-size: 11px; color: #9298a8; }
.chip .v { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 16px; font-weight: 600; color: #292b3b; }
.chip .v.ok { color: #16a34a; }
.chip .v.danger { color: #dc2626; }
.chip .v .unit { font-size: 11px; color: #9298a8; }

.toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.search { flex: 1; min-width: 220px; display: flex; align-items: center; gap: 8px; padding: 8px 12px; border: 1px solid #e8e9ef; border-radius: 9px; background: #fff; color: #9298a8; font-size: 13px; }
.search input { border: 0; outline: 0; flex: 1; font: inherit; color: #171826; background: transparent; }
.seg { display: inline-flex; gap: 2px; padding: 3px; border: 1px solid #e2e4eb; border-radius: 9px; background: #f5f6f9; }
.seg button { border: 0; background: transparent; color: #707789; font: inherit; font-size: 12px; padding: 0 11px; min-height: 28px; border-radius: 7px; cursor: pointer; transition: background-color .16s ease, color .16s ease, box-shadow .16s ease; }
.seg button:hover { color: #4f46e5; }
.seg button.active { background: #fff; color: #4f46e5; box-shadow: 0 1px 4px rgba(31, 35, 48, .1); font-weight: 600; }

.rr-table { width: 100%; cursor: pointer; }
.rr-table :deep(.el-table__header th) { height: 44px; background: #fafafd; color: #777e90; font-size: 12px; font-weight: 650; }
.rr-table :deep(.el-table__row:hover > td) { background: #f7f7ff !important; }
.mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
.muted { color: #9298a8; }
.url { color: #3c4051; max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; vertical-align: middle; }
.url .path { color: #4f46e5; }
.method { display: inline-block; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-weight: 600; font-size: 12px; padding: 2px 8px; border-radius: 6px; background: #f1f2f7; color: #5b6172; }
.has-body { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: #16a34a; }
.has-body.no { color: #9298a8; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.rr-count { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.legend { margin-top: 10px; font-size: 11px; color: #9298a8; line-height: 1.6; }

/* 抽屉 */
.meta { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.meta .m { display: flex; flex-direction: column; gap: 3px; padding: 9px 12px; border: 1px solid #eceef3; border-radius: 9px; background: #fafafd; min-width: 88px; }
.meta .m .k { font-size: 11px; color: #9298a8; }
.meta .m .v { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; color: #3c4051; font-weight: 600; }

.section { margin-bottom: 18px; }
.section-title { display: flex; align-items: center; gap: 8px; margin: 0 0 9px; font-size: 13px; font-weight: 700; color: #3c4051; }
.section-title .bar { width: 3px; height: 14px; border-radius: 2px; background: #4f46e5; }
.section-title .tag { margin-left: auto; }

.code { margin: 0; background: #0f1320; color: #e6e9f2; border-radius: 11px; padding: 14px 16px; font-family: ui-monospace, SFMono-Regular, "JetBrains Mono", Consolas, monospace; font-size: 12px; line-height: 1.65; overflow: auto; max-height: 240px; white-space: pre; tab-size: 2; }
.code :deep(.key) { color: #7dd3fc; }
.code :deep(.str) { color: #a7f3a0; }
.code :deep(.num) { color: #fcd34d; }

.notice { display: flex; gap: 9px; align-items: flex-start; padding: 10px 13px; border-radius: 10px; font-size: 12px; line-height: 1.55; margin-top: 9px; }
.notice.trunc { background: #fef3e2; color: #92600a; }
.notice.sensitive { background: #efefff; color: #4f46e5; }
.notice .ic { font-weight: 700; }
</style>
