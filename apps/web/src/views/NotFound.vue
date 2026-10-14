<script setup>
import { useRouter } from 'vue-router'

const router = useRouter()
function goHome() { router.push('/overview') }
</script>

<template>
  <div class="not-found">
    <div class="not-found-code">404</div>
    <h1>页面不存在</h1>
    <p>你访问的页面不存在或已被移除，请检查链接是否正确。</p>
    <div class="not-found-actions">
      <el-button type="primary" @click="goHome">回到总览</el-button>
      <el-button @click="router.back()">返回上一页</el-button>
    </div>
  </div>
</template>

<style scoped>
.not-found { display: grid; place-items: center; align-content: center; gap: 12px; min-height: 60vh; padding: 40px 16px; text-align: center; }
.not-found-code { color: var(--c-primary); font-size: 72px; font-weight: 800; line-height: 1; letter-spacing: 4px; }
.not-found h1 { margin: 0; font-size: 20px; }
.not-found p { margin: 0; color: var(--c-text-muted); font-size: 14px; }
.not-found-actions { display: flex; gap: 12px; margin-top: 8px; }
</style>
