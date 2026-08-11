<script setup>
import { onBeforeUnmount, onMounted } from 'vue'
import { installTableTooltipWidthTracking, tableConfig } from './table-tooltip.js'

let stopTableTooltipWidthTracking
onMounted(() => {
  stopTableTooltipWidthTracking = installTableTooltipWidthTracking()
})
onBeforeUnmount(() => stopTableTooltipWidthTracking?.())
</script>

<template>
  <el-config-provider :table="tableConfig">
    <router-view />
  </el-config-provider>
</template>
