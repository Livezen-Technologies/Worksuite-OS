import { app, BrowserWindow, ipcMain, session, shell, type IpcMainInvokeEvent } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { brokerCall, followSessionLock, publicAccounts, syncCall } from './broker'
import { deviceInfo, enrollDevice } from './device'
import { followJobs, packageClient } from './packages'
import { prepareAppMode, runAppMode } from './appwindow'
import { loadSession, parseAppArgs } from './webapps'
import { execProgram, findOffice, installedApps, OFFICE_NEW } from './xdg'
import { defaultEnv, driveDir, freeBytes, list, resolveIn, roots } from './files'

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
  // --recovery (recovery launcher unit) and --installer (live ISO) pick the screen; nothing else is accepted.
  const mode = process.argv.includes('--recovery') ? 'recovery' : process.argv.includes('--installer') ? 'installer' : null
  void win.loadFile(path.join(__dirname, '../dist/index.html'), mode ? { query: { mode } } : undefined)
}

// `worksuite-app <module>` starts the same binary as a WorkSuite app window instead of the shell.
const appRequest = parseAppArgs(process.argv)
if (appRequest) {
  if (prepareAppMode(appRequest)) runAppMode(appRequest)
  else app.quit()
} else startShell()

function startShell() {
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
  // Launcher data: the org's WorkSuite web apps (no token leaves the main process) and installed XDG apps.
  handle('ws:webApps', async () => {
    const r = await loadSession((m, p) => brokerCall(m, p ?? {}), (url, init) => fetch(url, { headers: init?.headers }))
    return r.ok ? { ok: true, value: r.value.apps.map(({ id, name }) => ({ id, name })) } : r
  })
  handle('ws:installedApps', () => {
    const all = installedApps()
    const office = findOffice(all)
    // worksuite-* entries are the web app windows, listed from the org's data instead.
    return { apps: all.filter((e) => !e.id.startsWith('worksuite-') || e === office).map(({ exec: _e, ...e }) => e), office: office?.id ?? null }
  })
  // WorkSuite Office "new document" entries: the detected editor's program with its --new switch (no shell).
  handle('ws:launchOffice', (kind) => {
    const office = findOffice(installedApps())
    if (!office) return undefined
    const prog = execProgram(office.exec)
    return kind in OFFICE_NEW && prog ? run(prog, [OFFICE_NEW[kind]]) : run('gtk-launch', [office.id])
  })
  handle('ws:openLink', (url) => {
    const u = new URL(url)
    if (!ALLOWED_SCHEMES.has(u.protocol)) throw new Error('Scheme not allowed')
    return shell.openExternal(u.toString())
  })
  // Sign-in waits for the user in the browser; the broker gives up after 5 minutes.
  handle('ws:cloudSignIn', async (serverUrl, mode) => {
    if (mode !== 'personal' && mode !== 'enterprise') return { ok: false, error: 'invalid_argument' }
    let https = false
    try { https = new URL(serverUrl).protocol === 'https:' } catch { /* invalid URL */ }
    if (!https) return { ok: false, error: 'insecure_url' }
    const r = await brokerCall('SignIn', { server_url: serverUrl, mode }, 6 * 60_000)
    return r.ok ? { ok: true, value: publicAccounts([r.value])[0] } : r
  })
  // WSOS-SYN-008: the renderer asks how many changes are unsent, the user chooses, then sign-out runs.
  handle('ws:cloudSignOut', async (accountId, choice) => {
    if (!['none', 'export', 'discard'].includes(choice)) return { ok: false, error: 'invalid_argument' }
    let exported: string | null = null
    if (choice === 'export') {
      const r = await syncCall('ExportUnsent', { account_id: accountId })
      if (!r.ok) return r
      exported = String(r.value)
    }
    // Remove this account's local WorkSuite data in every case; no sync service running means there is none.
    const f = await syncCall('Forget', { account_id: accountId })
    if (!f.ok && f.error !== 'broker_unavailable') return f
    const r = await brokerCall('SignOut', { account_id: accountId })
    return r.ok ? { ok: true, value: { exported } } : r
  })
  handle('ws:syncUnsent', async (accountId) => {
    const r = await syncCall('Unsent', { account_id: accountId })
    // No sync service running means nothing can be queued for this account.
    return r.ok ? { ok: true, value: Number(r.value) } : r.error === 'broker_unavailable' ? { ok: true, value: 0 } : r
  })
  handle('ws:syncNow', () => syncCall('SyncNow'))
  handle('ws:syncStatus', () => syncCall('Status'))
  handle('ws:deviceInfo', () => deviceInfo())
  handle('ws:enrollDevice', (serverUrl, code) => enrollDevice(serverUrl, code))
  // App Center (WSOS-APP-001/002): preview before confirmation, then a job whose result arrives as an event.
  const pkg = packageClient()
  handle('ws:pkgPreview', (catalogId, op) => pkg.preview(catalogId, op === 'remove' ? 'remove' : 'install'))
  handle('ws:pkgInstall', (catalogId) => pkg.start('Install', catalogId))
  handle('ws:pkgRemove', (catalogId) => pkg.start('Remove', catalogId))
  handle('ws:pkgApplyUpdate', () => pkg.applyUpdate())
  handle('ws:pkgCheckUpdates', () => pkg.checkUpdates())
  handle('ws:updateStatus', (check) => pkg.updateStatus(check === 'check'))
  handle('ws:updateDefer', () => pkg.deferUpdate())
  handle('ws:updateInstallNow', () => pkg.installUpdateNow())
  // Files: real folders plus Drive sync states from the sync service.
  const files = defaultEnv(async (dir) => { const r = await syncCall('FileStates', { dir }); return r.ok && Array.isArray(r.value) ? r.value as { name: string; state: string }[] : null })
  handle('ws:filesRoots', () => ({ roots: roots(files).map(({ id, label }) => ({ id, label })), drive_exists: existsSync(driveDir(files.home)) }))
  handle('ws:filesList', (root, rel) => list(files, root, rel))
  handle('ws:filesOpen', async (root, rel) => {
    const p = resolveIn(files, root, rel)
    if (!p || !existsSync(p.full)) return { ok: false, error: 'not_found' }
    const err = await shell.openPath(p.full)          // default app via XDG (WSOS-DSK-009)
    return err ? { ok: false, error: err } : { ok: true, value: true }
  })
  handle('ws:filesStatus', async (root) => {
    const r = roots(files).find((x) => x.id === root)
    const drive = root === 'drive' ? await syncCall('DriveSummary') : null
    return { free_bytes: r ? freeBytes(r.path) : null, drive: drive?.ok ? drive.value : null }
  })
  followJobs((e) => win?.webContents.send(e.kind === 'update_status' ? 'ws:updateStatusChanged' : 'ws:pkgJob', e.kind === 'update_status' ? e.status : e))
  handle('ws:cloudAccounts', async () => {
    const r = await brokerCall('Status')
    return r.ok ? { ok: true, value: publicAccounts(r.value) } : r
  })
  followSessionLock((locked) => void brokerCall(locked ? 'Lock' : 'Unlock'))
  createWindow()
})

app.on('window-all-closed', () => app.quit())
}

