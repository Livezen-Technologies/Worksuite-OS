import { app, BrowserWindow, ipcMain, session, shell, type IpcMainInvokeEvent } from 'electron'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { brokerCall, followSessionLock, publicAccounts } from './broker'

// Runs as the logged-in user; never a general root command runner (WSOS-ARC-001).
const ALLOWED_SCHEMES = new Set(['https:', 'mailto:', 'tel:', 'worksuite:']) // WSOS-SEC-006
const APP_ID = /^[A-Za-z0-9._-]+$/

let win: BrowserWindow | null = null

function validSender(e: IpcMainInvokeEvent) {
  return win !== null && e.sender === win.webContents && e.senderFrame?.url.startsWith('file://') === true
}

function handle(channel: string, fn: (...args: string[]) => unknown) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!validSender(e)) throw new Error('Rejected IPC sender')
    return fn(...args.map(String))
  })
}

function run(cmd: string, args: string[]) {
  // Fixed argument arrays, never a shell (WSOS-LCH-001).
  return new Promise<void>((resolve) => execFile(cmd, args, () => resolve()))
}

function createWindow() {
  win = new BrowserWindow({
    fullscreen: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (ALLOWED_SCHEMES.has(new URL(url).protocol)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  void win.loadFile(path.join(__dirname, '../dist/index.html'))
}

app.whenReady().then(() => {
  // Web permissions denied by default (WSOS-SEC-003).
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))

  handle('ws:authenticate', async () => ({ ok: false, message: 'Authentication is handled by the greeter (greetd/PAM).' }))
  handle('ws:lock', async () => { await brokerCall('Lock'); await run('loginctl', ['lock-session']) })
  handle('ws:logout', () => run('systemctl', ['--user', 'stop', 'worksuite-session.target']))
  handle('ws:power', (action) => {
    const verbs: Record<string, string> = { suspend: 'suspend', restart: 'reboot', shutdown: 'poweroff' }
    return verbs[action] ? run('systemctl', [verbs[action]]) : undefined
  })
  handle('ws:launchApp', (id) => (APP_ID.test(id) ? run('gtk-launch', [id]) : undefined))
  handle('ws:openLink', (url) => {
    const u = new URL(url)
    if (!ALLOWED_SCHEMES.has(u.protocol)) throw new Error('Scheme not allowed')
    return shell.openExternal(u.toString())
  })
  // Sign-in waits for the user in the browser; the broker gives up after 5 minutes.
  handle('ws:cloudSignIn', async (serverUrl) => {
    let https = false
    try { https = new URL(serverUrl).protocol === 'https:' } catch { /* invalid URL */ }
    if (!https) return { ok: false, error: 'insecure_url' }
    const r = await brokerCall('SignIn', { server_url: serverUrl }, 6 * 60_000)
    return r.ok ? { ok: true, value: publicAccounts([r.value])[0] } : r
  })
  handle('ws:cloudSignOut', (accountId) => brokerCall('SignOut', { account_id: accountId }))
  handle('ws:cloudAccounts', async () => {
    const r = await brokerCall('Status')
    return r.ok ? { ok: true, value: publicAccounts(r.value) } : r
  })
  followSessionLock((locked) => void brokerCall(locked ? 'Lock' : 'Unlock'))
  createWindow()
})

app.on('window-all-closed', () => app.quit())
