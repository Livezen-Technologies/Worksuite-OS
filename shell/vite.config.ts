/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { devMonitor } from './electron/devMonitor'
import { SHELL_CSP } from './electron/webSecurity'

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
  plugins: [react(), tailwindcss(), monitorPreview, {
    // The dev server injects <style> tags, so index.html allows inline style; the shipped bundle gets the strict CSP (WSOS-SEC-002).
    name: 'worksuite-strict-csp', apply: 'build',
    transformIndexHtml: (html: string) => html.replace(/(http-equiv="Content-Security-Policy" content=")[^"]*"/, `$1${SHELL_CSP}"`),
  }],
  build: { outDir: 'dist', emptyOutDir: true },
  // Tests isolate the XDG base directories from the runner's environment (electron/testEnv.ts).
  test: { setupFiles: ['./electron/testEnv.ts'] },
})
