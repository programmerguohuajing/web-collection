import { defineConfig } from 'vite'

// preload / 渲染侧入口（src/preload.js）：emptyOutDir=false 保留主进程构建产物。
// contextIsolation 场景下宿主应把本产物作为 preload 脚本加载或经打包器引用。
export default defineConfig({
  build: {
    lib: {
      entry: 'src/preload.js',
      name: 'WebCollectionElectronPreload',
      formats: ['es', 'cjs'],
      fileName: format => format === 'es' ? 'sdk-electron.preload.js' : 'sdk-electron.preload.cjs'
    },
    outDir: 'dist',
    emptyOutDir: false,
    minify: 'terser',
    sourcemap: true,
    rollupOptions: {
      external: ['electron']
    }
  }
})
