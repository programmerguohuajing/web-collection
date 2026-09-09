/**
 * @file RN 包主构建配置（复刻 packages/sdk/vite.platform.config.js 范式）
 *
 * 要点：
 * - 输出 es + cjs 双产物；**不做 IIFE**（IIFE 依赖全局挂载，与「移动端无浏览器全局」红线冲突，且无 script 标签场景）。
 * - 产物落在 packages/sdk-react-native/dist/（emptyOutDir 只清自己的目录），绝不污染 packages/sdk/dist。
 * - 内核 @web-collection/sdk/platform 走 external：由宿主 Metro 解析到同一份内核实例，避免重复打包 / 双份实现。
 *   兜底开关：RN_BUNDLE_CORE=1 时清空 external，把内核打进产物（体积换 Metro 老版本兼容性）。
 * - 版本由 package.json 注入 __RN_SDK_VERSION__，杜绝手写常量失真（与内核 __SDK_VERSION__ 同手法）。
 */
import { readFileSync } from 'node:fs'
import { resolve, resolve as resolvePath } from 'node:path'
import { defineConfig } from 'vite'

// 取 package.json 版本，构建时注入（避免手写常量漏改导致版本失真）。
const RN_SDK_VERSION = JSON.parse(
  readFileSync(resolvePath(process.cwd(), 'package.json'), 'utf8')
).version

/**
 * external 清单：内核 + 宿主原生模块一律不打包。
 * 宿主模块（react-native / AsyncStorage / NetInfo）必须由 App 侧提供，否则会把原生依赖打进 JS 产物。
 */
const CORE_EXTERNALS = [
  '@web-collection/sdk',
  '@web-collection/sdk/platform',
  'react',
  'react-native',
  '@react-native-async-storage/async-storage',
  '@react-native-community/netinfo'
]

// 兜底开关：老版本 Metro 不解析 package.json exports 时可开启，把内核打进产物。
const BUNDLE_CORE = process.env.RN_BUNDLE_CORE === '1'

export default defineConfig({
  define: { __RN_SDK_VERSION__: JSON.stringify(RN_SDK_VERSION) },
  build: {
    lib: {
      entry: resolve(process.cwd(), 'src/index.js'),
      // 同时输出 ES Module 和 CommonJS 格式（Metro 与 Jest 走 CJS 更稳，Metro 亦支持 ESM）
      formats: ['es', 'cjs'],
      fileName: format => format === 'es' ? 'sdk-react-native.js' : 'sdk-react-native.cjs'
    },
    outDir: 'dist',
    // 只清理本包自己的 dist（outDir 即本包 dist），不影响 packages/sdk/dist
    emptyOutDir: true,
    minify: 'terser',
    sourcemap: false,
    terserOptions: {
      compress: { passes: 2, drop_console: true, drop_debugger: true },
      mangle: { toplevel: true },
      format: { comments: false }
    },
    rollupOptions: {
      external: BUNDLE_CORE ? [] : CORE_EXTERNALS,
      output: { exports: 'named' }
    }
  }
})
