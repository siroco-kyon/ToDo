import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Standalone web build of the existing React renderer (src/renderer/src).
// The same components run unchanged in the browser; only the entry differs:
// web/main.tsx installs an HTTP/WebSocket-backed `window.api` instead of the
// Electron preload bridge.
const SERVER_PORT = process.env.SERVER_PORT || '4577'

export default defineConfig({
  root: resolve(__dirname, 'web'),
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@preload': resolve(__dirname, 'src/preload/index.ts')
    }
  },
  plugins: [react()],
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      '/api': { target: `http://localhost:${SERVER_PORT}`, changeOrigin: false },
      '/ws': { target: `ws://localhost:${SERVER_PORT}`, ws: true }
    }
  },
  build: {
    outDir: resolve(__dirname, 'dist-web'),
    emptyOutDir: true
  }
})
