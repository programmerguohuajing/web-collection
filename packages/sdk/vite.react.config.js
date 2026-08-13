/**
 * @file SDK React 集成层 Vite 配置
 * 构建 React 专属接入层（Provider / ErrorBoundary / Hooks），
 * 输出 ES Module 和 CommonJS 两种格式，供不同宿主环境引用。
 * 与主 SDK 构建共用 dist 目录（emptyOutDir: false），互不覆盖。
 *
 * 关键：React 与核心 SDK 均作 external，不打包进产物。
 * - react / react-dom：由宿主应用提供。
 * - 核心 SDK（src/index.js）通过 output.paths 重写为裸标识符 `@web-collection/sdk`，
 *   运行时由消费方打包器解析到同一份核心实例，避免重复打包导致两份 SDK / 重复上报。
 */
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// 归一化为正斜杠：Windows 下 resolve() 产出反斜杠，而 Rollup 传入的 id 为正斜杠，需统一比对。
const CORE_ENTRY = resolve(process.cwd(), 'src/index.js').replace(/\\/g, '/')

export default defineConfig({
  resolve: {
    alias: {
      // 源码以裸标识符 '@web-collection/sdk' 引用核心；构建时解析到核心源码。
      // 核心被 external，不会打包进 React 产物，运行时由消费方解析到同一份核心实例（避免重复打包）。
      '@web-collection/sdk': resolve(process.cwd(), 'src/index.js')
    }
  },
  build: {
    lib: {
      entry: resolve(process.cwd(), 'src/react/index.js').replace(/\\/g, '/'),
      // 同时输出 ES Module 和 CommonJS 格式
      formats: ['es', 'cjs'],
      fileName: format => format === 'es' ? 'web-collection-sdk.react.js' : 'web-collection-sdk.react.cjs'
    },
    outDir: 'dist',
    emptyOutDir: false, // 不清理 dist，以保留主 SDK 构建产物
    minify: 'terser',
    sourcemap: false,
    terserOptions: {
      compress: { passes: 2, drop_console: true, drop_debugger: true },
      mangle: { toplevel: true }, // 混淆顶层作用域变量名，进一步减小体积
      format: { comments: false } // 去除所有注释
    },
    rollupOptions: {
      external: (id) => {
        const norm = String(id).replace(/\\/g, '/')
        // 核心 SDK 作为 external（重写为 @web-collection/sdk 裸标识符）。
        if (norm === CORE_ENTRY || norm.endsWith('/src/index.js')) return true
        // React / React DOM 作为 external。
        if (/^react($|\/)/.test(norm) || /^react-dom($|\/)/.test(norm)) return true
        return false
      },
      output: {
        exports: 'named',
        paths: (id) => {
          // 把核心 SDK 的相对导入改写为裸标识符，运行时由消费方解析到同一份核心实例，避免重复打包。
          const norm = String(id).replace(/\\/g, '/')
          if (norm === CORE_ENTRY || norm.endsWith('/src/index.js')) return '@web-collection/sdk'
          return id
        },
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
          '@web-collection/sdk': 'WebCollection'
        }
      }
    }
  }
})
