// Wires the panel client (electron/panel.ts) to IPC. Without a session bus or bridge the taskbar shows pinned apps only.
import dbus from 'dbus-next'
import { ACTIVATED_FLAG, MAX_DESKTOPS, PanelClient, type PanelWindow } from './panel'

type Handle = (channel: string, fn: (...args: string[]) => unknown) => void

/** Open/Capture from Shell1 (Windows-style key bindings), and the lift for others (the snipping overlay) once it exists. */
export interface PanelHooks { open?(what: string): void; capture?(kind: string): void; lift?: (reason: string, on: boolean) => Promise<void> }

export function startPanel(handle: Handle, send: (channel: string, payload: unknown) => void, outputsChanged: () => void = () => undefined, openArchive: (path: string) => void = () => undefined, hooks: PanelHooks = {}): PanelClient | null {
  let client: PanelClient | null = null
  try {
    const bus = dbus.sessionBus()
    bus.on('error', () => { /* bus gone: keep the shell running */ })
    client = new PanelClient(bus as never, {
      windows: (w) => { send('ws:panelWindowsChanged', w); lift.windowsChanged(w) },
      tray: (t) => send('ws:panelTrayChanged', t),
      launcher: (a) => { if (a === 'taskview') void tv.open(); else send('ws:launcher', a) },
      outputs: outputsChanged,
      openArchive,
      workspaces: (w) => send('ws:panelWorkspacesChanged', w),
      open: (w) => hooks.open?.(w),
      capture: (k) => hooks.capture?.(k),
    })
    void client.start().catch(() => undefined)
  } catch {
    client = null
  }
  const c = client
  const none = { ok: false, error: 'bridge_unavailable' }
  // An app got the focus while the shell was over the apps: the shell went back below; the renderer closes its menus.
  const lift: ReturnType<typeof shellLift> = shellLift(c, () => send('ws:shellBehind', null))
  hooks.lift = (reason, on) => lift.set(reason, on)
  const tv = taskViewHost(c, send, lift)
  // Anything else of the shell's own open over the apps (launcher, Settings, Files, power menu…): see shellLift.
  // Sent when the set of open things changes or a shell window is opened again: each "on" raises the shell again.
  handle('ws:panelShellOnTop', (on) => { void lift.set('overlay', on === '1', true); return true })
  handle('ws:panelTaskView', (open) => {
    if (open === 'open') void tv.open(true)
    else tv.state(open === '1')
    return true
  })
  const n16 = (n: string) => Math.max(1, Math.min(MAX_DESKTOPS, Number(n) | 0))
  handle('ws:panelWorkspaceCreate', () => (c ? c.createWorkspace() : none))
  handle('ws:panelWorkspaceRemove', (n) => (c ? c.removeWorkspace(n16(n)) : none))
  handle('ws:panelWorkspaceMove', (a, b) => (c ? c.moveWorkspace(n16(a), n16(b)) : none))
  handle('ws:panelWorkspaceRename', (n, name) => (c ? c.renameWorkspace(n16(n), String(name)) : none))
  handle('ws:panelWorkspacesRestore', (json, prefix) => {
    let names: unknown = null
    try { names = JSON.parse(json) } catch { /* bad input */ }
    return c && Array.isArray(names) && names.length ? c.restoreWorkspaces(names.map(String), String(prefix)) : none
  })
  handle('ws:panelWindowAllDesktops', (h, on) => (c ? c.setWindowOnAllWorkspaces(h, on === '1') : none))
  handle('ws:panelAppAllDesktops', (app, on) => (c ? c.setAppOnAllWorkspaces(app, on === '1') : none))
  handle('ws:panelSwitcherAll', (on) => (c ? c.setSwitcherAllWorkspaces(on === '1') : none))
  handle('ws:panelWindows', () => c?.windows ?? [])
  handle('ws:panelTray', () => c?.tray ?? [])
  handle('ws:panelActivate', (h) => (c ? c.activate(h) : none))
  handle('ws:panelClose', (h) => (c ? c.close(h) : none))
  handle('ws:panelMinimize', (h, s) => (c ? c.minimize(h, s === '1') : none))
  handle('ws:panelWorkspaces', () => c?.workspaces ?? { supported: false, current: 1, count: 1, windows: {} })
  handle('ws:panelWorkspaceActivate', (n) => (c ? c.activateWorkspace(n16(n)) : none))
  handle('ws:panelMoveToWorkspace', (h, n) => (c ? c.moveToWorkspace(h, n16(n)) : none))
  handle('ws:panelTrayActivate', (k, x, y) => (c ? c.trayActivate(k, Number(x) || 0, Number(y) || 0) : none))
  return client
}

