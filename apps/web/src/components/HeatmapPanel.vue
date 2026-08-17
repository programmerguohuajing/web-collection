<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api, queryFromFilters } from '../dashboard.js'

const props = defineProps({
  appId: String
})

const canvasRef = ref(null)
const bgImageUrl = ref('')
const bgImageEl = ref(null)
const loading = ref(false)
const loadError = ref('')
const imageError = ref('')
const activeTab = ref('click')
const heatmapData = ref({ clickPoints: [], scrollData: [], scrollAggregate: [] })
const intensity = ref(30)
const radius = ref(40)
const transform = ref({ scale: 1, offsetX: 0, offsetY: 0 })
let isDragging = false
let dragStart = { x: 0, y: 0 }
let loadRequestId = 0
let _renderRetryId = 0

const colorStops = [
  { offset: 0, color: [0, 0, 255, 0] },
  { offset: 0.2, color: [0, 0, 255, 77] },
  { offset: 0.4, color: [0, 255, 255, 153] },
  { offset: 0.6, color: [0, 255, 0, 179] },
  { offset: 0.8, color: [255, 255, 0, 217] },
  { offset: 1.0, color: [255, 0, 0, 255] }
]

async function loadData() {
  const requestId = ++loadRequestId
  loadError.value = ''
  loading.value = true
  try {
    heatmapData.value = { clickPoints: [], scrollData: [], scrollAggregate: [] }
    const extra = props.appId ? { appId: props.appId } : {}
    const res = await api(`/api/analytics/heatmap?${queryFromFilters(extra, ['appId', 'release', 'startTime', 'endTime'])}`, {
      requestKey: 'analytics:heatmap',
      timeout: 15000
    })
    if (requestId !== loadRequestId) return
    const payload = res?.data && typeof res.data === 'object' ? res.data : res
    const clickPoints = Array.isArray(payload?.clickPoints)
      ? payload.clickPoints.filter(point => Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y)))
      : []
    const scrollData = Array.isArray(payload?.scrollData) ? payload.scrollData : []
    const scrollAggregate = Array.isArray(payload?.scrollAggregate)
      ? payload.scrollAggregate.filter(item => item && typeof item === 'object')
      : []
    heatmapData.value = { clickPoints, scrollData, scrollAggregate }
  } catch (error) {
    if (requestId === loadRequestId && error?.code !== 'ABORT_ERR') {
      heatmapData.value = { clickPoints: [], scrollData: [], scrollAggregate: [] }
      loadError.value = error?.message || '热力图数据加载失败，请稍后重试'
    }
  } finally {
    if (requestId === loadRequestId) loading.value = false
  }
}

onMounted(() => { void loadData() })
watch(() => props.appId, () => { void loadData() })

function handleImageUpload(e) {
  const file = e.target.files?.[0]
  if (!file) return
  imageError.value = ''
  const reader = new FileReader()
  reader.onload = () => {
    bgImageUrl.value = reader.result
    const img = new Image()
    img.onload = () => {
      if (!img.naturalWidth || !img.naturalHeight) {
        imageError.value = '背景图片尺寸无效，请重新选择图片'
        return
      }
      bgImageEl.value = img
      render()
    }
    img.onerror = () => { imageError.value = '背景图片加载失败，请重新选择图片' }
    img.src = reader.result
  }
  reader.onerror = () => { imageError.value = '背景图片读取失败，请重新选择图片' }
  reader.readAsDataURL(file)
}

function resetView() {
  transform.value = { scale: 1, offsetX: 0, offsetY: 0 }
  render()
}

function onWheel(e) {
  if (activeTab.value !== 'click') return
  const delta = e.deltaY > 0 ? 0.9 : 1.1
  const newScale = Math.min(5, Math.max(0.2, transform.value.scale * delta))
  transform.value.scale = newScale
  render()
}

function onMouseDown(e) {
  if (e.button !== 0) return
  isDragging = true
  dragStart = { x: e.clientX - transform.value.offsetX, y: e.clientY - transform.value.offsetY }
}
function onMouseMove(e) {
  if (!isDragging) return
  transform.value.offsetX = e.clientX - dragStart.x
  transform.value.offsetY = e.clientY - dragStart.y
  render()
}
function onMouseUp() { isDragging = false }

function render() {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()

  // 容器被 v-show 隐藏时 getBoundingClientRect 返回 0×0，跳过渲染并延迟重试
  if (rect.width === 0 || rect.height === 0) {
    cancelAnimationFrame(_renderRetryId)
    _renderRetryId = requestAnimationFrame(render)
    return
  }
  if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
    canvas.width = Math.round(rect.width * dpr)
    canvas.height = Math.round(rect.height * dpr)
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, rect.width, rect.height)

  const t = transform.value
  ctx.save()
  ctx.translate(t.offsetX, t.offsetY)
  ctx.scale(t.scale, t.scale)

  if (activeTab.value === 'click') {
    renderClickHeatmap(ctx, rect, t)
  } else {
    renderScrollHeatmap(ctx, rect)
  }

  ctx.restore()
}

