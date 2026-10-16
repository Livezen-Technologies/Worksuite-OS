// Renderer side of the panel: running windows from the Wayland bridge, tray items and the update badge
// (SRS §5.1, WSOS-DSK-003, WSOS-INT-008, WSOS-AUP-011). In a plain browser a stub answers instead.
import type { OsUpdateStatus } from './os'
import { unreadFromTitle, WHATSAPP_APP_ID } from '../../electron/whatsapp'

export interface PanelWindow { handle: string; appId: string; title: string; output: string; flags: number }
export interface TrayItem { key: string; id: string; title: string; icon: string; status: string }
export type PanelResult = { ok: true; value: true } | { ok: false; error: string }
/** Labwc desktops via the bridge (WSOS-DSK-003). */
export interface Workspaces {
  supported: boolean; current: number; count: number; windows: Record<string, number>
  /** "" = no name of its own (shown as "Desktop N"); see electron/panel.ts. */
  names?: string[]; sticky?: string[]; stickyApps?: string[]; switcherAll?: boolean; dynamic?: boolean; capture?: boolean; ids?: string[]
}
/** What opening Task View carries from the main process: a capture of the output taken before the shell was raised
 *  (data: URL in memory, or null) and the window that had focus (focused again when Task View closes with Esc). */
export interface TaskViewOpen { capture: string | null; previous: string }

/** lk.worksuite.Shell1 calls: Super key (toggle/show) and touch gestures (notifications, desktop). */
export type ShellAction = 'toggle' | 'show' | 'notifications' | 'desktop' | 'assistant' | 'taskview'

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
  createWorkspace?(): Promise<PanelResult>
  removeWorkspace?(n: number): Promise<PanelResult>
  moveWorkspace?(from: number, to: number): Promise<PanelResult>
  renameWorkspace?(n: number, name: string): Promise<PanelResult>
  restoreWorkspaces?(names: string[], prefix: string): Promise<PanelResult>
  setWindowOnAllDesktops?(handle: string, on: boolean): Promise<PanelResult>
  setAppOnAllDesktops?(appId: string, on: boolean): Promise<PanelResult>
  setSwitcherAllDesktops?(on: boolean): Promise<PanelResult>
  /** Ask the main process to open Task View (taskbar button). */
  openTaskView?(): Promise<unknown>
  taskViewState?(open: boolean): Promise<unknown>
  onTaskView?(cb: (o: TaskViewOpen) => void): () => void
}

/** Taskbar shows the windows of the current workspace; windows the bridge has not placed count as current. */
/** Show desktop (three-finger swipe down): minimise every visible window on the current workspace. */
export function showDesktopTargets(windows: PanelWindow[], ws: Workspaces): string[] {
  return onWorkspace(windows, ws).filter((w) => !(w.flags & MINIMIZED) && !['worksuite', 'worksuite-shell', 'electron'].includes(w.appId.toLowerCase())).map((w) => w.handle)
}

export function onWorkspace(windows: PanelWindow[], ws: Workspaces, n = ws.current): PanelWindow[] {
  if (!ws.supported) return windows
  const sticky = new Set(ws.sticky ?? [])
  return windows.filter((w) => sticky.has(w.handle) || (ws.windows[w.handle] ?? ws.current) === n)
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
  // No desktops in a plain browser, except the design-review demo (?demo=desktops): three desktops in memory.
  async workspaces() { return demoWs ? { ...demoWs } : { supported: false, current: 1, count: 1, windows: {} } },
  async activateWorkspace(n) { return demo((w) => { w.current = n }) },
  async moveToWorkspace(h, n) { return demo((w) => { w.windows = { ...w.windows, [h]: n } }) },
  onWorkspaces(cb) { wsListeners.add(cb); return () => { wsListeners.delete(cb) } },
  async createWorkspace() { return demo((w) => { w.count++; w.names = [...w.names!, '']; w.ids = [...w.ids!, `d${Date.now() % 1e6}`]; w.current = w.count }) },
  async removeWorkspace(n) {
    return demo((w) => {
      const to = n > 1 ? n - 1 : 1
      w.windows = Object.fromEntries(Object.entries(w.windows).map(([h, d]) => [h, d === n ? to : d > n ? d - 1 : d]))
      w.names = w.names!.filter((_, i) => i !== n - 1); w.ids = w.ids!.filter((_, i) => i !== n - 1); w.count--
      w.current = w.current === n ? to : w.current > n ? w.current - 1 : w.current
    })
  },
  async moveWorkspace(from, to) {
    return demo((w) => {
      const order = Array.from({ length: w.count }, (_, i) => i + 1); order.splice(to - 1, 0, order.splice(from - 1, 1)[0])
      const pos = (d: number) => order.indexOf(d) + 1
      w.windows = Object.fromEntries(Object.entries(w.windows).map(([h, d]) => [h, pos(d)]))
      w.names = order.map((d) => w.names![d - 1]); w.ids = order.map((d) => w.ids![d - 1]); w.current = pos(w.current)
    })
  },
  async renameWorkspace(n, name) { return demo((w) => { w.names = w.names!.map((x, i) => (i === n - 1 ? name : x)) }) },
  async setWindowOnAllDesktops(h, on) { return demo((w) => { w.sticky = on ? [...w.sticky!, h] : w.sticky!.filter((x) => x !== h) }) },
  async setAppOnAllDesktops(a, on) { return demo((w) => { w.stickyApps = on ? [...w.stickyApps!, a] : w.stickyApps!.filter((x) => x !== a) }) },
  async setSwitcherAllDesktops(on) { return demo((w) => { w.switcherAll = on }) },
  async openTaskView() { taskViewListeners.forEach((l) => l({ capture: null, previous: '' })); return true },
  async taskViewState() { return true },
  onTaskView(cb) { taskViewListeners.add(cb); return () => { taskViewListeners.delete(cb) } },
}
const wsListeners = new Set<(w: Workspaces) => void>()
const taskViewListeners = new Set<(o: TaskViewOpen) => void>()
let demoWs: Workspaces | null = null
function demo(f: (w: Workspaces) => void): PanelResult {
  if (!demoWs) return { ok: false, error: 'not_supported' }
  const next = { ...demoWs }
  f(next)
  demoWs = next
  wsListeners.forEach((l) => l({ ...next }))
  return { ok: true, value: true }
}
if (typeof location !== 'undefined' && /[?&]demo=desktops\b/.test(location.search)) {
  stubWindows = [
    { handle: 'w1', appId: 'firefox-esr', title: 'WorkSuite Cloud — Firefox', output: 'HDMI-A-1', flags: ACTIVATED },
    { handle: 'w2', appId: 'foot', title: 'Terminal', output: 'HDMI-A-1', flags: 0 },
    { handle: 'w3', appId: 'worksuite-mail', title: 'Inbox — Mail', output: 'HDMI-A-1', flags: 0 },
    { handle: 'w4', appId: 'office', title: 'Q3 budget.xlsx — Office', output: 'HDMI-A-1', flags: 0 },
    { handle: 'w5', appId: 'worksuite-chat', title: 'Team chat', output: 'HDMI-A-1', flags: 0 },
  ]
  demoWs = { supported: true, dynamic: true, capture: false, current: 1, count: 3, windows: { w1: 1, w2: 1, w3: 1, w4: 2, w5: 3 },
    names: ['', 'Finance', ''], ids: ['d1', 'd2', 'd3'], sticky: [], stickyApps: [], switcherAll: false }
}

export const panel: PanelApi = (typeof window !== 'undefined' && window.worksuitePanel) || stub
