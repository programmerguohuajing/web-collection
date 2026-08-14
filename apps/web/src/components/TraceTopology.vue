<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps({
  // 拓扑节点：{ id, label, type('page'|'api'|...), value(调用量) }
  nodes: { type: Array, default: () => [] },
  // 拓扑边：{ source, target, calls, avgDuration, errors }
  edges: { type: Array, default: () => [] },
  height: { type: String, default: '540px' },
  typeColors: {
    type: Object,
    default: () => ({
      page: '#1769e0', frontend: '#1769e0', gateway: '#6d4aff', service: '#409eff',
      api: '#409eff', database: '#0ea765', cache: '#f59e0b', queue: '#909399',
      external: '#e6a23c', default: '#909399'
    })
  },
  emptyText: { type: String, default: '暂无拓扑数据' }
})
const emit = defineEmits(['select'])

const W = 960
const H = 600
const svgEl = ref(null)
const tipEl = ref(null)
const showLegend = ref(true)

let rootGEl = null
let nodes = []
let byId = {}
let edges = []
let layoutMode = 'force'
let raf = null
let zoom = 1
let panX = 0
let panY = 0
let drag = null
let panState = null
let resizeObserver = null
let rebuildToken = 0

const HC = { ok: '#0ea765', warn: '#f59e0b', danger: '#ef4444', edgeLabel: '#8a96a7' }

function typeColor(t) { return props.typeColors[t] || props.typeColors.default || '#909399' }
function nodeRadius(n) { return 14 + Math.min(26, Math.sqrt(n.calls || 1) * 9) }
function healthColor(n) { return n.err > 0 ? HC.danger : (n.p95 > 300 ? HC.warn : HC.ok) }

function rebuild() {
  const len = props.nodes.length || 1
  const errByNode = {}
  props.edges.forEach(e => {
    const err = Number(e.errors || 0)
    if (err > 0) {
      errByNode[e.source] = (errByNode[e.source] || 0) + err
      errByNode[e.target] = (errByNode[e.target] || 0) + err
    }
  })
  nodes = props.nodes.map((n, i) => {
    const calls = Number(n.value ?? n.calls ?? 1)
    let p95 = Number(n.p95 ?? n.duration ?? 0)
    props.edges.forEach(e => {
      if (e.source === n.id || e.target === n.id) p95 = Math.max(p95, Number(e.avgDuration || 0))
    })
    return {
      id: n.id,
      label: n.label || n.id,
      type: n.type || 'default',
      calls,
      p95,
      err: Math.max(Number(n.errors || 0), errByNode[n.id] || 0),
      x: W / 2 + Math.cos((i / len) * Math.PI * 2) * 200,
      y: H / 2 + Math.sin((i / len) * Math.PI * 2) * 200,
      vx: 0,
      vy: 0,
      fixed: false
    }
  })
  byId = {}
  nodes.forEach(n => { byId[n.id] = n })
  edges = props.edges.map(e => ({ ...e }))
}

function computeStatic() {
  if (layoutMode === 'hier') {
    const adj = {}
    edges.forEach(e => { (adj[e.source] = adj[e.source] || []).push(e.target) })
    const depth = { }
    const roots = nodes.filter(n => !edges.some(e => e.target === n.id))
    const startNodes = roots.length ? roots : (nodes[0] ? [nodes[0]] : [])
    const q = startNodes.map(n => n.id)
    q.forEach(id => { depth[id] = 0 })
    let qi = 0
    while (qi < q.length) {
      const u = q[qi++]
      ;(adj[u] || []).forEach(v => {
        if (depth[v] == null) { depth[v] = depth[u] + 1; q.push(v) }
      })
    }
    const layers = {}
    q.forEach(u => { (layers[depth[u]] = layers[depth[u]] || []).push(u) })
    Object.keys(layers).forEach(d => {
      const arr = layers[d]
      arr.forEach((id, i) => {
        const n = byId[id]
        if (!n) return
        n.x = 70 + Number(d) * 150
        n.y = H / 2 + (i - (arr.length - 1) / 2) * 120
        n.vx = n.vy = 0
        n.fixed = true
      })
    })
  } else if (layoutMode === 'radial') {
    const center = nodes.find(n => n.type === 'page') || nodes[0]
    if (center) { center.x = W / 2; center.y = H / 2; center.fixed = true }
    const others = nodes.filter(n => n !== center)
    const R = 210
    others.forEach((n, i) => {
      const a = (i / others.length) * Math.PI * 2
      n.x = W / 2 + Math.cos(a) * R
      n.y = H / 2 + Math.sin(a) * R
      n.vx = n.vy = 0
      n.fixed = true
    })
  }
}

