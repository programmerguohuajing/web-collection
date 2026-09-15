<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps({
  events: { type: Array, default: () => [] },
  trend: { type: Array, default: () => null }
})
const canvasElement = ref(null)
let observer

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
    buckets = props.trend
    if (buckets.length >= 5) {
      xLabels = [
        buckets[0]?.label,
        buckets[Math.floor(buckets.length * 0.25)]?.label,
        buckets[Math.floor(buckets.length * 0.5)]?.label,
        buckets[Math.floor(buckets.length * 0.75)]?.label,
        buckets[buckets.length - 1]?.label
      ].filter(Boolean)
    }
  } else if (Array.isArray(props.events) && props.events.length) {
    const timestamps = props.events.map(event => Number(event.ts)).filter(value => Number.isFinite(value) && value > 0)
    const now = Date.now()
    const recentStart = now - 23 * 3600000
    const hasRecentEvents = timestamps.some(value => value >= recentStart && value <= now)
    const rangeEnd = hasRecentEvents ? now : (timestamps.length ? Math.max(...timestamps) : now)
    const rangeStart = hasRecentEvents ? recentStart : (timestamps.length ? Math.min(rangeEnd - 23 * 3600000, Math.min(...timestamps)) : recentStart)
    const rangeSpan = Math.max(1, rangeEnd - rangeStart)
    buckets = Array.from({ length: 24 }, () => ({ errors: 0, requests: 0 }))
    for (const event of props.events) {
      const timestamp = Number(event.ts || rangeEnd)
      if (!Number.isFinite(timestamp) || timestamp < rangeStart || timestamp > rangeEnd) continue
      const bucketIndex = Math.min(23, Math.max(0, Math.floor((timestamp - rangeStart) / rangeSpan * 24)))
      const bucket = buckets[bucketIndex]
      if (event.type === 'error') bucket.errors++
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

  const series = [
    { color: '#ef4444', values: buckets.map(item => Number(item.errors) || 0) },
    { color: '#1769e0', values: buckets.map(item => Number(item.requests) || 0) }
  ]

  const max = Math.max(1, ...series.flatMap(item => item.values))

  ctx.strokeStyle = '#e8edf3'
  ctx.lineWidth = 1
  ctx.font = '11px Segoe UI'
  ctx.fillStyle = '#8491a3'
  for (let index = 0; index <= 4; index++) {
    const y = pad.top + chartHeight * index / 4
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke()
    const val = Math.round(max * (4 - index) / 4)
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
      const y = pad.top + chartHeight - value / max * chartHeight
      index ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
    })
    ctx.stroke()
  }

  ctx.fillStyle = '#8491a3'
  const displayXLabels = xLabels.length === 5 ? xLabels : ['24小时前', '18小时前', '12小时前', '6小时前', '现在']
  displayXLabels.forEach((label, index) => ctx.fillText(label, pad.left + chartWidth * index / 4 - 14, height - 8))
}

onMounted(() => { nextTick(draw); observer = new ResizeObserver(draw); observer.observe(canvasElement.value) })
onBeforeUnmount(() => observer?.disconnect())
watch([() => props.events, () => props.trend], draw, { deep: true })
</script>

<template><canvas ref="canvasElement" class="trend-canvas" aria-label="错误与请求趋势图"></canvas></template>
