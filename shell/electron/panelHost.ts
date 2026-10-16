// Wires the panel client (electron/panel.ts) to IPC. Without a session bus or bridge the taskbar shows pinned apps only.
import dbus from 'dbus-next'
import { ACTIVATED_FLAG, MAX_DESKTOPS, PanelClient } from './panel'

type Handle = (channel: string, fn: (...args: string[]) => unknown) => void

export function startPanel(handle: Handle, send: (channel: string, payload: unknown) => void, outputsChanged: () => void = () => undefined, openArchive: (path: string) => void = () => undefined): PanelClient | null {
  let client: PanelClient | null = null
  try {
    const bus = dbus.sessionBus()
    bus.on('error', () => { /* bus gone: keep the shell running */ })
    client = new PanelClient(bus as never, {
      windows: (w) => send('ws:panelWindowsChanged', w),
      tray: (t) => send('ws:panelTrayChanged', t),
      launcher: (a) => { if (a === 'taskview') void tv.open(); else send('ws:launcher', a) },
      outputs: outputsChanged,
      openArchive,
      workspaces: (w) => send('ws:panelWorkspacesChanged', w),
    })
    void client.start().catch(() => undefined)
  } catch {
    client = null
  }
  const c = client
  const none = { ok: false, error: 'bridge_unavailable' }
  const tv = taskViewHost(c, send)
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

type TaskViewClient = Pick<PanelClient, 'windows' | 'workspaces' | 'captureOutput' | 'shellWindow' | 'setShellRaised' | 'activate'>

/** Task View (Super+Tab, the taskbar button, three fingers up): the output is captured first, while the apps are still
 *  on screen, then the shell's window is lifted over them. The shell's windows are always on bottom (Labwc rc.xml), so
 *  activating one alone would leave it under the apps; closing Task View puts it back down, also when it closes before
 *  the lift is done. The capture is a data: URL in memory only. */
export function taskViewHost(c: TaskViewClient | null, send: (channel: string, payload: unknown) => void) {
  let isOpen = false
  let lifted = ''
  let opened = 0, closed = 0
  async function lower() {
    const h = lifted
    lifted = ''
    if (h && c) await c.setShellRaised(h, false)
  }
  return {
    async open(fromShell = false) {
      if (isOpen) { send('ws:launcher', 'taskview'); return }
      const seq = ++opened
      const previous = c?.windows.find((w) => w.flags & ACTIVATED_FLAG && w.appId !== 'worksuite-shell')?.handle ?? ''
      const capture = c && !fromShell && c.workspaces.capture ? await c.captureOutput('', 480) : null
      send('ws:taskView', { capture, previous })
      const own = c?.shellWindow()
      if (!own || !c) return
      const r = await c.setShellRaised(own.handle, true)
      if (!r.ok) { await c.activate(own.handle); return }
      lifted = own.handle
      if (closed >= seq) await lower()
    },
    /** The renderer's Task View mounted (true) or closed (false). */
    state(open: boolean) {
      isOpen = open
      if (!open) { closed = opened; void lower() }
    },
  }
}
