<script setup>
/**
 * @file SourceMap 上传组件
 * 提供版本号、JS 文件名输入和 .map 文件上传功能，
 * 上传后用于错误堆栈的源码位置还原。
 */
import { ref } from 'vue'

const emit = defineEmits(['upload'])
const release = ref('dev')
const fileName = ref('')
const status = ref('')

/**
 * 处理文件上传：读取文件内容并解析为 JSON，通过 emit 传递给父组件。
 * @param {File} file - 用户选择的 .map 文件
 * @returns {boolean} 返回 false 阻止 el-upload 默认上传行为
 */
async function upload(file) {
  status.value = ''
  await emit('upload', {
    release: release.value,
    file: fileName.value || file.name.replace(/\.map$/, ''),
    map: JSON.parse(await file.text())
  })
  status.value = '已上传'
  return false
}
</script>

<template>
  <el-card shadow="never" class="panel section">
    <template #header><div class="panel-head"><h2>SourceMap</h2><small>{{ status || 'release + js file' }}</small></div></template>
    <el-form class="sourcemap-form" @submit.prevent>
      <el-input v-model="release" placeholder="release，如 1.0.0" />
      <el-input v-model="fileName" placeholder="JS 文件名，如 app.js" />
      <el-upload :before-upload="upload" :show-file-list="false" accept=".map,application/json">
        <el-button type="primary">上传 .map</el-button>
      </el-upload>
    </el-form>
  </el-card>
</template>
