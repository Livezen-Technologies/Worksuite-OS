// Renderer side of per-monitor display handling (WSOS-DSK-005/006/007). Layout types match electron/displays.ts.
import { useEffect, useState } from 'react'
import type { PanelWindow } from './panel'
import { t } from '../i18n'

/** `custom`: a standard size offered on a virtual GPU that takes any size (electron/displays.ts withOfferedModes). */
export interface DisplayMode { width: number; height: number; refresh: number; preferred: boolean; current: boolean; custom?: boolean }
/** `fixedMode`: the firmware framebuffer (simpledrm/efifb) runs this output; it has one mode until a GPU driver loads. */
export interface DisplayOutput { name: string; description: string; make: string; model: string; serial: string; enabled: boolean; modes: DisplayMode[]; x: number; y: number; scale: number; transform: string; driver?: string; fixedMode?: boolean }
export interface DisplayOutputConfig { name: string; enabled: boolean; width: number; height: number; refresh: number; scale: number; x: number; y: number }
export type Arrangement = 'extend' | 'mirror'
export interface DisplayLayout { arrangement: Arrangement; primary: string; outputs: DisplayOutputConfig[] }
export interface DisplayState { outputs: DisplayOutput[]; layout: DisplayLayout; wallpapers: Record<string, string>; pending: { deadline: number } | null }
export type DisplayResult<T> = { ok: true; value: T } | { ok: false; error: string }
export type Side = 'left' | 'right' | 'above' | 'below'

export const REVERT_SECONDS = 15
/** 100–200 % in the steps Labwc renders crisply enough for text. */
export const SCALES = [1, 1.25, 1.5, 1.75, 2]

/** Per-monitor wallpapers (id → CSS background). `default` is the shell's usual desktop gradient. */
export const WALLPAPERS: Record<string, { label: string; css: string }> = {
  default: { label: 'WorkSuite', css: 'radial-gradient(120% 90% at 20% 10%, #1F4FB0 0%, #0A1A3D 55%, #050C1F 100%)' },
  dusk: { get label() { return t('disp.wp.dusk') }, css: 'linear-gradient(160deg, #3B1F6B 0%, #1A1240 50%, #07081C 100%)' },
  teal: { get label() { return t('disp.wp.teal') }, css: 'linear-gradient(150deg, #0E8FA8 0%, #0A3A4D 55%, #041821 100%)' },
  graphite: { get label() { return t('disp.wp.graphite') }, css: 'linear-gradient(170deg, #3A4253 0%, #1B202B 60%, #0C0F15 100%)' },
  sunrise: { get label() { return t('disp.wp.sunrise') }, css: 'linear-gradient(160deg, #F2994A 0%, #B4456B 45%, #2A1640 100%)' },
}

export function wallpaperFor(state: DisplayState | null, output: string | null, fallback: string): string {
  const id = output ? state?.wallpapers[output] : undefined
  return id && id !== 'default' && WALLPAPERS[id] ? WALLPAPERS[id].css : fallback
}

/** Windows a monitor's taskbar lists: those on it; the primary also takes windows whose output is unknown. */
export function windowsOnOutput(windows: PanelWindow[], output: string, primary: boolean, known: string[]): PanelWindow[] {
  return windows.filter((w) => w.output === output || (primary && (!w.output || !known.includes(w.output))))
}

/** Whole seconds left on the "Keep these settings?" countdown. */
export function secondsLeft(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000))
}

export function modeLabel(m: Pick<DisplayMode, 'width' | 'height'>) { return `${m.width} × ${m.height}` }

/** Distinct resolutions of an output (largest first) and the refresh rates for one of them. */
export function resolutions(o: DisplayOutput): { width: number; height: number }[] {
  const seen = new Map<string, { width: number; height: number }>()
  for (const m of o.modes) seen.set(`${m.width}x${m.height}`, { width: m.width, height: m.height })
  return [...seen.values()].sort((a, b) => b.width * b.height - a.width * a.height)
}
export function refreshRates(o: DisplayOutput, width: number, height: number): number[] {
  return [...new Set(o.modes.filter((m) => m.width === width && m.height === height).map((m) => m.refresh))].sort((a, b) => b - a)
}

