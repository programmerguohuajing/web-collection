/**
 * @file SDK Vite 配置
 * 以库模式构建，输出 ES Module 和 IIFE 两种格式，
 * 全局变量名为 WebCollection，文件名为 web-collection-sdk.{format}.js。
 */
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: resolve(process.cwd(), 'src/index.js'),
      name: 'WebCollection',
      fileName: format => `web-collection-sdk.${format}.js`,
      formats: ['es', 'iife']
    },
    outDir: 'dist',
    emptyOutDir: true,
    minify: 'terser',
    sourcemap: false,
    terserOptions: {
      compress: {
        passes: 2,
        drop_console: true,
        drop_debugger: true
      },
      mangle: {
        toplevel: true
      },
      format: {
        comments: false
      }
    },
    rollupOptions: {
      output: {
        exports: 'named'
      }
    }
  }
})
