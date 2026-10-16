// Preload of the web kiosk page (WSOS-AUTH-002). Exposes nothing to the page; only reports the five-tap corner exit
// gesture (trusted pointer events only, so the page cannot fake it).
import { ipcRenderer } from 'electron'
import { tapCounter } from './kiosk'

const tap = tapCounter()
window.addEventListener('pointerdown', (e) => {
  if (e.isTrusted && tap(e.clientX, e.clientY)) ipcRenderer.send('kiosk:gesture')
}, { capture: true, passive: true })
