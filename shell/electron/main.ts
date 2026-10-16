import { findBundles } from './bundles'
import { app, BrowserWindow, dialog, ipcMain, Notification, session, shell, type IpcMainInvokeEvent } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { appWebPreferences, appWindows } from './appwindows'
import { bootMode } from './bootmode'
import { appLaunchCommand, scopeCommand, lockPaths, logoutCommand, readLockSettings, writeLockTimeout } from './session'
import { brokerCall, followSessionLock, publicAccounts, syncCall } from './broker'
import { deviceCredential, deviceInfo, enrollDevice } from './device'
import { appimageClient, flatpakUserClient, followJobs, packageClient } from './packages'
import { listDevices } from './hardware'
import { localUsers } from './users'
import { recoveryHost } from './recovery'
import { prepareAppMode, runAppMode } from './appwindow'
import { loadSession, parseAppArgs, resolveLink } from './webapps'
import { createSearch, localRecentHits, parseXbel } from './search'
import { DESKTOP_MODULES, execProgram, findOffice, findWorkSuiteDesktop, installedApps, OFFICE_NEW } from './xdg'
import { systemBridge } from './system'
import { CONNECTIVITY_CHECK_URL, initialPortalState, KILLSWITCH_MARKER, portalNavAllowed, portalStep, type PortalAction, type PortalState } from './connectivity'
import { archiveJobs, listIn, locate } from './archives'
import { defaultEnv, driveDir, freeBytes, list, resolveIn, roots } from './files'
import { eject, jobs as fileJobs, mkdirIn, places, recent, renameIn, search, setStar, starred, starredHits, trash, trashDelete, trashList, trashRestore } from './fileops'
import { startPanel } from './panelHost'
import { arrange, displayManager, outputRects, type DisplayState } from './displays'
import { outputWindows } from './outputWindows'
import { realExec } from './system'
import { startDesktopHost } from './desktopHost'
import { markShellReady, startMonitorHost } from './monitorHost'
import { flatpakPermsClient } from './flatpakPerms'
import { startPeripheralsHost } from './peripherals'
import { startNotifications } from './notifications'
import { isOfficeDoc, launchAndWait, openWithLock } from './officeLock'
import { startPolkitBridge } from './polkit'
import { fileHead, isWindowsProgram } from './winexe'
import { externalAllowed, loadGrants, permissionAllowed, shellWebPreferences } from './webSecurity'

// Runs as the logged-in user; never a general root command runner (WSOS-ARC-001).
// URL scheme allow-list, renderer prefs and per-origin permission grants: ./webSecurity (WSOS-SEC-001/003/006).

let win: BrowserWindow | null = null
// The main window plus one desktop/taskbar window per secondary monitor (WSOS-DSK-005).
const shellContents = new Set<Electron.WebContents>()

function validSender(e: IpcMainInvokeEvent) {
  return shellContents.has(e.sender) && e.senderFrame?.url.startsWith('file://') === true
}

function broadcast(channel: string, payload: unknown) {
  for (const wc of shellContents) if (!wc.isDestroyed()) wc.send(channel, payload)
}

const shellPrefs = () => shellWebPreferences(path.join(__dirname, 'preload.cjs'))

