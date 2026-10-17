// Kiosk app (WSOS-AUTH-002): the only program the kiosk session runs (services/session/kiosk/worksuite-kiosk-start
// restarts it if it exits). Built to dist-electron/kiosk.cjs.
//   web kiosk     one Electron BrowserWindow in kiosk mode: URL allowlist for every navigation and frame, no devtools,
//                 no downloads, no new windows, no permissions, an in-memory profile that is replaced on idle reset.
//   module/app    the WorkSuite module or installed app runs as a child process, restarted (with back-off) if it exits;
//                 idle reset stops it, clears the kiosk account's app data and starts it again.
// SIGUSR1 (worksuite-kiosk-ctl exit-prompt, the Labwc Ctrl+Alt+Shift+K binding) or five taps in the top-left corner
// show the exit prompt; SIGUSR2 (swayidle, worksuite-kiosk-ctl reset) resets; SIGHUP (worksuite-kiosk-ctl warn | active)
// shows or hides the "Still there?" screen 15 s before an idle reset. The status pages (board KioskStates: starting,
// restarting after a crash, offline, unavailable, still there?) are the shell's KioskStatus screen.
import { app, BrowserWindow, ipcMain, screen, session, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { blockedKey, desktopExecArgv, exitResult, isExitGesture, KIOSK_CONFIG, kioskWebPreferences, parseKioskConfig, restartDelay, screenState, urlAllowlist, type ExitResult, type KioskConfig } from './kiosk'
import { shellWebPreferences } from './webSecurity'
import { execProgram, findWorkSuiteDesktop, installedApps } from './xdg'

const RUN = path.join(process.env.XDG_RUNTIME_DIR || '/tmp', 'worksuite-kiosk')
const INDEX = path.join(__dirname, '../dist/index.html')
/** The kiosk's own status page (shown in the kiosk window while the app is unreachable). */
const OWN_PAGE = pathToFileURL(INDEX).toString()
const ownPage = (u: string) => u === OWN_PAGE || u.startsWith(OWN_PAGE + '?')

let cfg: KioskConfig | null = null
try { cfg = parseKioskConfig(readFileSync(process.env.WORKSUITE_KIOSK_CONFIG || KIOSK_CONFIG, 'utf8')) } catch { /* no kiosk config */ }

app.commandLine.appendSwitch('enable-wayland-ime')
app.commandLine.appendSwitch('disable-pinch')                   // no zooming the kiosk out of its layout
app.commandLine.appendSwitch('overscroll-history-navigation', '0')
if (!app.requestSingleInstanceLock()) app.exit(0)

let main: BrowserWindow | null = null
let exitWin: BrowserWindow | null = null
let idleWin: BrowserWindow | null = null
let restartWin: BrowserWindow | null = null
let screenWin: BrowserWindow | null = null
let child: ChildProcess | null = null
let generation = 0
let failures = 0
let leaving = false

/** Whole display, also where the compositor ignores the fullscreen request. */
const full = () => ({ ...screen.getPrimaryDisplay().bounds })

type StatusState = 'starting' | 'unavailable' | 'restarting' | 'offline' | 'idle' | 'screen-off'
const statusQuery = (state: StatusState, extra: Record<string, string> = {}) => ({ query: { mode: 'kiosk-status', state, ...extra } })

function statusWindow(state: StatusState, extra: Record<string, string> = {}, onTop = false): BrowserWindow {
  const w = new BrowserWindow({ ...full(), kiosk: true, fullscreen: true, frame: false, backgroundColor: '#0A1A3D', webPreferences: shellWebPreferences(path.join(__dirname, 'kioskPreload.cjs')) })
  if (onTop) w.setAlwaysOnTop(true, 'screen-saver')
  w.webContents.on('will-navigate', (e) => e.preventDefault())
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  w.webContents.on('before-input-event', (e, input) => { if (isExitGesture(input)) { e.preventDefault(); showExitPrompt() } else if (blockedKey(input)) e.preventDefault() })
  void w.loadFile(INDEX, statusQuery(state, extra))
  return w
}

/** "Restarting the app" over the screen while a crashed app comes back (after `ms`). */
function showRestarting(ms: number) {
  if (leaving) return
  restartWin?.destroy()
  restartWin = statusWindow('restarting', { attempt: String(failures), secs: String(Math.max(1, Math.round(ms / 1000))) }, true)
  restartWin.on('closed', () => { restartWin = null })
}
const hideRestarting = (afterMs = 0) => setTimeout(() => { restartWin?.destroy(); restartWin = null }, afterMs)

/** "Still there?" 15 s before an idle reset; any touch or key (swayidle's resume) takes it away. */
function idleWarning(show: boolean) {
  if (!show || leaving) { idleWin?.destroy(); idleWin = null; return }
  if (idleWin && !idleWin.isDestroyed()) return
  idleWin = statusWindow('idle', { secs: '15' }, true)
  idleWin.webContents.on('input-event', (_e, input) => { if (['mouseDown', 'touchStart', 'keyDown', 'gestureTap'].includes(input.type)) idleWarning(false) })
  idleWin.on('closed', () => { idleWin = null })
}

/** Night screen-off (policy kiosk.screen_off, worksuite-kiosk-screen): when a touch wakes the screen in the window, it
 *  shows "Screen off until 07:00" first; a tap takes the notice away and the app can be used until the screen goes off
 *  again. `until` is HH:MM from worksuite-kiosk-ctl. */
function screenOffNotice(until: string | null) {
  if (!until || leaving) { screenWin?.destroy(); screenWin = null; return }
  if (screenWin && !screenWin.isDestroyed()) return
  screenWin = statusWindow('screen-off', { until }, true)
  screenWin.webContents.on('input-event', (_e, input) => { if (['mouseDown', 'touchStart', 'keyDown', 'gestureTap'].includes(input.type)) { screenWin?.destroy(); screenWin = null } })
  screenWin.on('closed', () => { screenWin = null })
}
/** Every web contents of the kiosk: no new windows, no devtools, blocked shortcuts, exit gesture. */
function lockDown(wc: WebContents, allowed: (u: string) => boolean) {
  wc.setWindowOpenHandler(({ url }) => {
    // Links that open a new window stay in the kiosk window when allowed.
    if (allowed(url)) void wc.loadURL(url)
    return { action: 'deny' }
  })
  const guard = (e: { preventDefault(): void }, url: string) => { if (!allowed(url)) e.preventDefault() }
  wc.on('will-navigate', guard)
  wc.on('will-redirect', guard)
  wc.on('will-frame-navigate', (e) => { if (!allowed(e.url)) e.preventDefault() })
  wc.on('devtools-opened', () => wc.closeDevTools())
  wc.on('before-input-event', (e, input) => {
    if (isExitGesture(input)) { e.preventDefault(); showExitPrompt() }
    else if (blockedKey(input)) e.preventDefault()
  })
  wc.on('context-menu', (e) => e.preventDefault())
}

function webKiosk(c: KioskConfig & { app: { type: 'url'; url: string } }) {
  const allowed = urlAllowlist(c)
  const gen = ++generation
  const prefs = kioskWebPreferences(path.join(__dirname, 'kioskPreload.cjs'), gen)
  const ses = session.fromPartition(prefs.partition, { cache: false })
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
  ses.on('will-download', (e, item) => { e.preventDefault(); item.cancel() })
  // Top-level pages and frames outside the allowlist never load (subresources such as images and scripts may).
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => {
    const nav = d.resourceType === 'mainFrame' || d.resourceType === 'subFrame'
    cb({ cancel: nav && !allowed(d.url) && !ownPage(d.url) })
  })
  const w = new BrowserWindow({ ...full(), kiosk: true, fullscreen: true, frame: false, autoHideMenuBar: true, backgroundColor: '#0A1A3D', webPreferences: prefs })
  w.removeMenu()
  lockDown(w.webContents, allowed)
  // A crashed or hung page is replaced with a fresh one; an unreachable start page is retried.
  w.webContents.on('render-process-gone', () => { const ms = restartDelay(++failures); showRestarting(ms); setTimeout(() => { replaceWeb(); hideRestarting(1500) }, ms) })
  w.on('unresponsive', () => setTimeout(() => { if (main === w && !w.isDestroyed()) replaceWeb() }, 10_000))
  w.webContents.on('did-fail-load', (_e, code, _d, url, isMain) => {
    if (!isMain || code === -3 || ownPage(url)) return   // -3: aborted (our own block)
    const ms = restartDelay(++failures)
    // -100…-199: connection errors (no network, DNS, refused, timed out): "Offline", naming the host and the retry.
    let host = ''
    try { host = new URL(c.app.url).host } catch { /* keep empty */ }
    void w.loadFile(INDEX, code <= -100 && code > -200 ? statusQuery('offline', { host, secs: String(Math.round(ms / 1000)) }) : statusQuery('unavailable'))
    setTimeout(() => { if (main === w && !w.isDestroyed()) void w.loadURL(c.app.url) }, ms)
  })
  w.webContents.on('did-finish-load', () => { if (allowed(w.webContents.getURL())) failures = 0 })
  void w.loadURL(c.app.url)
  return w
}

