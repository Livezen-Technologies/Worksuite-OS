import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import OutputDesktop from './screens/OutputDesktop'
import KioskExit, { KioskStatus, kioskStatusFrom } from './screens/KioskExit'
import './index.css'
import { applyAppearance, loadAppearance } from './lib/setup'
import { applyA11y, getA11y } from './lib/a11y'
import TextContextMenu from './components/TextContextMenu'

applyAppearance(loadAppearance())
applyA11y(getA11y())

// `?mode=output&output=NAME`: a secondary monitor's desktop and taskbar (electron/outputWindows.ts, WSOS-DSK-005).
const q = new URLSearchParams(location.search)
const output = q.get('mode') === 'output' ? q.get('output') : null

// `?mode=kiosk-exit` / `?mode=kiosk-status&state=…`: kiosk mode's own screens (electron/kioskMain.ts, WSOS-AUTH-002).
const kiosk = q.get('mode') === 'kiosk-exit' ? <KioskExit /> : q.get('mode') === 'kiosk-status' ? <KioskStatus {...kioskStatusFrom(q)} /> : null

// Cut/Copy/Paste on every text field of the shell's own screens (not the kiosk's).
createRoot(document.getElementById('root')!).render(<StrictMode>{kiosk ?? (output ? <OutputDesktop output={output} /> : <><App /><TextContextMenu /></>)}</StrictMode>)
