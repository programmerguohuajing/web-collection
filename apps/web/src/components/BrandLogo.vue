<script setup>
import { computed } from 'vue'
import { useBrand } from '../composables/useBrand'

const props = defineProps({
  size: {
    type: [String, Number],
    default: '32px'
  },
  customUrl: {
    type: String,
    default: ''
  },
  alt: {
    type: String,
    default: ''
  }
})

const { brandLogoUrl, brandName } = useBrand()

const computedSize = computed(() => {
  if (typeof props.size === 'number') return `${props.size}px`
  return String(props.size)
})

const logoSrc = computed(() => props.customUrl || brandLogoUrl.value || '')
const altText = computed(() => props.alt || brandName.value || 'Web Collection')
</script>

<template>
  <div class="brand-logo-wrapper" :style="{ width: computedSize, height: computedSize }">
    <img v-if="logoSrc" :src="logoSrc" class="brand-logo-img" :alt="altText" />
    <svg
      v-else
      class="brand-logo-svg"
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="logoBgGrad" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#0f172a" />
          <stop offset="100%" stop-color="#1e1b4b" />
        </linearGradient>
        <linearGradient id="ringGrad" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#6366f1" />
          <stop offset="50%" stop-color="#3b82f6" />
          <stop offset="100%" stop-color="#0ea5e9" />
        </linearGradient>
        <linearGradient id="lineGrad" x1="112" y1="256" x2="400" y2="256" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#38bdf8" />
          <stop offset="50%" stop-color="#ffffff" />
          <stop offset="100%" stop-color="#818cf8" />
        </linearGradient>
      </defs>
      <!-- 圆角边框背景 -->
      <rect width="512" height="512" rx="128" fill="url(#logoBgGrad)" />
      <!-- 科技光环背景与主圈 -->
      <circle cx="256" cy="256" r="176" stroke="url(#ringGrad)" stroke-width="20" stroke-opacity="0.3" />
      <circle cx="256" cy="256" r="148" stroke="url(#ringGrad)" stroke-width="26" fill="none" />
      <!-- 心跳遥测波形脉冲 -->
      <path d="M112 272 H184 L216 186 L264 340 L312 210 L344 282 H400" stroke="url(#lineGrad)" stroke-width="28" stroke-linecap="round" stroke-linejoin="round" fill="none" />
      <!-- 遥测节点亮灯 -->
      <circle cx="344" cy="210" r="22" fill="#38bdf8" />
      <circle cx="344" cy="210" r="10" fill="#ffffff" />
    </svg>
  </div>
</template>

<style scoped>
.brand-logo-wrapper {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  vertical-align: middle;
}

.brand-logo-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  border-radius: 6px;
}

.brand-logo-svg {
  width: 100%;
  height: 100%;
  display: block;
  filter: drop-shadow(0 2px 8px rgba(99, 102, 241, 0.25));
  transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.brand-logo-wrapper:hover .brand-logo-svg {
  transform: scale(1.06);
}
</style>