type LiftClient = Pick<PanelClient, 'shellWindow' | 'setShellRaised' | 'activate'>
type TaskViewClient = LiftClient & Pick<PanelClient, 'windows' | 'workspaces' | 'captureOutput'>

/** The shell's full-screen window is always on bottom (Labwc rc.xml), below every app. While something of the shell's
 *  own is open over the apps (Task View, the launcher, Settings, Files, the power menu…) it is lifted over them, on
 *  every desktop, and put back down once nothing is open, so it can never stay over the apps. Reasons are counted
 *  separately; requests are applied one at a time, the last state wins.
 *
 *  Each request to show something raises the shell again, also when it is already lifted (the bridge's lift is
 *  idempotent): an app may have gone over it in between. And when an app window gets the focus while the shell is up
 *  (clicked in the taskbar, opened from the launcher, raised by a notification), the shell goes back below the apps at
 *  once and `behind` tells the renderer, which closes its menus: nothing of the shell's stays "open" under an app. */
export function shellLift(c: LiftClient | null, behind: () => void = () => undefined) {
  const reasons = new Set<string>()
  let lifted = ''          // the handle lifted now
  let again = false        // raise again although lifted
  let busy: Promise<void> | null = null
  let focusedApp: string | null = null
  async function apply() {
    for (;;) {
      const want = reasons.size > 0
      if (!c || !(want ? !lifted || again : !!lifted)) return
      if (want) {
        again = false
        const own = c.shellWindow()
        if (!own) return
        const r = await c.setShellRaised(own.handle, true)
        if (!r.ok) { await c.activate(own.handle); return }   // older bridge: at least focus it
        lifted = own.handle
      } else {
        const h = lifted
        lifted = ''
        await c.setShellRaised(h, false)
      }
    }
  }
  function kick(): Promise<void> {
    if (!busy) busy = apply().finally(() => { busy = null })
    else busy = busy.then(() => apply())
    return busy
  }
  return {
    /** raise: lift again although lifted (default: when this reason is new). */
    set(reason: string, on: boolean, raise = !reasons.has(reason)): Promise<void> {
      if (on) { reasons.add(reason); again ||= raise } else reasons.delete(reason)
      return kick()
    },
    /** The bridge's window list changed: an app window that newly has the focus puts the shell below the apps. */
    windowsChanged(windows: PanelWindow[]) {
      const app = windows.find((w) => w.flags & ACTIVATED_FLAG && !SHELL_IDS.has(w.appId.toLowerCase()))?.handle ?? ''
      const before = focusedApp
      focusedApp = app
      // Task View moves and picks windows itself (the bridge focuses a window to move it) and closes itself.
      if (before === null || !app || app === before || (!reasons.size && !lifted) || reasons.has('taskview') || reasons.has('snip')) return
      reasons.clear()
      again = false
      void kick()
      behind()
    },
    get lifted() { return lifted },
  }
}
const SHELL_IDS = new Set(['worksuite-shell', 'worksuite', 'electron'])

/** Task View (Super+Tab, the taskbar button, three fingers up): the output is captured first, while the apps are still
 *  on screen, then the shell's window is lifted over them; closing Task View puts it back down, also when it closes
 *  before the lift is done. The capture is a data: URL in memory only. */
export function taskViewHost(c: TaskViewClient | null, send: (channel: string, payload: unknown) => void, lift = shellLift(c)) {
  let isOpen = false
  let opened = 0, closed = 0   // a close may come before the lift was asked for
  return {
    async open(fromShell = false) {
      if (isOpen) { send('ws:launcher', 'taskview'); return }
      const seq = ++opened
      const previous = c?.windows.find((w) => w.flags & ACTIVATED_FLAG && w.appId !== 'worksuite-shell')?.handle ?? ''
      const capture = c && !fromShell && c.workspaces.capture ? await c.captureOutput('', 480) : null
      send('ws:taskView', { capture, previous })
      if (closed < seq) await lift.set('taskview', true)
    },
    /** The renderer's Task View mounted (true) or closed (false). */
    state(open: boolean) {
      isOpen = open
      if (!open) closed = opened
      void lift.set('taskview', open)
    },
  }
}