export interface DisplayApi {
  displayState(): Promise<DisplayResult<DisplayState>>
  displayApply(layout: DisplayLayout, sides: Record<string, Side>): Promise<DisplayResult<{ deadline: number }>>
  displayKeep(): Promise<DisplayResult<true>>
  displayRevert(): Promise<DisplayResult<true>>
  displayWallpaper(output: string, id: string): Promise<DisplayResult<true>>
  onDisplaysChanged(cb: (s: DisplayState) => void): () => void
}

// Browser preview (no Electron): two monitors in memory, with the same countdown behaviour.
export function stubDisplays(): DisplayApi {
  const mk = (name: string, description: string, w: number, h: number, x: number, scale: number): DisplayOutput => ({
    name, description, make: '', model: '', serial: '', enabled: true, x, y: 0, scale, transform: 'normal',
    modes: [{ width: w, height: h, refresh: 60, preferred: true, current: true }, { width: 1920, height: 1080, refresh: 60, preferred: false, current: false }, { width: 1920, height: 1080, refresh: 50, preferred: false, current: false }],
  })
  let outputs = [mk('eDP-1', 'Built-in display', 2560, 1600, 0, 1.5), mk('HDMI-A-1', 'External monitor', 3840, 2160, 1707, 2)]
  let arrangement: Arrangement = 'extend'
  let primary = 'eDP-1'
  let wallpapers: Record<string, string> = {}
  type Snap = { outputs: DisplayOutput[]; arrangement: Arrangement; primary: string }
  let pending: { deadline: number; timer: ReturnType<typeof setTimeout>; prev: Snap } | null = null
  const listeners = new Set<(s: DisplayState) => void>()
  const layout = (): DisplayLayout => ({
    arrangement, primary,
    outputs: outputs.map((o) => { const m = o.modes.find((x) => x.current) ?? o.modes[0]; return { name: o.name, enabled: o.enabled, width: m.width, height: m.height, refresh: m.refresh, scale: o.scale, x: o.x, y: o.y } }),
  })
  const state = (): DisplayState => structuredClone({ outputs, layout: layout(), wallpapers, pending: pending ? { deadline: pending.deadline } : null })
  const emit = () => { for (const l of listeners) l(state()) }
  const restore = (p: Snap) => { outputs = p.outputs; arrangement = p.arrangement; primary = p.primary }
  const set = (l: DisplayLayout) => {
    arrangement = l.arrangement
    primary = l.primary
    outputs = outputs.map((o) => {
      const c = l.outputs.find((x) => x.name === o.name)
      if (!c) return o
      return { ...o, enabled: c.enabled, scale: c.scale, modes: o.modes.map((m) => ({ ...m, current: m.width === c.width && m.height === c.height && m.refresh === c.refresh })) }
    })
  }
  return {
    async displayState() { return { ok: true, value: state() } },
    async displayApply(l) {
      if (pending) clearTimeout(pending.timer)
      const prev = pending?.prev ?? structuredClone({ outputs, arrangement, primary })
      set(l)
      const deadline = Date.now() + REVERT_SECONDS * 1000
      pending = { deadline, prev, timer: setTimeout(() => { restore(prev); pending = null; emit() }, REVERT_SECONDS * 1000) }
      emit()
      return { ok: true, value: { deadline } }
    },
    async displayKeep() { if (pending) clearTimeout(pending.timer); pending = null; emit(); return { ok: true, value: true } },
    async displayRevert() { if (pending) { clearTimeout(pending.timer); restore(pending.prev); pending = null } emit(); return { ok: true, value: true } },
    async displayWallpaper(o, id) { wallpapers = { ...wallpapers, [o]: id }; emit(); return { ok: true, value: true } },
    onDisplaysChanged(cb) { listeners.add(cb); return () => { listeners.delete(cb) } },
  }
}

const bridged = typeof window !== 'undefined' ? (window as unknown as { worksuite?: Partial<DisplayApi> }).worksuite : undefined
export const displays: DisplayApi = bridged?.displayState ? (bridged as DisplayApi) : stubDisplays()

/** Live display state for the desktop/panel windows; null before the first answer. */
export function useDisplayState(api: DisplayApi = displays): DisplayState | null {
  const [s, setS] = useState<DisplayState | null>(null)
  useEffect(() => {
    let live = true
    void api.displayState().then((r) => { if (live && r.ok) setS(r.value) }).catch(() => undefined)
    const off = api.onDisplaysChanged((x) => setS(x))
    return () => { live = false; off() }
  }, [api])
  return s
}
