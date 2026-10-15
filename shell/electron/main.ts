import { app, BrowserWindow, dialog, ipcMain, session, shell, type IpcMainInvokeEvent } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { appWebPreferences, appWindows } from './appwindows'
import { bootMode } from './bootmode'
import { appLaunchCommand, scopeCommand, lockPaths, logoutCommand, readLockSettings, writeLockTimeout } from './session'
import { brokerCall, followSessionLock, publicAccounts, syncCall } from './broker'
import { deviceInfo, enrollDevice } from './device'
import { appimageClient, flatpakUserClient, followJobs, packageClient } from './packages'
import { listDevices } from './hardware'
import { localUsers } from './users'
import { recoveryHost } from './recovery'
import { prepareAppMode, runAppMode } from './appwindow'
import { loadSession, parseAppArgs } from './webapps'
import { execProgram, findOffice, installedApps, OFFICE_NEW } from './xdg'
import { systemBridge } from './system'
import { defaultEnv, driveDir, freeBytes, list, resolveIn, roots } from './files'
import { startPanel } from './panelHost'

// Runs as the logged-in user; never a general root command runner (WSOS-ARC-001).
const ALLOWED_SCHEMES = new Set(['https:', 'mailto:', 'tel:', 'worksuite:']) // WSOS-SEC-006

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
  // Perf probe (tests/perf/guest/measure-shell, WSOS-PRF-002/006): process start → first window ready.
  if (process.env.WORKSUITE_PERF === '1') win.once('ready-to-show', () => process.stdout.write(`WORKSUITE_PERF shell_ready_ms ${Math.round(process.uptime() * 1000)}\n`))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (ALLOWED_SCHEMES.has(new URL(url).protocol)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // --recovery (recovery launcher unit), --installer (live ISO) or worksuite.recovery=1 on the kernel command line.
  let cmdline: string | null = null
  try { cmdline = readFileSync('/proc/cmdline', 'utf8') } catch { /* not Linux */ }
  const mode = bootMode(process.argv, cmdline)
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
  handle('ws:logout', () => run(...logoutCommand()))
  handle('ws:power', (action) => {
    const verbs: Record<string, string> = { suspend: 'suspend', restart: 'reboot', shutdown: 'poweroff' }
    return verbs[action] ? run('systemctl', [verbs[action]]) : undefined
  })
  // WorkSuite web apps: one window and one persistent session partition per app (WSOS-SEC-004).
  const apps = appWindows({
    session: (p) => session.fromPartition(p),
    window: ({ partition, title }) => new BrowserWindow({ title, backgroundColor: '#0f172a', webPreferences: appWebPreferences(partition) }),
    openExternal: (u) => { if (ALLOWED_SCHEMES.has(new URL(u).protocol)) void shell.openExternal(u) },
  })
  handle('ws:openWorkSuiteApp', (id, url) => apps.open(id, url))
  handle('ws:launchApp', (id) => { const c = appLaunchCommand(id); return c ? run(...c) : undefined })
  // Settings: idle lock timeout within the policy maximum (WSOS-LOCK-003).
  const lock = lockPaths(app.getPath('home'))
  handle('ws:lockSettings', () => readLockSettings(lock))
  handle('ws:setLockTimeout', (s) => writeLockTimeout(lock, Number(s)))
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
    // Own app scope either way, like every app launch (WSOS-SES-004).
    const c = kind in OFFICE_NEW && prog ? scopeCommand(office.id, [prog, OFFICE_NEW[kind]]) : appLaunchCommand(office.id)
    return c ? run(...c) : undefined
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
  // Settings → NetworkManager, BlueZ, PipeWire, UPower, CUPS, wlr-randr, UDisks2 (WSOS-INT-001…006, DSK-006).
  const sys = systemBridge()
  handle('ws:sysNetwork', () => sys.network())
  handle('ws:sysSetWifi', (on) => sys.setWifi(on === 'on'))
  handle('ws:sysWifiConnect', (ssid, password) => sys.wifiConnect(ssid, password))
  handle('ws:sysBluetooth', () => sys.bluetooth())
  handle('ws:sysSetBluetooth', (on) => sys.setBluetooth(on === 'on'))
  handle('ws:sysBtConnect', (address, on) => sys.btConnect(address, on === 'on'))
  handle('ws:sysSound', () => sys.sound())
  handle('ws:sysSetVolume', (p) => sys.setVolume(Number(p)))
  handle('ws:sysSetMute', (on) => sys.setMute(on === 'on'))
  handle('ws:sysSetDefaultAudio', (id) => sys.setDefaultAudio(Number(id)))
  handle('ws:sysBattery', () => sys.battery())
  handle('ws:sysPrinters', () => sys.printers())
  handle('ws:sysDisplays', () => sys.displays())
  handle('ws:sysDisks', () => sys.disks())
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
  // Devices: sysfs, read-only. There is no driver catalog or driver installer service yet, so those say so.
  handle('ws:hwDevices', () => { try { return { ok: true, value: listDevices() } } catch { return { ok: false, error: 'unavailable' } } })
  handle('ws:hwDriverUpdates', () => ({ ok: false, error: 'unavailable' }))
  handle('ws:hwInstallDrivers', () => ({ ok: false, error: 'unavailable' }))
  handle('ws:sysUsers', () => localUsers())
  handle('ws:pkgRepair', () => pkg.repair())
  handle('ws:pkgCatalog', () => pkg.catalog())
  // Files for local installs come only from the user's own choice in a file dialog: the renderer gets an opaque
  // handle, never the ability to name a path (WSOS-APT-005, WSOS-AIM-001, WSOS-AUP-010).
  const picked = new Map<string, string>()
  const FILTERS: Record<string, { name: string; extensions: string[] }> = {
    deb: { name: 'Debian package', extensions: ['deb'] }, appimage: { name: 'AppImage', extensions: ['AppImage', 'appimage'] }, wsupdate: { name: 'WorkSuite update bundle', extensions: ['wsupdate'] },
    wgconf: { name: 'WireGuard configuration', extensions: ['conf'] },
  }
  handle('ws:pickFile', async (kind) => {
    const filter = FILTERS[kind]
    if (!filter || !win) return { ok: false, error: 'invalid_argument' }
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [filter], defaultPath: kind === 'wsupdate' ? '/media' : app.getPath('downloads') })
    if (r.canceled || !r.filePaths[0]) return { ok: false, error: 'cancelled' }
    const handleId = `${kind}:${picked.size + 1}:${Date.now()}`
    picked.set(handleId, r.filePaths[0])
    return { ok: true, value: { handle: handleId, name: path.basename(r.filePaths[0]) } }
  })
  const pickedPath = (h: string, kind: string) => (h.startsWith(`${kind}:`) ? picked.get(h) ?? null : null)
  const noFile = { ok: false, error: 'invalid_argument' }
  // VPN (WSOS-INT-001): list/connect/disconnect/remove, and import of a WireGuard .conf the user picked.
  handle('ws:sysVpn', () => sys.vpn())
  handle('ws:sysVpnConnect', (uuid, on) => sys.vpnConnect(uuid, on === 'on'))
  handle('ws:sysVpnRemove', (uuid) => sys.vpnRemove(uuid))
  handle('ws:sysVpnImport', (h) => {
    const p = pickedPath(h, 'wgconf')
    if (!p) return noFile
    try {
      if (statSync(p).size > 64 * 1024) return { ok: false, error: 'invalid_file' }
      return sys.vpnImport(path.basename(p), readFileSync(p, 'utf8'))
    } catch { return { ok: false, error: 'invalid_file' } }
  })
  handle('ws:localDebPreview', (h) => { const p = pickedPath(h, 'deb'); return p ? pkg.localDebPreview(p) : noFile })
  handle('ws:localDebInstall', (token) => pkg.localDebInstall(token))
  const fpUser = flatpakUserClient()
  handle('ws:appPermissions', (id) => pkg.appPermissions(id))
  // Reset = system overrides (package service, admin) + this user's overrides and portal grants.
  handle('ws:appPermissionsReset', async (id) => {
    const u = await fpUser.resetUserPermissions(id)
    if (!u.ok) return u
    return pkg.resetAppPermissions(id)
  })
  handle('ws:appDataRemove', (id) => fpUser.removeAppData(id))
  handle('ws:pruneRuntimes', () => pkg.pruneRuntimes())
  handle('ws:bundleInspect', (h) => { const p = pickedPath(h, 'wsupdate'); return p ? pkg.bundleInspect(p) : noFile })
  handle('ws:bundleInstall', (h) => { const p = pickedPath(h, 'wsupdate'); return p ? pkg.bundleInstall(p) : noFile })
  const appimages = appimageClient()
  handle('ws:appimageList', () => appimages.list())
  handle('ws:appimageImport', (h) => { const p = pickedPath(h, 'appimage'); return p ? appimages.import(p, `file://${p}`) : noFile })
  handle('ws:appimageApprove', (id) => appimages.approve(id))
  handle('ws:appimageRemove', (id) => appimages.remove(id))
  handle('ws:appimageUpdate', (id, h) => { const p = pickedPath(h, 'appimage'); return p ? appimages.update(id, p) : noFile })
  handle('ws:appimageLaunch', (id) => appimages.launch(id))
  // Recovery screens (§9.2). The unlock secret goes to udisksctl's stdin only; it is never logged or stored.
  const rec = recoveryHost(pkg)
  handle('ws:recoveryInfo', () => rec.info())
  handle('ws:recoveryCheck', (id) => rec.check(id))
  handle('ws:recoveryUnlock', (device, secret) => rec.unlock(device, secret))
  for (const ch of ['ws:recoverySnapshots', 'ws:recoveryRestore', 'ws:recoveryReinstall', 'ws:recoveryCopyToUsb', 'ws:recoveryTerminal', 'ws:recoverySaveReport']) handle(ch, () => rec.unavailable())
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
  // Taskbar windows, tray and the Super key (lk.worksuite.Shell1) through the Wayland bridge.
  startPanel(handle, (channel, payload) => win?.webContents.send(channel, payload))
})

app.on('window-all-closed', () => app.quit())
}

