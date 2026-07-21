import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: resolve(process.cwd(), 'src/platform/index.js'),
      formats: ['es', 'cjs'],
      fileName: format => format === 'es' ? 'web-collection-sdk.platform.js' : 'web-collection-sdk.platform.cjs'
    },
    outDir: 'dist',
    emptyOutDir: false,
    minify: 'terser',
    sourcemap: false,
    terserOptions: {
      compress: { passes: 2, drop_console: true, drop_debugger: true },
      mangle: { toplevel: true },
      format: { comments: false }
    }
  }
})
