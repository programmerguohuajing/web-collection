<script setup>
const tableConfig = {
  tableLayout: 'fixed',
  tooltipOptions: {
    appendTo: 'body',
    popperClass: 'table-cell-tooltip',
    popperOptions: {
      modifiers: [
        { name: 'computeStyles', options: { adaptive: false } },
        {
          name: 'applyWidth',
          phase: 'beforeWrite',
          fn({ state }) {
            const ref = state.elements.reference
            if (ref) {
              state.styles.width = ref.getBoundingClientRect().width + 'px'
            }
          }
        }
      ]
    }
  }
}
</script>

<template>
  <el-config-provider :table="tableConfig">
    <router-view />
  </el-config-provider>
</template>
