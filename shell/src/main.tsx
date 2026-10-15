import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { applyAppearance, loadAppearance } from './lib/setup'

applyAppearance(loadAppearance())

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
