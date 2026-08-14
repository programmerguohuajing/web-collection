<script setup>
/**
 * @file SourceMap 上传组件
 * 提供版本号、JS 文件名输入和 .map 文件上传功能，
 * 上传后用于错误堆栈的源码位置还原。
 */
import { ref } from 'vue'
import { UploadFilled } from '@element-plus/icons-vue'

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
  <section class="grid sourcemap-grid">
    <el-card shadow="never" class="panel">
      <template #header><div class="panel-head"><h2>上传 SourceMap</h2><small>{{ status || '支持批量上传 .map 文件' }}</small></div></template>
      <el-upload class="sourcemap-dropzone" drag :before-upload="upload" :show-file-list="false" accept=".map,application/json">
        <el-icon class="el-icon--upload"><upload-filled /></el-icon>
        <div class="el-upload__text">拖拽 .map 文件到此处<br><em>或点击选择文件</em></div>
        <template #tip><div class="el-upload__tip">上传后，错误栈与回放中的压缩代码将自动反解到源码行号。</div></template>
      </el-upload>
      <el-form class="sourcemap-form" @submit.prevent>
        <el-input v-model="release" placeholder="release，如 1.0.0" />
        <el-input v-model="fileName" placeholder="JS 文件名，如 app.js" />
      </el-form>
    </el-card>

    <el-card shadow="never" class="panel">
      <template #header><div class="panel-head"><h2>反解效果示例</h2><small>SourceMap 映射预览</small></div></template>
      <div class="sourcemap-example">
        <div><span class="example-index">1</span><code>at renderOrder ( src/order/index.js : 142 )</code></div>
        <div><span class="example-index">2</span><code>at OrderPage ( src/order/index.js : 88 )</code></div>
        <div><span class="example-index">3</span><code>at processQueue ( src/runtime/queue.js : 31 )</code></div>
      </div>
      <p class="sourcemap-note">完成上传后，新的错误详情会优先展示源码文件与行号；历史错误仍保留压缩栈作为回退。</p>
    </el-card>
  </section>

  <el-card shadow="never" class="panel section">
    <template #header><div class="panel-head"><div><h2>SourceMap 文件</h2><small>按应用与 release 管理已上传文件</small></div></div></template>
    <el-empty description="暂无 SourceMap 文件，请先上传 .map 文件" />
  </el-card>
</template>

<style scoped>
.sourcemap-grid { align-items: stretch; }
.sourcemap-dropzone { width: 100%; }
.sourcemap-dropzone :deep(.el-upload-dragger) { width: 100%; min-height: 176px; padding: 28px 20px; border-color: var(--c-border); border-radius: 10px; background: var(--c-surface-2); }
.sourcemap-dropzone :deep(.el-upload-dragger:hover) { border-color: var(--c-primary); }
.sourcemap-dropzone :deep(.el-icon--upload) { margin: 6px 0 10px; color: var(--c-primary); font-size: 34px; }
.sourcemap-dropzone :deep(.el-upload__text) { color: var(--c-text-muted); line-height: 1.7; }
.sourcemap-dropzone :deep(.el-upload__text em) { color: var(--c-primary); font-style: normal; }
.sourcemap-dropzone :deep(.el-upload__tip) { color: var(--c-text-faint); line-height: 1.5; }
.sourcemap-form { grid-template-columns: 1fr 1fr; margin-top: 14px; }
.sourcemap-example { display: grid; gap: 10px; padding: 14px; background: #0f1420; border-radius: 10px; }
.sourcemap-example > div { display: grid; grid-template-columns: 22px minmax(0, 1fr); align-items: start; gap: 8px; color: #e6edf6; font-family: var(--font-mono); font-size: 12px; line-height: 1.5; }
.example-index { color: #6f7c90; text-align: right; }
.sourcemap-example code { overflow-wrap: anywhere; }
.sourcemap-note { margin: 16px 0 0; color: var(--c-text-muted); font-size: 13px; line-height: 1.6; }
@media (max-width: 720px) { .sourcemap-form { grid-template-columns: 1fr; } }
</style>
