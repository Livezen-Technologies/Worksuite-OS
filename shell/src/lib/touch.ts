// Renderer side of electron/touch.ts: touchscreen/pen state, touch (tablet) mode and the on-screen keyboard.
// Outside Electron there is no bridge; the browser preview simulates a convertible only with ?touch=1.
import { useEffect, useState } from 'react'

export type Avail<T> = { available: true; value: T } | { available: false; reason: string }
export type DevKind = 'touchscreen' | 'tablet' | 'tablet-pad' | 'switch'
export interface InputDev { name: string; node: string; kinds: DevKind[]; tabletModeSwitch: boolean }
export type OskMode = 'off' | 'touch' | 'always'
export type TabletMode = 'auto' | 'on' | 'off'
export type OskSize = 'small' | 'medium' | 'large'
export interface GestureSettings {
  enabled: boolean; edgeSwipes: boolean; edgeBottom: 'launcher' | 'off'; edgeRight: 'notifications' | 'off'; edgeLeft: 'switch-apps' | 'off'
  threeHorizontal: 'workspaces' | 'switch-apps' | 'off'; threeDown: 'desktop' | 'off'
}
export const DEFAULT_GESTURES: GestureSettings = { enabled: true, edgeSwipes: true, edgeBottom: 'launcher', edgeRight: 'notifications', edgeLeft: 'switch-apps', threeHorizontal: 'workspaces', threeDown: 'desktop' }
export interface TouchSettings { touchEnabled: boolean; mapToOutput: Record<string, string>; tabletMode: TabletMode; rotationLock: boolean; osk: OskMode; oskSize: OskSize; calibration: Record<string, number[]>; gestures?: GestureSettings; longPressMs?: number }
export interface TouchState {
  devices: InputDev[]; settings: TouchSettings; tabletSwitch: boolean; touchMode: boolean
  orientation: string | null; hasAccelerometer: boolean; osk: { available: boolean; visible: boolean }; outputs: string[]
}
export type PenEvent = { pressure?: number; button?: string; pressed?: boolean; proximity?: boolean }

export interface TouchApi {
  state(): Promise<Avail<TouchState>>
  set(patch: Partial<TouchSettings>): Promise<Avail<TouchState>>
  osk(show: boolean): Promise<Avail<boolean>>
  penTest(on: boolean): Promise<Avail<true>>
  onChange(cb: (s: unknown) => void): () => void
  onPen(cb: (e: unknown) => void): () => void
}
declare global { interface Window { worksuiteTouch?: TouchApi } }

export const touchScreens = (s: TouchState) => s.devices.filter((d) => d.kinds.includes('touchscreen'))
export const pens = (s: TouchState) => s.devices.filter((d) => d.kinds.includes('tablet'))
export const hasTabletSwitch = (s: TouchState) => s.devices.some((d) => d.tabletModeSwitch)

/** The shell's touch-friendly sizing hangs off :root[data-touch] (index.css). */
export function applyTouchMode(on: boolean, root: HTMLElement = document.documentElement) {
  if (on) root.setAttribute('data-touch', '')
  else root.removeAttribute('data-touch')
}
/** Text fields that should bring up the on-screen keyboard when focused. */
export function isTextField(el: Element | null): boolean {
  if (!el) return false
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled
  if (el instanceof HTMLInputElement) return !el.readOnly && !el.disabled && !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color', 'hidden', 'image'].includes(el.type)
  return (el as HTMLElement).isContentEditable === true
}
/**
 * Touch and hold → right-click on the shell's own surfaces (Settings › Touchscreen & pen › Long-press delay): after
 * `ms` without moving more than 10 px, a contextmenu event goes to the element under the finger. Returns the remover.
 */
export function installLongPress(root: HTMLElement | Document, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let start: { x: number; y: number } | null = null
  const cancel = () => { if (timer) clearTimeout(timer); timer = null; start = null }
  const down = (e: Event) => {
    const te = e as TouchEvent
    if (te.touches.length !== 1) { cancel(); return }
    const p = te.touches[0]
    start = { x: p.clientX, y: p.clientY }
    const target = e.target as Element
    timer = setTimeout(() => {
      timer = null
      if (start) target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: start.x, clientY: start.y }))
    }, ms)
  }
  const move = (e: Event) => {
    const p = (e as TouchEvent).touches[0]
    if (start && p && Math.hypot(p.clientX - start.x, p.clientY - start.y) > 10) cancel()
  }
  root.addEventListener('touchstart', down, { passive: true })
  root.addEventListener('touchmove', move, { passive: true })
  root.addEventListener('touchend', cancel)
  root.addEventListener('touchcancel', cancel)
  return () => { cancel(); root.removeEventListener('touchstart', down); root.removeEventListener('touchmove', move); root.removeEventListener('touchend', cancel); root.removeEventListener('touchcancel', cancel) }
}

