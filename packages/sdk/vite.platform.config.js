/**
 * @file SDK 平台适配层 Vite 配置
 * 构建跨平台适配器（小程序 / UniApp / Taro / React Native），
 * 输出 ES Module 和 CommonJS 两种格式，供不同宿主环境引用。
 * 与主 SDK 构建共用 dist 目录（emptyOutDir: false），互不覆盖。
 */
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: resolve(process.cwd(), 'src/platform/index.js'),
      // 同时输出 ES Module 和 CommonJS 格式
      formats: ['es', 'cjs'],
      fileName: format => format === 'es' ? 'web-collection-sdk.platform.js' : 'web-collection-sdk.platform.cjs'
    },
    outDir: 'dist',
    emptyOutDir: false,  // 不清理 dist，以保留主 SDK 构建产物
    minify: 'terser',
    sourcemap: false,
    terserOptions: {
      compress: { passes: 2, drop_console: true, drop_debugger: true },
      mangle: { toplevel: true },  // 混淆顶层作用域变量名，进一步减小体积
      format: { comments: false }   // 去除所有注释
    }
  }
})
