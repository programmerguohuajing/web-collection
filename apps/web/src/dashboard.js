import { computed, ref } from 'vue'
import { useFilterStore } from './stores/filters.js'

const apiBase = import.meta.env?.VITE_API_BASE || ''

export const loading = ref(false)
export const refreshVersion = ref(0)
export const tableLoading = ref({ events: false, errorEvents: false, perf: false, behavior: false, issues: false, replays: false })
export const pageLoading = ref(false)
// Shared request telemetry used by the shell to make slow responses visible.
// A request is considered slow after 800ms and is hard-aborted after 20s unless
// a caller supplies a shorter/longer timeout.
export const slowRequest = ref(false)
export const activeRequestCount = ref(0)
export const error = ref('')
export const summary = ref(null)
export const events = ref([])
export const errorEvents = ref([])
export const perfEvents = ref([])
export const behaviorEvents = ref([])
export const issues = ref([])
export const replays = ref([])
export const eventPager = ref({ page: 1, pageSize: 10, total: 0 })
export const errorEventPager = ref({ page: 1, pageSize: 10, total: 0 })
export const perfPager = ref({ page: 1, pageSize: 10, total: 0 })
export const behaviorPager = ref({ page: 1, pageSize: 10, total: 0 })
export const issuePager = ref({ page: 1, pageSize: 10, total: 0 })
export const replayPager = ref({ page: 1, pageSize: 10, total: 0 })
const replayCache = new Map()
const inflightRequests = new Map()
const slowRequestIds = new Set()
let requestSequence = 0
let refreshSequence = 0
const pageRequestSequence = new Map()

export const API_TIMEOUT_MS = 20000
export const API_SLOW_THRESHOLD_MS = 800

// 页面级搜索条件（应用 / 版本 / 时间范围属于顶部全局条件，见 stores/filters.js）。
// 这些字段在路由切换时会被重置（resetPageFilters），因此不会跨页面缓存。
export const filterDefaults = {
  traceId: '',
  path: '',
  userId: '',
  userName: '',
  userPhone: '',
  keyword: '',
  type: '',
  status: ''
}

export const filters = ref({ ...filterDefaults })

export const latestErrors = computed(() => issues.value.slice(0, 8))
export const byType = computed(() => Object.entries(summary.value?.byType || {}).map(([name, count]) => [typeLabel(name), count]))
export const behavior = computed(() => rankBehavior(summary.value?.behavior))

export function rankBehavior(source = {}) {
  const totals = new Map()
  for (const [name, count] of Object.entries(source || {})) {
    const label = behaviorLabel(name)
    totals.set(label, (totals.get(label) || 0) + Number(count || 0))
  }
  return [...totals].sort((a, b) => b[1] - a[1]).slice(0, 12)
}

export function queryFromFilters(extra = {}, names = null) {
  const store = useFilterStore()
  const f = {
    appId: store.appId,
    release: store.release,
    range: store.range,
    ...filters.value,
    ...extra
  }
  const params = new URLSearchParams()
  const [startTime, endTime] = f.range || []
  const values = { ...f, startTime, endTime }
  delete values.range
  // names 仅用于限制「自动注入的」store/filters 字段（避免把全局筛选 keyword/userId 等泄漏给不相关的端点）；
  // 调用方通过 extra 显式传入的自定义参数（如 dim / a / b / path / start / end）必须始终放行，
  // 否则会被静默丢弃——曾导致「按 SDK 版本」tab 实际查到应用版本 release_name(0.1.0)、A/B 对比与参与度详情失效等 bug。
  const allowed = names ? new Set([...names.filter(name => name !== 'range'), 'startTime', 'endTime', ...Object.keys(extra)]) : null
  Object.entries(values).forEach(([name, value]) => {
    if (allowed && !allowed.has(name)) return
    if (value !== '' && value != null) params.set(name, value)
  })
  return params.toString()
}

