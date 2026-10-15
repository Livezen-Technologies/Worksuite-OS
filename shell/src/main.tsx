import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { applyAppearance, loadAppearance } from './lib/setup'
import { applyA11y, getA11y } from './lib/a11y'

applyAppearance(loadAppearance())
applyA11y(getA11y())

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
