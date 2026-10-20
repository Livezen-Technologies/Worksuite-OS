import { findBundles } from './bundles'
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, Notification, powerMonitor, session, shell, type IpcMainInvokeEvent } from 'electron'

// Drag image for files dragged out of Files (startDrag needs one): a small document glyph.
const DRAG_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIklEQVR4nGNgoCaQz/7/nxiM1wBCYNSAUQNGigEUZSZyAAAnXe3wcJ4r8wAAAABJRU5ErkJggg=='
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { appWebPreferences, appWindows } from './appwindows'
import { bootMode } from './bootmode'
import { appLaunchCommand, scopeCommand, lockPaths, logoutCommand, readLockSettings, writeLockTimeout } from './session'
import { brokerCall, followSessionLock, publicAccounts, syncCall } from './broker'
import { deviceCredential, deviceInfo, enrollDevice, STATUS_PATH } from './device'
import { appimageClient, flatpakUserClient, followJobs, packageClient } from './packages'
import { listDevices } from './hardware'
import { checkOwnPassword, localUsers } from './users'
import { ask, signinHost, type SignInMethod } from './signin'
import { recoveryHost } from './recovery'
import { prepareAppMode, runAppMode } from './appwindow'
import { prepareWhatsApp, runWhatsApp } from './whatsappwindow'
import { WHATSAPP_ID } from './whatsapp'
import { shellPrefsFrom } from '../src/lib/shellPrefs'
import { launcherApps, loadSession, parseAppArgs, resolveLink } from './webapps'
import { createSearch, localRecentHits, parseXbel } from './search'
import { createWidgets } from './widgets'
import { DESKTOP_MODULES, execProgram, findOffice, findWorkSuiteDesktop, installedApps, OFFICE_NEW } from './xdg'
import { systemBridge, AGENT_POLICY_PATH } from './system'
import { applyFix, diagnose, diagnosisText, type RadioFix, type RadioKind } from './radios'
import { accelerationPlan, graphicsState, noteGpuCrash, readCrashLog, readRendererChoice, resetGpuFallback, setRenderer } from './graphics'
import { CONNECTIVITY_CHECK_URL, initialPortalState, KILLSWITCH_MARKER, portalNavAllowed, portalStep, type PortalAction, type PortalState } from './connectivity'
import { archiveJobs, listIn, locate } from './archives'
import { startAIHost } from './ai'
import { defaultEnv, driveDir, dropPlan, freeBytes, list, resolveIn, roots } from './files'
import { eject, jobs as fileJobs, desktopDir, mkdirIn, newFileIn, places, recent, removeIn, renameIn, search, setStar, starred, starredHits, templates, trash, trashDelete, trashList, trashRestore } from './fileops'
import { startPanel, type PanelHooks } from './panelHost'
import { startActivity } from './activityHost'
import { startSecurity } from './securityCenter'
import { captureHost, imageData, runBytes, screenshotFileName, screenshotsDir, wlCopyImage, type CaptureKind, type SnipMode } from './capture'
import { clipboardAllowed } from './clipboard'
import { applyShortcuts } from './shortcutsHost'
import { applyWindowTheme } from './windowTheme'
import { APP_WINDOW } from './windowDefaults'
import { ACTIVATED_FLAG, FULLSCREEN_FLAG } from './panel'
import { arrange, displayManager, outputRects, type DisplayState } from './displays'
import type { Layout } from './displays'
import { outputWindows } from './outputWindows'
import { realExec } from './system'
import { collectReport, finalReport, reportText, sendReport, type ProblemReport } from './problemReport'
import { startDesktopHost } from './desktopHost'
import { powerArgs, startSessionHost } from './sessionHost'
import { bannerAllowed, toastHost, type ToastMsg } from './toastHost'
import { markShellReady, startMonitorHost } from './monitorHost'
import { flatpakPermsClient } from './flatpakPerms'
import { startPeripheralsHost } from './peripherals'
import { startRemoteSupportHost } from './remoteSupport'
import { appPermissionsBridge, startAppPermissionsHost } from './appPermissions'
import { startTouchHost } from './touch'
import { startPointerHost } from './pointer'
import { startSysWatch } from './sysWatch'
import { startNotifications, windowForNotification } from './notifications'
import { isOfficeDoc, launchAndWait, openWithLock } from './officeLock'
import { startPolkitBridge } from './polkit'
import { fileHead, isWindowsProgram } from './winexe'
import { externalAllowed, loadGrants, permissionAllowed, shellWebPreferences } from './webSecurity'
import { xdgDirs } from './xdgDirs'
import { IconCache } from './icons'

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
  const w = new BrowserWindow({ x: r.x, y: r.y, width: r.width, height: r.height, fullscreen: true, frame: false, title: `WorkSuite desktop ${r.name}`, backgroundColor: '#040A1A', webPreferences: shellPrefs() })
  const wc = w.webContents
  shellContents.add(wc)
  w.on('closed', () => { shellContents.delete(wc); monitors.forget(r.name) })
  wc.on('will-navigate', (e) => e.preventDefault())
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  void w.loadFile(path.join(__dirname, '../dist/index.html'), { query: { mode: 'output', output: r.name } })
  return w
}, () => win)

