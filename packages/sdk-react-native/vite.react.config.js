/**
 * @file RN 包 ./react 子路径构建配置（P1 Hook，复刻 packages/sdk/vite.react.config.js 范式）
 *
 * 要点：
 * - 主入口 src/index.js 与 react 均作 external：运行时由消费方解析到同一份实例，避免内核被重复打包。
 * - emptyOutDir: false —— 必须保留主构建产物（与主构建共用 dist 目录）。
 */
import { readFileSync } from 'node:fs'
import { resolve, resolve as resolvePath } from 'node:path'
import { defineConfig } from 'vite'

const RN_SDK_VERSION = JSON.parse(
  readFileSync(resolvePath(process.cwd(), 'package.json'), 'utf8')
).version

// 归一化为正斜杠：Windows 下 resolve() 产出反斜杠，而 Rollup 传入的 id 为正斜杠，需统一比对。
const CORE_ENTRY = resolve(process.cwd(), 'src/index.js').replace(/\\/g, '/')

export default defineConfig({
  define: { __RN_SDK_VERSION__: JSON.stringify(RN_SDK_VERSION) },
  resolve: {
    alias: {
      // 源码以裸标识符 '@web-collection/sdk-react-native' 引用主入口；构建时解析到源码。
      // 主入口被 external，不会打进 react 产物。
      '@web-collection/sdk-react-native': CORE_ENTRY
    }
  },
  build: {
    lib: {
      entry: resolve(process.cwd(), 'src/react.js').replace(/\\/g, '/'),
      formats: ['es', 'cjs'],
      fileName: format => format === 'es' ? 'sdk-react-native.react.js' : 'sdk-react-native.react.cjs'
    },
    outDir: 'dist',
    emptyOutDir: false, // 不清理 dist，以保留主构建产物
    minify: 'terser',
    sourcemap: false,
    terserOptions: {
      compress: { passes: 2, drop_console: true, drop_debugger: true },
      mangle: { toplevel: true },
      format: { comments: false }
    },
    rollupOptions: {
      external: id => {
        const norm = String(id).replace(/\\/g, '/')
        // 主入口作 external（下方 output.paths 改写回裸标识符）。
        if (norm === CORE_ENTRY || norm.endsWith('/src/index.js')) return true
        if (/^react($|\/)/.test(norm) || /^react-dom($|\/)/.test(norm)) return true
        // 内核与原生模块同样 external。
        if (/^@web-collection\/sdk($|\/)/.test(norm)) return true
        if (/^react-native($|\/)/.test(norm)) return true
        return false
      },
      output: {
        exports: 'named',
        paths: id => {
          const norm = String(id).replace(/\\/g, '/')
          if (norm === CORE_ENTRY || norm.endsWith('/src/index.js')) return '@web-collection/sdk-react-native'
          return id
        },
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
          '@web-collection/sdk-react-native': 'WebCollectionRN'
        }
      }
    }
  }
})
