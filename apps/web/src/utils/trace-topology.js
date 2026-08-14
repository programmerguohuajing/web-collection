function text(value) {
  return String(value ?? '').trim()
}

function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function hasError(node = {}) {
  if (node.hasError === true) return true
  const status = text(node.status || node.statusCode).toUpperCase()
  return status === 'ERROR' || status === 'FAILED' || number(status) >= 400
}

function nodeType(node = {}) {
  const service = text(node.service || node.serviceName).toLowerCase()
  const kind = text(node.kind).toLowerCase()
  const value = `${service} ${kind}`
  if (service === 'frontend' || value.includes('browser')) return 'frontend'
  if (/postgres|mysql|mongodb|database|\bdb\b/.test(value)) return 'database'
  if (/redis|memcache|cache/.test(value)) return 'cache'
  if (/kafka|rabbit|queue|mq\b/.test(value)) return 'queue'
  if (/gateway|ingress|proxy/.test(value)) return 'gateway'
  if (/external|third.party/.test(value)) return 'external'
  if (/fetch|xhr|http client/.test(value)) return 'api'
  return 'service'
}

/**
 * Builds a renderable service topology from the distributed-span response.
 * This is a compatibility path for API deployments that do not yet expose
 * `/api/traces/:traceId/topology`.
 */
export function buildTopologyFromDistributed(payload = {}) {
  const sourceNodes = Array.isArray(payload?.nodes) ? payload.nodes : []
  const sourceEdges = Array.isArray(payload?.edges) ? payload.edges : []
  const spanToTopology = new Map()
  const spansById = new Map()
  const topologyNodes = new Map()

  sourceNodes.forEach((node, index) => {
    const spanId = text(node.id || node.spanId) || `span-${index}`
    const service = text(node.service || node.serviceName)
    const operation = text(node.name || node.operationName)
    const groupName = service && service.toLowerCase() !== 'unknown' ? service : operation || spanId
    const topologyId = `service:${groupName}`
    const existing = topologyNodes.get(topologyId)
    const failed = hasError(node)
    const duration = number(node.duration)

    if (existing) {
      existing.value += 1
      existing.p95 = Math.max(existing.p95, duration)
      if (failed) existing.errors += 1
      if (service.toLowerCase() === 'frontend' && existing.label !== operation) existing.label = service
    } else {
      topologyNodes.set(topologyId, {
        id: topologyId,
        label: service.toLowerCase() === 'frontend' ? operation || service : groupName,
        type: nodeType(node),
        value: 1,
        p95: duration,
        errors: failed ? 1 : 0
      })
    }

    spanToTopology.set(spanId, topologyId)
    spansById.set(spanId, node)
  })

  const topologyEdges = new Map()
  sourceEdges.forEach(edge => {
    const sourceSpanId = text(edge.source || edge.parentSpanId)
    const targetSpanId = text(edge.target || edge.spanId)
    const source = spanToTopology.get(sourceSpanId)
    const target = spanToTopology.get(targetSpanId)
    if (!source || !target || source === target) return

    const key = `${source}|${target}`
    const targetSpan = spansById.get(targetSpanId) || {}
    const duration = number(targetSpan.duration)
    const failed = hasError(targetSpan)
    const existing = topologyEdges.get(key)
    if (existing) {
      existing.calls += 1
      existing.avgDuration = Math.round((existing.avgDuration * (existing.calls - 1) + duration) / existing.calls)
      if (failed) existing.errors += 1
    } else {
      topologyEdges.set(key, {
        source,
        target,
        calls: 1,
        avgDuration: Math.round(duration),
        errors: failed ? 1 : 0
      })
    }
  })

  return { nodes: [...topologyNodes.values()], edges: [...topologyEdges.values()] }
}
