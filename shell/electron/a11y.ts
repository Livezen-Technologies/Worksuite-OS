// Settings › Accessibility: GNOME's own accessibility settings (gsettings-desktop-schemas 48), per user. GNOME Shell,
// GTK and the WorkSuite windows follow them at once; nothing here is a copy that could drift. Reduce motion is
// GNOME's enable-animations (the same key Personalization › Animations uses), there is no separate key in GNOME 48.
import type { Avail, Exec } from './system'
import { parseGv } from './desktopLook'

export const TEXT_SIZES = [1, 1.15, 1.3, 1.5] as const
export const CURSOR_SIZES = [24, 32, 48] as const
export interface A11y { textSize: number; highContrast: boolean; reduceMotion: boolean; screenReader: boolean; screenKeyboard: boolean; stickyKeys: boolean; slowKeys: boolean; cursorSize: number }

const KEYS: Record<keyof A11y, [string, string]> = {
  textSize: ['org.gnome.desktop.interface', 'text-scaling-factor'],
  highContrast: ['org.gnome.desktop.a11y.interface', 'high-contrast'],
  reduceMotion: ['org.gnome.desktop.interface', 'enable-animations'],
  screenReader: ['org.gnome.desktop.a11y.applications', 'screen-reader-enabled'],
  screenKeyboard: ['org.gnome.desktop.a11y.applications', 'screen-keyboard-enabled'],
  stickyKeys: ['org.gnome.desktop.a11y.keyboard', 'stickykeys-enable'],
  slowKeys: ['org.gnome.desktop.a11y.keyboard', 'slowkeys-enable'],
  cursorSize: ['org.gnome.desktop.interface', 'cursor-size'],
}

/** IPC input → one known setting with a valid value, or null. */
export function cleanA11y(raw: unknown): Partial<A11y> | null {
  if (!raw || typeof raw !== 'object') return null
  const out: Partial<A11y> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === 'textSize') { if (!(TEXT_SIZES as readonly unknown[]).includes(v)) return null; out.textSize = v as number }
    else if (k === 'cursorSize') { if (!(CURSOR_SIZES as readonly unknown[]).includes(v)) return null; out.cursorSize = v as number }
    else if (k in KEYS) { if (typeof v !== 'boolean') return null; (out as Record<string, boolean>)[k] = v }
    else return null
  }
  return Object.keys(out).length ? out : null
}

export function makeA11y(exec: Exec) {
  async function read(): Promise<Avail<A11y>> {
    const v: Record<string, unknown> = {}
    for (const [k, [schema, key]] of Object.entries(KEYS)) {
      const r = await exec('gsettings', ['get', schema, key])
      if (r.missing) return { available: false, reason: 'unavailable' }
      if (r.code !== 0) return { available: false, reason: 'failed' }
      v[k] = parseGv(r.stdout)
    }
    return { available: true, value: { ...(v as unknown as A11y), reduceMotion: v.reduceMotion === false } }
  }
  async function apply(c: Partial<A11y>): Promise<Avail<A11y>> {
    for (const [k, value] of Object.entries(c)) {
      const [schema, key] = KEYS[k as keyof A11y]
      const text = k === 'reduceMotion' ? String(!value) : String(value)   // GVariant text (gsettings parses it against the key's type)
      const r = await exec('gsettings', ['set', schema, key, text])
      if (r.code !== 0) return { available: false, reason: r.missing ? 'unavailable' : 'failed' }
    }
    return read()
  }
  return { read, apply }
}