function renderClickHeatmap(ctx, rect, t) {
  const img = bgImageEl.value
  if (img) {
    if (!img.naturalWidth || !img.naturalHeight) return
    const maxW = rect.width / t.scale
    const maxH = rect.height / t.scale
    const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight)
    const w = img.naturalWidth * scale
    const h = img.naturalHeight * scale
    const ox = (rect.width / t.scale - w) / 2
    const oy = (rect.height / t.scale - h) / 2
    ctx.drawImage(img, ox - t.offsetX / t.scale, oy - t.offsetY / t.scale, w, h)
  }

  const points = heatmapData.value.clickPoints
  if (!points.length) {
    ctx.fillStyle = '#666'
    ctx.font = '14px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('暂无点击数据，请确保 SDK 已采集点击事件并包含坐标信息', rect.width / (2 * t.scale), rect.height / (2 * t.scale))
    return
  }

  let maxVw = 1, maxVh = 1
  for (const p of points) {
    if (p.viewportWidth > maxVw) maxVw = p.viewportWidth
    if (p.viewportHeight > maxVh) maxVh = p.viewportHeight
  }

  const offscreen = document.createElement('canvas')
  offscreen.width = rect.width
  offscreen.height = rect.height
  const octx = offscreen.getContext('2d')

  const r = radius.value
  const int = intensity.value
  for (const p of points) {
    const nx = (p.x / maxVw) * rect.width
    const ny = (p.y / maxVh) * rect.height
    const grad = octx.createRadialGradient(nx, ny, 0, nx, ny, r)
    grad.addColorStop(0, `rgba(0,0,0,${int / 100})`)
    grad.addColorStop(1, 'rgba(0,0,0,0)')
    octx.fillStyle = grad
    octx.beginPath()
    octx.arc(nx, ny, r, 0, Math.PI * 2)
    octx.fill()
  }

  const imageData = octx.getImageData(0, 0, offscreen.width, offscreen.height)
  const data = imageData.data
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3]
    if (alpha === 0) continue
    const vt = Math.min(alpha / 255, 1)
    const color = gradientColor(vt)
    data[i] = color[0]
    data[i + 1] = color[1]
    data[i + 2] = color[2]
    data[i + 3] = alpha > 10 ? Math.min(220, alpha * 2) : 0
  }
  octx.putImageData(imageData, 0, 0)
  ctx.drawImage(offscreen, 0, 0)
}

