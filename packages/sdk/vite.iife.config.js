/**
 * @file SDK 浏览器端 Vite 配置（IIFE 入口）
 * 输出 IIFE 单文件格式（全局变量 WebCollection），供传统 <script> 直接引入。
 *
 * Phase 7 · SDK-209：IIFE 形态无法原生支持 `import('rrweb')`（无模块加载器），
 * 因此将 rrweb **外部化**（external）。核心 iife 包**不包含** rrweb；replay 开启时，
 * 由 `loadRrweb` 通过宿主注入的 `window.rrweb`（IIFE 自托管）或 `replayLibUrl`
 * （注入 rrweb 脚本）提供，详见 src/replay/rrweb-driver.js。
 *
 * 与 ESM 构建 (`vite.config.js`) 共用 dist 目录，本条配置 emptyOutDir: false，
 * 以免覆盖已生成的 es 产物。构建顺序须先 es 后 iife。
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
      formats: ['iife']
    },
    outDir: 'dist',
    emptyOutDir: false,
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
      // rrweb 外部化：核心 iife 包不含 rrweb；运行时由宿主或 replayLibUrl 注入。
      external: ['rrweb'],
      output: {
        exports: 'named',
        globals: { rrweb: 'rrweb' }
      }
    }
  }
})
