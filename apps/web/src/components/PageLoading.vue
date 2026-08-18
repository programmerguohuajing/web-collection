<script setup>
// 页面级加载遮罩：自定义 redesign 的转圈图标（替代 Element Plus 默认 spinner）
// - 靛蓝主色 + 天蓝渐变弧，旋转放慢到 3.4s 匀速（linear），避免"转太快/忽快忽慢"的视觉疲劳
// - 中心脉冲核心点，柔化遮罩背景，无文字（保持全屏居中无文字的原有约定）
defineProps({
  active: { type: Boolean, default: false }
})
</script>

<template>
  <transition name="wc-loading-fade">
    <div v-if="active" class="wc-page-loading" role="status" aria-label="加载中">
      <div class="wc-spinner">
        <svg class="wc-spinner-svg" viewBox="0 0 50 50" aria-hidden="true">
          <defs>
            <linearGradient id="wc-spin-grad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="var(--c-primary)" />
              <stop offset="100%" stop-color="var(--c-accent)" />
            </linearGradient>
          </defs>
          <circle class="wc-ring-track" cx="25" cy="25" r="20" />
          <circle class="wc-ring-arc" cx="25" cy="25" r="20" />
        </svg>
        <span class="wc-spinner-core" />
      </div>
    </div>
  </transition>
</template>

<style scoped>
.wc-page-loading {
  position: absolute;
  inset: 0;
  /* 必须高于 Element Plus v-loading 默认遮罩（z-index 2000），
     否则页面内 el-table/el-card 的 v-loading 会叠在全屏遮罩之上，出现"上下两个 loading"。 */
  z-index: 3000;
  display: grid;
  place-items: center;
  /* 足够不透明，遮住下层页面的局部 v-loading 转圈，保证全局加载时只显示这一个 */
  background: color-mix(in srgb, var(--c-surface) 88%, transparent);
  backdrop-filter: blur(2px);
  cursor: progress;
}

.wc-spinner {
  position: relative;
  width: 46px;
  height: 46px;
}

.wc-spinner-svg {
  width: 100%;
  height: 100%;
  display: block;
}

.wc-ring-track {
  fill: none;
  stroke: var(--c-border);
  stroke-width: 4;
}

.wc-ring-arc {
  fill: none;
  stroke: url(#wc-spin-grad);
  stroke-width: 4;
  stroke-linecap: round;
  /* 圆周长 ≈125.66，可见 100、缺口 26 → 带缺口的环，旋转即为经典 spinner */
  stroke-dasharray: 100 126;
  transform-origin: center;
  transform: rotate(-90deg);
  /* 3.4s 匀速（linear）旋转：比 EP 默认 2s 明显更慢，且匀速无加减速，观感更平稳 */
  animation: wc-spin 3.4s linear infinite;
}

.wc-spinner-core {
  position: absolute;
  inset: 0;
  margin: auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--c-primary);
  box-shadow: 0 0 0 4px var(--c-primary-soft);
  animation: wc-pulse 1.7s ease-in-out infinite;
}

@keyframes wc-spin {
  to { transform: rotate(270deg); }
}

@keyframes wc-pulse {
  0%, 100% { transform: scale(.85); opacity: .85; }
  50% { transform: scale(1.12); opacity: 1; }
}

.wc-loading-fade-enter-active,
.wc-loading-fade-leave-active {
  transition: opacity .25s ease;
}
.wc-loading-fade-enter-from,
.wc-loading-fade-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .wc-ring-arc { animation-duration: 4.6s; }
  .wc-spinner-core { animation: none; }
}
</style>
