/**
 * @file Web 仪表盘 Vite 配置
 * 启用 Vue 插件，开发环境将 /api 请求代理到本地 API 服务（端口 8787）。
 */
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { defineConfig } from 'vite'

const apiProxy = process.env.VITE_API_PROXY || 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [
    vue(),
    Components({
      resolvers: [ElementPlusResolver({ importStyle: 'css' })]
    })
  ],
  build: {
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.code === 'INVALID_ANNOTATION' && String(warning.id || '').includes('@vueuse/core')) return
        warn(warning)
      },
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (
            id.includes('/node_modules/vue/') ||
            id.includes('/node_modules/vue-router/') ||
            id.includes('/node_modules/pinia/') ||
            id.includes('/node_modules/@vue/')
          ) return 'vendor-vue'
          if (id.includes('/lodash-es/')) return 'vendor-utils'
          if (id.includes('/rrweb') || id.includes('/@rrweb/')) return 'vendor-replay'
          if (id.includes('/marked/') || id.includes('/dompurify/')) return 'vendor-markdown'
        }
      }
    },
    chunkSizeWarningLimit: 500
  },
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