/** 路由切换时重置页面级搜索条件，确保关键字等不会跨页面缓存。 */
export function resetPageFilters() {
  filters.value = { ...filterDefaults }
}

/** 仅用于“点击跳转并在目标页预填搜索”的一次性深链（如从概览跳转到链路追踪检索 traceId）。不读取顶部全局条件字段。 */
export function applyRoutePrefill(query = {}) {
  for (const name of ['traceId', 'path', 'userId', 'userName', 'userPhone', 'keyword', 'type', 'status']) {
    if (query[name] != null && query[name] !== '') filters.value[name] = query[name]
  }
}

export function resetPages() {
  for (const pager of [eventPager, errorEventPager, perfPager, behaviorPager, issuePager, replayPager]) {
    pager.value.page = 1
  }
}

export async function refreshAll() {
  refreshVersion.value += 1
  await refresh()
}

export async function refresh() {
  const sequence = ++refreshSequence
  loading.value = true
  pageLoading.value = true
  error.value = ''
  try {
    const [summaryData, eventData, errorEventData, issueData, replayData, perfData, behaviorData] = await Promise.all([
      api(`/api/summary?${queryFromFilters()}`, { requestKey: 'summary' }),
      loadPaged('events', sequence),
      loadPaged('errorEvents', sequence),
      loadPaged('issues', sequence),
      loadPaged('replays', sequence),
      loadPaged('perf', sequence),
      loadPaged('behavior', sequence)
    ])
    if (sequence !== refreshSequence) return
    summary.value = summaryData
    setPaged(events, eventPager, eventData)
    setPaged(errorEvents, errorEventPager, errorEventData)
    setPaged(issues, issuePager, issueData)
    setPaged(replays, replayPager, replayData)
    setPaged(perfEvents, perfPager, perfData)
    setPaged(behaviorEvents, behaviorPager, behaviorData)
  } catch (e) {
    if (e?.code !== 'ABORT_ERR') {
      error.value = e.message || '加载失败'
      summary.value = null
      events.value = []
      errorEvents.value = []
      issues.value = []
      replays.value = []
      perfEvents.value = []
      behaviorEvents.value = []
    }
  } finally {
    if (sequence === refreshSequence) {
      loading.value = false
      pageLoading.value = false
    }
  }
}

export async function setPage(kind, page) {
  const pager = pagerMap()[kind]
  if (!pager) return
  pager.value.page = page
  await refreshPaged(kind)
}

export async function setPageSize(kind, pageSize) {
  const pager = pagerMap()[kind]
  if (!pager) return
  pager.value.page = 1
  pager.value.pageSize = pageSize
  await refreshPaged(kind)
}

async function refreshPaged(kind) {
  const pager = pagerMap()[kind]
  if (!pager) return
  const sequence = (pageRequestSequence.get(kind) || 0) + 1
  pageRequestSequence.set(kind, sequence)
  tableLoading.value[kind] = true
  error.value = ''
  try {
    const data = await loadPaged(kind, sequence)
    if (pageRequestSequence.get(kind) !== sequence) return
    setPaged(targetMap()[kind], pager, data)
  } catch (e) {
    if (e?.code !== 'ABORT_ERR') {
      error.value = e.message || '加载失败'
      const target = targetMap()[kind]
      if (target) target.value = []
      pager.value.total = 0
    }
  } finally {
    if (pageRequestSequence.get(kind) === sequence) tableLoading.value[kind] = false
  }
}

async function loadPaged(kind, sequence = refreshSequence) {
  const pager = pagerMap()[kind]
  const endpoint = { events: '/api/events', errorEvents: '/api/events', perf: '/api/events', behavior: '/api/events', issues: '/api/issues', replays: '/api/replays' }[kind]
  const type = { errorEvents: 'error', perf: 'perf', behavior: 'behavior,track' }[kind]
  const query = queryFromFilters(type ? { type } : {})
  return api(`${endpoint}?${query}&page=${pager.value.page}&pageSize=${pager.value.pageSize}`, { requestKey: `page:${kind}`, sequence })
}

