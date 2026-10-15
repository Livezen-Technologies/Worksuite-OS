// Quick settings (G01) pieces that Settings didn't have: screen brightness and the power mode.
// Brightness: read from /sys/class/backlight, set through logind's Session.SetBrightness (no root needed for the
// session's own seat). Power mode: power-profiles-daemon through powerprofilesctl. Fixed argv, no shell; when the
// hardware or the service isn't there the answer is { available: false, reason }.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Avail, Exec } from './system'

export interface Backlight { device: string; percent: number }
export type PowerProfile = 'power-saver' | 'balanced' | 'performance'
export interface PowerModeState { active: PowerProfile; profiles: PowerProfile[] }

export interface BacklightFs { list(): string[]; read(device: string, file: string): string | null }
export const realBacklightFs = (root = '/sys/class/backlight'): BacklightFs => ({
  list() { try { return readdirSync(root).sort() } catch { return [] } },
  read(d, f) { try { return readFileSync(join(root, d, f), 'utf8') } catch { return null } },
})

/** Firmware/platform interfaces first, then raw (the same order logind and brightnessctl prefer). */
export function pickBacklight(fs: BacklightFs): { device: string; cur: number; max: number } | null {
  const rank = (t: string | null) => (t === 'firmware' ? 0 : t === 'platform' ? 1 : t === 'raw' ? 2 : 3)
  const all = fs.list().map((d) => ({ device: d, type: fs.read(d, 'type')?.trim() ?? null, cur: Number(fs.read(d, 'brightness')), max: Number(fs.read(d, 'max_brightness')) }))
    .filter((b) => Number.isFinite(b.cur) && b.max > 0)
    .sort((a, b) => rank(a.type) - rank(b.type))
  return all[0] ? { device: all[0].device, cur: all[0].cur, max: all[0].max } : null
}

/** `powerprofilesctl list`: "* balanced:" marks the active one. */
export function parseProfiles(text: string): PowerModeState | null {
  const profiles: PowerProfile[] = []
  let active: PowerProfile | null = null
  for (const m of text.matchAll(/^(\*?)\s*(power-saver|balanced|performance):\s*$/gm)) {
    profiles.push(m[2] as PowerProfile)
    if (m[1] === '*') active = m[2] as PowerProfile
  }
  return active ? { active, profiles: (['power-saver', 'balanced', 'performance'] as const).filter((p) => profiles.includes(p)) } : null
}

export function quickBridge(exec: Exec, fs: BacklightFs = realBacklightFs()) {
  return {
    brightness(): Avail<Backlight> {
      const b = pickBacklight(fs)
      return b ? { available: true, value: { device: b.device, percent: Math.round((b.cur / b.max) * 100) } } : { available: false, reason: 'no_backlight' }
    },
    async setBrightness(percent: number): Promise<Avail<true>> {
      const b = pickBacklight(fs)
      if (!b) return { available: false, reason: 'no_backlight' }
      // Never all the way to black: 1% keeps the panel readable.
      const value = Math.max(1, Math.round((Math.max(1, Math.min(100, percent)) / 100) * b.max))
      const r = await exec('busctl', ['call', 'org.freedesktop.login1', '/org/freedesktop/login1/session/auto', 'org.freedesktop.login1.Session', 'SetBrightness', 'ssu', 'backlight', b.device, String(value)])
      return r.missing ? { available: false, reason: 'tool_missing' } : r.code === 0 ? { available: true, value: true } : { available: false, reason: 'failed' }
    },
    async powerMode(): Promise<Avail<PowerModeState>> {
      const r = await exec('powerprofilesctl', ['list'])
      if (r.missing) return { available: false, reason: 'tool_missing' }
      const s = r.code === 0 ? parseProfiles(r.stdout) : null
      return s ? { available: true, value: s } : { available: false, reason: 'service_unavailable' }
    },
    async setPowerMode(p: string): Promise<Avail<true>> {
      if (p !== 'power-saver' && p !== 'balanced' && p !== 'performance') return { available: false, reason: 'invalid_argument' }
      const r = await exec('powerprofilesctl', ['set', p])
      return r.missing ? { available: false, reason: 'tool_missing' } : r.code === 0 ? { available: true, value: true } : { available: false, reason: 'failed' }
    },
  }
}
