<script setup>
/**
 * DashboardEmbed — 顶层嵌入页（不套 Layout）。
 *
 * /embed/dashboard/:token —— 第三方页面通过 <iframe src=".../embed/dashboard/:token"> 嵌入。
 * 只读：按 token 拉取公开看板定义（GET /api/dashboards/shared/:token），经 DashboardWidgets
 * 渲染既有聚合挂件；不暴露原始事件 / PII。404（未分享 / token 失效）显示提示态。
 */
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { Loading } from '@element-plus/icons-vue'
import { api } from '../../dashboard.js'
import DashboardWidgets from '../../components/DashboardWidgets.vue'

const route = useRoute()
const dashboard = ref(null)
const loading = ref(true)
const notFound = ref(false)

onMounted(async () => {
  try {
    dashboard.value = await api(`/api/dashboards/shared/${encodeURIComponent(route.params.token)}`)
  } catch {
    // 命中不到（未分享 / token 不匹配）一律 404，不区分原因以防枚举
    notFound.value = true
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="embed-shell">
    <div v-if="loading" class="embed-state">
      <el-icon class="is-loading"><Loading /></el-icon>
      <span>看板加载中…</span>
    </div>
    <div v-else-if="notFound" class="embed-state">
      <el-empty description="看板不存在或已取消分享" />
    </div>
    <div v-else class="embed-body">
      <h2 class="embed-title">{{ dashboard?.name }}</h2>
      <DashboardWidgets :dashboard="dashboard" :read-only="true" />
    </div>
  </div>
</template>

<style scoped>
.embed-shell { min-height: 100vh; padding: 20px 24px; box-sizing: border-box; background: var(--el-bg-color-page, #f5f7fa); }
.embed-state { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding-top: 15vh; color: var(--el-text-color-secondary); }
.embed-body { max-width: 1280px; margin: 0 auto; }
.embed-title { margin: 0 0 16px; font-size: 18px; font-weight: 600; color: var(--el-text-color-primary); }
</style>
