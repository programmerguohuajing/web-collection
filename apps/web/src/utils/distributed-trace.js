const SERVICE_COLORS = ['#1769e0', '#0ea765', '#6d4aff', '#d97706', '#0891b2', '#c2410c', '#64748b']

export function buildTraceTree(nodes = [], edges = []) {
  if (!nodes.length) return []
  const nodeMap = new Map(nodes.map(node => [node.id, { ...node, children: [] }]))
  const childIds = new Set()
  const linkedEdges = new Set()

  for (const edge of edges) {
    const parent = nodeMap.get(edge.source)
    const child = nodeMap.get(edge.target)
    const edgeKey = `${edge.source}->${edge.target}`
    if (!parent || !child || parent === child || linkedEdges.has(edgeKey)) continue
    parent.children.push(child)
    childIds.add(child.id)
    linkedEdges.add(edgeKey)
  }

  const roots = [...nodeMap.values()].filter(node => !childIds.has(node.id))
  return roots.length ? roots : [...nodeMap.values()]
}

export function filterTraceTree(tree = [], options = {}) {
  const query = String(options.query || '').trim().toLowerCase()
  const mode = options.mode || 'all'
  const service = options.service || 'all'
  const errorIds = new Set(options.errorSpans || [])
  const criticalIds = new Set(options.criticalPath || [])

  function visit(node, ancestorIds = []) {
    if (ancestorIds.includes(node.id)) return null
    const children = (node.children || []).map(child => visit(child, [...ancestorIds, node.id])).filter(Boolean)
    const isError = Boolean(node.hasError || errorIds.has(node.id))
    const isCritical = criticalIds.has(node.id)
    const haystack = `${node.name || ''} ${node.service || ''} ${node.id || ''} ${node.kind || ''} ${node.status || ''}`.toLowerCase()
    const matchesQuery = !query || haystack.includes(query)
    const matchesMode = mode === 'all' || (mode === 'errors' && isError) || (mode === 'critical' && isCritical)
    const matchesService = service === 'all' || node.service === service
    if (!(matchesQuery && matchesMode && matchesService) && !children.length) return null
    return { ...node, children }
  }

  return tree.map(root => visit(root)).filter(Boolean)
}

export function getTraceBounds(nodes = []) {
  if (!nodes.length) return { start: 0, end: 0, duration: 1 }
  const starts = nodes.map(node => Number(node.startTs)).filter(Number.isFinite)
  if (!starts.length) return { start: 0, end: 0, duration: 1 }
  const start = Math.min(...starts)
  const lastStart = Math.max(...starts)
  const observedWindow = Math.max(0, lastStart - start)
  const durations = nodes.map(node => Number(node.duration)).filter(Number.isFinite).map(value => Math.max(0, value))
  const maxDuration = durations.length ? Math.max(...durations) : 0
  // 浏览器采集节点里偶尔会混入“内存值”等指标，其数值并非真实耗时。
  // 仅在单个值明显超过整段事件窗口时做上限保护，避免时间轴被异常值压扁。
  const durationCap = observedWindow > 0 && maxDuration > observedWindow * 2
    ? Math.max(60000, observedWindow * 0.1)
    : maxDuration
  const end = Math.max(...nodes.map(node => {
    const nodeStart = Number(node.startTs)
    const duration = Number(node.duration)
    const safeDuration = Number.isFinite(duration) ? Math.min(Math.max(0, duration), durationCap) : 0
    return Number.isFinite(nodeStart) ? nodeStart + safeDuration : start
  }))
  return { start, end, duration: Math.max(1, end - start) }
}

export function countTraceNodes(tree = []) {
  return tree.reduce((total, node) => total + 1 + countTraceNodes(node.children || []), 0)
}

export function limitTraceTree(tree = [], limit = Infinity) {
  let remaining = Math.max(0, Number(limit) || 0)

  function take(nodes) {
    const result = []
    for (const node of nodes) {
      if (remaining <= 0) break
      remaining--
      result.push({ ...node, children: take(node.children || []) })
    }
    return result
  }

  return take(tree)
}

export function formatTraceDuration(value) {
  const duration = Number(value)
  if (!Number.isFinite(duration)) return '-'
  if (duration < 1) return `${Math.round(duration * 1000)}μs`
  if (duration < 1000) return `${Number(duration.toFixed(duration < 10 ? 2 : 1))}ms`
  if (duration < 60000) return `${Number((duration / 1000).toFixed(2))}s`
  const minutes = Math.floor(duration / 60000)
  const seconds = Math.round((duration % 60000) / 1000)
  return `${minutes}m ${seconds}s`
}

export function serviceColor(service = '') {
  const text = String(service || 'unknown')
  let hash = 0
  for (let index = 0; index < text.length; index++) hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0
  return SERVICE_COLORS[Math.abs(hash) % SERVICE_COLORS.length]
}
