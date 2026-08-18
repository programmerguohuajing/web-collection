<!--
  PathFlow
  ========
  Renders a user journey as a sequence of refined step chips instead of a
  flat monospace string. Each step is a compact card with:
    • 2px colored top accent (category aware: auth / orders / rent / trade /
      user / admin / home / neutral)
    • Small step number (01, 02, ...) and category glyph
    • Path segment in monospace

  Steps are joined by thin SVG connectors with chevron tips. Long paths
  (> MAX_VISIBLE_STEPS) are folded: keep first N + last 1 with a "+K" chip
  in between. Hovering the "+K" chip reveals the hidden steps via tooltip.

  Pure presentational; no API calls, no DOM mutation beyond tooltip.
-->
<script setup>
import { computed } from 'vue'
import OverflowTip from './OverflowTip.vue'

const props = defineProps({
  path: { type: String, default: '' },
  // 内部直接展示的最大步骤数；超出部分折叠为 "+K"
  maxVisible: { type: Number, default: 6 },
  // 单元格整体的上层提示（保留 cell tooltip 兼容）
  tooltip: { type: String, default: '' }
})

const MAX_VISIBLE_STEPS = computed(() => Math.max(2, props.maxVisible))

// 把 `/login → /user/orders/rent-buyer → ...` 切成数组。
// 后端约定使用 U+2192 (→) 作为分隔；额外兼容 → ASCII 替代符。
const SEPARATOR = /\s*(?:→|->|=>)\s*/

const steps = computed(() => {
  if (!props.path) return []
  return props.path
    .split(SEPARATOR)
    .map(s => s.trim())
    .filter(Boolean)
})

// 给每个步骤计算分类与配色。分类完全靠 URL 前缀推断，不发起网络请求。
// 优先级：先匹配业务页（rent/trade/orders），再匹配通用页（auth/user/admin/home）。
const CATEGORY_RULES = [
  { match: /\/rent-(buyer|seller|product)\b/, category: 'rent', label: '租赁', hue: '#0ea5e9' },
  { match: /\/trade-(buyer|seller|product|order)\b/, category: 'trade', label: '交易', hue: '#f59e0b' },
  // /user/orders?/(trade|rent)-* 子路径 → 按业务分类优先
  { match: /\/orders?\/[^\/]*trade/i, category: 'trade', label: '交易', hue: '#f59e0b' },
  { match: /\/orders?\/[^\/]*rent/i, category: 'rent', label: '租赁', hue: '#0ea5e9' },
  { match: /\/orders?(\/|$)/, category: 'orders', label: '订单', hue: '#4f46e5' },
  { match: /\/products\/trade\b/, category: 'trade', label: '交易', hue: '#f59e0b' },
  { match: /\/products\/rent\b/, category: 'rent', label: '租赁', hue: '#0ea5e9' },
  { match: /^(\/.*)?\/(login|signin|signup|register|forgot|reset|logout|auth)(\b|\/|$)/, category: 'auth', label: 'Auth', hue: '#94a3b8' },
  { match: /(^|\/)(profile|account|settings|messages|notifications)(\b|\/|$)/, category: 'user', label: '账户', hue: '#10b981' },
  { match: /(^|\/)(admin|console|manage)(\b|\/|$)/, category: 'admin', label: '管理', hue: '#8b5cf6' },
  { match: /(^|\/)(home|index|dashboard|overview)(\b|\/|$)|^\/$/, category: 'home', label: '首页', hue: '#14b8a6' }
]

function classify(segment) {
  for (const rule of CATEGORY_RULES) if (rule.match.test(segment)) return rule
  return { category: 'neutral', label: 'Page', hue: '#6b7585' }
}

