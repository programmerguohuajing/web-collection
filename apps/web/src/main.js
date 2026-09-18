/**
 * @file Web 仪表盘入口
 * 创建 Vue 应用；Element Plus 组件由 Vite 按模板实际使用情况自动按需引入。
 */
import { createApp } from 'vue'
import { createPinia } from 'pinia'
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

createApp(App).use(createPinia()).use(router).mount('#app')
