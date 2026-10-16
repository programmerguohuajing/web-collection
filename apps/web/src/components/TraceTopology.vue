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
      page: '#6366f1', frontend: '#6366f1', gateway: '#7c3aed', service: '#4f46e5',
      api: '#4f46e5', database: '#059669', cache: '#d97706', queue: '#64748b',
      external: '#c2701d', default: '#64748b'
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
/** 颜色提亮（用于渐变高光）：hex → 按比例混白 */
function lighten(hex, amt = 20) {
  const h = String(hex || '#909399').replace('#', '')
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h.padEnd(6, '0')
  const p = Math.max(0, Math.min(100, amt)) / 100
  const ch = [0, 2, 4].map(i => {
    const v = parseInt(full.slice(i, i + 2), 16)
    return Math.round(v + (255 - v) * p).toString(16).padStart(2, '0')
  })
  return '#' + ch.join('')
}
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
  // ---- defs: 箭头、渐变、滤镜（高级感核心） ----
  const defs = [`<defs>
    <marker id="topoArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#9aa5b5"/></marker>
    <marker id="topoArrowErr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#f87171"/></marker>
    <filter id="topoSoft" x="-60%" y="-60%" width="220%" height="220%">
      <feDropShadow dx="0" dy="3" stdDeviation="5" flood-color="#1e2a44" flood-opacity="0.22"/>
    </filter>
    <filter id="topoGlowErr" x="-80%" y="-80%" width="260%" height="260%">
      <feDropShadow dx="0" dy="0" stdDeviation="7" flood-color="#ef4444" flood-opacity="0.55"/>
    </filter>`]
  // 每种节点类型一个径向渐变（中心提亮 18%）
  const seenTypes = [...new Set(nodes.map(n => n.type))]
  seenTypes.forEach(t => {
    const c = typeColor(t)
    const gid = `topoGrad-${t.replace(/[^a-z0-9]/gi, '')}`
    defs.push(`<radialGradient id="${gid}" cx="35%" cy="30%" r="80%">
      <stop offset="0%" stop-color="${lighten(c, 22)}"/><stop offset="100%" stop-color="${c}"/>
    </radialGradient>`)
  })
  defs.push('</defs>')
  parts.push(defs.join(''))
  parts.push(`<g class="topo-root" transform="translate(${panX} ${panY}) scale(${zoom})">`)
  // ---- edges: 贝塞尔曲线 + 流动虚线 ----
  edges.forEach((e, idx) => {
    const a = byId[e.source]
    const b = byId[e.target]
    if (!a || !b) return
    const err = Number(e.errors || 0) > 0
    const calls = Number(e.calls || 1)
    const w = Math.max(1, Math.min(4.5, Math.log2(calls + 1) * 1.2))
    // 二次贝塞尔：控制点取中点沿法线偏移，曲率与弦长成正比（上限 46px）
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    const bend = Math.min(46, len * 0.18)
    const cx = mx - (dy / len) * bend
    const cy = my + (dx / len) * bend
    const d = `M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}`
    const cls = err ? 'err' : ''
    const dur = err ? 0.8 : Math.max(1, 2 - Math.min(1, calls / 40))
    // 标签放在曲线中点（t=0.5 的贝塞尔点）
    const lx = 0.25 * a.x + 0.5 * cx + 0.25 * b.x
    const ly = 0.25 * a.y + 0.5 * cy + 0.25 * b.y
    const label = err ? ('⚠ ' + e.errors) : (calls + '·' + Math.round(Number(e.avgDuration || 0)) + 'ms')
    const lw = label.length * 6.8 + 10
    const edgeBg = err ? '#fef2f2' : 'rgba(255,255,255,.92)'
    const edgeBd = err ? '#fecaca' : '#e2e8f0'
    const edgeTx = err ? '#dc2626' : '#7c8aa0'
    parts.push(`<g class="edge-grp ${cls}" data-edge="${idx}">
      <path class="edge-base ${cls}" d="${d}" stroke-width="${w}" marker-end="url(#${err ? 'topoArrowErr' : 'topoArrow'})"/>
      <path class="edge-flow ${cls}" d="${d}" stroke-width="${Math.max(1.4, w * 0.9)}" style="animation-duration:${dur}s"/>
      <g transform="translate(${lx} ${ly - 7})" style="pointer-events:none">
        <rect x="${-lw / 2}" y="-9" width="${lw}" height="17" rx="8.5" fill="${edgeBg}" stroke="${edgeBd}" stroke-width="1"/>
        <text text-anchor="middle" dy="3.5" style="font-family:ui-monospace,Consolas,monospace;font-size:9px;fill:${edgeTx}${err ? ';font-weight:600' : ''}">${label}</text>
      </g>
    </g>`)
  })
  // ---- nodes: 光晕 + 渐变球 + 标签在圆下方（圆内不放字，避免小节点溢出） ----
  nodes.forEach((n, i) => {
    const r = nodeRadius(n)
    const col = typeColor(n.type)
    const gid = `topoGrad-${String(n.type).replace(/[^a-z0-9]/gi, '')}`
    const hc = healthColor(n)
    const isErr = n.err > 0
    const delay = Math.min(0.6, i * 0.05)
    const shortLabel = n.label.length > 16 ? n.label.slice(0, 15) + '…' : n.label
    const sub = `${n.calls} calls · P95 ${n.p95}ms`
    // 标签宽度估算（用于胶囊底）：中文 12px / 字符，英文数字约 6.5px
    const labelW = Math.max(shortLabel.length * 7, sub.length * 5.4) + 18
    const labelY = n.y + r + 16
    const tagBg = isErr ? '#fef2f2' : 'rgba(255,255,255,.94)'
    const tagBd = isErr ? '#fecaca' : '#e2e8f0'
    parts.push(`<g class="topo-node${isErr ? ' is-err' : ''}" data-id="${n.id}" style="cursor:pointer;animation-delay:${delay}s">
      ${isErr ? `<circle cx="${n.x}" cy="${n.y}" r="${r + 7}" fill="none" stroke="${hc}" stroke-width="2.5" opacity="0.5" filter="url(#topoGlowErr)"/>` : `<circle cx="${n.x}" cy="${n.y}" r="${r + 5}" fill="none" stroke="${hc}" stroke-width="1.6" opacity="0.55"/>`}
      <circle cx="${n.x}" cy="${n.y}" r="${r}" fill="url(#${gid})" filter="url(#topoSoft)"/>
      <circle cx="${n.x - r * 0.28}" cy="${n.y - r * 0.32}" r="${r * 0.42}" fill="#ffffff" opacity="0.16"/>
      <g transform="translate(${n.x} ${labelY})" style="pointer-events:none">
        <rect x="${-labelW / 2}" y="-10" width="${labelW}" height="30" rx="9" fill="${tagBg}" stroke="${tagBd}" stroke-width="1"/>
        <text y="2" text-anchor="middle" style="font-family:'Segoe UI','Microsoft YaHei',sans-serif;font-size:11px;font-weight:600;fill:#2b3547">${shortLabel}</text>
        <text y="14" text-anchor="middle" style="font-family:ui-monospace,Consolas,monospace;font-size:9px;fill:#8a96a7">${sub}</text>
      </g>
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
  background:
    radial-gradient(1200px 500px at 50% -10%, rgba(99,102,241,.06), transparent 60%),
    radial-gradient(circle at 1px 1px, rgba(23,32,51,.055) 1px, transparent 0) 0 0/22px 22px,
    linear-gradient(180deg, #fbfcfe 0%, #f4f6fa 100%);
  border: 1px solid var(--line, #dfe5ec); border-radius: 10px; }
.topo-svg:active { cursor: grabbing; }
.topo-empty { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
.topo-legend { position: absolute; left: 16px; bottom: 14px; background: rgba(255,255,255,.92); backdrop-filter: blur(8px); border: 1px solid rgba(223,229,236,.9); border-radius: 12px; padding: 11px 13px; box-shadow: 0 6px 20px rgba(23,32,51,.09); font-size: 11px; display: flex; flex-direction: column; gap: 6px; }
.topo-legend .lg-title { color: #4b586c; font-weight: 700; margin-bottom: 2px; letter-spacing: .04em; font-size: 10px; text-transform: uppercase; }
.topo-legend .lg-row { display: flex; align-items: center; gap: 8px; color: #627085; }
.topo-legend .dot { width: 10px; height: 10px; border-radius: 50%; box-shadow: 0 1px 3px rgba(23,32,51,.25); }
.topo-legend .ln { width: 18px; height: 0; border-top: 2px solid #c3ccd9; border-radius: 2px; }
.topo-legend .ln.err { border-color: #f87171; }
.topo-legend .lg-sep { height: 1px; background: var(--c-border, #e7e9ee); margin: 2px 0; }
.topo-hint { position: absolute; right: 16px; top: 12px; color: #7c8aa0; font-size: 11px; background: rgba(255,255,255,.88); backdrop-filter: blur(6px); padding: 6px 10px; border-radius: 8px; border: 1px solid rgba(231,233,238,.9); box-shadow: 0 2px 8px rgba(23,32,51,.05); }
.topo-tip { position: fixed; pointer-events: none; background: rgba(255,255,255,.97); border: 1px solid var(--c-border, #e7e9ee); border-radius: 8px; padding: 8px 10px; font-size: 12px; color: #1f2733; box-shadow: 0 4px 14px rgba(23,32,51,.12); z-index: 50; max-width: 240px; display: none; }
.topo-tip b { color: #4f46e5; }
.topo-tip .muted { color: #8a96a7; font-size: 11px; }

/* 拓扑连线：贝塞尔曲线 + 动态流动虚线 */
.edge-grp { cursor: pointer; }
.edge-base { fill: none; stroke: #c3ccd9; stroke-linecap: round; opacity: .75; transition: stroke .2s, opacity .2s; }
.edge-base.err { stroke: #f87171; opacity: .95; animation: edgePulse 1.6s ease-in-out infinite; }
.edge-flow { fill: none; stroke: #a5b0c2; stroke-width: 1.4; stroke-dasharray: 4 10; stroke-linecap: round; pointer-events: none; opacity: .8; animation: edgeFlow 1.4s linear infinite; }
.edge-flow.err { stroke: #f87171; animation: edgeFlow .8s linear infinite, edgePulse 1.6s ease-in-out infinite; }
.edge-grp:hover .edge-base { stroke: #6366f1; opacity: 1; }
.edge-grp:hover .edge-flow { stroke: #818cf8; }
@keyframes edgeFlow { to { stroke-dashoffset: -14; } }
@keyframes edgePulse { 0%, 100% { opacity: .95; } 50% { opacity: .45; } }
/* 边标签：胶囊底 */
.edge-label { pointer-events: none; }
.edge-label-bg { fill: rgba(255,255,255,.92); stroke: #e2e8f0; stroke-width: 1; }
.edge-label-bg.err { fill: #fef2f2; stroke: #fecaca; }
.edge-label-tx { font-family: ui-monospace, Consolas, monospace; font-size: 9px; fill: #7c8aa0; }
.edge-label-tx.err { fill: #dc2626; font-weight: 600; }
/* 节点：入场 stagger + 悬停上浮 */
.topo-node { animation: nodeIn .45s cubic-bezier(.2,.9,.3,1.2) backwards; transition: filter .18s; }
.topo-node:hover { filter: brightness(1.06); }
.topo-node.is-err .node-label { fill: #fff; }
@keyframes nodeIn { from { opacity: 0; transform: scale(.4); } to { opacity: 1; transform: scale(1); } }
/* 节点标签：圆下方胶囊（圆内不放字） */
.node-tag { pointer-events: none; }
.node-tag-bg { fill: rgba(255,255,255,.94); stroke: #e2e8f0; stroke-width: 1; filter: drop-shadow(0 1px 3px rgba(23,32,51,.1)); }
.node-tag-bg.err { fill: #fef2f2; stroke: #fecaca; }
.node-label { font-family: 'Segoe UI','Microsoft YaHei',sans-serif; font-size: 11px; font-weight: 600; fill: #2b3547; }
.node-sub { font-family: ui-monospace,Consolas,monospace; font-size: 9px; fill: #8a96a7; }
</style>
