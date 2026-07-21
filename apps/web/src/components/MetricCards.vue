<script setup>
/**
 * @file 核心指标卡片组件
 * 展示事件量、活跃错误、错误回归数和性能评分。
 */
defineProps({ summary: Object })
</script>

<template>
  <section class="metrics section">
    <el-card shadow="never"><span>事件量</span><strong>{{ summary?.totalEvents ?? 0 }}</strong></el-card>
    <el-card shadow="never"><span>活跃错误</span><strong>{{ summary?.issueCount ?? 0 }}</strong></el-card>
    <el-card shadow="never"><span>错误回归</span><strong>{{ summary?.regressionCount ?? 0 }}</strong></el-card>
    <el-card shadow="never"><span>性能评分</span><strong>{{ summary?.perfScore?.score ?? 0 }}<small>{{ summary?.perfScore?.grade || '-' }}</small></strong></el-card>
  </section>
</template>
