<script setup>
/**
 * @file 告警面板组件
 * 展示性能告警和错误回归告警列表。
 */
defineProps({ alerts: { type: Array, default: () => [] } })
</script>

<template>
  <section v-if="alerts.length" class="alerts section">
    <el-alert
      v-for="item in alerts"
      :key="item.metric"
      :type="item.level === 'error' ? 'error' : 'warning'"
      :title="`${item.metric} ${item.message}`"
      show-icon
      :closable="false"
    />
  </section>
</template>