/** Idle reset / crash recovery of the web kiosk: a new window on a new in-memory profile; the old one is discarded. */
function replaceWeb() {
  if (!cfg || cfg.app.type !== 'url' || leaving) return
  const old = main
  main = webKiosk(cfg as KioskConfig & { app: { type: 'url'; url: string } })
  if (old && !old.isDestroyed()) {
    const ses = old.webContents.session
    old.destroy()
    void ses.clearStorageData().catch(() => {})
    void ses.clearCache().catch(() => {})
  }
}

function nativeArgv(c: KioskConfig): string[] | null {
  const env = { ...process.env, XDG_CURRENT_DESKTOP: 'WorkSuite' }
  const all = installedApps(env)
  if (c.app.type === 'module') {
    const desktop = findWorkSuiteDesktop(all)
    const prog = desktop && execProgram(desktop.exec)
    return prog ? [prog, `--module=${c.app.id}`] : null
  }
  if (c.app.type === 'desktop') {
    const id = c.app.id.replace(/\.desktop$/, '')
    return desktopExecArgv(all.find((e) => e.id === id)?.exec)
  }
  return null
}

/** The kiosk account's app data (fresh state after an idle reset). Only ever for the kiosk account itself. */
function clearAppData() {
  if (!cfg || userInfo().username !== cfg.user) return
  const home = homedir()
  if (!home || home === '/') return
  for (const d of ['.cache', '.config', '.local/share', '.local/state']) rmSync(path.join(home, d), { recursive: true, force: true })
}

