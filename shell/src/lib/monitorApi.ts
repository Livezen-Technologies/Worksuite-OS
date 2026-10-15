// Renderer side of electron/monitorHost.ts: system monitor samples (G11) and quick settings brightness / power mode
// (G01). In Electron the preload exposes `window.worksuiteMonitor`. In the browser preview the Vite dev server
// answers the same calls from this machine's /proc (vite.config.ts), so the preview shows real numbers too; when
// neither is there every call says unavailable.
import type { MonitorSnapshot, HealthItem, StartupEntry } from '../../electron/monitor'
import type { Backlight, PowerModeState, PowerProfile } from '../../electron/quick'
import type { Avail } from './os'

export type { MonitorSnapshot, MonitorGroup, MonitorProcess, HealthItem, StartupEntry } from '../../electron/monitor'
export type { Backlight, PowerModeState, PowerProfile } from '../../electron/quick'
export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

export interface MonitorApi {
  sysBrightness(): Promise<Avail<Backlight>>
  sysSetBrightness(percent: number): Promise<Avail<true>>
  sysPowerMode(): Promise<Avail<PowerModeState>>
  sysSetPowerMode(mode: PowerProfile): Promise<Avail<true>>
  monitorSample(): Promise<Avail<MonitorSnapshot>>
  monitorHealth(): Promise<Avail<HealthItem[]>>
  monitorStartup(): Promise<Avail<StartupEntry[]>>
  monitorEnd(pid: number): Promise<Result<true>>
}

declare global {
  interface Window { worksuiteMonitor?: MonitorApi }
}

const NONE = { available: false as const, reason: 'no_bridge' }

async function dev<T>(op: string, arg?: string | number): Promise<T> {
  const r = await fetch(`/__dev/monitor/${op}${arg === undefined ? '' : `?a=${encodeURIComponent(String(arg))}`}`)
  if (!r.ok) throw new Error(String(r.status))
  return r.json() as Promise<T>
}
const devOr = <T>(op: string, fallback: T, arg?: string | number) => dev<T>(op, arg).catch(() => fallback)

const preview: MonitorApi = {
  sysBrightness: () => devOr('brightness', NONE),
  sysSetBrightness: (p) => devOr('setBrightness', NONE, p),
  sysPowerMode: () => devOr('powerMode', NONE),
  sysSetPowerMode: (m) => devOr('setPowerMode', NONE, m),
  monitorSample: () => devOr('sample', NONE),
  monitorHealth: () => devOr('health', NONE),
  monitorStartup: () => devOr('startup', NONE),
  // The preview never signals processes on the machine serving it.
  monitorEnd: async () => ({ ok: false, error: 'not_allowed' }),
}

export const monitorApi: MonitorApi = (typeof window !== 'undefined' && window.worksuiteMonitor) || preview

/** Fixed-length history for the overview graphs (30 samples ≈ one minute at 2 s). */
export function pushHistory(h: number[], v: number | null, max = 30): number[] {
  return v == null ? h : [...h, v].slice(-max)
}

/** Polyline points for a 200×56 viewBox; `top` is the value drawn at the top edge. */
export function sparkPoints(h: number[], top: number, w = 200, ht = 56): string {
  if (!h.length) return ''
  const n = Math.max(h.length, 2)
  const scale = top > 0 ? top : 1
  return h.map((v, i) => `${((i * w) / (n - 1)).toFixed(1)},${(ht - 2 - Math.max(0, Math.min(1, v / scale)) * (ht - 4)).toFixed(1)}`).join(' ')
}

/** A graph's top edge: the next 1-2-5 step above the largest value, so small rates still show movement. */
export function niceTop(h: number[], floor: number): number {
  const m = Math.max(floor, ...h)
  const p = 10 ** Math.floor(Math.log10(m))
  return [1, 2, 5, 10].map((k) => k * p).find((x) => x >= m)!
}