const appIcons = new IconCache()
const parseJson = (s: string): unknown => { try { return JSON.parse(s) } catch { return null } }

/** The checked sender of the IPC call being handled (read synchronously in a handler, e.g. ws:edit). */
let ipcSender: Electron.WebContents | null = null
function handle(channel: string, fn: (...args: string[]) => unknown) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!validSender(e)) throw new Error('Rejected IPC sender')
    ipcSender = e.sender
    try { return fn(...args.map(String)) } finally { ipcSender = null }
  })
}

function run(cmd: string, args: string[]) {
  // Fixed argument arrays, never a shell (WSOS-LCH-001).
  return new Promise<void>((resolve) => execFile(cmd, args, () => resolve()))
}

/** $XDG_RUNTIME_DIR/worksuite/shell-ready: services/session/greeter/worksuite_greeter/veil.py session_main. */
function markSessionVeil() {
  const run = process.env.XDG_RUNTIME_DIR
  if (!run) return
  try { mkdirSync(path.join(run, 'worksuite'), { recursive: true, mode: 0o700 }); writeFileSync(path.join(run, 'worksuite', 'shell-ready'), `${process.pid}\n`) } catch { /* no veil to tell */ }
}

function createWindow() {
  win = new BrowserWindow({
    fullscreen: true,
    // See-through, so Start, the notification centre, quick settings and the shell's windows float over the app below
    // while the shell is lifted (src/screens/Desktop.tsx draws the wallpaper only when it is the desktop). The page
    // itself starts in the greeter veil's colour (index.css), so signing in still fades through dark.
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: shellPrefs(),
  })
  shellContents.add(win.webContents)
  // Perf probe (tests/perf/guest/measure-shell, WSOS-PRF-002/006): process start → first window ready.
  if (process.env.WORKSUITE_PERF === '1') win.once('ready-to-show', () => process.stdout.write(`WORKSUITE_PERF shell_ready_ms ${Math.round(process.uptime() * 1000)}\n`))
  win.once('ready-to-show', () => markShellReady(Math.round(process.uptime() * 1000)))
  // The session veil (worksuite-session-veil, over Labwc from the session's start) leaves once the renderer has drawn
  // its first screen (ws:firstFrame, src/main.tsx); ready-to-show is only the empty page. A renderer that never says so
  // still lets it go a little after its page showed.
  win.once('ready-to-show', () => setTimeout(markSessionVeil, 5000))
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
// #16: GPU compositing, rasterization and VA-API video in the shell and every WorkSuite app window, or software
// rendering when the session has no usable GPU or the GPU process kept crashing (graphics.ts).
const accel = accelerationPlan(process.env, readCrashLog(), readRendererChoice())
if (accel.disable) app.disableHardwareAcceleration()
for (const [k, v] of accel.switches) app.commandLine.appendSwitch(k, v)
app.on('child-process-gone', (_e, d) => {
  if (d.type === 'GPU' && d.reason !== 'clean-exit' && d.reason !== 'killed') noteGpuCrash()
})
// `worksuite-app <module>` starts the same binary as a WorkSuite app window instead of the shell.
const appRequest = parseAppArgs(process.argv)
if (appRequest?.id === WHATSAPP_ID) {
  // WhatsApp Web: its own window, partition and app_id; no WorkSuite account involved (whatsappwindow.ts).
  if (prepareWhatsApp()) runWhatsApp()
  else app.quit()
} else if (appRequest) {
  if (prepareAppMode(appRequest)) runAppMode(appRequest)
  else app.quit()
} else startShell()

/** The shell's Wayland app_id is Electron's default, "worksuite-shell" (package.json name): Labwc's window rule
 *  (services/session/labwc/rc.xml) keeps it always on bottom by that id: below every app, and on every desktop. */
export const SHELL_APP_ID = 'worksuite-shell'
function startShell() {
app.whenReady().then(() => {
  // Web permissions denied by default; the shell's own session never gets any (WSOS-SEC-003).
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  // Administrator grants for exact HTTPS origins of WorkSuite apps (/etc/worksuite/web-permissions.json).
  const webGrants = loadGrants()

  // Sign-in is greetd/PAM's; the shell only re-checks the signed-in user's own password to unlock its lock screen.
  handle('ws:authenticate', async (user, secret, method) => {
    if (method === 'pin') {
      const r = await ask({ op: 'verify', user: os.userInfo().username, pin: secret })
      return r.ok ? { ok: true } : { ok: false }
    }
    if (method === 'key') return { ok: false, message: 'Use your password.' }
    return checkOwnPassword(user, secret)
  })
  // true = the system locker (swayidle → worksuite-lock → gtklock) has the screen; the shell then shows no lock board.
  handle('ws:lock', async () => {
    await brokerCall('Lock')
    return new Promise<boolean>((resolve) => execFile('loginctl', ['lock-session'], (err) => resolve(!err)))
  })
  handle('ws:logout', () => run(...logoutCommand()))
  handle('ws:power', (action) => {
    const args = powerArgs(String(action), false)
    return args ? run('systemctl', args) : undefined
  })
  // WorkSuite web apps: one window and one persistent session partition per app (WSOS-SEC-004).
  const apps = appWindows({
    session: (p) => session.fromPartition(p),
    window: ({ partition, title }) => new BrowserWindow({ ...APP_WINDOW, title, backgroundColor: '#0f172a', webPreferences: appWebPreferences(partition) }),
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
    // Cached per account in the user's cache dir so the launcher keeps the org's list offline (WSOS-DSK-001).
    const file = path.join(app.getPath('home'), '.cache', 'worksuite', 'launcher-apps.json')
    return launcherApps((m, p) => brokerCall(m, p ?? {}), (url, init) => fetch(url, { headers: init?.headers }), {
      read: () => (existsSync(file) ? readFileSync(file, 'utf8') : null),
      write: (text) => { mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, text, { mode: 0o600 }) },
    })
  })
  // App icons (Icon= of desktop entries) as data: URLs, from icon directories only (electron/icons.ts).
  handle('ws:appIcons', (names, size, scale) => appIcons.resolve(parseJson(names), size, scale))
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
  // Desktop widgets (WorkSuite Desktop's Home on the wallpaper): the same token path as search; the renderer gets
  // parsed data only. Cached per account (hashed id) under ~/.cache/worksuite/widgets for offline use; policy
  // desktop_widgets: false, or a kiosk device, turns them off here too, so no request is made.
  const widgetDir = path.join(app.getPath('home'), '.cache', 'worksuite', 'widgets')
  const widgetFile = (id: string) => path.join(widgetDir, `${createHash('sha256').update(id).digest('hex').slice(0, 32)}.json`)
  const widgets = createWidgets({
    broker: brokerFn, device: () => deviceCredential(), fetch: (url, init) => fetch(url, { headers: init.headers, signal: init.signal }),
    enabled: () => { const p = deviceInfo().policies as { desktop_widgets?: boolean | null; kiosk?: boolean } | null; return p?.desktop_widgets !== false && p?.kiosk !== true },
    cache: {
      read: (id) => { try { return JSON.parse(readFileSync(widgetFile(id), 'utf8')) } catch { return null } },
      write: (id, snap) => { try { mkdirSync(widgetDir, { recursive: true, mode: 0o700 }); writeFileSync(widgetFile(id), JSON.stringify(snap), { mode: 0o600 }) } catch { /* a convenience */ } },
      clear: () => { try { rmSync(widgetDir, { recursive: true, force: true }) } catch { /* nothing cached */ } },
    },
  })
  handle('ws:widgets', () => widgets.load())
  handle('ws:recentFiles', async () => {
    const home = app.getPath('home')
    let local: ReturnType<typeof localRecentHits> = []
    try {
      const xbel = path.join(xdgDirs(home).data, 'recently-used.xbel')
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
  // "Cancel" or "Try again" while the browser is open: the broker ends the waiting sign-in (sign_in_cancelled).
  handle('ws:cloudSignInCancel', () => brokerCall('CancelSignIn'))
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
  // Shell ENH-01 preferences (favourites, taskbar pins, order): the user's synced 'preferences/shell' object.
  handle('ws:shellPrefs', () => syncCall('GetPreference', { object_id: 'shell' }))
  // The preferences come as JSON text (handle() passes strings only).
  handle('ws:setShellPrefs', (prefs) => syncCall('SetPreference', { object_id: 'shell', data: shellPrefsFrom(parseJson(prefs)) }))
  // WSOS-SYN-004: rejected changes are shown against their record; retry only when the user asks.
  handle('ws:syncFailed', () => syncCall('ListFailed'))
  handle('ws:syncRetry', (mutationId) => syncCall('RetryFailed', { mutation_id: mutationId }))
  handle('ws:deviceInfo', () => deviceInfo())
  handle('ws:firstFrame', () => { markSessionVeil(); return true })
  // Settings → NetworkManager, BlueZ, PipeWire, UPower, CUPS, wlr-randr, UDisks2 (WSOS-INT-001…006, DSK-006).
  const sys = systemBridge()
  handle('ws:sysNetwork', () => sys.network())
  handle('ws:sysSetWifi', (on) => sys.setWifi(on === 'on'))
  handle('ws:sysWifiConnect', (ssid, password) => sys.wifiConnect(ssid, password))
  handle('ws:sysBluetooth', () => sys.bluetooth())
  handle('ws:sysSetBluetooth', (on) => sys.setBluetooth(on === 'on'))
  handle('ws:sysBtConnect', (address, on) => sys.btConnect(address, on === 'on'))
  handle('ws:sysWifiRescan', () => sys.wifiRescan())
  handle('ws:sysWifiDisconnect', () => sys.wifiDisconnect())
  // #31: why Wi-Fi or Bluetooth doesn't work, and the fixes a person can apply (radios.ts).
  const radioKind = (k: string): RadioKind | null => (k === 'wifi' || k === 'bluetooth' ? k : null)
  handle('ws:radioDiagnose', async (kind) => {
    const k = radioKind(kind)
    if (!k) return { ok: false, error: 'invalid_argument' }
    const d = await diagnose(k, { exec: realExec })
    return { ok: true, value: { ...d, text: diagnosisText(d) } }
  })
  handle('ws:radioFix', (kind, fix) => {
    const k = radioKind(kind)
    if (!k || (fix !== 'unblock' && fix !== 'restart_service')) return { ok: false, error: 'invalid_argument' }
    return applyFix(k, fix as RadioFix, realExec)
  })
  // #16: Settings › Graphics.
  handle('ws:graphics', async () => ({ ok: true, value: await graphicsState({ exec: realExec, plan: accel, featureStatus: () => app.getGPUFeatureStatus() as unknown as Record<string, string>, gpuInfo: () => app.getGPUInfo('complete') }) }))
  handle('ws:graphicsSetRenderer', (choice) => setRenderer(choice))
  handle('ws:graphicsReset', () => resetGpuFallback())
  handle('ws:sysSound', () => sys.sound())
  handle('ws:sysSetVolume', (p) => sys.setVolume(Number(p)))
  handle('ws:sysSetMute', (on) => sys.setMute(on === 'on'))
  handle('ws:sysSetDefaultAudio', (id) => sys.setDefaultAudio(Number(id)))
  handle('ws:sysBattery', () => sys.battery())
  // The taskbar's Wi-Fi, Bluetooth and power indicators update when the services signal a change (#28).
  void startSysWatch(broadcast)
  // After sleep the AC and Wi-Fi may have changed while no signal could arrive (#43): re-read everything on wake.
  powerMonitor.on('resume', () => { for (const k of ['battery', 'network', 'bluetooth']) broadcast('ws:sysChanged', k) })
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
  // Settings › Drivers: the package service's driver report (hardware scan, online search) and installs (polkit).
  handle('ws:hwDriverReport', (check) => pkg.driverReport(check === 'check'))
  handle('ws:hwMokPassword', () => pkg.mokPassword())
  handle('ws:hwInstallDrivers', (...ids) => pkg.installDrivers(ids.map(String)))
  handle('ws:sysUsers', () => localUsers())
  // Settings › Users › Sign-in options. Every change runs worksuite-signin through pkexec; the PIN goes on stdin.
  const signin = signinHost()
  handle('ws:signinMethods', () => signin.methods())
  handle('ws:signinPinSet', (pin) => signin.pinSet(pin))
  handle('ws:signinPinRemove', () => signin.pinRemove())
  handle('ws:signinKeyAdd', (name) => signin.keyAdd(name))
  handle('ws:signinKeyRemove', (id) => signin.keyRemove(id))
  handle('ws:signinSetDefault', (m) => ['password', 'pin', 'key'].includes(m) ? signin.setDefault(m as SignInMethod) : { ok: false, error: 'bad_method' })
  handle('ws:pkgRepair', () => pkg.repair())
  handle('ws:pkgState', () => pkg.serviceState())
  handle('ws:pkgCatalog', () => pkg.catalog())
  handle('ws:pkgRequestApp', (catalogId, reason) => pkg.requestApp(String(catalogId), String(reason ?? '')))
  handle('ws:updateHistory', () => pkg.updateHistory())
  handle('ws:appUpdates', () => pkg.appUpdates())
  handle('ws:updateApps', (...ids) => pkg.updateApps(ids.map(String)))
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
  // §11.6-d Report a problem: collected only when asked, reviewed by the person, then saved or sent.
  const reports = new Map<string, ProblemReport>()
  handle('ws:reportCollect', async () => {
    const r = await collectReport({ exec: realExec, readFile: (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }, home: app.getPath('home') })
    reports.clear(); reports.set(r.id, r)
    return { ok: true, value: r }
  })
  const finalOf = (id: string, keep: string, desc: string) => { const r = reports.get(id); return r ? finalReport(r, keep.split(',').filter(Boolean), desc) : null }
  handle('ws:reportSave', async (id, keep, desc) => {
    const f = finalOf(id, keep, desc)
    if (!f || !win) return { ok: false, error: 'invalid_argument' }
    const d = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), `worksuite-problem-report-${f.created_at.slice(0, 10)}.txt`) })
    if (d.canceled || !d.filePath) return { ok: false, error: 'cancelled' }
    try { writeFileSync(d.filePath, reportText(f), { mode: 0o600 }) } catch { return { ok: false, error: 'failed' } }
    return { ok: true, value: d.filePath }
  })
  handle('ws:reportSend', async (id, keep, desc) => {
    const f = finalOf(id, keep, desc)
    if (!f) return { ok: false, error: 'invalid_argument' }
    const s = await loadSession(brokerFn, (url, init) => fetch(url, { headers: init?.headers }), () => deviceCredential())
    const r = await sendReport(f, s.ok ? s.value : null, (url, init) => fetch(url, init), deviceCredential())
    return r.ok ? { ok: true, value: f.id } : (!s.ok && s.error !== 'not_signed_in' ? { ok: false, error: s.error } : r)
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
  // On-device AI assistant (services/ai): Settings › AI, the assistant panel and its context actions.
  startAIHost(handle, broadcast, files, { readClipboard: () => clipboard.readText() })
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
  // Desktop right-click menu (#27): the XDG Desktop folder, "New" from ~/Templates, new empty files.
  handle('ws:desktopDir', () => desktopDir(files))
  handle('ws:filesTemplates', () => templates(files))
  handle('ws:filesNewFile', (root, rel, name, template) => newFileIn(files, root, rel, name, template ? template : null))
  handle('ws:filesRename', (root, rel, name) => renameIn(files, root, rel, name))
  handle('ws:filesTrash', (root, rels) => trash(files, root, strs(rels)))
  handle('ws:filesDelete', (root, rels) => removeIn(files, root, strs(rels)))
  handle('ws:filesTrashList', () => trashList(files))
  handle('ws:filesTrashRestore', (ids) => trashRestore(files, strs(ids)))
  handle('ws:filesTrashDelete', (ids) => trashDelete(files, ids === 'all' ? 'all' : strs(ids)))
  // Drag and drop with other apps (WSOS-DSK-013): dropped paths inside the user's places are copied here by the
  // same jobs as paste; dragging files out hands real file paths to the compositor (text/uri-list for the target).
  handle('ws:filesDrop', (paths, dstRoot, dstRel) => {
    const plan = dropPlan(files, strs(paths))
    const jobs = plan.groups.map((g) => fjobs.start('copy', g.root, g.rels, dstRoot, dstRel)).filter((r) => r.ok).length
    return { ok: true, value: { jobs, rejected: plan.rejected } }
  })
  handle('ws:filesStartDrag', (root, rels) => {
    const paths = strs(rels).slice(0, 500).map((r) => resolveIn(files, root, r)?.full).filter((p): p is string => !!p && existsSync(p))
    const wc = [...shellContents].find((c) => !c.isDestroyed() && c.isFocused())
    if (!paths.length || !wc) return { ok: false, error: 'not_found' }
    wc.startDrag({ file: paths[0], files: paths, icon: nativeImage.createFromDataURL(DRAG_ICON) })
    return { ok: true, value: paths.length }
  })
  handle('ws:filesPaste', (op, srcRoot, rels, dstRoot, dstRel) => fjobs.start(op, srcRoot, strs(rels), dstRoot, dstRel))
  // Archives (electron/archives.ts): passwords arrive here only to go to 7z's stdin; they are never logged or sent back.
  const ajobs = archiveJobs(files, (e) => broadcast('ws:filesJob', e))
  handle('ws:filesResolve', (id, r, all) => (id.startsWith('arc') ? ajobs.resolve(id, r, all === '1') : fjobs.resolve(id, r, all === '1')))
  handle('ws:filesCompress', (root, rels, opts) => { try { return ajobs.compress(root, strs(rels), JSON.parse(opts)) } catch { return { ok: false, error: 'invalid' } } })
  handle('ws:filesExtract', (root, rel, mode, items, password) => ajobs.extract(root, rel, mode, strs(items), password || null))
  handle('ws:filesArchivePassword', (id, pw, cancel) => ajobs.password(id, cancel === '1' ? null : pw))
  handle('ws:filesArchiveList', (root, rel, password) => listIn(files, root, rel, password || null))
  handle('ws:filesEject', (id) => eject(files, id))
  followJobs((e) => broadcast(e.kind === 'update_status' ? 'ws:updateStatusChanged' : e.kind === 'drivers' ? 'ws:driversChanged' : 'ws:pkgJob', e.kind === 'update_status' || e.kind === 'drivers' ? e.status : e))
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
    storeFile: path.join(xdgDirs(app.getPath('home')).config, 'worksuite', 'displays.json'),
    spawn: (cmd, args) => { const p = spawn(cmd, args, { stdio: 'ignore' }); p.on('error', () => undefined); return { kill: () => p.kill() } },
    onChange: (st: DisplayState) => { layout = st.layout; broadcast('ws:displaysChanged', st); monitors.sync(outputRects(st.layout)) },
  })
  let layout: Layout | null = null
  void displays.state().then((r) => { if (r.ok && !layout) layout = r.value.layout })
  handle('ws:displayState', () => displays.state())
  handle('ws:displayApply', (json) => {
    try { const p = JSON.parse(json); return displays.apply(arrange(p.layout, p.sides ?? {})) } catch { return { ok: false, error: 'bad_layout' } }
  })
  handle('ws:displayKeep', () => displays.confirm())
  handle('ws:displayRevert', () => displays.revert())
  handle('ws:displayWallpaper', (output, id) => displays.setWallpaper(output, id))
  void displays.applySaved()
  // Taskbar windows, tray and the Super key (lk.worksuite.Shell1) through the Wayland bridge.
  const hooks: PanelHooks = {}
  const panelClient = startPanel(handle, broadcast, () => void displays.applySaved(), (full) => {
    // An archive opened from elsewhere (worksuite-open-archive, the default handler): browse it in Files.
    const at = locate(files, full)
    if (at) { broadcast('ws:openArchive', at); win?.show(); win?.focus() }
  }, hooks)
  const home = app.getPath('home')
  const policies = () => deviceInfo().policies as { screen_capture?: string | null; clipboard_history?: string | null; kiosk?: boolean } | null
  // The app window with the focus (not the shell's): where Super+V pastes, and whose copies the deny list checks.
  const focusedWindow = () => panelClient?.windows.find((w) => w.flags & ACTIVATED_FLAG && !['worksuite-shell', 'worksuite', 'electron'].includes(w.appId.toLowerCase())) ?? null
  // Default apps, clipboard history, problem report (WSOS-DSK-008/009, SES-005).
  startDesktopHost(handle, broadcast, home, app.getVersion(), {
    focusedApp: () => focusedWindow()?.appId ?? null,
    allowed: () => clipboardAllowed(policies()),
    preview: (data) => { try { const img = nativeImage.createFromBuffer(data); if (img.isEmpty()) return null; const s = img.getSize(); return (s.width > 360 || s.height > 240 ? img.resize(s.width / 360 > s.height / 240 ? { width: 360 } : { height: 240 }) : img).toDataURL() } catch { return null } },
    activate: (h) => panelClient?.activate(h) ?? Promise.resolve(),
  })
  // Screenshots and the snipping tool (electron/capture.ts): Shell1.Capture from the Print/Super+Shift+S bindings.
  const capture = captureHost({
    run: runBytes, copy: (png) => wlCopyImage(png), policies, broadcast,
    outputs: () => (layout ? outputRects(layout).map(({ name, x, y, width, height }) => ({ name, x, y, width, height })) : []),
    lift: (on) => hooks.lift?.('snip', on),
    dir: () => screenshotsDir(process.env, home),
    settingsFile: path.join(xdgDirs(home).config, 'worksuite', 'capture.json'),
  })
  hooks.capture = (k) => void capture.request(k as CaptureKind)
  // Open(what) from the key bindings: shell surfaces, or an app (custom shortcuts, Ctrl+Alt+T) in its own scope.
  // Super+V, Super+. and Super+/ show over a capture of the screen, so they look like they float over the app.
  hooks.open = (what) => void (async () => {
    if (what.startsWith('app:')) { const c = appLaunchCommand(what.slice(4)); if (c) await run(...c); return }
    const previous = focusedWindow()?.handle ?? ''
    let backdrop: string | null = null
    if (['clipboard', 'emoji', 'shortcuts'].includes(what) && capture.allowed()) {
      const primary = layout?.primary
      const jpg = await runBytes('grim', [...(primary && /^[A-Za-z0-9._-]{1,64}$/.test(primary) ? ['-o', primary] : []), '-t', 'jpeg', '-q', '80', '-'])
      if (jpg) backdrop = `data:image/jpeg;base64,${jpg.toString('base64')}`
    }
    broadcast('ws:shellOpen', { what, previous, backdrop })
  })()
  handle('ws:captureAllowed', () => capture.allowed())
  handle('ws:captureSettings', () => capture.settings())
  handle('ws:captureSetSettings', (json) => capture.setSettings((parseJson(json) ?? {}) as object))
  handle('ws:capture', (kind) => (['print', 'save', 'window', 'snip'].includes(kind) ? capture.request(kind as CaptureKind) : false))
  handle('ws:snipStart', (mode, delay) => capture.start(mode as SnipMode, Number(delay) || 0))
  handle('ws:snipFrame', (id, output) => capture.frame(Number(id), output))
  handle('ws:snipDone', (id, dataUrl) => capture.done(Number(id), dataUrl))
  handle('ws:snipCancel', (id) => capture.cancel(Number(id)))
  handle('ws:snipImage', (id) => capture.image(Number(id) || 0))
  handle('ws:snipCopy', (dataUrl) => capture.copyImage(dataUrl))
  // Save as: the person picks the place (default Pictures/Screenshots) and PNG or JPEG; nothing is written elsewhere.
  handle('ws:snipSave', async (dataUrl) => {
    const img = imageData(dataUrl)
    if (!img || !win) return { ok: false, error: 'invalid_argument' }
    const dir = screenshotsDir(process.env, home)
    try { mkdirSync(dir, { recursive: true }) } catch { /* the dialog still opens */ }
    const d = await dialog.showSaveDialog(win, { defaultPath: path.join(dir, screenshotFileName(new Date(), img.ext)), filters: [img.ext === 'png' ? { name: 'PNG', extensions: ['png'] } : { name: 'JPEG', extensions: ['jpg', 'jpeg'] }] })
    if (d.canceled || !d.filePath) return { ok: false, error: 'cancelled' }
    try { writeFileSync(d.filePath, img.data, { mode: 0o644 }) } catch { return { ok: false, error: 'failed' } }
    return { ok: true, value: d.filePath }
  })
  // "Show in Files": the saved file's folder in the shell's own Files, when it is in the home folder.
  handle('ws:snipReveal', (file) => {
    const rel = path.relative(home, path.dirname(path.resolve(file)))
    return rel.startsWith('..') || path.isAbsolute(rel) ? null : { root: 'home', rel, name: path.basename(file) }
  })
  // Settings › Keyboard › Shortcuts: the user's block in their Labwc rc.xml; also applied at start from the synced
  // preferences, so shortcuts follow the person to another computer.
  const shortcutFiles = { userRc: path.join(xdgDirs(home).config, 'worksuite', 'labwc', 'rc.xml'), systemRc: '/etc/xdg/worksuite/labwc/rc.xml' }
  handle('ws:shortcutsApply', (json) => applyShortcuts(parseJson(json), shortcutFiles, realExec))
  // Settings › Appearance: the Labwc title bar theme (light or dark) in the same file.
  handle('ws:windowTheme', (dark) => applyWindowTheme(dark === 'dark', shortcutFiles, realExec))
  setTimeout(() => void syncCall('GetPreference', { object_id: 'shell' }).then((r) => {
    const sc = r.ok ? (r.value as { shortcuts?: unknown } | null)?.shortcuts : undefined
    if (sc) void applyShortcuts(sc, shortcutFiles, realExec)
  }).catch(() => undefined), 3000).unref?.()
  // Edit commands for the shell's own text fields (right-click menu): the focused field of the asking window.
  handle('ws:edit', (cmd) => {
    const wc = ipcSender
    if (!wc) return false
    const fn = ({ cut: () => wc.cut(), copy: () => wc.copy(), paste: () => wc.paste(), selectAll: () => wc.selectAll(), undo: () => wc.undo(), redo: () => wc.redo() } as Record<string, () => void>)[String(cmd)]
    fn?.()
    return !!fn
  })
  // Shutdown/restart/sign-out overlay on every display, inhibitors, crashed apps, administrators' diagnostics.
  startSessionHost(handle, broadcast, {
    apps: () => installedApps(), user: os.userInfo().username, readGroup: () => readFileSync('/etc/group', 'utf8'),
    launch: (id) => { const c = appLaunchCommand(id); return c ? run(...c) : undefined },
  })
  // System monitor (G11) and quick settings brightness / power mode (G01).
  startMonitorHost(handle)
  // Bluetooth pairing, removable storage, power profiles, printers, input methods (WSOS-INT-003…006, 011).
  startPeripheralsHost(handle, app.getPath('home'))
  startRemoteSupportHost(handle, undefined, {
    exec: realExec, credential: () => deviceCredential(),
    serverBase: () => { try { const h = JSON.parse(readFileSync(STATUS_PATH, 'utf8'))?.server; return typeof h === 'string' && /^[A-Za-z0-9.:[\]-]+$/.test(h) ? `https://${h}/` : null } catch { return null } },
  })
  startAppPermissionsHost(handle, appPermissionsBridge({
    exec: realExec,
    readPolicy: () => { try { return readFileSync(AGENT_POLICY_PATH, 'utf8') } catch { return null } },
    stateDir: path.join(app.getPath('home'), '.local/state/worksuite/permissions'),
  }))
  startTouchHost(handle, broadcast, app.getPath('home'))
  // Settings › Mouse & touchpad (#35): Labwc libinput block, applied live with labwc --reconfigure.
  startPointerHost(handle, app.getPath('home'))
  // The shell is the session's org.freedesktop.Notifications server (WSOS-INT-007).
  // Clicking one (its "default" action) also raises the sender's window through the bridge, whatever the app does.
  const notices = startNotifications(handle, broadcast, (n) => {
    if (n.app === DRIVERS_APP) { broadcast('ws:openSettings', 'Drivers'); return }
    const w = panelClient && windowForNotification(n, panelClient.windows, installedApps())
    if (w) void panelClient.activate(w.handle)
  })
  // Toasts over the apps (worksuite-toasts, a layer-shell overlay surface): the renderer hands its toast here when the
  // helper runs. Clicking an app notification's toast takes its default action, which focuses the sender's window.
  const toasts = toastHost((key) => {
    const m = /^app-(\d+)$/.exec(key)
    if (m) notices.invoke(Number(m[1]), 'default')
    else broadcast('ws:toastClicked', key)
  })
  handle('ws:toastsAvailable', () => toasts.available())
  handle('ws:toastShow', (json) => {
    try {
      const t = JSON.parse(json) as ToastMsg
      // Held back under a full-screen window: true, so the renderer does not draw it itself (it stays in the centre).
      if (!bannerAllowed(panelClient?.windows ?? [], ACTIVATED_FLAG, FULLSCREEN_FLAG)) return true
      return toasts.show({ ...t, key: String(t.key) })
    } catch { return false }
  })
  // A notification closed by its app (or from the notification centre) takes its toast away too.
  let liveIds = new Set<number>()
  notices.onChange((list) => {
    const now = new Set(list.map((n) => n.id))
    for (const id of liveIds) if (!now.has(id)) toasts.hide(`app-${id}`)
    liveIds = now
  })
  app.on('before-quit', () => toasts.stop())
  // Files' "Notify me when done" (FO1): a notice in the shell's own notification centre, text only.
  // "Drivers available for your Wi-Fi card": the renderer words it (en/si/ta); clicking opens Settings › Drivers.
  handle('ws:driversNotify', (summary, body) => {
    return notices.notify(DRIVERS_APP, 0, String(summary).slice(0, 200), String(body).slice(0, 400), ['default', ''], 1)
  })
  handle('ws:filesNotify', (summary, body) => notices.notify('Files', 0, String(summary).slice(0, 200), String(body).slice(0, 400), [], 1))
  // WorkSuite Security (#20): status, Scan now, and notices for threats, firewall alerts, protection off, isolation.
  startSecurity(handle, (n) => void notices.notify('WorkSuite Security', 0, n.title, n.body, [], n.kind === 'threat_detected' || n.kind === 'isolated' ? 2 : 1), broadcast)
  // Employee monitoring (#22): only when the signed policy turns it on; Settings and the taskbar indicator show it.
  const activity = startActivity(handle, {
    home, broadcast, device: () => deviceCredential(),
    session: async () => { const s = await loadSession(brokerFn, (url, init) => fetch(url, { headers: init?.headers }), () => deviceCredential()); return s.ok ? s.value : null },
    fetch: (url, init) => fetch(url, init as RequestInit),
  })
  hooks.windows = (w) => activity.windows(w, ACTIVATED_FLAG)
  app.on('before-quit', () => activity.stop())
  // Administrator prompts from the WorkSuite polkit agent (G05, WSOS-INT-010).
  startPolkitBridge(handle, broadcast)
})

app.on('window-all-closed', () => app.quit())
}


const DRIVERS_APP = 'WorkSuite Drivers'

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
      ...APP_WINDOW, title: 'Sign in to network', width: 900, height: 700, backgroundColor: '#ffffff',
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
