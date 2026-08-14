/**
 * @file SDK 浏览器端 Vite 配置（ESM 入口）
 * 以库模式构建，输出 ES Module 格式，全局变量名为 WebCollection。
 *
 * Phase 7 · SDK-209：rrweb 通过 `import('rrweb')` 动态加载，Rollup 会将其自动拆分为
 * 独立的按需 chunk，核心 es 包**不包含** rrweb；只有当 replay 真正开启时才下载该 chunk。
 * IIFE 形态（需外部化 rrweb）见 vite.iife.config.js。
 */
import { readFileSync } from 'node:fs'
import { resolve, resolve as resolvePath } from 'node:path'
import { defineConfig } from 'vite'

// 取 package.json 版本，构建时注入 SDK_VERSION（避免手写常量漏改导致版本失真）。
const SDK_VERSION = JSON.parse(
  readFileSync(resolvePath(process.cwd(), 'package.json'), 'utf8')
).version

export default defineConfig({
  define: { __SDK_VERSION__: JSON.stringify(SDK_VERSION) },
  build: {
    lib: {
      entry: resolve(process.cwd(), 'src/index.js'),
      name: 'WebCollection',
      fileName: format => `web-collection-sdk.${format}.js`,
      formats: ['es']
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
