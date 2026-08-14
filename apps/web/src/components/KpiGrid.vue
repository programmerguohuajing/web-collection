<script setup>
defineProps({
  items: { type: Array, default: () => [] }
})
</script>

<template>
  <section v-if="items.length" class="kpi-grid section" aria-label="关键指标">
    <el-card v-for="item in items" :key="item.label" shadow="never" class="kpi-card">
      <div class="kpi-label">{{ item.label }}</div>
      <div class="kpi-value" :class="item.valueClass">{{ item.value }}</div>
      <div class="kpi-delta" :class="item.deltaClass">{{ item.delta || '当前筛选范围' }}</div>
    </el-card>
  </section>
</template>

<style scoped>
.kpi-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 20px; }
.kpi-card { min-height: 112px; }
.kpi-label { color: var(--c-text-muted); font-size: 13px; font-weight: 500; }
.kpi-value { margin-top: 10px; color: var(--c-text); font-family: var(--font-mono); font-size: 30px; font-weight: 600; line-height: 1.15; }
.kpi-delta { margin-top: 6px; color: var(--c-text-muted); font-size: 12px; font-weight: 600; }
.value-danger { color: var(--c-danger); }
.value-primary { color: var(--c-primary); }
.value-success { color: var(--c-success); }
.value-purple { color: var(--c-purple); }
.delta-good { color: var(--c-success); }
.delta-bad { color: var(--c-danger); }
@media (max-width: 1100px) { .kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 720px) { .kpi-grid { grid-template-columns: 1fr; } }
</style>
