<script setup>
import { computed } from 'vue'

const props = defineProps({
  steps: { type: Array, default: () => [] },
  selectedStep: { type: Number, default: 0 }
})
const emit = defineEmits(['update:selectedStep'])

const enriched = computed(() => (props.steps || []).map((item, i) => ({
  ...item,
  _index: i,
  _rate: Number(item.rate) || 0,
  _stepRate: Number(item.stepRate) || 0,
  _lost: Number(item.lost) || 0,
  _count: Number(item.count) || 0,
  _convWidth: i === 0 ? 100 : (Number(item.stepRate) || 0)
})))

function select(i) { emit('update:selectedStep', i) }
function fmt(n) { return (Number(n) || 0).toLocaleString() }
</script>

<template>
  <div class="path">
    <template v-for="(item, i) in enriched" :key="i">
      <div
        class="step-node"
        :class="{ selected: i === selectedStep }"
        @click="select(i)"
      >
        <span class="idx">{{ i + 1 }}</span>
        <div class="name">{{ item.step }}</div>
        <div class="nums">
          <div class="row"><span class="l">进入</span><span class="v">{{ fmt(item._count) }}</span></div>
          <div class="row"><span class="l">流失</span><span class="v danger">{{ fmt(item._lost) }}</span></div>
        </div>
        <div class="conv"><i :style="{ width: item._convWidth + '%' }"></i></div>
      </div>
      <div v-if="i < enriched.length - 1" class="connector">
        <span class="pct">{{ item._stepRate }}%</span>
        <span class="lost">−{{ fmt(item._lost) }}</span>
        <span class="arrow">▶</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.path { display: flex; align-items: stretch; gap: 0; overflow-x: auto; padding-bottom: 6px; }
.step-node {
  flex: 1 1 0; min-width: 150px;
  background: var(--c-surface-2);
  border: 1px solid var(--c-border);
  border-radius: 12px; padding: 14px; cursor: pointer;
  transition: border-color .15s, box-shadow .15s, background .15s; position: relative;
}
.step-node:hover { border-color: var(--c-primary); box-shadow: 0 0 0 1px var(--c-primary) inset, var(--sh-md); }
.step-node.selected { border-color: var(--c-primary); background: var(--c-primary-soft); box-shadow: 0 0 0 1px var(--c-primary) inset; }
.step-node .idx {
  position: absolute; top: 6px; left: 6px;
  width: 20px; height: 20px; border-radius: 50%;
  background: var(--c-primary); color: #fff; font-size: 11px;
  display: grid; place-items: center; font-weight: 700;
}
.step-node.selected .idx { box-shadow: 0 0 0 2px var(--c-surface-2) inset; }
.step-node .name { font-size: 14px; font-weight: 600; margin: 26px 0 10px; color: var(--c-text); }
.step-node .nums { display: flex; flex-direction: column; gap: 5px; }
.step-node .row { display: flex; justify-content: space-between; font-size: 12px; }
.step-node .row .l { color: var(--c-text-muted); }
.step-node .row .v { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--c-text); }
.step-node .row .v.danger { color: var(--c-danger); }
.step-node .conv { margin-top: 10px; height: 6px; border-radius: 4px; background: var(--c-surface-3); overflow: hidden; }
.step-node .conv i { display: block; height: 100%; background: linear-gradient(90deg, var(--c-primary), var(--c-primary-2, #6366f1)); }
.connector { flex: 0 0 64px; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--c-text-muted); }
.connector .pct { font-family: var(--font-mono); font-size: 13px; font-weight: 600; color: var(--c-primary); }
.connector .lost { font-size: 11px; color: var(--c-danger); }
.connector .arrow { margin-top: 4px; opacity: .5; color: var(--c-primary); }
</style>
