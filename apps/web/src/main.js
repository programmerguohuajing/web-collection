/**
 * @file Web 仪表盘入口
 * 创建 Vue 应用，注册 Element Plus 插件并挂载到 #app。
 */
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import App from './App.vue'
import { router } from './router/index.js'
import './style.css'

// P0-1：捕获懒加载 chunk 加载失败（旧 HTML 引用已下线的旧 chunk），
// 仅允许自动刷新一次，避免“刷新→仍失败→循环刷新”卡死。
let chunkReloaded = false
function handleChunkLoadFailure(message) {
  if (chunkReloaded) return false
  if (/Failed to fetch dynamically imported module/i.test(message || '')) {
    chunkReloaded = true
    window.location.reload()
    return true
  }
  return false
}
window.addEventListener('error', (event) => {
  if (handleChunkLoadFailure(event && event.message)) event.preventDefault?.()
})
window.addEventListener('unhandledrejection', (event) => {
  const reason = event && (event.reason && event.reason.message || String(event.reason || ''))
  if (handleChunkLoadFailure(reason)) event.preventDefault?.()
})

createApp(App).use(createPinia()).use(ElementPlus, { locale: zhCn }).use(router).mount('#app')