function forceTick() {
  if (layoutMode !== 'force') { render(); return }
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]
      const b = nodes[j]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d2 = dx * dx + dy * dy + 0.01
      const d = Math.sqrt(d2)
      const f = 3200 / d2
      const fx = (dx / d) * f
      const fy = (dy / d) * f
      a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy
    }
  }
  edges.forEach(e => {
    const a = byId[e.source]
    const b = byId[e.target]
    if (!a || !b) return
    const dx = b.x - a.x
    const dy = b.y - a.y
    const d = Math.sqrt(dx * dx + dy * dy) + 0.01
    const rest = 130
    const f = (d - rest) * 0.02
    const fx = (dx / d) * f
    const fy = (dy / d) * f
    a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy
  })
  let maxMov = 0
  nodes.forEach(n => {
    if (n.fixed) return
    n.vx += (W / 2 - n.x) * 0.004
    n.vy += (H / 2 - n.y) * 0.004
    n.vx *= 0.86; n.vy *= 0.86
    n.x += n.vx; n.y += n.vy
    n.x = Math.max(40, Math.min(W - 40, n.x))
    n.y = Math.max(40, Math.min(H - 40, n.y))
    maxMov = Math.max(maxMov, Math.hypot(n.vx, n.vy))
  })
  render()
  if (maxMov < 0.35) { raf = null; return }
  raf = requestAnimationFrame(forceTick)
}

function startSim() {
  if (raf) cancelAnimationFrame(raf)
  if (layoutMode === 'force') {
    nodes.forEach(n => { n.fixed = false })
    forceTick()
  } else {
    computeStatic()
    render()
  }
}

function render() {
  if (!svgEl.value) return
  const parts = []
  parts.push(`<defs>
    <marker id="topoArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#8b97a6"/></marker>
    <marker id="topoArrowErr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#ef4444"/></marker>
  </defs>`)
  parts.push(`<g class="topo-root" transform="translate(${panX} ${panY}) scale(${zoom})">`)
  // edges: 基础线 + 动态流动线（source → target）
  edges.forEach((e, idx) => {
    const a = byId[e.source]
    const b = byId[e.target]
    if (!a || !b) return
    const err = Number(e.errors || 0) > 0
    const calls = Number(e.calls || 1)
    const w = Math.max(1.2, Math.min(6, Math.log2(calls + 1) * 1.6))
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    const cls = err ? 'err' : ''
    const dur = err ? 0.75 : Math.max(0.85, 1.7 - calls * 0.15)
    parts.push(`<g class="edge-grp ${cls}" data-edge="${idx}">
      <line class="edge-base ${cls}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke-width="${w}" marker-end="url(#${err ? 'topoArrowErr' : 'topoArrow'})" opacity="${err ? 0.9 : 0.5}"/>
      <line class="edge-flow ${cls}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke-width="${Math.max(1.8, w)}" style="animation-duration:${dur}s"/>
      <text x="${mx}" y="${my - 4}" text-anchor="middle" font-size="9" font-family="ui-monospace,Consolas,monospace" fill="${err ? HC.danger : HC.edgeLabel}" pointer-events="none">${err ? ('⚠ ' + e.errors) : (calls + '·' + Math.round(Number(e.avgDuration || 0)) + 'ms')}</text>
    </g>`)
  })
  // nodes
  nodes.forEach(n => {
    const r = nodeRadius(n)
    const col = typeColor(n.type)
    const hc = healthColor(n)
    parts.push(`<g class="topo-node" data-id="${n.id}" style="cursor:pointer">
      <circle cx="${n.x}" cy="${n.y}" r="${r + 4}" fill="none" stroke="${hc}" stroke-width="2" opacity="0.85"/>
      <circle cx="${n.x}" cy="${n.y}" r="${r}" fill="${col}" opacity="0.94"/>
      <text class="node-label" x="${n.x}" y="${n.y + 4}" text-anchor="middle" font-weight="600" fill="#ffffff">${n.label.length > 14 ? n.label.slice(0, 13) + '…' : n.label}</text>
      <text class="node-sub" x="${n.x}" y="${n.y + r + 12}" text-anchor="middle">${n.calls} calls · P95 ${n.p95}ms</text>
    </g>`)
  })
  parts.push('</g>')
  svgEl.value.innerHTML = parts.join('')
  rootGEl = svgEl.value.querySelector('.topo-root')
  // 事件绑定
  svgEl.value.querySelectorAll('.topo-node').forEach(g => {
    g.addEventListener('mousemove', ev => showTip(ev, byId[g.dataset.id]))
    g.addEventListener('mouseleave', hideTip)
    g.addEventListener('click', () => emit('select', byId[g.dataset.id]))
  })
  svgEl.value.querySelectorAll('.edge-grp').forEach(l => {
    l.addEventListener('mousemove', ev => {
      const e = edges[+l.dataset.edge]
      const a = byId[e.source]
      const b = byId[e.target]
      showTip(ev, null, { source: a?.label || e.source, target: b?.label || e.target, calls: e.calls, avg: e.avgDuration, err: e.errors })
    })
    l.addEventListener('mouseleave', hideTip)
  })
}

