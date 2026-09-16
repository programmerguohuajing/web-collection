<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps({
  events: { type: Array, default: () => [] },
  trend: { type: Array, default: () => null },
  hiddenSeries: { type: Object, default: () => ({}) }
})

const containerElement = ref(null)
const canvasElement = ref(null)
let observer

const currentBuckets = ref([])
const hoverIndex = ref(-1)
const hoverTooltip = ref({
  visible: false,
  x: 0,
  y: 0,
  time: '',
  errors: 0,
  requests: 0
})

function formatLocalBucketLabel(ts, isMultiDay) {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = n => String(n).padStart(2, '0')
  if (isMultiDay) {
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatFullTimeLabel(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function getNiceMax(rawMax) {
  if (rawMax <= 4) return 4
  const targetTicks = 4
  const rawStep = rawMax / targetTicks
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)))
  const norm = rawStep / mag
  let step = 1
  if (norm > 5) step = 10
  else if (norm > 2.5) step = 5
  else if (norm > 1.25) step = 2
  else step = 1
  return Math.ceil(rawMax / (step * mag)) * (step * mag)
}

function draw() {
  if (!canvasElement.value) return
  const rect = canvasElement.value.getBoundingClientRect()
  const ratio = window.devicePixelRatio || 1
  canvasElement.value.width = rect.width * ratio
  canvasElement.value.height = rect.height * ratio
  const ctx = canvasElement.value.getContext('2d')
  ctx.scale(ratio, ratio)
  const width = rect.width
  const height = rect.height
  const pad = { left: 42, right: 26, top: 22, bottom: 32 }
  const chartWidth = width - pad.left - pad.right
  const chartHeight = height - pad.top - pad.bottom

  let buckets = []
  let xLabels = []

  if (Array.isArray(props.trend) && props.trend.length) {
    buckets = props.trend.map(item => ({
      ...item,
      ts: item.ts || null,
      errors: Number(item.errors) || 0,
      requests: Number(item.requests) || 0
    }))
  } else if (Array.isArray(props.events) && props.events.length) {
    const timestamps = props.events.map(event => Number(event.ts)).filter(value => Number.isFinite(value) && value > 0)
    const now = Date.now()
    const recentStart = now - 23 * 3600000
    const hasRecentEvents = timestamps.some(value => value >= recentStart && value <= now)
    const rangeEnd = hasRecentEvents ? now : (timestamps.length ? Math.max(...timestamps) : now)
    const rangeStart = hasRecentEvents ? recentStart : (timestamps.length ? Math.min(rangeEnd - 23 * 3600000, Math.min(...timestamps)) : recentStart)
    const rangeSpan = Math.max(1, rangeEnd - rangeStart)
    const bucketSpan = rangeSpan / 24

    buckets = Array.from({ length: 24 }, (_, i) => ({
      ts: Math.round(rangeStart + i * bucketSpan),
      errors: 0,
      requests: 0
    }))

    for (const event of props.events) {
      const timestamp = Number(event.ts || rangeEnd)
      if (!Number.isFinite(timestamp) || timestamp < rangeStart || timestamp > rangeEnd) continue
      const bucketIndex = Math.min(23, Math.max(0, Math.floor((timestamp - rangeStart) / rangeSpan * 24)))
      const bucket = buckets[bucketIndex]
      if (!bucket) continue
      if (
        event.type === 'error' ||
        event.metric === 'error' ||
        event.name === 'error' ||
        (event.type === 'log' && (event.metric === 'error' || event.name === 'error'))
      ) {
        bucket.errors++
      }
      if (
        event.type === 'api' ||
        event.metric === 'fetch' ||
        event.metric === 'xhr' ||
        (event.type === 'perf' && (event.metric === 'fetch' || event.metric === 'xhr'))
      ) {
        bucket.requests++
      }
    }
  }

  currentBuckets.value = buckets

  if (buckets.length >= 5) {
    const firstTs = buckets[0]?.ts
    const lastTs = buckets[buckets.length - 1]?.ts
    const span = firstTs && lastTs ? lastTs - firstTs : 0
    const isMultiDay = span > 24.5 * 3600000

    const indices = [
      0,
      Math.floor(buckets.length * 0.25),
      Math.floor(buckets.length * 0.5),
      Math.floor(buckets.length * 0.75),
      buckets.length - 1
    ]
    xLabels = indices.map(idx => {
      const b = buckets[idx]
      if (b?.ts) return formatLocalBucketLabel(b.ts, isMultiDay)
      return b?.label || ''
    }).filter(Boolean)
  }

  const allSeries = [
    { key: 'errors', color: '#ef4444', values: buckets.map(item => Number(item.errors) || 0) },
    { key: 'requests', color: '#1769e0', values: buckets.map(item => Number(item.requests) || 0) }
  ]
  const series = allSeries.filter(item => !props.hiddenSeries?.[item.key])

  const maxVal = Math.max(0, ...series.flatMap(item => item.values))
  const yMax = getNiceMax(maxVal)

  ctx.strokeStyle = '#e8edf3'
  ctx.lineWidth = 1
  ctx.font = '11px Segoe UI'
  ctx.fillStyle = '#8491a3'
  for (let index = 0; index <= 4; index++) {
    const y = pad.top + chartHeight * index / 4
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke()
    const val = Math.round(yMax * (4 - index) / 4)
    ctx.fillText(String(val), 8, y + 4)
  }

  if (!buckets.length) {
    ctx.textAlign = 'center'
    ctx.fillText('暂无趋势数据', width / 2, height / 2)
    ctx.textAlign = 'start'
    return
  }

  const bucketCount = Math.max(1, buckets.length - 1)
  for (const item of series) {
    ctx.strokeStyle = item.color; ctx.lineWidth = 2.2; ctx.beginPath()
    item.values.forEach((value, index) => {
      const x = pad.left + chartWidth * index / bucketCount
      const y = pad.top + chartHeight - (value / yMax) * chartHeight
      index ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
    })
    ctx.stroke()
  }

  // Hover crosshair line & highlighted dots
  if (hoverIndex.value >= 0 && hoverIndex.value < buckets.length) {
    const hoverX = pad.left + chartWidth * hoverIndex.value / bucketCount
    ctx.save()
    ctx.strokeStyle = '#94a3b8'
    ctx.setLineDash([4, 4])
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(hoverX, pad.top)
    ctx.lineTo(hoverX, pad.top + chartHeight)
    ctx.stroke()
    ctx.restore()

    for (const item of series) {
      const val = item.values[hoverIndex.value] || 0
      const y = pad.top + chartHeight - (val / yMax) * chartHeight
      ctx.fillStyle = '#ffffff'
      ctx.strokeStyle = item.color
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.arc(hoverX, y, 4.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
  }

  ctx.fillStyle = '#8491a3'
  ctx.textAlign = 'center'
  const displayXLabels = xLabels.length === 5 ? xLabels : ['24小时前', '18小时前', '12小时前', '6小时前', '现在']
  displayXLabels.forEach((label, index) => ctx.fillText(label, pad.left + chartWidth * index / 4, height - 8))
  ctx.textAlign = 'start'
}

function handlePointerMove(e) {
  if (!canvasElement.value) return
  const rect = canvasElement.value.getBoundingClientRect()
  const clientX = e.touches ? e.touches[0].clientX : e.clientX
  const clientY = e.touches ? e.touches[0].clientY : e.clientY
  const mouseX = clientX - rect.left
  const mouseY = clientY - rect.top

  const pad = { left: 42, right: 26, top: 22, bottom: 32 }
  const chartWidth = rect.width - pad.left - pad.right

  if (mouseX < pad.left || mouseX > rect.width - pad.right || mouseY < pad.top || mouseY > rect.height - pad.bottom) {
    handlePointerLeave()
    return
  }

  const buckets = currentBuckets.value
  if (!buckets || !buckets.length) {
    handlePointerLeave()
    return
  }

  const bucketCount = Math.max(1, buckets.length - 1)
  const ratio = Math.max(0, Math.min(1, (mouseX - pad.left) / chartWidth))
  const activeIdx = Math.round(ratio * bucketCount)

  hoverIndex.value = activeIdx
  const b = buckets[activeIdx]
  if (b) {
    const timeStr = b.ts ? formatFullTimeLabel(b.ts) : (b.label || `桶 #${activeIdx + 1}`)
    let posX = mouseX + 12
    if (posX + 150 > rect.width) {
      posX = mouseX - 150 - 12
    }
    let posY = mouseY - 25
    if (posY < 10) posY = 10

    hoverTooltip.value = {
      visible: true,
      x: Math.max(8, posX),
      y: posY,
      time: timeStr,
      errors: Number(b.errors) || 0,
      requests: Number(b.requests) || 0
    }
  }
  draw()
}

function handlePointerLeave() {
  if (hoverIndex.value !== -1 || hoverTooltip.value.visible) {
    hoverIndex.value = -1
    hoverTooltip.value.visible = false
    draw()
  }
}

onMounted(() => { nextTick(draw); observer = new ResizeObserver(draw); observer.observe(canvasElement.value) })
onBeforeUnmount(() => observer?.disconnect())
watch([() => props.events, () => props.trend, () => props.hiddenSeries], draw, { deep: true })
</script>

<template>
  <div
    ref="containerElement"
    class="trend-chart-container"
    @mousemove="handlePointerMove"
    @mouseleave="handlePointerLeave"
    @touchmove.passive="handlePointerMove"
    @touchend="handlePointerLeave"
  >
    <canvas ref="canvasElement" class="trend-canvas" aria-label="错误与请求趋势图"></canvas>

    <div
      v-if="hoverTooltip.visible"
      class="trend-tooltip"
      :style="{ left: hoverTooltip.x + 'px', top: hoverTooltip.y + 'px' }"
    >
      <div class="tooltip-time">{{ hoverTooltip.time }}</div>
      <div v-if="!hiddenSeries?.errors" class="tooltip-row red">
        <span class="dot"></span>
        <span class="label">错误数</span>
        <span class="value">{{ hoverTooltip.errors }}</span>
      </div>
      <div v-if="!hiddenSeries?.requests" class="tooltip-row blue">
        <span class="dot"></span>
        <span class="label">请求数</span>
        <span class="value">{{ hoverTooltip.requests }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.trend-chart-container {
  position: relative;
  width: 100%;
  height: 220px;
}

.trend-canvas {
  width: 100%;
  height: 100%;
  display: block;
}

.trend-tooltip {
  position: absolute;
  pointer-events: none;
  z-index: 20;
  background: rgba(15, 23, 42, 0.92);
  backdrop-filter: blur(8px);
  color: #ffffff;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 12px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2);
  border: 1px solid rgba(255, 255, 255, 0.12);
  white-space: nowrap;
  min-width: 130px;
}

.tooltip-time {
  font-size: 11px;
  color: #94a3b8;
  margin-bottom: 6px;
  font-weight: 500;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  padding-bottom: 4px;
}

.tooltip-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
}

.tooltip-row .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
}

.tooltip-row.red .dot {
  background: #ef4444;
}

.tooltip-row.blue .dot {
  background: #1769e0;
}

.tooltip-row .label {
  color: #cbd5e1;
  font-size: 12px;
}

.tooltip-row .value {
  font-weight: 600;
  margin-left: auto;
  font-size: 12px;
}
</style>
