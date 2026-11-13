// Settings › Privacy & security under GNOME: the screen lock and the device permissions GNOME itself enforces, per
// user, through gsettings (gsettings-desktop-schemas 48). GNOME Shell's lock screen, the camera/microphone portals and
// GeoClue read these keys; nothing here is a copy that could drift. Every change is read back from gsettings.
//   idle-delay      org.gnome.desktop.session idle-delay (seconds of inactivity before the screen blanks; 0 = never)
//   lock            org.gnome.desktop.screensaver lock-enabled (lock when the screen blanks, and on suspend)
//   lockDelay       org.gnome.desktop.screensaver lock-delay (seconds between blanking and locking)
//   camera          org.gnome.desktop.privacy disable-camera (inverted: true here = allowed)
//   microphone      org.gnome.desktop.privacy disable-microphone (inverted)
//   location        org.gnome.system.location enabled
import type { Avail, Exec } from './system'
import { parseGv } from './desktopLook'

/** Inactivity before the screen blanks and locks: 1, 2, 5, 10, 15 minutes, or never (0). */
export const IDLE_CHOICES = [60, 120, 300, 600, 900, 0] as const
export const LOCK_DELAYS = [0, 30, 60, 300] as const
export interface GnomePrivacy { idleDelay: number; lock: boolean; lockDelay: number; camera: boolean; microphone: boolean; location: boolean }

const KEYS: Record<keyof GnomePrivacy, [string, string, boolean?]> = {
  idleDelay: ['org.gnome.desktop.session', 'idle-delay'],
  lock: ['org.gnome.desktop.screensaver', 'lock-enabled'],
  lockDelay: ['org.gnome.desktop.screensaver', 'lock-delay'],
  camera: ['org.gnome.desktop.privacy', 'disable-camera', true],
  microphone: ['org.gnome.desktop.privacy', 'disable-microphone', true],
  location: ['org.gnome.system.location', 'enabled'],
}

/** IPC input → known settings with valid values, or null. */
export function cleanGnomePrivacy(raw: unknown): Partial<GnomePrivacy> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: Partial<GnomePrivacy> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === 'idleDelay') { if (!(IDLE_CHOICES as readonly unknown[]).includes(v)) return null; out.idleDelay = v as number }
    else if (k === 'lockDelay') { if (!(LOCK_DELAYS as readonly unknown[]).includes(v)) return null; out.lockDelay = v as number }
    else if (k in KEYS) { if (typeof v !== 'boolean') return null; (out as Record<string, boolean>)[k] = v }
    else return null
  }
  return Object.keys(out).length ? out : null
}

/** gsettings prints uint32 values as "uint32 600". */
const num = (v: unknown) => Number(String(v).replace(/^uint32\s+/, ''))

export function makeGnomePrivacy(exec: Exec) {
  async function read(): Promise<Avail<GnomePrivacy>> {
    const v: Record<string, unknown> = {}
    for (const [k, [schema, key, inverted]] of Object.entries(KEYS)) {
      const r = await exec('gsettings', ['get', schema, key])
      if (r.missing) return { available: false, reason: 'unavailable' }
      if (r.code !== 0) return { available: false, reason: 'failed' }
      const raw = r.stdout.trim()
      v[k] = k === 'idleDelay' || k === 'lockDelay' ? num(raw) : inverted ? parseGv(raw) !== true : parseGv(raw) === true
    }
    return { available: true, value: v as unknown as GnomePrivacy }
  }
  async function apply(c: Partial<GnomePrivacy>): Promise<Avail<GnomePrivacy>> {
    for (const [k, value] of Object.entries(c)) {
      const [schema, key, inverted] = KEYS[k as keyof GnomePrivacy]
      const text = typeof value === 'number' ? `uint32 ${value}` : String(inverted ? !value : value)
      const r = await exec('gsettings', ['set', schema, key, text])
      if (r.code !== 0) return { available: false, reason: r.missing ? 'unavailable' : 'failed' }
    }
    return read()
  }
  return { read, apply }
}
