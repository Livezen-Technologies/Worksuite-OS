import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import OutputDesktop from './screens/OutputDesktop'
import './index.css'
import { applyAppearance, loadAppearance } from './lib/setup'
import { applyA11y, getA11y } from './lib/a11y'

applyAppearance(loadAppearance())
applyA11y(getA11y())

// `?mode=output&output=NAME`: a secondary monitor's desktop and taskbar (electron/outputWindows.ts, WSOS-DSK-005).
const q = new URLSearchParams(location.search)
const output = q.get('mode') === 'output' ? q.get('output') : null

createRoot(document.getElementById('root')!).render(<StrictMode>{output ? <OutputDesktop output={output} /> : <App />}</StrictMode>)