function showTip(ev, node, edge) {
  if (!tipEl.value) return
  let html = ''
  if (node) {
    html = `<b>${node.label}</b><br><span class="muted">${node.type} · ${node.calls} calls · P95 ${node.p95}ms${node.err ? ` · <span style="color:#ef4444">${node.err} 错误</span>` : ''}</span>`
  } else if (edge) {
    html = `<b>${edge.source} → ${edge.target}</b><br><span class="muted">调用 ${edge.calls} · 平均 ${Math.round(Number(edge.avg || 0))}ms${edge.err ? ` · <span style="color:#ef4444">${edge.err} 错误</span>` : ''}</span>`
  }
  tipEl.value.innerHTML = html
  tipEl.value.style.display = 'block'
  tipEl.value.style.left = (ev.clientX + 14) + 'px'
  tipEl.value.style.top = (ev.clientY + 14) + 'px'
}
function hideTip() { if (tipEl.value) tipEl.value.style.display = 'none' }

/* ===== 交互：拖拽节点 / 平移 / 缩放 ===== */
function screenToLocal(ev) {
  if (!rootGEl) return { x: 0, y: 0 }
  const ctm = rootGEl.getScreenCTM()
  if (!ctm) return { x: 0, y: 0 }
  const pt = svgEl.value.createSVGPoint()
  pt.x = ev.clientX
  pt.y = ev.clientY
  const local = pt.matrixTransform(ctm.inverse())
  return { x: local.x, y: local.y }
}

function onMouseDown(ev) {
  const g = ev.target.closest('.topo-node')
  if (g) {
    drag = byId[g.dataset.id]
    if (drag) drag.fixed = true
    return
  }
  // 背景平移
  const ctm = rootGEl ? rootGEl.getScreenCTM() : null
  panState = { sx: ev.clientX, sy: ev.clientY, px: panX, py: panY, a: ctm ? ctm.a : 1, d: ctm ? ctm.d : 1 }
}
function onMouseMove(ev) {
  if (drag) {
    const p = screenToLocal(ev)
    drag.x = p.x
    drag.y = p.y
    render()
    return
  }
  if (panState) {
    panX = panState.px + (ev.clientX - panState.sx) / panState.a
    panY = panState.py + (ev.clientY - panState.sy) / panState.d
    render()
  }
}
function onMouseUp() {
  drag = null
  panState = null
}
function onWheel(ev) {
  ev.preventDefault()
  const p = screenToLocal(ev)
  const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1
  const nz = Math.max(0.4, Math.min(3, zoom * factor))
  panX += (zoom - nz) * p.x
  panY += (zoom - nz) * p.y
  zoom = nz
  render()
}

/* ===== 对外方法（供父页面工具栏调用） ===== */
function setLayout(mode) {
  layoutMode = mode
  startSim()
}
function fit() {
  zoom = 1
  panX = 0
  panY = 0
  startSim()
}
function toggleLegend() { showLegend.value = !showLegend.value }

defineExpose({ setLayout, fit, toggleLegend })

/* ===== 生命周期 ===== */
function onResize() { if (layoutMode !== 'force') render() }
function refresh() {
  if (!props.nodes.length) { if (svgEl.value) svgEl.value.innerHTML = ''; return }
  const token = ++rebuildToken
  rebuild()
  if (layoutMode === 'force') {
    // 切换 trace 时重新力导，但保留视图缩放
    startSim()
  } else {
    computeStatic()
    render()
  }
}

onMounted(() => {
  if (svgEl.value) {
    svgEl.value.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    svgEl.value.addEventListener('wheel', onWheel, { passive: false })
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(onResize)
      resizeObserver.observe(svgEl.value)
    }
  }
  refresh()
})

watch(() => [props.nodes, props.edges], refresh, { deep: true })

onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf)
  if (resizeObserver) resizeObserver.disconnect()
  if (svgEl.value) {
    svgEl.value.removeEventListener('mousedown', onMouseDown)
    svgEl.value.removeEventListener('wheel', onWheel)
  }
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
})
</script>

<template>
  <div class="topo-wrap">
    <svg ref="svgEl" class="topo-svg" :style="{ height }" viewBox="0 0 960 600" preserveAspectRatio="xMidYMid meet"></svg>
    <div v-if="!nodes.length" class="topo-empty"><el-empty :image-size="72" :description="emptyText" /></div>
    <div v-if="showLegend && nodes.length" class="topo-legend">
      <div class="lg-title">服务类型</div>
      <div v-for="t in [...new Set(nodes.map(n => n.type))]" :key="t" class="lg-row">
        <span class="dot" :style="{ background: typeColor(t) }"></span>{{ t }}
      </div>
      <div class="lg-sep"></div>
      <div class="lg-row"><span class="ln"></span>正常调用</div>
      <div class="lg-row"><span class="ln err"></span>错误调用</div>
    </div>
    <div class="topo-hint">拖拽节点 · 滚轮缩放 · 拖背景平移 · 悬停看指标 · 点击聚焦</div>
    <div ref="tipEl" class="topo-tip"></div>
  </div>
</template>

<style scoped>
.topo-wrap { position: absolute; inset: 0; width: 100%; height: 100%; }
.topo-svg { width: 100%; display: block; cursor: grab;
  background: radial-gradient(circle at 1px 1px, rgba(23,32,51,.05) 1px, transparent 0) 0 0/22px 22px, #fff;
  border: 1px solid var(--line, #dfe5ec); border-radius: 7px; }
.topo-svg:active { cursor: grabbing; }
.topo-empty { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
.topo-legend { position: absolute; left: 16px; bottom: 14px; background: rgba(255,255,255,.94); border: 1px solid var(--line, #dfe5ec); border-radius: 10px; padding: 10px 12px; box-shadow: 0 4px 14px rgba(23,32,51,.08); font-size: 11px; display: flex; flex-direction: column; gap: 6px; }
.topo-legend .lg-title { color: #627085; font-weight: 600; margin-bottom: 2px; }
.topo-legend .lg-row { display: flex; align-items: center; gap: 8px; color: #627085; }
.topo-legend .dot { width: 10px; height: 10px; border-radius: 50%; }
.topo-legend .ln { width: 18px; height: 0; border-top: 2px solid #c0c4cc; }
.topo-legend .ln.err { border-color: #ef4444; }
.topo-legend .lg-sep { height: 1px; background: var(--line, #dfe5ec); margin: 2px 0; }
.topo-hint { position: absolute; right: 16px; top: 12px; color: #627085; font-size: 11px; background: rgba(255,255,255,.85); padding: 5px 9px; border-radius: 7px; border: 1px solid var(--line, #dfe5ec); }
.topo-tip { position: fixed; pointer-events: none; background: rgba(255,255,255,.97); border: 1px solid var(--line, #dfe5ec); border-radius: 8px; padding: 8px 10px; font-size: 12px; color: #172033; box-shadow: 0 4px 14px rgba(23,32,51,.12); z-index: 50; max-width: 240px; display: none; }
.topo-tip b { color: #1769e0; }
.topo-tip .muted { color: #8a96a7; font-size: 11px; }

/* 拓扑连线：基础线 + 动态流动线（方向 source → target） */
.edge-grp { cursor: pointer; }
.edge-base { fill: none; stroke: #c0c4cc; transition: stroke .2s; }
.edge-base.err { stroke: #ef4444; animation: edgePulse 1.4s ease-in-out infinite; }
.edge-flow { fill: none; stroke: #8b97a6; stroke-dasharray: 5 11; stroke-linecap: round; pointer-events: none; animation: edgeFlow 1.1s linear infinite; }
.edge-flow.err { stroke: #ef4444; animation: edgeFlow .75s linear infinite, edgePulse 1.4s ease-in-out infinite; }
.edge-grp:hover .edge-base { stroke: #1769e0; }
.edge-grp:hover .edge-flow { stroke: #3b82f6; }
@keyframes edgeFlow { to { stroke-dashoffset: -16; } }
@keyframes edgePulse { 0%, 100% { opacity: .92; } 50% { opacity: .42; } }
.node-label { font-family: 'Segoe UI','Microsoft YaHei',sans-serif; font-size: 11px; pointer-events: none; }
.node-sub { font-family: ui-monospace,Consolas,monospace; font-size: 9px; fill: #8a96a7; pointer-events: none; }
</style>