export function normalizePageResponse(data, fallback = {}) {
  let payload = data
  let envelopeMeta = null
  let envelope = false
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (Object.prototype.hasOwnProperty.call(payload, 'data')) {
      envelopeMeta = payload
      payload = payload.data
      envelope = true
    } else if (Object.prototype.hasOwnProperty.call(payload, 'result')) {
      envelopeMeta = payload
      payload = payload.result
      envelope = true
    }
  }
  const items = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.items) ? payload.items
      : Array.isArray(payload?.rows) ? payload.rows
      : Array.isArray(payload?.results) ? payload.results : []
  if (payload != null && !Array.isArray(payload) && typeof payload !== 'object') {
    const contractError = new Error('响应格式异常：列表接口应返回数组或分页对象')
    contractError.code = 'CONTRACT_ERR'
    throw contractError
  }
  if (!Array.isArray(payload) && !items.length && payload && typeof payload === 'object') {
    const hasListField = ['items', 'rows', 'results'].some(name => Object.prototype.hasOwnProperty.call(payload, name))
    const isExplicitEmptyEnvelope = envelope && (payload == null || (typeof payload === 'object' && Object.keys(payload).length === 0))
    if (!hasListField && !isExplicitEmptyEnvelope && Object.keys(payload).length > 0) {
      const contractError = new Error('响应格式异常：列表接口应返回数组或 items/rows/results')
      contractError.code = 'CONTRACT_ERR'
      throw contractError
    }
  }
  const page = positiveInteger(payload?.page ?? envelopeMeta?.page, fallback.page || 1)
  const pageSize = positiveInteger(payload?.pageSize ?? envelopeMeta?.pageSize, fallback.pageSize || (items.length || 10))
  const totalValue = payload?.total ?? payload?.count ?? envelopeMeta?.total ?? envelopeMeta?.count
  const total = Number.isFinite(Number(totalValue)) ? Math.max(0, Number(totalValue)) : items.length
  return { items, page, pageSize, total }
}

export function toList(data) {
  return normalizePageResponse(data).items
}

function setPaged(target, pager, data) {
  const normalized = normalizePageResponse(data, pager.value)
  target.value = normalized.items
  pager.value = normalized
}

function pagerMap() {
  return { events: eventPager, errorEvents: errorEventPager, perf: perfPager, behavior: behaviorPager, issues: issuePager, replays: replayPager }
}

function targetMap() {
  return { events, errorEvents, perf: perfEvents, behavior: behaviorEvents, issues, replays }
}

