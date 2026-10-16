// Renderer side of the panel: running windows from the Wayland bridge, tray items and the update badge
// (SRS §5.1, WSOS-DSK-003, WSOS-INT-008, WSOS-AUP-011). In a plain browser a stub answers instead.
import type { OsUpdateStatus } from './os'
import { unreadFromTitle, WHATSAPP_APP_ID } from '../../electron/whatsapp'

export interface PanelWindow { handle: string; appId: string; title: string; output: string; flags: number }
export interface TrayItem { key: string; id: string; title: string; icon: string; status: string }
export type PanelResult = { ok: true; value: true } | { ok: false; error: string }
/** Labwc desktops via the bridge (WSOS-DSK-003). */
export interface Workspaces { supported: boolean; current: number; count: number; windows: Record<string, number> }

/** lk.worksuite.Shell1 calls: Super key (toggle/show) and touch gestures (notifications, desktop). */
export type ShellAction = 'toggle' | 'show' | 'notifications' | 'desktop' | 'assistant'

export const ACTIVATED = 1
export const MINIMIZED = 2

export interface PanelApi {
  windows(): Promise<PanelWindow[]>
  activate(handle: string): Promise<PanelResult>
  close(handle: string): Promise<PanelResult>
  minimize(handle: string, state: boolean): Promise<PanelResult>
  tray(): Promise<TrayItem[]>
  trayActivate(key: string, x: number, y: number): Promise<PanelResult>
  onWindows(cb: (w: PanelWindow[]) => void): () => void
  onTray(cb: (t: TrayItem[]) => void): () => void
  /** Super key (and Super+A for the AI assistant) via lk.worksuite.Shell1. */
  onLauncher(cb: (action: ShellAction) => void): () => void
  workspaces?(): Promise<Workspaces>
  activateWorkspace?(n: number): Promise<PanelResult>
  moveToWorkspace?(handle: string, n: number): Promise<PanelResult>
  onWorkspaces?(cb: (w: Workspaces) => void): () => void
}

/** Taskbar shows the windows of the current workspace; windows the bridge has not placed count as current. */
/** Show desktop (three-finger swipe down): minimise every visible window on the current workspace. */
export function showDesktopTargets(windows: PanelWindow[], ws: Workspaces): string[] {
  return onWorkspace(windows, ws).filter((w) => !(w.flags & MINIMIZED) && !['worksuite', 'worksuite-shell', 'electron'].includes(w.appId.toLowerCase())).map((w) => w.handle)
}

export function onWorkspace(windows: PanelWindow[], ws: Workspaces): PanelWindow[] {
  if (!ws.supported) return windows
  return windows.filter((w) => (ws.windows[w.handle] ?? ws.current) === ws.current)
}

declare global {
  interface Window { worksuitePanel?: PanelApi }
}

/** App ids that belong to a launcher entry (desktop-file id → Wayland app_id values seen in practice). */
const ALIASES: Record<string, string[]> = {
  terminal: ['foot', 'org.gnome.Terminal', 'org.gnome.Console', 'xterm'],
  firefox: ['firefox', 'firefox-esr', 'org.mozilla.firefox'],
  files: ['org.gnome.Nautilus', 'pcmanfm'],
}
/** The shell's own surfaces are not taskbar entries. */
const OWN = new Set(['worksuite', 'worksuite-shell', 'electron'])

export function matchesApp(appId: string, windowAppId: string): boolean {
  const w = windowAppId.toLowerCase()
  return w === appId.toLowerCase() || (ALIASES[appId] ?? []).some((a) => a.toLowerCase() === w) || w === `lk.worksuite.${appId}` || w === `lk.worksuite.${appId.replace(/^worksuite-/, '')}`
}

export interface TaskbarEntry { id: string; pinned: boolean; windows: PanelWindow[]; running: boolean; active: boolean; title: string }

