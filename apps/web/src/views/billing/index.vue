<script setup>
/**
 * D3 · 用量计量与套餐（PRD 15）——容器页。
 * 能力位 false：显式「当前部署不支持用量计量」占位，不静默隐藏、不发起任何写请求
 * （对齐 experiment/index.vue:239 范式）。
 */
import { useAuth } from '../../composables/useAuth'
import UsageView from './usage.vue'
import PlansView from './plans.vue'
import { QuestionFilled } from '@element-plus/icons-vue'

const { meteringEnabled } = useAuth()
</script>

<template>
  <div class="billing-page">
    <div class="page-heading">
      <h1>用量计费<el-tooltip content="当前部署不支持用量计量（capability: metering）。用量计量与套餐能力需要后端开启 metering 能力位后使用（Worker 部署需设置 METERING_ENABLED=1）；本页当前为只读占位，不会发起任何写请求。" placement="top"><el-icon class="help-icon"><QuestionFilled /></el-icon></el-tooltip></h1>
    </div>
    <template v-if="meteringEnabled">
      <el-tabs class="billing-tabs">
        <el-tab-pane label="用量" name="usage">
          <UsageView />
        </el-tab-pane>
        <el-tab-pane label="套餐" name="plans">
          <PlansView />
        </el-tab-pane>
      </el-tabs>
    </template>
  </div>
</template>

<style scoped>
.billing-page { width: 100%; }
.billing-tabs :deep(.el-tabs__header) { margin-bottom: 18px; }
</style>