export async function resolveIssue(fingerprint) {
  // ADR-005：闭环时选填"解决办法"，非空才进知识库（提升 AI 诊断价值，不强制录入）
  let resolutionNotes
  try {
    const { ElMessageBox } = await import('element-plus')
    const { value } = await ElMessageBox.prompt(`为该 issue 补充解决办法（选填，将用于 AI 知识库）`, '解决 Issue', {
      confirmButtonText: '解决',
      cancelButtonText: '取消',
      inputType: 'textarea',
      inputPlaceholder: '如：接口缺参导致，增加了字段校验（可留空）'
    })
    resolutionNotes = (value || '').trim() || undefined
  } catch {
    return // 用户取消，解决操作终止
  }
  await api(`/api/issues/${encodeURIComponent(fingerprint)}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resolutionNotes })
  })
  await refresh()
}

export async function uploadSourceMap(payload) {
  await api('/api/sourcemaps', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  })
}

export async function getReplay(replayKey) {
  const cached = replayCache.get(replayKey)
  if (cached?.expiresAt > Date.now()) {
    // 并发调用共享同一个 inflight promise（避免同 key 重复请求）；
    // 空结果在解析后从缓存移除，后续再次点击会重新请求而不是 30s 内都拿到空数组。
    return cached.promise.then(value => {
      if (!hasReplayEvents(value)) replayCache.delete(replayKey)
      return value
    })
  }
  const promise = api(`/api/replays/${encodeURIComponent(replayKey)}`).then(value => {
    // 空事件（会话已被清理 / 深链无效）不缓存，避免短时间内重试也返回空
    if (!hasReplayEvents(value)) replayCache.delete(replayKey)
    return value
  }, error => {
    replayCache.delete(replayKey)
    throw error
  })
  replayCache.set(replayKey, { promise, expiresAt: Date.now() + 30000 })
  return promise
}

/** 回放详情是否包含可用事件（数组本身或 {events|data:[...]} 信封） */
function hasReplayEvents(payload) {
  if (Array.isArray(payload)) return payload.length > 0
  return Array.isArray(payload?.events) ? payload.events.length > 0
    : Array.isArray(payload?.data) ? payload.data.length > 0 : false
}

export async function loadGovernance({ appPage = 1, appPageSize = 10 } = {}) {
  const [applications, applicationOptions, settings] = await Promise.all([
    api(`/api/applications?page=${appPage}&pageSize=${appPageSize}`),
    api('/api/applications'),
    api('/api/settings')
  ])
  return { applications, applicationOptions, settings }
}

export async function saveApplication(app) {
  return api(`/api/applications/${encodeURIComponent(app.appId)}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(app)
  })
}
export async function deleteApplication(appId) { return api(`/api/applications/${encodeURIComponent(appId)}`, { method: 'DELETE' }) }
export async function rotateCollectKey(appId) { return api(`/api/applications/${encodeURIComponent(appId)}/collect-key`, { method: 'POST' }) }

export async function loadReleases(appId, page = 1, pageSize = 10) {
  return api(`/api/applications/${encodeURIComponent(appId)}/releases?page=${page}&pageSize=${pageSize}`)
}