function renderScrollHeatmap(ctx, rect) {
  const items = heatmapData.value.scrollAggregate
  if (!items.length) {
    ctx.fillStyle = '#666'
    ctx.font = '14px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('暂无滚动数据', rect.width / 2, rect.height / 2)
    return
  }

  const pad = { top: 36, right: 16, bottom: 60, left: 44 }
  const w = rect.width - pad.left - pad.right
  const h = rect.height - pad.top - pad.bottom
  const barW = w / items.length - 4

  ctx.fillStyle = '#1e1e2e'
  ctx.fillRect(pad.left, pad.top, w, h)

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const depth = Math.min(100, Math.max(0, Number(item.maxDepth) || 0))
    const barH = (depth / 100) * h
    const x = pad.left + i * (w / items.length) + 2
    const y = pad.top + h - barH
    const color = gradientColor(depth / 100)
    ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},0.85)`
    ctx.fillRect(x, y, barW, barH)
  }

  ctx.fillStyle = '#888'
  ctx.font = '10px sans-serif'
  ctx.textAlign = 'center'
  for (let i = 0; i < items.length; i++) {
    let label
    try { label = new URL(items[i].path).pathname.split('/').slice(0, 2).join('/') || '/' } catch { label = items[i].path?.slice(0, 16) || '-' }
    ctx.save()
    ctx.translate(pad.left + i * (w / items.length) + barW / 2, pad.top + h + 14)
    ctx.rotate(-Math.PI / 4)
    ctx.fillText(label, 0, 0)
    ctx.restore()
  }

  ctx.strokeStyle = '#333'
  ctx.lineWidth = 1
  for (let depth = 0; depth <= 100; depth += 25) {
    const y = pad.top + h - (depth / 100) * h
    ctx.beginPath(); ctx.moveTo(pad.left - 6, y); ctx.lineTo(pad.left, y); ctx.stroke()
    ctx.fillStyle = '#666'; ctx.textAlign = 'right'
    ctx.fillText(depth + '%', pad.left - 8, y + 3)
  }

  ctx.fillStyle = '#aaa'
  ctx.textAlign = 'center'
  ctx.fillText('页面滚动深度热力图', pad.left + w / 2, pad.top - 16)
}

function gradientColor(t) {
  const value = Math.min(1, Math.max(0, Number(t) || 0))
  let i = 0
  while (i < colorStops.length - 2 && colorStops[i + 1].offset < value) i++
  const a = colorStops[i], b = colorStops[i + 1]
  const range = b.offset - a.offset
  const lt = range > 0 ? (value - a.offset) / range : 0
  return [
    Math.round(a.color[0] + (b.color[0] - a.color[0]) * lt),
    Math.round(a.color[1] + (b.color[1] - a.color[1]) * lt),
    Math.round(a.color[2] + (b.color[2] - a.color[2]) * lt)
  ]
}

function triggerFileInput() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.onchange = handleImageUpload
  input.click()
}

watch([activeTab, heatmapData, intensity, radius, bgImageUrl, transform], render)

onBeforeUnmount(() => { cancelAnimationFrame(_renderRetryId) })
</script>

<template>
  <el-card shadow="never" class="panel section heatmap-card">
    <template #header>
      <div class="panel-head">
        <h2>行为热力图</h2>
        <div style="display:flex;gap:8px;align-items:center">
          <el-radio-group v-model="activeTab" size="small">
            <el-radio-button value="click">点击热力图</el-radio-button>
            <el-radio-button value="scroll">滚动热力图</el-radio-button>
          </el-radio-group>
          <el-tooltip content="上传页面截图作为背景图" placement="bottom">
            <el-button size="small" @click="triggerFileInput">
              <el-icon style="vertical-align:middle"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg></el-icon>
              背景图
            </el-button>
          </el-tooltip>
          <el-button size="small" @click="resetView">重置视图</el-button>
        </div>
      </div>
    </template>

    <el-alert v-if="loadError" type="error" :title="loadError" show-icon :closable="false" class="heatmap-alert">
      <template #default><el-button link type="primary" @click="loadData">重试</el-button></template>
    </el-alert>
    <el-alert v-if="imageError" type="warning" :title="imageError" show-icon :closable="false" class="heatmap-alert" />

    <div v-if="activeTab === 'click'" style="margin-bottom:12px">
      <span style="margin-right:16px;font-size:13px">强度：<el-slider v-model="intensity" :min="5" :max="80" style="width:120px;display:inline-block;vertical-align:middle" /></span>
      <span style="font-size:13px">半径：<el-slider v-model="radius" :min="10" :max="100" style="width:120px;display:inline-block;vertical-align:middle" /></span>
    </div>

    <div class="heatmap-canvas-wrap" :class="{ 'heatmap-canvas--scroll': activeTab === 'scroll' }">
      <div v-loading="loading" class="heatmap-canvas-inner">
        <canvas
          ref="canvasRef"
          class="heatmap-canvas"
          @wheel.prevent="onWheel"
          @mousedown="onMouseDown"
          @mousemove="onMouseMove"
          @mouseup="onMouseUp"
          @mouseleave="onMouseUp"
        />
        <div v-if="!heatmapData.clickPoints.length && activeTab === 'click' && !loading" class="heatmap-empty">
          <el-empty description="暂无点击数据" :image-size="60" />
        </div>
      </div>
    </div>

    <div class="heatmap-legend">
      <span style="font-size:12px;color:#888">低</span>
      <div class="heatmap-gradient-bar" />
      <span style="font-size:12px;color:#888">高</span>
      <span style="font-size:12px;color:#999;margin-left:12px">{{ activeTab === 'click' ? `共 ${heatmapData.clickPoints.length} 个点击点` : `共 ${heatmapData.scrollAggregate.length} 个页面` }}</span>
    </div>
  </el-card>
</template>

<style scoped>
.heatmap-card { min-height: 480px; }
.heatmap-alert { margin-bottom: 10px; }
.heatmap-canvas-wrap { position: relative; width: 100%; height: 420px; overflow: hidden; background: #16161a; border-radius: 6px; cursor: grab; }
.heatmap-canvas-wrap:active { cursor: grabbing; }
.heatmap-canvas--scroll { cursor: default; }
.heatmap-canvas-inner { width: 100%; height: 100%; position: relative; }
.heatmap-canvas { width: 100%; height: 100%; display: block; }
.heatmap-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
.heatmap-legend { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.heatmap-gradient-bar { width: 200px; height: 12px; border-radius: 6px; background: linear-gradient(90deg, rgba(0,0,255,0.6), rgba(0,255,255,0.6), rgba(0,255,0,0.8), rgba(255,255,0,0.9), rgba(255,0,0,1)); }
</style>
