import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { SHELL_CSP } from './electron/webSecurity'

// Shell assets are bundled locally so the desktop renders during a backend outage (WSOS-DSK-012).
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), {
    // The dev server injects <style> tags, so index.html allows inline style; the shipped bundle gets the strict CSP (WSOS-SEC-002).
    name: 'worksuite-strict-csp', apply: 'build',
    transformIndexHtml: (html: string) => html.replace(/(http-equiv="Content-Security-Policy" content=")[^"]*"/, `$1${SHELL_CSP}"`),
  }],
  build: { outDir: 'dist', emptyOutDir: true },
})