function startNative() {
  if (!cfg || leaving) return
  const argv = nativeArgv(cfg)
  if (!argv) { main ??= statusWindow('unavailable'); setTimeout(startNative, 30_000); return }
  const started = Date.now()
  child = spawn(argv[0], argv.slice(1), { stdio: 'ignore', env: { ...process.env, XDG_CURRENT_DESKTOP: 'WorkSuite' } })
  child.on('exit', () => {
    child = null
    if (leaving) return
    failures = Date.now() - started > 60_000 ? 1 : failures + 1
    const ms = restartDelay(failures)
    showRestarting(ms)
    setTimeout(() => { startNative(); hideRestarting(2500) }, ms)
  })
  child.on('error', () => {})
}

function reset() {
  if (!cfg || leaving) return
  exitWin?.destroy(); exitWin = null
  idleWarning(false)
  if (cfg.app.type === 'url') { replaceWeb(); return }
  failures = 0
  const c = child
  if (c) { c.removeAllListeners('exit'); c.once('exit', () => { child = null; clearAppData(); startNative() }); c.kill('SIGTERM'); setTimeout(() => c.kill('SIGKILL'), 5000) }
  else { clearAppData(); startNative() }
}

function showExitPrompt() {
  if (leaving) return
  if (exitWin && !exitWin.isDestroyed()) { exitWin.focus(); return }
  exitWin = new BrowserWindow({ ...full(), fullscreen: true, frame: false, alwaysOnTop: true, backgroundColor: '#050B18', webPreferences: { ...shellWebPreferences(path.join(__dirname, 'kioskExitPreload.cjs')), devTools: false } })
  exitWin.setAlwaysOnTop(true, 'screen-saver')
  exitWin.webContents.on('will-navigate', (e) => e.preventDefault())
  exitWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  exitWin.webContents.on('before-input-event', (e, input) => { if (blockedKey(input)) e.preventDefault() })
  exitWin.on('closed', () => { exitWin = null })
  void exitWin.loadFile(INDEX, { query: { mode: 'kiosk-exit' } })
}

