import { computed, ref } from 'vue'

const apiBase = import.meta.env?.VITE_API_BASE || ''

export const loading = ref(false)
export const tableLoading = ref({ events: false, errorEvents: false, perf: false, behavior: false, issues: false, replays: false })
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

export const filterDefaults = {
  range: [],
  appId: '',
  release: '',
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
  const f = filters.value
  const params = new URLSearchParams()
  const [startTime, endTime] = f.range || []
  const values = { ...f, startTime, endTime, ...extra }
  delete values.range
  const allowed = names ? new Set([...names.filter(name => name !== 'range'), 'startTime', 'endTime']) : null
  Object.entries(values).forEach(([name, value]) => {
    if (allowed && !allowed.has(name)) return
    if (value !== '' && value != null) params.set(name, value)
  })
  return params.toString()
}

export function setFiltersFromRoute(query = {}) {
  filters.value = {
    ...filterDefaults,
    range: query.startTime && query.endTime ? [Number(query.startTime), Number(query.endTime)] : [],
    appId: query.appId || '',
    release: query.release || '',
    path: query.path || '',
    userId: query.userId || '',
    userName: query.userName || '',
    userPhone: query.userPhone || '',
    keyword: query.keyword || '',
    type: query.type || '',
    status: query.status || ''
  }
}

export async function refresh() {
  loading.value = true
  error.value = ''
  try {
    const [summaryData, eventData, errorEventData, issueData, replayData, perfData, behaviorData] = await Promise.all([
      api(`/api/summary?${queryFromFilters()}`),
      loadPaged('events'),
      loadPaged('errorEvents'),
      loadPaged('issues'),
      loadPaged('replays'),
      loadPaged('perf'),
      loadPaged('behavior')
    ])
    summary.value = summaryData
    setPaged(events, eventPager, eventData)
    setPaged(errorEvents, errorEventPager, errorEventData)
    setPaged(issues, issuePager, issueData)
    setPaged(replays, replayPager, replayData)
    setPaged(perfEvents, perfPager, perfData)
    setPaged(behaviorEvents, behaviorPager, behaviorData)
  } catch (e) {
    error.value = e.message || '加载失败'
  } finally {
    loading.value = false
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
  tableLoading.value[kind] = true
  error.value = ''
  try {
    setPaged(targetMap()[kind], pager, await loadPaged(kind))
  } catch (e) {
    error.value = e.message || '加载失败'
  } finally {
    tableLoading.value[kind] = false
  }
}

async function loadPaged(kind) {
  const pager = pagerMap()[kind]
  const endpoint = { events: '/api/events', errorEvents: '/api/events', perf: '/api/events', behavior: '/api/events', issues: '/api/issues', replays: '/api/replays' }[kind]
  const type = { errorEvents: 'error', perf: 'perf', behavior: 'behavior' }[kind]
  const query = queryFromFilters(type ? { type } : {})
  return api(`${endpoint}?${query}&page=${pager.value.page}&pageSize=${pager.value.pageSize}`)
}

function setPaged(target, pager, data) {
  target.value = data.items || data
  pager.value = { page: data.page || 1, pageSize: data.pageSize || 10, total: data.total || target.value.length }
}

function pagerMap() {
  return { events: eventPager, errorEvents: errorEventPager, perf: perfPager, behavior: behaviorPager, issues: issuePager, replays: replayPager }
}

function targetMap() {
  return { events, errorEvents, perf: perfEvents, behavior: behaviorEvents, issues, replays }
}

export async function resolveIssue(fingerprint) {
  await api(`/api/issues/${encodeURIComponent(fingerprint)}/resolve`, { method: 'POST' })
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
  return api(`/api/replays/${encodeURIComponent(replayKey)}`)
}

export async function loadGovernance() {
  const [applications, settings, alerts] = await Promise.all([api('/api/applications'), api('/api/settings'), api('/api/alerts?limit=50')])
  return { applications, settings, alerts }
}

export async function saveApplication(app) {
  return api(`/api/applications/${encodeURIComponent(app.appId)}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(app)
  })
}
export async function rotateCollectKey(appId) { return api(`/api/applications/${encodeURIComponent(appId)}/collect-key`, { method: 'POST' }) }

export async function loadReleases(appId) {
  return api(`/api/applications/${encodeURIComponent(appId)}/releases`)
}

export async function saveRelease(appId, release, status) {
  return api(`/api/applications/${encodeURIComponent(appId)}/releases/${encodeURIComponent(release)}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status })
  })
}

export async function saveGovernanceSettings(settings) {
  return api('/api/settings', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings)
  })
}

export async function runCleanup() {
  return api('/api/maintenance/cleanup', { method: 'POST' })
}

export async function downloadReport(kind) {
  const res = await fetch(`${apiBase}/api/export/${kind}.csv?${queryFromFilters()}`)
  if (!res.ok) throw new Error(await res.text())
  const link = document.createElement('a')
  link.href = URL.createObjectURL(await res.blob())
  link.download = `web-collection-${kind}.csv`
  link.click()
  URL.revokeObjectURL(link.href)
}

export async function api(path, options = {}) {
  const res = await fetch(`${apiBase}${path}`, options)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

function typeLabel(name) {
  return ({ track: '埋点', perf: '性能', performance: '性能', behavior: '行为', error: '错误', replay: '回放' })[name] || '其他'
}

function behaviorLabel(name) {
  return ({ click: '点击', track: '埋点', pv: '页面访问', page_leave: '页面离开', scroll: '滚动', exposure: '曝光', route: '路由切换', replaceState: '路由切换', pushState: '路由切换', popstate: '路由切换' })[name] || name
}
