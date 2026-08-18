<!--
  单元格溢出 tooltip 组件。

  背景：EP 2.14 的 show-overflow-tooltip 把原始 DOM 元素作为 virtualRef 传给
  ElTooltip，未被识别为有效 reference，导致 popper 失去参考点，position:fixed
  + placement:top 时 tooltip 漂到视口顶部（而非当前行上方）。这里直接用
  el-tooltip 包住一个真实的 DOM 元素（.cell-ellipsis），触发器和定位都用
  标准 el-tooltip 机制，tooltip 一定紧贴当前单元格上方。
-->
<script setup>
import { computed, ref } from 'vue'

defineOptions({ inheritAttrs: false })
const props = defineProps({
  text: { type: [String, Number, null], default: '' },
  force: { type: Boolean, default: false }
})

const triggerRef = ref(null)
const overflowing = ref(false)
const popperMaxWidth = ref(520)

const content = computed(() => props.text != null && props.text !== '' ? String(props.text) : '')
const popperStyle = computed(() => ({ maxWidth: `${popperMaxWidth.value}px` }))

const popperOptions = {
  strategy: 'fixed',
  modifiers: [
    {
      name: 'computeStyles',
      options: { adaptive: false, gpuAcceleration: false }
    },
    {
      name: 'flip',
      options: { fallbackPlacements: ['bottom'], rootBoundary: 'viewport', padding: 8 }
    },
    {
      name: 'preventOverflow',
      options: { rootBoundary: 'viewport', altAxis: true, padding: 8 }
    }
  ]
}

function measureOverflow() {
  const trigger = triggerRef.value
  if (!trigger) {
    overflowing.value = false
    return
  }
  overflowing.value = trigger.scrollWidth > trigger.clientWidth + 1
  const tableWidth = trigger.closest('.el-table')?.getBoundingClientRect().width || 520
  popperMaxWidth.value = Math.max(1, Math.min(520, tableWidth, window.innerWidth - 24))
}
</script>

<template>
  <el-tooltip
    :content="content"
    placement="top"
    :show-after="120"
    :disabled="!content || (!force && !overflowing)"
    :show-arrow="false"
    :teleported="true"
    append-to="body"
    popper-class="table-cell-tooltip"
    :popper-style="popperStyle"
    :popper-options="popperOptions"
  >
    <template #content><slot name="content">{{ content }}</slot></template>
    <div ref="triggerRef" class="cell-ellipsis" v-bind="$attrs" @mouseenter="measureOverflow"><slot>{{ content }}</slot></div>
  </el-tooltip>
</template>
