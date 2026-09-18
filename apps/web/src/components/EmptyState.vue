<!--
  通用暂无数据组件 (EmptyState)
  用于表格、面板、列表等无数据场景，图标居中并在下方展示提示文字。
-->
<script setup>
defineProps({
  description: { type: String, default: '暂无数据' },
  text: { type: String, default: '' },
  imageSize: { type: Number, default: 68 }
})
</script>

<template>
  <div class="app-empty-state">
    <div class="empty-icon" :style="{ width: `${imageSize}px`, height: `${imageSize}px` }">
      <svg width="100%" height="100%" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg">
        <!-- 背景淡紫圆环 -->
        <circle cx="40" cy="40" r="32" fill="#EEF2FF" />
        <!-- 文件夹/数据箱主体 -->
        <path d="M24 28C24 25.7909 25.7909 24 28 24H36.3431C37.404 24 38.4214 24.4214 39.1716 25.1716L41.8284 27.8284C42.5786 28.5786 43.596 29 44.6569 29H52C54.2091 29 56 30.7909 56 33V52C56 54.2091 54.2091 56 52 56H28C25.7909 56 24 54.2091 24 52V28Z" fill="#E0E7FF" stroke="#818CF8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <!-- 前置空白卡片 -->
        <rect x="28" y="34" width="24" height="18" rx="3" fill="white" stroke="#6366F1" stroke-width="2" />
        <line x1="33" y1="39" x2="47" y2="39" stroke="#A5B4FC" stroke-width="2" stroke-linecap="round" />
        <line x1="33" y1="44" x2="43" y2="44" stroke="#C7D2FE" stroke-width="2" stroke-linecap="round" />
        <!-- 右下虚线点缀 -->
        <circle cx="52" cy="48" r="7" fill="#F3F4F6" stroke="#9CA3AF" stroke-width="1.5" stroke-dasharray="2 2" />
        <!-- 装饰星点 -->
        <circle cx="20" cy="22" r="2" fill="#818CF8" opacity="0.6"/>
        <circle cx="62" cy="26" r="1.5" fill="#A5B4FC" opacity="0.8"/>
      </svg>
    </div>
    <div class="empty-description">{{ text || description }}</div>
    <div v-if="$slots.default || $slots.action" class="empty-action">
      <slot name="action"><slot /></slot>
    </div>
  </div>
</template>

<style scoped>
.app-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 16px 12px;
  text-align: center;
}
.empty-icon {
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.empty-description {
  color: var(--c-text-muted, #6b7585);
  font-size: 13px;
  line-height: 1.4;
}
.empty-action {
  margin-top: 10px;
}
</style>