/** Pinned apps first (in pin order) with their windows, then other running apps grouped by app_id. */
export function taskbarEntries(pinned: string[], windows: PanelWindow[]): TaskbarEntry[] {
  const mine = windows.filter((w) => !OWN.has(w.appId.toLowerCase()))
  const used = new Set<string>()
  const entry = (id: string, pin: boolean, ws: PanelWindow[]): TaskbarEntry => ({
    id, pinned: pin, windows: ws, running: ws.length > 0, active: ws.some((w) => w.flags & ACTIVATED && !(w.flags & MINIMIZED)), title: ws[0]?.title ?? '',
  })
  const out = pinned.map((id) => {
    const ws = mine.filter((w) => matchesApp(id, w.appId))
    ws.forEach((w) => used.add(w.handle))
    return entry(id, true, ws)
  })
  const rest = new Map<string, PanelWindow[]>()
  for (const w of mine) if (!used.has(w.handle)) rest.set(w.appId || w.handle, [...(rest.get(w.appId || w.handle) ?? []), w])
  for (const [id, ws] of rest) out.push(entry(id, false, ws))
  return out
}

/** Unread count a taskbar entry shows: WhatsApp's from its window title ("(3) WhatsApp"); 0 for other apps. */
export function taskbarUnread(id: string, windows: PanelWindow[]): number {
  if (id.toLowerCase() !== WHATSAPP_APP_ID) return 0
  return windows.reduce((n, w) => Math.max(n, unreadFromTitle(w.title)), 0)
}

export type ClickAction = { kind: 'launch' } | { kind: 'activate'; handle: string } | { kind: 'minimize'; handle: string }

/** Click on a taskbar entry: launch if not running, minimize the active window, otherwise raise the next one. */
export function clickAction(e: TaskbarEntry): ClickAction {
  if (!e.windows.length) return { kind: 'launch' }
  const i = e.windows.findIndex((w) => w.flags & ACTIVATED && !(w.flags & MINIMIZED))
  if (i >= 0 && e.windows.length === 1) return { kind: 'minimize', handle: e.windows[i].handle }
  return { kind: 'activate', handle: e.windows[(i + 1) % e.windows.length].handle }
}

export type BadgeState = 'available' | 'downloading' | 'restart' | 'failed'

/** Panel update badge (WSOS-AUP-011): available, downloading, ready-to-restart and failed. */
export function updateBadge(s: OsUpdateStatus | null, appUpdates = 0): BadgeState | null {
  switch (s?.state) {
    case 'available': case 'waiting': return 'available'
    case 'installing': return 'downloading'
    case 'ready_to_restart': case 'restart_pending': return 'restart'
    case 'failed': return 'failed'
    default: return appUpdates > 0 ? 'available' : null
  }
}

// ---- browser stub (dev/design review): two windows, one tray item ----
let stubWindows: PanelWindow[] = [
  { handle: 'w1', appId: 'firefox-esr', title: 'WorkSuite Cloud — Firefox', output: 'HDMI-A-1', flags: ACTIVATED },
  { handle: 'w2', appId: 'foot', title: 'Terminal', output: 'HDMI-A-1', flags: 0 },
]
const stubListeners = new Set<(w: PanelWindow[]) => void>()
const publish = () => stubListeners.forEach((l) => l(stubWindows))
const setFlags = (handle: string, f: (flags: number) => number): PanelResult => {
  if (!stubWindows.some((w) => w.handle === handle)) return { ok: false, error: 'not_found' }
  stubWindows = stubWindows.map((w) => (w.handle === handle ? { ...w, flags: f(w.flags) } : { ...w, flags: f === activateFlags ? w.flags & ~ACTIVATED : w.flags }))
  publish()
  return { ok: true, value: true }
}
const activateFlags = () => ACTIVATED
const stub: PanelApi = {
  async windows() { return stubWindows },
  async activate(h) { return setFlags(h, activateFlags) },
  async close(h) { stubWindows = stubWindows.filter((w) => w.handle !== h); publish(); return { ok: true, value: true } },
  async minimize(h, state) { return setFlags(h, (f) => (state ? (f | MINIMIZED) & ~ACTIVATED : f & ~MINIMIZED)) },
  async tray() { return [{ key: ':1.9/StatusNotifierItem', id: 'nm-applet', title: 'Network', icon: 'network-wireless', status: 'Active' }] },
  async trayActivate() { return { ok: true, value: true } },
  onWindows(cb) { stubListeners.add(cb); return () => { stubListeners.delete(cb) } },
  onTray() { return () => {} },
  onLauncher() { return () => {} },
  // No workspaces in a plain browser: the switcher only appears where Labwc and the bridge provide them.
  async workspaces() { return { supported: false, current: 1, count: 1, windows: {} } },
}

export const panel: PanelApi = (typeof window !== 'undefined' && window.worksuitePanel) || stub
