// Screenshots and the snipping tool (WSOS-DSK-011), like Windows 11:
//   Print / Super+Print     the whole screen (every monitor), saved to ~/Pictures/Screenshots and copied; a toast offers
//                           the editor. Settings › Keyboard › Shortcuts can make Print open the snipping overlay instead.
//   Alt+Print               the snipping overlay in Window mode: one click copies a window.
//   Super+Shift+S           the snipping overlay (Shift+Print too): Rectangle, Window, Full screen or Freeform; the snip
//                           is copied to the clipboard and a toast "Screenshot copied — click to edit" opens the editor.
//   Snipping Tool (app)     the same overlay, with a 3/5/10 s delay if wanted, and the editor.
//
// Capture is grim (wlr-screencopy) in this process: each output frozen first, then the shell's windows (one per monitor)
// are lifted over the apps and draw the overlay on the frozen frame, so the selection looks like part of the desktop
// rather than a separate picker. The renderer cuts the selection out of the frame (freeform with a transparent outside)
// and hands back a PNG. Images are kept in memory (the last few, for the editor) and written only where the person saves
// them: Print saves to Pictures/Screenshots. Nothing is ever uploaded. When the shell is not running, worksuite-screenshot
// falls back to xdg-desktop-portal (screenshot.ts).
//
// Policy screen_capture: disabled (admin console › Policy), and every kiosk, turn all of it off; the shortcuts then say so.
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type CaptureKind = 'print' | 'save' | 'window' | 'snip'
export type SnipMode = 'rect' | 'window' | 'full' | 'free'
export const SNIP_MODES: SnipMode[] = ['rect', 'window', 'full', 'free']
export const DELAYS = [0, 3, 5, 10]
export const MAX_IMAGE = 64 * 1024 * 1024
const KEEP = 6

/** "Screenshot 2026-10-16 091502.png": local time, sorts by name, no characters that need quoting. */
export function screenshotFileName(now: Date, ext: 'png' | 'jpg' = 'png'): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `Screenshot ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.${ext}`
}
/** The name itself, or "<name> (2).png" … when it is taken. */
export function uniqueFile(dir: string, name: string, exists: (p: string) => boolean = existsSync): string {
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length)
  for (let i = 1; i < 1000; i++) {
    const p = path.join(dir, i === 1 ? name : `${stem} (${i})${ext}`)
    if (!exists(p)) return p
  }
  return path.join(dir, `${stem} ${Date.now()}${ext}`)
}
/** ~/Pictures/Screenshots (XDG_PICTURES_DIR when set). */
export function screenshotsDir(env: NodeJS.ProcessEnv, home: string): string {
  return path.join(env.XDG_PICTURES_DIR || path.join(home, 'Pictures'), 'Screenshots')
}

export interface CapturePolicy { screen_capture?: string | null; kiosk?: boolean }
/** Allowed unless policy says `disabled`; never on a kiosk. */
export const captureAllowed = (p: CapturePolicy | null | undefined) => p?.screen_capture !== 'disabled' && p?.kiosk !== true

export interface CaptureSettings { printOpensSnip: boolean; mode: SnipMode; delay: number }
export const DEFAULT_CAPTURE: CaptureSettings = { printOpensSnip: false, mode: 'rect', delay: 0 }
export function normalizeCapture(v: unknown): CaptureSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return {
    printOpensSnip: o.printOpensSnip === true,
    mode: SNIP_MODES.includes(o.mode as SnipMode) ? (o.mode as SnipMode) : 'rect',
    delay: DELAYS.includes(Number(o.delay)) ? Number(o.delay) : 0,
  }
}

/** What Shell1.Capture(kind) does with the settings: the overlay (in which mode) or a whole-screen screenshot. */
export function plan(kind: CaptureKind, s: CaptureSettings): { overlay: SnipMode } | { full: true } {
  if (kind === 'window') return { overlay: 'window' }
  if (kind === 'snip') return { overlay: s.mode }
  if (kind === 'print' && s.printOpensSnip) return { overlay: s.mode }
  return { full: true }
}

