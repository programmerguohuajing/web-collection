import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

// 主进程入口（src/index.js）：外部化平台内核与 electron —— 运行时由宿主提供。
export default defineConfig({
  define: {
    __ELECTRON_SDK_VERSION__: JSON.stringify(pkg.version)
  },
  build: {
    lib: {
      entry: 'src/index.js',
      name: 'WebCollectionElectron',
      formats: ['es', 'cjs'],
      fileName: format => format === 'es' ? 'sdk-electron.js' : 'sdk-electron.cjs'
    },
    outDir: 'dist',
    emptyOutDir: true,
    minify: 'terser',
    sourcemap: true,
    rollupOptions: {
      external: [
        '@web-collection/sdk',
        '@web-collection/sdk/platform',
        'electron',
        'node:fs',
        'node:path'
      ],
      // named + default 混合导出：CJS 消费方经 .default 取默认导出（与 RN 包同策略）
      output: { exports: 'named' }
    }
  }
})
