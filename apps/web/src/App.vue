<script setup>
import { tableConfig } from './table-tooltip.js'
</script>

<template>
  <el-config-provider :table="tableConfig">
    <router-view />
  </el-config-provider>
</template>
