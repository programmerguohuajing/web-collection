<script setup>
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import { tableConfig } from './table-tooltip.js'
</script>

<template>
  <el-config-provider :locale="zhCn" :table="tableConfig">
    <router-view />
  </el-config-provider>
</template>
