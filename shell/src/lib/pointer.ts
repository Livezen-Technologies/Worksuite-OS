// Renderer side of electron/pointer.ts (Settings › Mouse & touchpad, #35). Outside Electron there is no bridge; the
// browser preview simulates a laptop (touchpad + mouse) only with ?pointer=1, otherwise the page says it's unavailable.
import { useCallback, useEffect, useState } from 'react'

export type Avail<T> = { available: true; value: T } | { available: false; reason: string }
export type AccelProfile = 'adaptive' | 'flat'
export interface MouseSettings { speed: number; accel: AccelProfile; naturalScroll: boolean; scrollFactor: number; leftHanded: boolean }
export interface TouchpadSettings extends MouseSettings {
  enabled: 'yes' | 'no' | 'disabledOnExternalMouse'
  tap: boolean; tapAndDrag: boolean; dragLock: boolean
  scrollMethod: 'twoFinger' | 'edge'; clickMethod: 'clickfinger' | 'buttonAreas'; disableWhileTyping: boolean
}
export interface PointerSettings { mouse: MouseSettings; touchpad: TouchpadSettings }
export interface PointerCaps {
  tap: boolean; naturalScroll: boolean; leftHanded: boolean; accel: boolean; flat: boolean
  edgeScroll: boolean; twoFingerScroll: boolean; clickfinger: boolean; buttonAreas: boolean; disableWhileTyping: boolean; dragLock: boolean
}
export interface PointerDev { name: string; kind: 'mouse' | 'touchpad'; caps: PointerCaps }
export interface PointerSupport { mouse: PointerCaps | null; touchpad: PointerCaps | null; scrollFactor: boolean; swipeGestures: boolean }
export interface PointerState { devices: PointerDev[]; settings: PointerSettings; support: PointerSupport }
export type PointerPatch = { mouse?: Partial<MouseSettings>; touchpad?: Partial<TouchpadSettings> }

export interface PointerApi {
  state(): Promise<Avail<PointerState>>
  set(patch: PointerPatch): Promise<Avail<PointerState>>
}
declare global { interface Window { worksuitePointer?: PointerApi } }

export const SCROLL_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4]
/** libinput speed −1…1 shown as 1…11 on the slider. */
export const speedToStep = (v: number) => Math.round((v + 1) * 5) + 1
export const stepToSpeed = (s: number) => Math.round(((s - 1) / 5 - 1) * 100) / 100

const ALL: PointerCaps = { tap: true, naturalScroll: true, leftHanded: true, accel: true, flat: true, edgeScroll: true, twoFingerScroll: true, clickfinger: true, buttonAreas: true, disableWhileTyping: true, dragLock: true }
export const DEFAULT_POINTER: PointerSettings = {
  mouse: { speed: 0, accel: 'adaptive', naturalScroll: false, scrollFactor: 1, leftHanded: false },
  touchpad: { speed: 0, accel: 'adaptive', naturalScroll: true, scrollFactor: 1, leftHanded: false, enabled: 'yes', tap: true, tapAndDrag: true, dragLock: false, scrollMethod: 'twoFinger', clickMethod: 'clickfinger', disableWhileTyping: true },
}

/** In-memory laptop for the browser preview and tests. */
export function stubPointer(devices: PointerDev[] = [{ name: 'Touchpad', kind: 'touchpad', caps: { ...ALL } }, { name: 'USB Mouse', kind: 'mouse', caps: { ...ALL, tap: false, edgeScroll: false, twoFingerScroll: false, clickfinger: false, buttonAreas: false, disableWhileTyping: false, dragLock: false } }]): PointerApi {
  let settings = structuredClone(DEFAULT_POINTER)
  const sup = (): PointerSupport => ({ mouse: devices.find((d) => d.kind === 'mouse')?.caps ?? null, touchpad: devices.find((d) => d.kind === 'touchpad')?.caps ?? null, scrollFactor: true, swipeGestures: false })
  const st = (): PointerState => structuredClone({ devices, settings, support: sup() })
  return {
    async state() { return { available: true, value: st() } },
    async set(p) { settings = { mouse: { ...settings.mouse, ...p.mouse }, touchpad: { ...settings.touchpad, ...p.touchpad } }; return { available: true, value: st() } },
  }
}

let preview: PointerApi | null = null
export function pointerApi(): PointerApi | null {
  if (typeof window === 'undefined') return null
  if (window.worksuitePointer) return window.worksuitePointer
  if (/[?&]pointer=1\b/.test(window.location?.search ?? '')) return (preview ??= stubPointer())
  return null
}

/** State plus a setter that answers the bridge's reply (so the switches can show a failed change). */
export function usePointer(api: PointerApi | null = pointerApi()) {
  const [state, setState] = useState<PointerState | null>(null)
  const [reason, setReason] = useState<string | null>(null)
  useEffect(() => {
    if (!api) { setReason('service_unavailable'); return }
    let live = true
    void api.state().then((r) => { if (!live) return; if (r.available) setState(r.value); else setReason(r.reason) }).catch(() => { if (live) setReason('service_unavailable') })
    return () => { live = false }
  }, [api])
  const set = useCallback(async (p: PointerPatch): Promise<Avail<PointerState>> => {
    if (!api) return { available: false, reason: 'service_unavailable' }
    let r: Avail<PointerState>
    try { r = await api.set(p) } catch { r = { available: false, reason: 'service_unavailable' } }
    if (r.available) setState(r.value)
    return r
  }, [api])
  return { state, reason, set }
}
