// Kiosk app (WSOS-AUTH-002): the only program the kiosk session runs (services/session/kiosk/worksuite-kiosk-start
// restarts it if it exits). Built to dist-electron/kiosk.cjs.
//   web kiosk     one Electron BrowserWindow in kiosk mode: URL allowlist for every navigation and frame, no devtools,
//                 no downloads, no new windows, no permissions, an in-memory profile that is replaced on idle reset.
//   module/app    the WorkSuite module or installed app runs as a child process, restarted (with back-off) if it exits;
//                 idle reset stops it, clears the kiosk account's app data and starts it again.
// SIGUSR1 (worksuite-kiosk-ctl exit-prompt, the Labwc Ctrl+Alt+Shift+K binding) or five taps in the top-left corner
// show the exit prompt; SIGUSR2 (swayidle, worksuite-kiosk-ctl reset) resets.
import { app, BrowserWindow, ipcMain, screen, session, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { blockedKey, desktopExecArgv, exitResult, isExitGesture, KIOSK_CONFIG, kioskWebPreferences, parseKioskConfig, restartDelay, urlAllowlist, type ExitResult, type KioskConfig } from './kiosk'
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
let child: ChildProcess | null = null
let generation = 0
let failures = 0
let leaving = false

/** Whole display, also where the compositor ignores the fullscreen request. */
const full = () => ({ ...screen.getPrimaryDisplay().bounds })

function statusWindow(state: 'starting' | 'unavailable'): BrowserWindow {
  const w = new BrowserWindow({ ...full(), kiosk: true, fullscreen: true, frame: false, backgroundColor: '#0A1A3D', webPreferences: shellWebPreferences(path.join(__dirname, 'kioskPreload.cjs')) })
  void w.loadFile(INDEX, { query: { mode: 'kiosk-status', state } })
  return w
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
  w.webContents.on('render-process-gone', () => setTimeout(() => replaceWeb(), restartDelay(++failures)))
  w.on('unresponsive', () => setTimeout(() => { if (main === w && !w.isDestroyed()) replaceWeb() }, 10_000))
  w.webContents.on('did-fail-load', (_e, code, _d, url, isMain) => {
    if (!isMain || code === -3 || ownPage(url)) return   // -3: aborted (our own block)
    void w.loadFile(INDEX, { query: { mode: 'kiosk-status', state: 'unavailable' } })
    setTimeout(() => { if (main === w && !w.isDestroyed()) void w.loadURL(c.app.url) }, restartDelay(++failures))
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
    setTimeout(startNative, restartDelay(failures))
  })
  child.on('error', () => {})
}

function reset() {
  if (!cfg || leaving) return
  exitWin?.destroy(); exitWin = null
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