export interface Output { name: string; x: number; y: number; width: number; height: number }
/** grim argv: one output, or the whole layout; PNG to stdout, fast compression (it stays in memory). */
export function grimArgs(output: string | null): string[] {
  return [...(output ? ['-o', output] : []), '-t', 'png', '-l', '1', '-']
}
const SAFE_OUTPUT = /^[A-Za-z0-9._-]{1,64}$/

export interface Frame extends Output { png: Buffer }
export interface SnipSession { id: number; mode: SnipMode; frames: Frame[] }
export interface Shot { id: number; png: Buffer; file: string | null; at: number }

export type RunBytes = (cmd: string, args: string[]) => Promise<Buffer | null>
export const runBytes: RunBytes = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { encoding: 'buffer', maxBuffer: MAX_IMAGE, timeout: 10_000 }, (err, stdout) => resolve(err || !stdout.length ? null : stdout))
})
export function wlCopyImage(data: Buffer, type = 'image/png'): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('wl-copy', ['--type', type], { stdio: ['pipe', 'ignore', 'ignore'] })
    p.on('error', () => resolve(false))
    p.on('exit', (c) => resolve(c === 0))
    p.stdin.on('error', () => undefined)
    p.stdin.end(data)
  })
}

export interface CaptureDeps {
  run: RunBytes
  copy: (png: Buffer) => Promise<boolean>
  outputs: () => Output[]
  policies: () => CapturePolicy | null
  broadcast: (channel: string, payload: unknown) => void
  /** Lift the shell's windows over the apps (true) or put them back (false). */
  lift: (on: boolean) => Promise<void> | void
  dir: () => string
  settingsFile: string | null
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  write?: (file: string, data: Buffer) => void
}