export const oskWanted = (s: TouchSettings, touchMode: boolean) => s.osk === 'always' || (s.osk === 'touch' && touchMode)

// ---------- preview stub (?touch=1) ----------
const DEFAULTS: TouchSettings = { touchEnabled: true, mapToOutput: {}, tabletMode: 'auto', rotationLock: false, osk: 'touch', oskSize: 'medium', calibration: {}, gestures: { ...DEFAULT_GESTURES }, longPressMs: 600 }
function stubApi(): TouchApi {
  const subs = new Set<(s: unknown) => void>()
  const st: TouchState = {
    devices: [
      { name: 'ELAN9008:00 04F3:2C82', node: '/dev/input/event9', kinds: ['touchscreen'], tabletModeSwitch: false },
      { name: 'ELAN9008:00 04F3:2C82 Stylus', node: '/dev/input/event10', kinds: ['tablet'], tabletModeSwitch: false },
      { name: 'Intel HID switches', node: '/dev/input/event4', kinds: ['switch'], tabletModeSwitch: true },
    ],
    settings: { ...DEFAULTS }, tabletSwitch: false, touchMode: false, orientation: 'normal', hasAccelerometer: true,
    osk: { available: true, visible: false }, outputs: ['eDP-1', 'HDMI-A-1'],
  }
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null
  if (q?.get('tablet') === '1') st.settings.tabletMode = 'on'
  const sync = () => { st.touchMode = st.settings.tabletMode === 'on' || (st.settings.tabletMode === 'auto' && st.tabletSwitch); subs.forEach((f) => f(structuredClone(st))) }
  sync()
  return {
    async state() { return { available: true, value: structuredClone(st) } },
    async set(p) { st.settings = { ...st.settings, ...p }; sync(); return { available: true, value: structuredClone(st) } },
    async osk(show) { st.osk.visible = show; sync(); return { available: true, value: show } },
    async penTest() { return { available: true, value: true } },
    onChange(cb) { subs.add(cb); return () => { subs.delete(cb) } },
    onPen() { return () => {} },
  }
}
let stub: TouchApi | null = null
export function touchApi(): TouchApi | null {
  if (typeof window === 'undefined') return null
  if (window.worksuiteTouch) return window.worksuiteTouch
  if (new URLSearchParams(location.search).get('touch') === '1') return (stub ??= stubApi())
  return null
}

/** Live touch state (null while loading); `reason` when the bridge is not there. */
export function useTouch(): { state: TouchState | null; reason: string | null; set: (p: Partial<TouchSettings>) => Promise<void> } {
  const [state, setState] = useState<TouchState | null>(null)
  const [reason, setReason] = useState<string | null>(null)
  useEffect(() => {
    const api = touchApi()
    if (!api) { setReason('service_unavailable'); return }
    let live = true
    void api.state().then((r) => { if (!live) return; if (r.available) setState(r.value); else setReason(r.reason) }).catch(() => setReason('service_unavailable'))
    const off = api.onChange((s) => { if (live) setState(s as TouchState) })
    return () => { live = false; off() }
  }, [])
  const set = async (p: Partial<TouchSettings>) => {
    const api = touchApi(); if (!api) return
    const r = await api.set(p)
    if (r.available) setState(r.value)
  }
  return { state, reason, set }
}

/** Desktop: keeps :root[data-touch] in step with touch mode and shows the keyboard on text-field focus. */
export function useTouchMode(): TouchState | null {
  const { state } = useTouch()
  const on = !!state?.touchMode
  useEffect(() => { applyTouchMode(on); return () => applyTouchMode(false) }, [on])
  useEffect(() => {
    if (!state || !oskWanted(state.settings, state.touchMode)) return
    const api = touchApi()
    const focus = (e: FocusEvent) => { if (isTextField(e.target as Element)) void api?.osk(true) }
    const blur = (e: FocusEvent) => { if (isTextField(e.target as Element) && !isTextField(e.relatedTarget as Element | null)) void api?.osk(false) }
    document.addEventListener('focusin', focus)
    document.addEventListener('focusout', blur)
    return () => { document.removeEventListener('focusin', focus); document.removeEventListener('focusout', blur) }
  }, [state?.settings.osk, state?.touchMode]) // eslint-disable-line react-hooks/exhaustive-deps
  const hold = state?.settings.longPressMs ?? 600
  const touchOn = !!state && state.devices.some((d) => d.kinds.includes('touchscreen')) && state.settings.touchEnabled
  useEffect(() => (touchOn ? installLongPress(document, hold) : undefined), [touchOn, hold])
  return state
}
