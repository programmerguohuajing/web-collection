<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps({ events: { type: Array, default: () => [] } })
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

  ctx.strokeStyle = '#e8edf3'
  ctx.lineWidth = 1
  ctx.font = '11px Segoe UI'
  ctx.fillStyle = '#8491a3'
  for (let index = 0; index <= 4; index++) {
    const y = pad.top + chartHeight * index / 4
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke()
    ctx.fillText(String(100 - index * 25), 8, y + 4)
  }

  const now = Date.now()
  const buckets = Array.from({ length: 24 }, () => ({ errors: 0, users: new Set(), perf: [] }))
  for (const event of props.events) {
    const age = Math.floor((now - Number(event.ts || now)) / 3600000)
    if (age < 0 || age > 23) continue
    const bucket = buckets[23 - age]
    if (event.type === 'error') bucket.errors++
    if (event.userId || event.deviceId) bucket.users.add(event.userId || event.deviceId)
    if (event.type === 'perf' && Number.isFinite(Number(event.value))) bucket.perf.push(Number(event.value))
  }
  if (!props.events.length) buckets.forEach((item, index) => { item.errors = index % 5 + (index === 19 ? 18 : 0); item.users.add(index); item.perf = [18 + index % 7 + (index === 19 ? 45 : 0)] })
  const series = [
    { color: '#ef4444', values: buckets.map(item => item.errors) },
    { color: '#6d4aff', values: buckets.map(item => item.users.size) },
    { color: '#1769e0', values: buckets.map(item => item.perf.length ? item.perf.reduce((a, b) => a + b, 0) / item.perf.length : 0) }
  ]
  const max = Math.max(1, ...series.flatMap(item => item.values))
  for (const item of series) {
    ctx.strokeStyle = item.color; ctx.lineWidth = 2.2; ctx.beginPath()
    item.values.forEach((value, index) => {
      const x = pad.left + chartWidth * index / 23
      const y = pad.top + chartHeight - value / max * chartHeight
      index ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
    })
    ctx.stroke()
  }
  ctx.fillStyle = '#8491a3'
  ;['24小时前', '18小时前', '12小时前', '6小时前', '现在'].forEach((label, index) => ctx.fillText(label, pad.left + chartWidth * index / 4 - 18, height - 8))
}

onMounted(() => { nextTick(draw); observer = new ResizeObserver(draw); observer.observe(canvasElement.value) })
onBeforeUnmount(() => observer?.disconnect())
watch(() => props.events, draw, { deep: true })
</script>

<template><canvas ref="canvasElement" class="trend-canvas" aria-label="错误与性能趋势图"></canvas></template>
