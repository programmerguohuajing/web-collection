<script setup>
/**
 * @file 仪表盘头部组件，展示标题、Admin API Key 输入和刷新按钮。
 */
defineProps({ loading: Boolean })
const apiKey = defineModel('apiKey', { type: String, default: '' })
defineEmits(['refresh'])
</script>

<template>
  <section class="hero section">
    <div>
      <p class="eyebrow">Web Collection</p>
      <h1>前端监控生产看板</h1>
    </div>
    <el-form class="keybar" @submit.prevent="$emit('refresh')">
      <el-input v-model="apiKey" placeholder="Admin API Key" type="password" show-password />
      <el-button type="primary" native-type="submit" :loading="loading">刷新</el-button>
    </el-form>
  </section>
</template>
