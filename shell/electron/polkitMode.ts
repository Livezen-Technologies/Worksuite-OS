// `worksuite-shell --polkit-agent`: the shell's polkit agent process (WSOS-INT-010). See polkit.ts. Exits with
// code 3 when it cannot become the session's agent, so worksuite-polkit-agent falls back to lxpolkit.
import { app, BrowserWindow, ipcMain } from 'electron'
import os from 'node:os'
import path from 'node:path'
import dbus from 'dbus-next'
import { displaySession, exportAgent, nameOwner, registerAgent, type AgentUi, type AuthRequest } from './polkit'

type Pending = { req: AuthRequest; retry: boolean; resolve: (a: { account: string; password: string } | null) => void }

/** One prompt at a time; later requests wait their turn. */
export function promptQueue(show: (p: Pending) => void, hide: () => void) {
  const queue: Pending[] = []
  let current: Pending | null = null
  const next = () => { current = queue.shift() ?? null; if (current) show(current); else hide() }
  return {
    ui: {
      ask: (req, retry) => new Promise((resolve) => { queue.push({ req, retry, resolve }); if (!current) next() }),
      close: (cookie) => {
        for (let i = queue.length - 1; i >= 0; i--) if (queue[i].req.cookie === cookie) { queue[i].resolve(null); queue.splice(i, 1) }
        if (current?.req.cookie === cookie) { current.resolve(null); next() }
      },
    } satisfies AgentUi,
    current: () => current,
    answer(a: { account: string; password: string } | null) { const c = current; if (!c) return false; c.resolve(a); next(); return true },
  }
}

export function runPolkitMode() {
  app.setName('worksuite-polkit-agent')
  app.setPath('userData', path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'worksuite-polkit-agent'))
  if (!app.requestSingleInstanceLock()) { app.exit(0); return }
  app.on('window-all-closed', () => { /* stay registered with polkitd */ })
  void app.whenReady().then(async () => {
    let win: BrowserWindow | null = null
    const q = promptQueue((p) => {
      if (!win || win.isDestroyed()) {
        win = new BrowserWindow({
          width: 460, height: 420, resizable: false, minimizable: false, maximizable: false, alwaysOnTop: true, frame: false, show: false,
          backgroundColor: '#0F2350', title: 'WorkSuite',
          webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
        })
        win.webContents.on('will-navigate', (e) => e.preventDefault())
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        win.on('closed', () => { win = null; q.answer(null) })
        void win.loadFile(path.join(__dirname, '../dist/index.html'), { query: { mode: 'polkit' } })
        win.once('ready-to-show', () => { win?.show(); win?.focus() })
      } else { win.webContents.send('ws:polkitChanged', { request: p.req, retry: p.retry }); win.show(); win.focus() }
    }, () => { if (win && !win.isDestroyed()) win.hide() })

    const mine = (e: Electron.IpcMainInvokeEvent) => !!win && e.sender === win.webContents && e.senderFrame?.url.startsWith('file://') === true
    ipcMain.handle('ws:polkitRequest', (e) => {
      if (!mine(e)) throw new Error('Rejected IPC sender')
      const c = q.current()
      return c ? { request: c.req, retry: c.retry } : null
    })
    ipcMain.handle('ws:polkitAnswer', (e, account: unknown, password: unknown) => {
      if (!mine(e)) throw new Error('Rejected IPC sender')
      return q.answer({ account: String(account), password: String(password) })
    })
    ipcMain.handle('ws:polkitCancel', (e) => {
      if (!mine(e)) throw new Error('Rejected IPC sender')
      return q.answer(null)
    })

    try {
      const bus = dbus.systemBus()
      bus.on('error', () => app.exit(3))
      exportAgent(bus, { ui: q.ui }, () => nameOwner(bus, 'org.freedesktop.PolicyKit1'))
      const sid = await displaySession(bus, process.getuid?.() ?? -1)
      if (!sid) throw new Error('no graphical session')
      await registerAgent(bus, sid, app.getLocale() || 'en_US.UTF-8')
      process.stdout.write(`worksuite-polkit-agent: registered for session ${sid}\n`)
    } catch (err) {
      process.stderr.write(`worksuite-polkit-agent: cannot register (${(err as Error).message})\n`)
      app.exit(3)
    }
  })
}
