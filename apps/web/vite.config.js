/**
 * @file Web 仪表盘 Vite 配置
 * 启用 Vue 插件，开发环境将 /api 请求代理到本地 API 服务（端口 8787）。
 */
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

const apiProxy = process.env.VITE_API_PROXY || 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [vue()],
  server: {
    host: true,
    proxy: {
      '/api': {
        target: apiProxy,
        changeOrigin: true,
        // 与生产主 worker 的 proxyAi 行为一致：剥离浏览器来源头，
        // 使 ai-worker 的 settings 同源守卫在本地开发也能通过
        configure(proxy) {
          proxy.on('proxyReq', proxyReq => {
            try { proxyReq.removeHeader('origin'); proxyReq.removeHeader('referer') } catch {}
          })
        }
      }
    }
  }
})