/** Events to the renderer: ws:snipOpen {id, mode, outputs}, ws:snipClose {id}, ws:captured {id, kind, file, error}. */
export function captureHost(d: CaptureDeps) {
  const now = d.now ?? (() => new Date())
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const write = d.write ?? ((file: string, data: Buffer) => {
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.part`
    writeFileSync(tmp, data, { mode: 0o644 })
    renameSync(tmp, file)
  })
  let next = 1
  let session: SnipSession | null = null
  let busy = false
  const shots: Shot[] = []
  const keep = (png: Buffer, file: string | null): Shot => {
    const s = { id: next++, png, file, at: now().getTime() }
    shots.unshift(s)
    shots.splice(KEEP)
    return s
  }

  function loadSettings(): CaptureSettings {
    if (!d.settingsFile) return { ...DEFAULT_CAPTURE }
    try { return normalizeCapture(JSON.parse(readFileSync(d.settingsFile, 'utf8'))) } catch { return { ...DEFAULT_CAPTURE } }
  }
  function saveSettings(s: CaptureSettings) {
    if (!d.settingsFile) return
    try {
      mkdirSync(path.dirname(d.settingsFile), { recursive: true })
      writeFileSync(`${d.settingsFile}.tmp`, JSON.stringify(s) + '\n', { mode: 0o600 })
      renameSync(`${d.settingsFile}.tmp`, d.settingsFile)
    } catch { /* this session only */ }
  }
  let settings = loadSettings()
  const allowed = () => captureAllowed(d.policies())
  const refuse = () => { d.broadcast('ws:captured', { id: 0, kind: 'blocked', file: null }); return false }

  async function fullScreen(save: boolean): Promise<boolean> {
    const png = await d.run('grim', grimArgs(null))
    if (!png) { d.broadcast('ws:captured', { id: 0, kind: 'failed', file: null }); return false }
    let file: string | null = null
    if (save) {
      try { file = uniqueFile(d.dir(), screenshotFileName(now())); write(file, png) } catch { file = null }
    }
    const copied = await d.copy(png)
    const s = keep(png, file)
    d.broadcast('ws:captured', { id: s.id, kind: file ? 'saved' : copied ? 'copied' : 'failed', file, copied })
    return true
  }

  async function openOverlay(mode: SnipMode, delay = 0, fromApp = false): Promise<boolean> {
    if (session) { d.broadcast('ws:snipOpen', { id: session.id, mode: session.mode, outputs: session.frames.map(({ png: _p, ...o }) => o) }); return true }
    if (busy) return false
    busy = true
    try {
      // From the Snipping Tool window: give the shell time to go back below the apps before the frame is taken.
      if (fromApp || delay) await sleep(Math.max(fromApp ? 450 : 0, delay * 1000))
      if (!allowed()) return refuse()
      const outs = d.outputs().filter((o) => SAFE_OUTPUT.test(o.name))
      const frames: Frame[] = []
      for (const o of outs.length ? outs : [{ name: '', x: 0, y: 0, width: 0, height: 0 }]) {
        const png = await d.run('grim', grimArgs(o.name || null))
        if (png) frames.push({ ...o, png })
      }
      if (!frames.length) { d.broadcast('ws:captured', { id: 0, kind: 'failed', file: null }); return false }
      session = { id: next++, mode, frames }
      d.broadcast('ws:snipOpen', { id: session.id, mode, outputs: frames.map(({ png: _p, ...o }) => o) })
      await d.lift(true)
      return true
    } finally { busy = false }
  }

  function close() {
    if (!session) return
    const id = session.id
    session = null
    d.broadcast('ws:snipClose', { id })
    void d.lift(false)
  }

  return {
    settings: () => ({ ...settings }),
    setSettings(patch: Partial<CaptureSettings>) { settings = normalizeCapture({ ...settings, ...patch }); saveSettings(settings); return { ...settings } },
    allowed,
    /** Shell1.Capture: the keyboard shortcuts. */
    async request(kind: CaptureKind): Promise<boolean> {
      if (!allowed()) return refuse()
      const p = plan(kind, settings)
      return 'full' in p ? fullScreen(true) : openOverlay(p.overlay)
    },
    /** The Snipping Tool app's "New" (mode and delay remembered for next time). */
    start(mode: SnipMode, delay: number) {
      if (!allowed()) return Promise.resolve(refuse())
      settings = normalizeCapture({ ...settings, mode, delay })
      saveSettings(settings)
      if (mode === 'full' && !delay) return sleep(450).then(() => fullScreen(false))
      return openOverlay(settings.mode, settings.delay, true)
    },
    /** The frozen frame of one output, as a data: URL (the main window passes '' for the first one). */
    frame(id: number, output: string): string | null {
      if (!session || session.id !== id) return null
      const f = session.frames.find((x) => x.name === output) ?? (output ? null : session.frames[0])
      return f ? `data:image/png;base64,${f.png.toString('base64')}` : null
    },
    /** The overlay's result: a PNG data: URL of the selection. Copied, kept for the editor, and the overlay closes. */
    async done(id: number, dataUrl: string): Promise<{ id: number } | null> {
      if (!session || session.id !== id) return null
      close()
      const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
      const png = m ? Buffer.from(m[1], 'base64') : null
      if (!png || !png.length || png.length > MAX_IMAGE) { d.broadcast('ws:captured', { id: 0, kind: 'failed', file: null }); return null }
      const copied = await d.copy(png)
      const s = keep(png, null)
      d.broadcast('ws:captured', { id: s.id, kind: copied ? 'copied' : 'failed', file: null, copied })
      return { id: s.id }
    },
    cancel(id: number) { if (session?.id === id) close() },
    /** A kept screenshot for the editor, newest when id is 0. */
    image(id: number): { id: number; url: string; file: string | null } | null {
      const s = id ? shots.find((x) => x.id === id) : shots[0]
      return s ? { id: s.id, url: `data:image/png;base64,${s.png.toString('base64')}`, file: s.file } : null
    },
    /** The editor's Copy: its PNG to the clipboard. */
    async copyImage(dataUrl: string): Promise<boolean> {
      const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
      return m ? d.copy(Buffer.from(m[1], 'base64')) : false
    },
    get open() { return session?.id ?? 0 },
  }
}

/** A PNG or JPEG data: URL as bytes and its extension; null for anything else. */
export function imageData(dataUrl: string): { data: Buffer; ext: 'png' | 'jpg' } | null {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (!m) return null
  const data = Buffer.from(m[2], 'base64')
  return data.length && data.length <= MAX_IMAGE ? { data, ext: m[1] === 'png' ? 'png' : 'jpg' } : null
}