/** Runs the root helper through pkexec; the PIN goes on stdin, never on a command line. */
function runExit(mode: '--pin' | '--admin', pin?: string): Promise<ExitResult> {
  return new Promise((resolve) => {
    const p = spawn('pkexec', ['/usr/lib/worksuite/worksuite-kiosk-exit', mode], { stdio: ['pipe', 'ignore', 'ignore'] })
    p.on('error', () => resolve('failed'))
    p.on('exit', (code) => resolve(exitResult(code)))
    p.stdin!.end(pin ? pin + '\n' : '')
  })
}

const fromPrompt = (e: IpcMainInvokeEvent) => !!exitWin && !exitWin.isDestroyed() && e.sender === exitWin.webContents
async function leave(r: ExitResult): Promise<ExitResult> {
  if (r === 'ok') {
    leaving = true
    try { writeFileSync(path.join(RUN, 'exiting'), '') } catch { /* the helper writes it too */ }
    child?.kill('SIGTERM')
  }
  return r
}

app.on('window-all-closed', () => { /* the kiosk app keeps running with a native child and no window */ })
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  mkdirSync(RUN, { recursive: true, mode: 0o700 })
  writeFileSync(path.join(RUN, 'app.pid'), String(process.pid))
  process.on('SIGUSR1', () => showExitPrompt())
  process.on('SIGUSR2', () => reset())
  process.on('SIGHUP', () => {
    let v = ''
    try { v = readFileSync(path.join(RUN, 'idle'), 'utf8').trim() } catch { /* nothing asked */ }
    idleWarning(v === 'warn')
    let sc = ''
    try { sc = readFileSync(path.join(RUN, 'screen'), 'utf8') } catch { /* no schedule */ }
    screenOffNotice(screenState(sc))
  })

  ipcMain.on('kiosk:gesture', (e) => { if (main && e.sender === main.webContents) showExitPrompt() })
  ipcMain.handle('kiosk:info', (e) => (fromPrompt(e) ? { exitPin: cfg?.exit_pin === true } : null))
  ipcMain.handle('kiosk:exitPin', async (e, pin: unknown) => {
    if (!fromPrompt(e)) return 'failed'
    if (typeof pin !== 'string' || !/^\d{6,12}$/.test(pin)) return 'wrong_pin'
    return leave(await runExit('--pin', pin))
  })
  ipcMain.handle('kiosk:exitAdmin', async (e) => (fromPrompt(e) ? leave(await runExit('--admin')) : 'failed'))
  ipcMain.handle('kiosk:cancel', (e) => { if (fromPrompt(e)) exitWin?.destroy() })

  if (!cfg) { main = statusWindow('unavailable'); return }
  if (cfg.app.type === 'url') main = webKiosk(cfg as KioskConfig & { app: { type: 'url'; url: string } })
  else startNative()
}).catch(() => app.exit(1))
