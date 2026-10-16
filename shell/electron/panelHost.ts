// Wires the panel client (electron/panel.ts) to IPC. Without a session bus or bridge the taskbar shows pinned apps only.
import dbus from 'dbus-next'
import { PanelClient } from './panel'

type Handle = (channel: string, fn: (...args: string[]) => unknown) => void

export function startPanel(handle: Handle, send: (channel: string, payload: unknown) => void, outputsChanged: () => void = () => undefined, openArchive: (path: string) => void = () => undefined): PanelClient | null {
  let client: PanelClient | null = null
  try {
    const bus = dbus.sessionBus()
    bus.on('error', () => { /* bus gone: keep the shell running */ })
    client = new PanelClient(bus as never, {
      windows: (w) => send('ws:panelWindowsChanged', w),
      tray: (t) => send('ws:panelTrayChanged', t),
      launcher: (a) => send('ws:launcher', a),
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
  handle('ws:panelWindows', () => c?.windows ?? [])
  handle('ws:panelTray', () => c?.tray ?? [])
  handle('ws:panelActivate', (h) => (c ? c.activate(h) : none))
  handle('ws:panelClose', (h) => (c ? c.close(h) : none))
  handle('ws:panelMinimize', (h, s) => (c ? c.minimize(h, s === '1') : none))
  handle('ws:panelWorkspaces', () => c?.workspaces ?? { supported: false, current: 1, count: 1, windows: {} })
  handle('ws:panelWorkspaceActivate', (n) => (c ? c.activateWorkspace(Math.max(1, Math.min(9, Number(n) | 0))) : none))
  handle('ws:panelMoveToWorkspace', (h, n) => (c ? c.moveToWorkspace(h, Math.max(1, Math.min(9, Number(n) | 0))) : none))
  handle('ws:panelTrayActivate', (k, x, y) => (c ? c.trayActivate(k, Number(x) || 0, Number(y) || 0) : none))
  return client
}
