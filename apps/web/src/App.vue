<script setup>
const tableConfig = {
  tooltipOptions: {
    appendTo: 'body',
    popperOptions: {
      modifiers: [{ name: 'computeStyles', options: { adaptive: false } }]
    }
  }
}
</script>

<template>
  <el-config-provider :table="tableConfig">
    <router-view />
  </el-config-provider>
</template>