const monitors = outputWindows((r) => {
  const w = new BrowserWindow({ x: r.x, y: r.y, width: r.width, height: r.height, fullscreen: true, frame: false, title: `WorkSuite desktop ${r.name}`, backgroundColor: '#0f172a', webPreferences: shellPrefs() })
  const wc = w.webContents
  shellContents.add(wc)
  w.on('closed', () => { shellContents.delete(wc); monitors.forget(r.name) })
  wc.on('will-navigate', (e) => e.preventDefault())
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  void w.loadFile(path.join(__dirname, '../dist/index.html'), { query: { mode: 'output', output: r.name } })
  return w
}, () => win)

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
    webPreferences: shellPrefs(),
  })
  shellContents.add(win.webContents)
  // Perf probe (tests/perf/guest/measure-shell, WSOS-PRF-002/006): process start → first window ready.
  if (process.env.WORKSUITE_PERF === '1') win.once('ready-to-show', () => process.stdout.write(`WORKSUITE_PERF shell_ready_ms ${Math.round(process.uptime() * 1000)}\n`))
  win.once('ready-to-show', () => markShellReady(Math.round(process.uptime() * 1000)))
  // Renderer probes (launcher first frame, WSOS-PRF-005) report on the console; forwarded only in perf runs.
  if (process.env.WORKSUITE_PERF === '1') win.webContents.on('console-message', (ev) => { if (/^WORKSUITE_PERF [a-z_]+ \d+$/.test(ev.message)) process.stdout.write(`${ev.message}\n`) })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (externalAllowed(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // --recovery (recovery launcher unit), --installer (live ISO) or worksuite.recovery=1 on the kernel command line.
  let cmdline: string | null = null
  try { cmdline = readFileSync('/proc/cmdline', 'utf8') } catch { /* not Linux */ }
  const mode = bootMode(process.argv, cmdline)
  void win.loadFile(path.join(__dirname, '../dist/index.html'), mode ? { query: { mode } } : undefined)
}

// WSOS-INT-011: Sinhala/Tamil typing in the shell and app windows through fcitx5 (Wayland text-input-v3).
app.commandLine.appendSwitch('enable-wayland-ime')
// `worksuite-app <module>` starts the same binary as a WorkSuite app window instead of the shell.
const appRequest = parseAppArgs(process.argv)
if (appRequest) {
  if (prepareAppMode(appRequest)) runAppMode(appRequest)
  else app.quit()
} else startShell()

function startShell() {
app.whenReady().then(() => {
  // Web permissions denied by default; the shell's own session never gets any (WSOS-SEC-003).
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  // Administrator grants for exact HTTPS origins of WorkSuite apps (/etc/worksuite/web-permissions.json).
  const webGrants = loadGrants()

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
    openExternal: (u) => { if (externalAllowed(u)) void shell.openExternal(u) },
    permission: (perm, url) => permissionAllowed(webGrants, url, perm),
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
    return r.ok ? { ok: true, value: r.value.apps.map(({ id, name, offline_level }) => ({ id, name, offline_level })) } : r
  })
  handle('ws:installedApps', () => {
    const all = installedApps()
    const office = findOffice(all)
    const desktop = findWorkSuiteDesktop(all)
    // worksuite-* entries are the web app windows, listed from the org's data instead.
    return { apps: all.filter((e) => !e.id.startsWith('worksuite-') || e === office).map(({ exec: _e, ...e }) => e), office: office?.id ?? null, desktop: desktop?.id ?? null }
  })
  // WorkSuite Desktop modules: its program with --module=<id> (fixed list, no shell), in its own app scope. A second
  // launch is handed to the running WorkSuite (single instance).
  handle('ws:launchWorkSuite', (module) => {
    if (!(DESKTOP_MODULES as readonly string[]).includes(module)) return undefined
    const desktop = findWorkSuiteDesktop(installedApps())
    const prog = desktop && execProgram(desktop.exec)
    const c = desktop && prog ? scopeCommand(desktop.id, [prog, `--module=${module}`]) : null
    return c ? run(...c) : undefined
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
  // Launcher global search (WSOS-LCH, DSK-010): the token is attached here; the renderer only gets results.
  const brokerFn = (m: string, p?: Record<string, unknown>) => brokerCall(m, p ?? {})
  const searcher = createSearch({ broker: brokerFn, device: () => deviceCredential(), fetch: (url, init) => fetch(url, { headers: init.headers, signal: init.signal }) })
  handle('ws:search', (q, types) => searcher.search(q, types ? types.split(',').filter(Boolean) : []))
  handle('ws:recentFiles', async () => {
    const home = app.getPath('home')
    let local: ReturnType<typeof localRecentHits> = []
    try {
      const xbel = path.join(process.env.XDG_DATA_HOME || path.join(home, '.local/share'), 'recently-used.xbel')
      local = localRecentHits(parseXbel(readFileSync(xbel, 'utf8')).filter((r) => existsSync(r.path)), home)
    } catch { /* no history yet */ }
    const cloud = await searcher.recent().catch(() => ({ state: 'offline' as const, hits: [] }))
    return { local, cloud }
  })
  // Opens a result: file:// with the default app (or its folder), worksuite:// in WorkSuite Desktop when installed,
  // else in the module's app window via links/resolve.
  handle('ws:openSearchResult', async (link, where) => {
    const u = new URL(link)
    if (u.protocol === 'file:') {
      const p = decodeURIComponent(u.pathname)
      if (!existsSync(p)) return { ok: false, error: 'not_found' }
      if (where === 'location') shell.showItemInFolder(p); else await shell.openPath(p)
      return { ok: true }
    }
    if (u.protocol !== 'worksuite:') return { ok: false, error: 'invalid_argument' }
    const desktop = findWorkSuiteDesktop(installedApps())
    const prog = desktop && execProgram(desktop.exec)
    const c = desktop && prog ? scopeCommand(desktop.id, [prog, u.toString()]) : null
    if (c) { await run(...c); return { ok: true } }
    const s = await loadSession(brokerFn, (url, init) => fetch(url, { headers: init?.headers }))
    if (!s.ok) return s
    // "Search in WorkSuite" without WorkSuite Desktop: the web app's own search page.
    if (u.hostname === 'search') return apps.open('search', new URL(`search?q=${encodeURIComponent(u.searchParams.get('q') ?? '')}`, s.value.account.server_url.replace(/\/?$/, '/')).toString())
    const web = await resolveLink(s.value, u.toString(), (url, init) => fetch(url, { headers: init?.headers }))
    return web ? apps.open(u.hostname, web) : { ok: false, error: 'not_found' }
  })
  handle('ws:openLink', (url) => {
    if (!externalAllowed(url)) throw new Error('Scheme not allowed')
    return shell.openExternal(new URL(url).toString())
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
  // WSOS-SYN-004: rejected changes are shown against their record; retry only when the user asks.
  handle('ws:syncFailed', () => syncCall('ListFailed'))
  handle('ws:syncRetry', (mutationId) => syncCall('RetryFailed', { mutation_id: mutationId }))
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
    wgconf: { name: 'WireGuard configuration', extensions: ['conf'] }, ovpn: { name: 'OpenVPN configuration', extensions: ['ovpn', 'conf'] },
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
  // G14: .wsupdate bundles on mounted USB drives, behind the same opaque handles as a picked file.
  handle('ws:findBundles', () => {
    const found = findBundles(roots(files).filter((r) => r.id.startsWith('media:')))
    return { ok: true, value: found.map((f) => {
      const h = [...picked].find(([, p]) => p === f.path)?.[0] ?? `wsupdate:${picked.size + 1}:${Date.now()}`
      picked.set(h, f.path)
      return { handle: h, name: f.name, drive: f.drive }
    }) }
  })
  // VPN (WSOS-INT-001): list/connect/disconnect/remove, and import of a WireGuard .conf the user picked.
  handle('ws:sysVpn', () => sys.vpn())
  // OpenVPN user name/password arrive only with a Connect click and go to nmcli on stdin (system.ts).
  handle('ws:sysVpnConnect', (uuid, on, username, password) => sys.vpnConnect(uuid, on === 'on', username !== undefined && password !== undefined ? { username, password } : undefined))
  handle('ws:sysVpnRemove', (uuid) => sys.vpnRemove(uuid))
  handle('ws:sysVpnImport', (h) => {
    const p = pickedPath(h, 'wgconf')
    if (!p) return noFile
    try {
      if (statSync(p).size > 64 * 1024) return { ok: false, error: 'invalid_file' }
      return sys.vpnImport(path.basename(p), readFileSync(p, 'utf8'))
    } catch { return { ok: false, error: 'invalid_file' } }
  })
  // OpenVPN: certificates the .ovpn names must sit next to it (no '..' or absolute paths); they are copied into
  // the user's private VPN folder by system.ts.
  handle('ws:sysVpnImportOpenvpn', (h) => {
    const p = pickedPath(h, 'ovpn')
    if (!p) return noFile
    try {
      if (statSync(p).size > 256 * 1024) return { ok: false, error: 'invalid_file' }
      const dir = path.dirname(p)
      return sys.vpnImportOpenvpn(path.basename(p), readFileSync(p, 'utf8'), {
        readRef(rel) {
          const f = path.resolve(dir, rel)
          if (path.dirname(f) !== dir && !f.startsWith(dir + path.sep)) return null
          try { return statSync(f).isFile() && statSync(f).size <= 256 * 1024 ? readFileSync(f) : null } catch { return null }
        },
      })
    } catch { return { ok: false, error: 'invalid_file' } }
  })
  startPortalWatch(sys)
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
  // App detail (G09): this user's switches for single declared permissions (flatpak override --user).
  const fpPerms = flatpakPermsClient(realExec)
  handle('ws:appPermsUserOff', (id) => fpPerms.userOff(id))
  handle('ws:appPermSet', async (id, perm, on) => {
    const d = await pkg.appPermissions(id)
    if (!d.ok) return d
    return fpPerms.set(id, perm, on === 'on', (d.value as { permissions?: string[] }).permissions ?? [])
  })
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
  handle('ws:recoveryReinstall', (mode, confirm) => rec.reinstall(mode, confirm ?? ''))
  for (const ch of ['ws:recoverySnapshots', 'ws:recoveryRestore', 'ws:recoveryCopyToUsb', 'ws:recoveryTerminal', 'ws:recoverySaveReport']) handle(ch, () => rec.unavailable())
  // Files: real folders plus Drive sync states from the sync service.
  const files = defaultEnv(async (dir) => { const r = await syncCall('FileStates', { dir }); return r.ok && Array.isArray(r.value) ? r.value as { name: string; state: string }[] : null })
  handle('ws:filesRoots', () => ({ roots: roots(files).map(({ id, label }) => ({ id, label })), drive_exists: existsSync(driveDir(files.home)) }))
  handle('ws:filesList', (root, rel) => list(files, root, rel))
  handle('ws:filesOpen', async (root, rel) => {
    const p = resolveIn(files, root, rel)
    if (!p || !existsSync(p.full)) return { ok: false, error: 'not_found' }
    // Windows programs are never opened or run; the renderer shows why (WSOS-LCH-003).
    if (isWindowsProgram(p.full, fileHead(p.full))) return { ok: false, error: 'windows_program' }
    // Drive documents open in WorkSuite Office under the server file lock (WSOS-DRV-003, electron/officeLock.ts).
    const office = root === 'drive' && isOfficeDoc(p.full) ? findOffice(installedApps()) : null
    const prog = office ? execProgram(office.exec) : null
    if (office && prog) {
      const r = await openWithLock(rel, p.full, { syncCall, launch: (f) => { const c = scopeCommand(office.id, [prog, f]); return c ? launchAndWait(c) : Promise.resolve() } })
      return { ok: true, value: r.outcome }
    }
    const err = await shell.openPath(p.full)          // default app via XDG (WSOS-DSK-009)
    return err ? { ok: false, error: err } : { ok: true, value: true }
  })
  handle('ws:filesStatus', async (root) => {
    const r = roots(files).find((x) => x.id === root)
    const drive = root === 'drive' ? await syncCall('DriveSummary') : null
    return { free_bytes: r ? freeBytes(r.path) : null, drive: drive?.ok ? drive.value : null }
  })
  const strs = (json: string): string[] => { try { const v = JSON.parse(json); return Array.isArray(v) ? v.map(String) : [] } catch { return [] } }
  const fjobs = fileJobs(files, (e) => broadcast('ws:filesJob', e))
  handle('ws:filesPlaces', () => places(files))
  handle('ws:filesStarred', () => ({ keys: starred(files), hits: starredHits(files) }))
  handle('ws:filesStar', (root, rel, on) => setStar(files, root, rel, on === '1'))
  handle('ws:filesRecent', () => recent(files))
  handle('ws:filesSearch', (root, rel, q, kind, days) => search(files, root, rel, q, kind, Number(days) || 0))
  handle('ws:filesMkdir', (root, rel, name) => mkdirIn(files, root, rel, name))
  handle('ws:filesRename', (root, rel, name) => renameIn(files, root, rel, name))
  handle('ws:filesTrash', (root, rels) => trash(files, root, strs(rels)))
  handle('ws:filesTrashList', () => trashList(files))
  handle('ws:filesTrashRestore', (ids) => trashRestore(files, strs(ids)))
  handle('ws:filesTrashDelete', (ids) => trashDelete(files, ids === 'all' ? 'all' : strs(ids)))
  handle('ws:filesPaste', (op, srcRoot, rels, dstRoot, dstRel) => fjobs.start(op, srcRoot, strs(rels), dstRoot, dstRel))
  // Archives (electron/archives.ts): passwords arrive here only to go to 7z's stdin; they are never logged or sent back.
  const ajobs = archiveJobs(files, (e) => broadcast('ws:filesJob', e))
  handle('ws:filesResolve', (id, r, all) => (id.startsWith('arc') ? ajobs.resolve(id, r, all === '1') : fjobs.resolve(id, r, all === '1')))
  handle('ws:filesCompress', (root, rels, opts) => { try { return ajobs.compress(root, strs(rels), JSON.parse(opts)) } catch { return { ok: false, error: 'invalid' } } })
  handle('ws:filesExtract', (root, rel, mode, items, password) => ajobs.extract(root, rel, mode, strs(items), password || null))
  handle('ws:filesArchivePassword', (id, pw, cancel) => ajobs.password(id, cancel === '1' ? null : pw))
  handle('ws:filesArchiveList', (root, rel, password) => listIn(files, root, rel, password || null))
  handle('ws:filesEject', (id) => eject(files, id))
  followJobs((e) => broadcast(e.kind === 'update_status' ? 'ws:updateStatusChanged' : 'ws:pkgJob', e.kind === 'update_status' ? e.status : e))
  handle('ws:cloudAccounts', async () => {
    const r = await brokerCall('Status')
    return r.ok ? { ok: true, value: publicAccounts(r.value) } : r
  })
  followSessionLock((locked) => void brokerCall(locked ? 'Lock' : 'Unlock'))
  createWindow()
  // Settings › Display (WSOS-DSK-006): changes revert after 15 s unless kept; kept layouts are saved per monitor set
  // and re-applied at login and on hotplug, which also re-plans the per-monitor windows (DSK-005/007).
  const displays = displayManager({
    exec: realExec,
    storeFile: path.join(app.getPath('home'), '.config', 'worksuite', 'displays.json'),
    spawn: (cmd, args) => { const p = spawn(cmd, args, { stdio: 'ignore' }); p.on('error', () => undefined); return { kill: () => p.kill() } },
    onChange: (st: DisplayState) => { broadcast('ws:displaysChanged', st); monitors.sync(outputRects(st.layout)) },
  })
  handle('ws:displayState', () => displays.state())
  handle('ws:displayApply', (json) => {
    try { const p = JSON.parse(json); return displays.apply(arrange(p.layout, p.sides ?? {})) } catch { return { ok: false, error: 'bad_layout' } }
  })
  handle('ws:displayKeep', () => displays.confirm())
  handle('ws:displayRevert', () => displays.revert())
  handle('ws:displayWallpaper', (output, id) => displays.setWallpaper(output, id))
  void displays.applySaved()
  // Taskbar windows, tray and the Super key (lk.worksuite.Shell1) through the Wayland bridge.
  startPanel(handle, broadcast, () => void displays.applySaved(), (full) => {
    // An archive opened from elsewhere (worksuite-open-archive, the default handler): browse it in Files.
    const at = locate(files, full)
    if (at) { broadcast('ws:openArchive', at); win?.show(); win?.focus() }
  })
  // Default apps, clipboard history, problem report (WSOS-DSK-008/009, SES-005).
  startDesktopHost(handle, broadcast, app.getPath('home'), app.getVersion())
  // System monitor (G11) and quick settings brightness / power mode (G01).
  startMonitorHost(handle)
  // Bluetooth pairing, removable storage, power profiles, printers, input methods (WSOS-INT-003…006, 011).
  startPeripheralsHost(handle, app.getPath('home'))
  // The shell is the session's org.freedesktop.Notifications server (WSOS-INT-007).
  startNotifications(handle, broadcast)
  // Administrator prompts from the WorkSuite polkit agent (G05, WSOS-INT-010).
  startPolkitBridge(handle, broadcast)
})

app.on('window-all-closed', () => app.quit())
}


// ---------- captive portal (WSOS-INT-001) ----------
// NetworkManager's connectivity check (conf.d/20-worksuite-connectivity.conf) says `portal`: notify and open a
// "Sign in to network" window. That window is fully sandboxed in its own in-memory partition (no "persist:" prefix,
// so nothing is written to disk and nothing is shared with the shell or WorkSuite app sessions), has no preload and
// no Node, allows only http(s) navigation, denies permissions, pop-ups and downloads, and closes itself once
// connectivity is `full`. With the managed VPN kill switch loaded the portal is unreachable by design; the shell says
// so instead of opening a hole (docs/networking.md).
function startPortalWatch(sys: ReturnType<typeof systemBridge>) {
  let state: PortalState = initialPortalState
  let portalWin: BrowserWindow | null = null
  const notify = (title: string, body: string, onClick?: () => void) => {
    if (!Notification.isSupported()) return
    const n = new Notification({ title, body })
    if (onClick) n.on('click', onClick)
    n.show()
  }
  const apply = (actions: PortalAction[]) => {
    for (const a of actions) {
      if (a === 'notify_portal') notify('Sign in to network', 'This network needs you to sign in before you can use the internet.', () => dispatch('user_opened'))
      else if (a === 'notify_blocked_by_killswitch') notify('Network sign-in blocked', 'This network needs a sign-in page, but your organization\'s VPN kill switch blocks all traffic outside the VPN. Use another network or contact your IT team.')
      else if (a === 'notify_signed_in') notify('Connected', 'You are signed in to the network.')
      else if (a === 'open_window') openPortal()
      else if (a === 'close_window') { const w = portalWin; portalWin = null; w?.close() }
    }
  }
  const dispatch = (ev: Parameters<typeof portalStep>[1]) => { const r = portalStep(state, ev); state = r.state; apply(r.actions) }
  const openPortal = () => {
    if (portalWin) { portalWin.focus(); return }
    const partition = `ws-portal-${Date.now()}`   // ephemeral: in-memory, discarded with the window
    const ses = session.fromPartition(partition, { cache: false })
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    ses.setPermissionCheckHandler(() => false)
    ses.on('will-download', (e) => e.preventDefault())
    const w = new BrowserWindow({
      title: 'Sign in to network', width: 900, height: 700, backgroundColor: '#ffffff', autoHideMenuBar: true,
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false, webSecurity: true, spellcheck: false },
    })
    const guard = (e: { preventDefault(): void }, url: string) => { if (!portalNavAllowed(url)) e.preventDefault() }
    w.webContents.on('will-navigate', guard)
    w.webContents.on('will-redirect', guard)
    w.webContents.on('will-attach-webview', (e) => e.preventDefault())
    // Pop-ups (some portals open terms in a new window) load in the same window instead, if allowed.
    w.webContents.setWindowOpenHandler(({ url }) => { if (portalNavAllowed(url)) void w.loadURL(url); return { action: 'deny' } })
    w.on('closed', () => { if (portalWin === w) { portalWin = null; dispatch('user_closed') } void ses.clearStorageData() })
    portalWin = w
    void w.loadURL(CONNECTIVITY_CHECK_URL)   // the portal intercepts the check URL and redirects to its sign-in page
  }
  const poll = async () => {
    const r = await sys.connectivity()
    if (r.available) dispatch({ connectivity: r.value, killSwitch: existsSync(KILLSWITCH_MARKER) })
  }
  void poll()
  setInterval(() => void poll(), 15_000).unref?.()
}
