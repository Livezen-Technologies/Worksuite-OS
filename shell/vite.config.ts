import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { devMonitor } from './electron/devMonitor'

// Browser preview only (`vite` dev server, never in a build): the system monitor and quick settings read this
// machine's /proc and backlight through the same code Electron uses (src/lib/monitorApi.ts).
const monitorPreview: Plugin = {
  name: 'ws-monitor-preview',
  apply: 'serve',
  configureServer(server) { server.middlewares.use('/__dev/monitor', devMonitor()) },
}

// Shell assets are bundled locally so the desktop renders during a backend outage (WSOS-DSK-012).
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), monitorPreview],
  build: { outDir: 'dist', emptyOutDir: true },
})
