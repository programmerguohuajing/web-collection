<script setup>
/**
 * D3 · 配额进度条（事件 / 回放会话 / 席位）。
 * 配色与超限级别对齐：< soft → 绿；soft~hard → 橙；>= hard → 红（PRD §4 阈值语义）。
 * 不限量（quota=-1 / unlimited）显示「不限量」标签，不渲染进度条。
 */
import { computed } from 'vue'

const props = defineProps({
  /** 用量指标数组：[{ metric, used, quota, pct, level, unlimited }]（来自 GET /api/metering/usage.metrics） */
  metrics: { type: Array, default: () => [] },
  /** 软限百分比（来自套餐），仅用于语义说明，实际配色依据后端已算好的 level */
  softLimitPct: { type: Number, default: 80 }
})

const META = {
  events: '事件数',
  replay_sessions: '回放会话数',
  seats: '席位'
}

const rows = computed(() =>
  (props.metrics || []).map(m => {
    const quota = Number(m.quota ?? -1)
    return {
      metric: m.metric,
      label: META[m.metric] || m.metric,
      used: Number(m.used ?? 0),
      quota,
      pct: Number(m.pct ?? 0),
      level: m.level || 'ok',
      unlimited: m.unlimited === true || quota <= 0
    }
  })
)

function displayPct(row) {
  return Math.max(0, Math.min(100, Math.round(row.pct)))
}
function barColor(level) {
  if (level === 'hard') return '#ef4444'
  if (level === 'soft') return '#f59e0b'
  return '#10b981'
}
function fmt(n) {
  return Number(n || 0).toLocaleString()
}
</script>

<template>
  <div class="quota-progress">
    <div v-for="row in rows" :key="row.metric" class="quota-row">
      <div class="quota-head">
        <span class="quota-label">{{ row.label }}</span>
        <span v-if="row.unlimited" class="quota-unlimited">不限量</span>
        <span v-else class="quota-fig">
          已用 {{ fmt(row.used) }} / 配额 {{ fmt(row.quota) }}
          <b :style="{ color: barColor(row.level) }">（{{ Math.round(row.pct) }}%）</b>
        </span>
      </div>
      <el-progress
        v-if="!row.unlimited"
        :percentage="displayPct(row)"
        :color="barColor(row.level)"
        :stroke-width="14"
        :show-text="false"
      />
    </div>
  </div>
</template>

<style scoped>
.quota-progress { display: grid; gap: 16px; }
.quota-row { display: grid; gap: 7px; }
.quota-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.quota-label { font-size: 13px; font-weight: 600; color: var(--c-text); }
.quota-fig { font-size: 12px; color: var(--c-text-muted); font-variant-numeric: tabular-nums; }
.quota-fig b { font-weight: 700; }
.quota-unlimited { font-size: 12px; color: var(--c-success); font-weight: 600; }
</style>
