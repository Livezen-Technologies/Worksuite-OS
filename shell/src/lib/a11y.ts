// Accessibility preferences (WSOS-ACC-001…006): high contrast, reduced motion and text size.
// Applied as attributes on <html> so every screen (greeter, lock, desktop, Settings…) follows them; index.css holds the rules.
import { useSyncExternalStore } from 'react'

export interface A11yPrefs { highContrast: boolean; reducedMotion: boolean; textScale: 1 | 1.5 | 2 }
export const DEFAULT_A11Y: A11yPrefs = { highContrast: false, reducedMotion: false, textScale: 1 }
export const TEXT_SCALES: A11yPrefs['textScale'][] = [1, 1.5, 2]
const KEY = 'ws.a11y'

function load(): A11yPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<A11yPrefs> | null
    if (raw && typeof raw === 'object') {
      return {
        highContrast: raw.highContrast === true,
        reducedMotion: raw.reducedMotion === true,
        textScale: TEXT_SCALES.includes(raw.textScale as A11yPrefs['textScale']) ? (raw.textScale as A11yPrefs['textScale']) : 1,
      }
    }
  } catch { /* no storage or bad JSON */ }
  return { ...DEFAULT_A11Y }
}

let prefs: A11yPrefs = load()
const listeners = new Set<() => void>()

/** True when the OS (GTK/portal → Chromium) asks for reduced motion; the setting can only add to it. */
export function systemReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function motionReduced(p: A11yPrefs = prefs): boolean {
  return p.reducedMotion || systemReducedMotion()
}

export function applyA11y(p: A11yPrefs, root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement): void {
  if (!root) return
  root.toggleAttribute('data-high-contrast', p.highContrast)
  root.toggleAttribute('data-reduced-motion', p.reducedMotion)
  // The shell is laid out in px, so text size scales the whole page (Chromium zoom), like the GTK text scale.
  root.style.setProperty('zoom', p.textScale === 1 ? '' : String(p.textScale))
}

export function getA11y(): A11yPrefs { return prefs }

export function setA11y(patch: Partial<A11yPrefs>): void {
  prefs = { ...prefs, ...patch }
  try { localStorage.setItem(KEY, JSON.stringify(prefs)) } catch { /* no storage */ }
  applyA11y(prefs)
  listeners.forEach((fn) => fn())
}

export function useA11y(): A11yPrefs {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn) } }, getA11y, getA11y)
}
