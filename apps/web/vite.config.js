/**
 * @file Web 仪表盘 Vite 配置
 * 启用 Vue 插件，开发环境将 /api 请求代理到本地 API 服务（端口 8787）。
 */
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  server: {
    host: true,
    proxy: {
      '/api': 'http://192.168.17.45:8787'
    }
  }
})
