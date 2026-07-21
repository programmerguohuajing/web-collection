<script setup>
/**
 * @file 排行面板组件
 * 展示事件类型分布或行为事件排行，以 [name, count] 数组形式渲染。
 */
defineProps({
  title: String,
  subtitle: String,
  items: { type: Array, default: () => [] }
})
</script>

<template>
  <el-card shadow="never" class="panel">
    <template #header><div class="panel-head"><h2>{{ title }}</h2><small>{{ subtitle }}</small></div></template>
    <el-empty v-if="!items.length" description="暂无数据" />
    <div v-else class="bars">
      <div v-for="[name, count] in items" :key="name"><span>{{ name }}</span><strong>{{ count }}</strong></div>
    </div>
  </el-card>
</template>
