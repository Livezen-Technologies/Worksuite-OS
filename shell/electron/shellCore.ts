import { BrowserWindow, screen, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { bootMode } from './bootmode'
import { outputWindows, screensMatch, type Rect } from './outputWindows'
import { markShellReady } from './monitorHost'
import { externalAllowed, shellWebPreferences } from './webSecurity'
import { IconCache } from './icons'

// The shell's own windows and its sender-checked IPC entry point (from main.ts): the main window, one desktop window per
// secondary output, and `handle`, through which every ws: channel is registered (WSOS-ARC-001).

export let win: BrowserWindow | null = null
// The main window plus one desktop/taskbar window per secondary monitor (WSOS-DSK-005).
export const shellContents = new Set<Electron.WebContents>()

function validSender(e: IpcMainInvokeEvent) {
  return shellContents.has(e.sender) && e.senderFrame?.url.startsWith('file://') === true
}

export function broadcast(channel: string, payload: unknown) {
  for (const wc of shellContents) if (!wc.isDestroyed()) wc.send(channel, payload)
}

export const shellPrefs = () => shellWebPreferences(path.join(__dirname, 'preload.cjs'))

export const monitors = outputWindows((r) => {
  const w = new BrowserWindow({ x: r.x, y: r.y, width: r.width, height: r.height, fullscreen: true, frame: false, title: `WorkSuite desktop ${r.name}`, backgroundColor: '#040A1A', webPreferences: shellPrefs() })
  const wc = w.webContents
  shellContents.add(wc)
  w.on('closed', () => { shellContents.delete(wc); monitors.forget(r.name) })
  wc.on('will-navigate', (e) => e.preventDefault())
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  void w.loadFile(path.join(__dirname, '../dist/index.html'), { query: { mode: 'output', output: r.name } })
  return w
}, () => win)

/** After a scale or mode change: waits (bounded) for Electron to see the new output geometry, re-places every shell
 *  window on it, then for each renderer to have laid out and drawn a frame at its new size. Only then does Settings ›
 *  Display start the keep/revert countdown, so its buttons are where they are drawn (#60). */
export async function settleShell(rects: Rect[], timeoutMs = 4000) {
  const until = Date.now() + timeoutMs
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
  while (!screensMatch(rects, screen.getAllDisplays()) && Date.now() < until) await pause(100)
  // Toggling fullscreen can take the keyboard focus away: the window with Settings gets it back for Enter/Escape.
  const focused = BrowserWindow.getFocusedWindow() ?? win
  monitors.refit()
  await Promise.all(monitors.placed().map(({ win: w, rect }) => {
    if (w.isDestroyed()) return null
    const js = `new Promise((done) => { let n = 0; const ok = () => Math.abs(innerWidth - ${rect.width}) <= 2 && Math.abs(innerHeight - ${rect.height}) <= 2;
      const step = () => (ok() || n++ > 60 ? requestAnimationFrame(() => requestAnimationFrame(() => done(ok()))) : setTimeout(step, 50)); step() })`
    return Promise.race([w.webContents.executeJavaScript(js).catch(() => false), pause(Math.max(500, until - Date.now()))])
  }))
  if (focused && !focused.isDestroyed()) focused.focus()
}

export const appIcons = new IconCache()
export const parseJson = (s: string): unknown => { try { return JSON.parse(s) } catch { return null } }

/** The checked sender of the IPC call being handled (read synchronously in a handler, e.g. ws:edit). */
export let ipcSender: Electron.WebContents | null = null
export function handle(channel: string, fn: (...args: string[]) => unknown) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!validSender(e)) throw new Error('Rejected IPC sender')
    ipcSender = e.sender
    try { return fn(...args.map(String)) } finally { ipcSender = null }
  })
}

export function run(cmd: string, args: string[]) {
  // Fixed argument arrays, never a shell (WSOS-LCH-001).
  return new Promise<void>((resolve) => execFile(cmd, args, () => resolve()))
}

/** $XDG_RUNTIME_DIR/worksuite/shell-ready: services/session/greeter/worksuite_greeter/veil.py session_main. */
export function markSessionVeil() {
  const run = process.env.XDG_RUNTIME_DIR
  if (!run) return
  try { mkdirSync(path.join(run, 'worksuite'), { recursive: true, mode: 0o700 }); writeFileSync(path.join(run, 'worksuite', 'shell-ready'), `${process.pid}\n`) } catch { /* no veil to tell */ }
}

export function createWindow() {
  win = new BrowserWindow({
    fullscreen: true,
    // Frameless: re-asserting fullscreen after a scale or mode change must never leave a decorated window (#60).
    frame: false,
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
