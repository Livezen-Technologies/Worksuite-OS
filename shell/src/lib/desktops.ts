// Desktops like Windows 11 (WSOS-DSK-003): the synced preferences (names, order, count, wallpapers, the taskbar's and
// Alt+Tab's scope, the Task View button) and the pure helpers Task View, the taskbar and Settings › Multitasking use.
// The desktops themselves are Labwc's, through the Wayland bridge (native/wayland-bridge/worksuite_bridge/workspace.py).
import { useEffect, useState } from 'react'
import { onWorkspace, type PanelWindow, type Workspaces } from './panel'
import { WALLPAPERS } from './displays'
import { t } from '../i18n'

export * from './desktopPrefs'
import { MAX_DESKTOPS, DEFAULT_DESKTOP_PREFS, type DesktopPrefs, type Scope, type SavedDesktop } from './desktopPrefs'

/** A desktop's name to show: its own, else "Desktop N" in the user's language. */
export function desktopName(ws: Pick<Workspaces, 'names'>, n: number): string {
  return ws.names?.[n - 1] || t('desktops.name', { n: String(n) })
}

/** The desktop's wallpaper (CSS) when it has one of its own. */
export function desktopWallpaper(wallpapers: Record<string, string>, ws: Workspaces, n: number): string | null {
  const id = wallpapers[ws.ids?.[n - 1] ?? ''] ?? ''
  return id && WALLPAPERS[id] ? WALLPAPERS[id].css : null
}

/** The shell's own surfaces are never a desktop's windows. */
const OWN = new Set(['worksuite', 'worksuite-shell', 'electron'])
export const appWindows = (w: PanelWindow[]) => w.filter((x) => !OWN.has(x.appId.toLowerCase()))

/** Windows on desktop n (windows on all desktops included). */
export const windowsOn = (windows: PanelWindow[], ws: Workspaces, n: number) => appWindows(onWorkspace(windows, ws, n))

/** The taskbar's windows under Settings › Multitasking: the current desktop's, or every desktop's. */
export function taskbarWindows(windows: PanelWindow[], ws: Workspaces, scope: Scope): PanelWindow[] {
  return scope === 'all' ? windows : onWorkspace(windows, ws)
}

export const isSticky = (ws: Workspaces, w: PanelWindow) => (ws.sticky ?? []).includes(w.handle)
export const isStickyApp = (ws: Workspaces, w: PanelWindow) => (ws.stickyApps ?? []).includes(w.appId)

/** Move item `from` to position `to` (1-based), as the bridge's MoveWorkspace does. */
export function moved<T>(list: T[], from: number, to: number): T[] {
  const out = [...list]
  out.splice(to - 1, 0, ...out.splice(from - 1, 1))
  return out
}

/** The list to save for the bridge's desktops, keeping each desktop's wallpaper (keyed by the bridge's stable id). */
export function savedList(ws: Workspaces, wallpapers: Record<string, string>): SavedDesktop[] {
  return Array.from({ length: ws.count }, (_, i) => ({ name: ws.names?.[i] ?? '', wallpaper: wallpapers[ws.ids?.[i] ?? ''] ?? '' }))
}

/** Wallpapers by desktop id after restoring a saved list onto the bridge's desktops (same order). */
export function wallpapersFor(ws: Workspaces, list: SavedDesktop[]): Record<string, string> {
  const out: Record<string, string> = {}
  ;(ws.ids ?? []).forEach((id, i) => { if (list[i]?.wallpaper) out[id] = list[i].wallpaper })
  return out
}

/** Whether the bridge already has the saved desktops (count and names). */
export const sameDesktops = (ws: Workspaces, list: SavedDesktop[]) => ws.count === list.length && list.every((d, i) => (ws.names?.[i] ?? '') === d.name)

// ---- live preferences inside the shell: Settings changes them, the taskbar and Task View follow ----------------
export const DESKTOP_PREFS_EVENT = 'ws:desktop-prefs'
let live: DesktopPrefs = DEFAULT_DESKTOP_PREFS
export const desktopPrefs = () => live
export function setDesktopPrefs(p: DesktopPrefs) {
  live = p
  globalThis.dispatchEvent?.(new CustomEvent(DESKTOP_PREFS_EVENT, { detail: p }))
}
export function useDesktopPrefs(): DesktopPrefs {
  const [p, setP] = useState(live)
  useEffect(() => {
    const on = (e: Event) => setP((e as CustomEvent<DesktopPrefs>).detail)
    window.addEventListener(DESKTOP_PREFS_EVENT, on)
    setP(live)
    return () => window.removeEventListener(DESKTOP_PREFS_EVENT, on)
  }, [])
  return p
}

/** Save the desktops preferences into the synced shell preferences (merged with what is there). */
export async function saveDesktopPrefs(p: DesktopPrefs, sync: { shellPrefs(): Promise<{ ok: boolean; value?: unknown }>; setShellPrefs(p: unknown): Promise<unknown> }): Promise<void> {
  setDesktopPrefs(p)
  try {
    const cur = await sync.shellPrefs()
    const base = cur.ok && cur.value && typeof cur.value === 'object' ? cur.value as Record<string, unknown> : {}
    await sync.setShellPrefs({ ...base, desktops: p })
  } catch { /* not signed in or offline: kept for this session */ }
}

/** Whether Task View and the desktops exist here: never on a kiosk, and only where the bridge provides desktops. */
export const desktopsAllowed = (ws: Workspaces, policies: unknown) => ws.supported && (policies as { kiosk?: boolean } | null)?.kiosk !== true