export async function saveRelease(appId, release, status) {
  return api(`/api/applications/${encodeURIComponent(appId)}/releases/${encodeURIComponent(release)}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status })
  })
}
export async function deleteRelease(appId, release) { return api(`/api/applications/${encodeURIComponent(appId)}/releases/${encodeURIComponent(release)}`, { method: 'DELETE' }) }

export async function saveGovernanceSettings(settings) {
  return api('/api/settings', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings)
  })
}

export async function runCleanup() {
  return api('/api/maintenance/cleanup', { method: 'POST' })
}

export async function downloadReport(kind) {
  const requestId = ++requestSequence
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const slowTimer = setTimeout(() => { slowRequestIds.add(requestId); slowRequest.value = true }, API_SLOW_THRESHOLD_MS)
  const timeoutTimer = controller ? setTimeout(() => controller.abort(), API_TIMEOUT_MS) : null
  activeRequestCount.value += 1
  let href = ''
  try {
    const res = await fetch(`${apiBase}/api/export/${kind}.csv?${queryFromFilters()}`, controller ? { signal: controller.signal } : undefined)
    if (!res.ok) throw new Error((await res.text()) || `导出失败（${res.status}）`)
    href = URL.createObjectURL(await res.blob())
    const link = document.createElement('a')
    link.href = href
    link.download = `web-collection-${kind}.csv`
    document.body.append(link)
    link.click()
    link.remove()
  } catch (cause) {
    if (cause?.name === 'AbortError') {
      const timeoutError = new Error('导出接口响应超时，请稍后重试')
      timeoutError.code = 'TIMEOUT_ERR'
      throw timeoutError
    }
    throw cause
  } finally {
    clearTimeout(slowTimer)
    clearTimeout(timeoutTimer)
    slowRequestIds.delete(requestId)
    slowRequest.value = slowRequestIds.size > 0
    activeRequestCount.value = Math.max(0, activeRequestCount.value - 1)
    if (href) setTimeout(() => URL.revokeObjectURL(href), 0)
  }
}

export async function saveAlertChannel(channel) {
  return api(channel.id ? `/api/alert-channels/${channel.id}` : '/api/alert-channels', {
    method: channel.id ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(channel)
  })
}
export async function deleteAlertChannel(id) { return api(`/api/alert-channels/${id}`, { method: 'DELETE' }) }
export async function testAlertChannel(id) { return api(`/api/alert-channels/${id}/test`, { method: 'POST' }) }
export async function loadAlertDeliveries(alertId, page = 1, pageSize = 20) { return api(`/api/alert-deliveries?alertId=${alertId}&page=${page}&pageSize=${pageSize}`) }
export async function retryAlertDelivery(id) { return api(`/api/alert-deliveries/${id}/retry`, { method: 'POST' }) }

export async function api(path, options = {}) {
  const {
    timeout = API_TIMEOUT_MS,
    slowThreshold = API_SLOW_THRESHOLD_MS,
    requestKey = '',
    sequence: _sequence,
    signal: upstreamSignal,
    ...fetchOptions
  } = options
  const requestId = ++requestSequence
  const previous = requestKey ? inflightRequests.get(requestKey) : null
  previous?.abort()

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  let removeUpstreamListener = () => {}
  if (controller && upstreamSignal) {
    if (upstreamSignal.aborted) controller.abort()
    else {
      const onAbort = () => controller.abort()
      upstreamSignal.addEventListener('abort', onAbort, { once: true })
      removeUpstreamListener = () => upstreamSignal.removeEventListener('abort', onAbort)
    }
  }
  if (requestKey && controller) inflightRequests.set(requestKey, controller)
  const signal = controller?.signal || upstreamSignal
  const startedAt = Date.now()
  let timedOut = false
  let slowTimer
  let timeoutTimer
  activeRequestCount.value += 1
  slowTimer = setTimeout(() => {
    slowRequestIds.add(requestId)
    slowRequest.value = true
  }, Math.max(0, Number(slowThreshold) || API_SLOW_THRESHOLD_MS))
  if (controller && Number(timeout) > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, Number(timeout))
  }
  try {
    const res = await fetch(`${apiBase}${path}`, { ...fetchOptions, ...(signal ? { signal } : {}) })
    const text = await res.text()
    let body = {}
    if (text) {
      try { body = JSON.parse(text) } catch { body = text }
    }
    if (!res.ok) {
      const message = typeof body === 'string' ? body : body?.message || body?.error || `请求失败（${res.status}）`
      const requestError = new Error(message)
      requestError.code = 'HTTP_ERR'
      requestError.status = res.status
      requestError.path = path
      throw requestError
    }
    return body
  } catch (cause) {
    if (cause?.name === 'AbortError' || cause?.code === 20) {
      const requestError = new Error(timedOut ? `接口响应超时（${Math.round((Date.now() - startedAt) / 1000)}s），请稍后重试` : '请求已取消')
      requestError.code = timedOut ? 'TIMEOUT_ERR' : 'ABORT_ERR'
      requestError.path = path
      throw requestError
    }
    throw cause
  } finally {
    clearTimeout(slowTimer)
    clearTimeout(timeoutTimer)
    removeUpstreamListener()
    if (slowRequestIds.delete(requestId)) slowRequest.value = slowRequestIds.size > 0
    activeRequestCount.value = Math.max(0, activeRequestCount.value - 1)
    if (requestKey && inflightRequests.get(requestKey) === controller) inflightRequests.delete(requestKey)
  }
}

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

function typeLabel(name) {
  return ({ track: '埋点', perf: '性能', performance: '性能', behavior: '行为', error: '错误', replay: '回放' })[name] || '其他'
}

function behaviorLabel(name) {
  return ({ click: '点击', track: '埋点', pv: '页面访问', page_leave: '页面离开', scroll: '滚动', exposure: '曝光', route: '路由切换', replaceState: '路由切换', pushState: '路由切换', popstate: '路由切换' })[name] || name
}