const enrichedSteps = computed(() =>
  steps.value.map((segment, index) => {
    const cls = classify(segment)
    // 提取页面最后一段（去掉 query/hash），让显示名更紧凑
    const cleanSeg = segment.split(/[?#]/)[0]
    const parts = cleanSeg.split('/').filter(Boolean)
    const shortName = parts[parts.length - 1] || '/'
    return {
      index,
      segment: cleanSeg,
      shortName,
      category: cls.category,
      label: cls.label,
      hue: cls.hue,
      isFirst: index === 0,
      isLast: index === steps.value.length - 1
    }
  })
)

// 把超长路径折叠成 [first N, +K, last 1]
const foldedSteps = computed(() => {
  const all = enrichedSteps.value
  const max = MAX_VISIBLE_STEPS.value
  if (all.length <= max) return { head: all, hidden: [], tail: [] }

  // 头部保留 max - 2 步（给 +K 折叠器和最末一步留位）
  const headCount = max - 2
  const head = all.slice(0, headCount)
  const hidden = all.slice(headCount, all.length - 1)
  const tail = all.slice(all.length - 1)
  return { head, hidden, tail }
})

const needsFold = computed(() => enrichedSteps.value.length > MAX_VISIBLE_STEPS.value)
const hiddenTooltip = computed(() =>
  foldedSteps.value.hidden.map((s, i) => `${String(i + foldedSteps.value.head.length + 1).padStart(2, '0')}  ·  ${s.segment}`).join('\n')
)
</script>

<template>
  <div class="path-flow" :title="tooltip || undefined">
    <template v-if="enrichedSteps.length === 0">
      <span class="path-flow__empty">— 无路径 —</span>
    </template>
    <template v-else>
      <template v-if="!needsFold">
        <div
          v-for="(step, i) in enrichedSteps"
          :key="`s-${i}`"
          class="pf-step"
          :class="[`pf-step--${step.category}`, { 'pf-step--first': step.isFirst, 'pf-step--last': step.isLast }]"
          :style="{ '--pf-hue': step.hue }"
        >
          <span class="pf-step__num">{{ String(i + 1).padStart(2, '0') }}</span>
          <span class="pf-step__dot" aria-hidden="true"></span>
          <span class="pf-step__path" :title="step.segment">{{ step.shortName }}</span>
          <span v-if="i < enrichedSteps.length - 1" class="pf-arrow" aria-hidden="true">
            <svg viewBox="0 0 16 10" width="16" height="10">
              <path d="M0 5 H12 M9 1.5 L13 5 L9 8.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
        </div>
      </template>

      <template v-else>
        <!-- Head: visible steps -->
        <div
          v-for="step in foldedSteps.head"
          :key="`h-${step.index}`"
          class="pf-step"
          :class="[`pf-step--${step.category}`]"
          :style="{ '--pf-hue': step.hue }"
        >
          <span class="pf-step__num">{{ String(step.index + 1).padStart(2, '0') }}</span>
          <span class="pf-step__dot" aria-hidden="true"></span>
          <span class="pf-step__path" :title="step.segment">{{ step.shortName }}</span>
          <span class="pf-arrow" aria-hidden="true">
            <svg viewBox="0 0 16 10" width="16" height="10">
              <path d="M0 5 H12 M9 1.5 L13 5 L9 8.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
        </div>

        <!-- Fold indicator -->
        <OverflowTip :text="hiddenTooltip" force class="pf-fold">
          <template #content>
            <div style="max-width: 320px; line-height: 1.7; font-family: var(--font-mono); font-size: 11.5px;">
              <div v-for="line in hiddenTooltip.split('\n')" :key="line">{{ line }}</div>
            </div>
          </template>
          <template #default>
            <span class="pf-fold__bar"></span>
            <span class="pf-fold__bar"></span>
            <span class="pf-fold__bar"></span>
            <span class="pf-fold__count">+{{ foldedSteps.hidden.length }}</span>
          </template>
        </OverflowTip>

        <!-- Tail: last step -->
        <div
          v-for="step in foldedSteps.tail"
          :key="`t-${step.index}`"
          class="pf-step pf-step--tail"
          :class="[`pf-step--${step.category}`, { 'pf-step--last': step.isLast }]"
          :style="{ '--pf-hue': step.hue }"
        >
          <span v-if="foldedSteps.head.length" class="pf-arrow" aria-hidden="true">
            <svg viewBox="0 0 16 10" width="16" height="10">
              <path d="M0 5 H12 M9 1.5 L13 5 L9 8.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
          <span class="pf-step__num">{{ String(step.index + 1).padStart(2, '0') }}</span>
          <span class="pf-step__dot" aria-hidden="true"></span>
          <span class="pf-step__path" :title="step.segment">{{ step.shortName }}</span>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.path-flow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0;
  row-gap: 6px;
  font-family: var(--font-sans);
  min-height: 30px;
  --pf-hue: var(--c-text-muted);
}

.path-flow__empty {
  color: var(--c-text-faint);
  font-size: 12px;
  font-style: italic;
}

/* ---------- Step chip ---------- */
.pf-step {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 9px 0 7px;
  border-radius: 7px;
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-top-color: var(--pf-hue, var(--c-border));
  border-top-width: 2px;
  color: var(--c-text);
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  transition:
    transform 140ms ease,
    box-shadow 140ms ease,
    border-color 140ms ease,
    background 140ms ease;
  cursor: default;
}
.pf-step::before {
  content: '';
  position: absolute;
  top: -2px;
  left: -1px;
  right: -1px;
  height: 2px;
  background: linear-gradient(90deg, transparent 0%, var(--pf-hue) 30%, var(--pf-hue) 70%, transparent 100%);
  border-radius: 7px 7px 0 0;
  opacity: 0.85;
  pointer-events: none;
}
.pf-step:hover {
  transform: translateY(-1px);
  box-shadow:
    0 0 0 1px var(--pf-hue) inset,
    0 4px 10px -2px rgba(16, 24, 40, 0.12);
  background: var(--c-surface);
}
.pf-step--first {
  background: linear-gradient(180deg, color-mix(in srgb, var(--pf-hue) 8%, var(--c-surface)) 0%, var(--c-surface) 100%);
}
.pf-step--last::after {
  content: '●';
  position: absolute;
  top: 50%;
  right: -3px;
  width: 6px;
  height: 6px;
  display: grid;
  place-items: center;
  color: var(--pf-hue);
  font-size: 6px;
  line-height: 1;
  background: var(--c-surface);
  border-radius: 50%;
  transform: translateY(-50%);
}
.pf-step--last .pf-step__path {
  font-weight: 600;
}

.pf-step__num {
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: var(--c-text-faint);
}
.pf-step:hover .pf-step__num { color: var(--pf-hue); }

.pf-step__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--pf-hue);
  flex-shrink: 0;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--pf-hue) 25%, transparent);
}

.pf-step__path {
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-weight: 600;
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---------- Arrow ---------- */
.pf-arrow {
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 12px;
  margin: 0 4px;
  color: var(--c-text-faint);
  transition: color 140ms ease;
}
.pf-arrow svg { display: block; }
.pf-step:hover + .pf-arrow,
.pf-arrow:has(+ .pf-step:hover) { color: var(--c-primary); }

/* ---------- Fold indicator ---------- */
.pf-fold {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  margin: 0 6px;
  border-radius: 7px;
  background: var(--c-surface-3);
  border: 1px dashed var(--c-border);
  color: var(--c-text-muted);
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  cursor: help;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
}
.pf-fold:hover {
  background: var(--c-primary-soft);
  color: var(--c-primary);
  border-color: var(--c-primary);
}
.pf-fold__bar {
  display: inline-block;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
}
.pf-fold__bar:nth-child(2) { opacity: 0.55; }
.pf-fold__bar:nth-child(3) { opacity: 0.3; }
.pf-fold__count { letter-spacing: 0.3px; }
</style>
