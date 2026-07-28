import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    port: 5173,
    // Docker Desktop on Windows doesn't reliably forward inotify events across bind mounts,
    // so Vite's watcher can silently miss file changes without polling.
    watch: {
      usePolling: true,
      interval: 300,
    },
  },
})
