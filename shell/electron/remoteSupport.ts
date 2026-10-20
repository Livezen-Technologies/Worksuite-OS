// Remote support consent on the desktop (issue #19): the shell side of services/device-agent/src/remoteSupport.ts.
// The agent publishes the request in /run/worksuite-device-agent/remote-support.json (no secrets) and, for an
// attended request, a one-time nonce readable only by the seat user in consent/<uid>. The shell draws the consent
// dialog and the "remote support" indicator and answers over remote-support.sock. Without the agent nothing is shown.
import { readFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { RemoteSessionController, type CaptureWindow } from './remoteSession'
import type { Region } from './rsInput'
import type { Exec } from './system'

export const RS_DIR = '/run/worksuite-device-agent'
export type RsMode = 'view' | 'control'
export interface RsSession {
  session_id: string
  state: 'pending' | 'active' | 'ended'
  mode: RsMode
  reason: string
  admin_name: string
  org_name: string
  consent: 'user' | 'unattended_policy' | null
  granted_mode: RsMode | null
  requested_at: number
  started_at: number | null
  expires_at: number
  /** Issue #37: the administrator's viewer may record (policy + request), told to the user. */
  record: boolean
  /** Text clipboard sync, turned on by the user for this session. */
  clipboard: boolean
  /** 'pending' while the user is asked to allow control mid-session. */
  elevation: 'pending' | null
}
type Reply<T> = { ok: true; value: T } | { ok: false; error: string }

/** The published file → a session, or null when it is absent or not the agent's shape. */
export function parseSession(text: string | null): RsSession | null {
  if (!text) return null
  let o: unknown
  try { o = JSON.parse(text) } catch { return null }
  if (!o || typeof o !== 'object') return null
  const s = o as Partial<RsSession>
  if (typeof s.session_id !== 'string' || (s.state !== 'pending' && s.state !== 'active') || (s.mode !== 'view' && s.mode !== 'control')) return null
  if (typeof s.admin_name !== 'string' || typeof s.reason !== 'string') return null
  return {
    session_id: s.session_id, state: s.state, mode: s.mode, reason: s.reason, admin_name: s.admin_name, org_name: typeof s.org_name === 'string' ? s.org_name : '',
    consent: s.consent === 'user' || s.consent === 'unattended_policy' ? s.consent : null,
    granted_mode: s.granted_mode === 'view' || s.granted_mode === 'control' ? s.granted_mode : null,
    requested_at: Number(s.requested_at) || 0, started_at: s.started_at == null ? null : Number(s.started_at), expires_at: Number(s.expires_at) || 0,
    record: s.record === true, clipboard: s.clipboard === true, elevation: s.elevation === 'pending' && s.state === 'active' ? 'pending' : null,
  }
}

export interface RsDeps {
  read(path: string): Promise<string | null>
  /** One JSON line to the socket, one JSON reply back. */
  call(path: string, line: string): Promise<string>
  uid: number
}

export const realDeps = (): RsDeps => ({
  read: (p) => readFile(p, 'utf8').catch(() => null),
  call: (p, line) => new Promise((resolve, reject) => {
    const s = createConnection(p)
    let buf = ''
    s.setEncoding('utf8')
    s.setTimeout(10_000, () => { s.destroy(); reject(new Error('timeout')) })
    s.on('connect', () => s.write(line + '\n'))
    s.on('data', (c) => { buf += c })
    s.on('end', () => resolve(buf))
    s.on('error', reject)
  }),
  uid: process.getuid?.() ?? -1,
})

export function remoteSupportBridge(d: RsDeps = realDeps(), dir = RS_DIR) {
  const send = async (method: string, params?: Record<string, unknown>): Promise<Reply<RsSession | null>> => {
    let text: string
    try { text = await d.call(join(dir, 'remote-support.sock'), JSON.stringify({ method, ...(params ? { params } : {}) })) } catch { return { ok: false, error: 'service_unavailable' } }
    let r: { result?: unknown; error?: string }
    try { r = JSON.parse(text) } catch { return { ok: false, error: 'bad_reply' } }
    return r.error ? { ok: false, error: r.error } : { ok: true, value: parseSession(r.result ? JSON.stringify(r.result) : null) }
  }
  return {
    async state(): Promise<RsSession | null> { return parseSession(await d.read(join(dir, 'remote-support.json'))) },
    /** decision: deny | view | control. The nonce is read here, in the main process, never handed to the page. */
    async decide(decision: string): Promise<Reply<RsSession | null>> {
      if (decision !== 'deny' && decision !== 'view' && decision !== 'control') return { ok: false, error: 'invalid_argument' }
      if (d.uid < 0) return { ok: false, error: 'service_unavailable' }
      const nonce = (await d.read(join(dir, 'consent', String(d.uid))))?.trim()
      if (!nonce) return { ok: false, error: 'NO_PENDING_REQUEST' }
      return send('Decide', { nonce, decision })
    },
    /** Step-up answer (issue #37): the same seat-bound nonce, read here. */
    async decideElevation(allow: boolean): Promise<Reply<RsSession | null>> {
      if (typeof allow !== 'boolean') return { ok: false, error: 'invalid_argument' }
      if (d.uid < 0) return { ok: false, error: 'service_unavailable' }
      const nonce = (await d.read(join(dir, 'consent', String(d.uid))))?.trim()
      if (!nonce) return { ok: false, error: 'NO_PENDING_REQUEST' }
      return send('DecideElevation', { nonce, allow })
    },
    setClipboard: (enabled: boolean) => send('SetClipboard', { enabled: enabled === true }),
    revokeControl: () => send('RevokeControl'),
    end: () => send('End'),
  }
}

/** The monitor the viewer chose (issue #37); null = the first source (the portal's choice). */
let chosenSource: string | null = null

/** Bounds of the display behind a source in the whole layout (Electron's screen), for absolute pointer motion. */
export function regionFor(displayId: string, displays: { id: number; bounds: { x: number; y: number; width: number; height: number } }[]): Region | null {
  const d = displays.find((x) => String(x.id) === displayId)
  if (!d || displays.length < 2) return null
  const minX = Math.min(...displays.map((x) => x.bounds.x)), minY = Math.min(...displays.map((x) => x.bounds.y))
  const maxX = Math.max(...displays.map((x) => x.bounds.x + x.bounds.width)), maxY = Math.max(...displays.map((x) => x.bounds.y + x.bounds.height))
  return { x: d.bounds.x - minX, y: d.bounds.y - minY, w: d.bounds.width, h: d.bounds.height, layoutW: maxX - minX, layoutH: maxY - minY }
}

/** Hidden capture window for the media session: its own partition, screen capture through the portal only. */
async function captureWindow(): Promise<CaptureWindow & { wc: Electron.WebContents }> {
  const { BrowserWindow, desktopCapturer, session } = await import('electron')
  const ses = session.fromPartition('ws-remote-support')
  ses.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'))
  // getSources goes to the ScreenCast portal, whose chooser asks which screen (multi-monitor) when it has to.
  ses.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((src) => {
      const pick = src.find((x) => x.id === chosenSource) ?? src[0]
      cb(pick ? { video: pick } : {})
    }).catch(() => cb({}))
  })
  const w = new BrowserWindow({ show: false, webPreferences: { session: ses, preload: join(__dirname, 'rsCapture.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  w.webContents.on('will-navigate', (e) => e.preventDefault())
  void w.loadURL('about:blank')
  return { wc: w.webContents, send: (ch, data) => { if (!w.isDestroyed()) w.webContents.send(ch, data) }, close: () => { if (!w.isDestroyed()) w.destroy() } }
}

type Handle = (channel: string, fn: (...args: string[]) => unknown) => void
export function startRemoteSupportHost(handle: Handle, b = remoteSupportBridge(), o: { exec?: Exec; credential: () => string | null; serverBase: () => string | null }) {
  let wc: Electron.WebContents | null = null
  let sources: { id: string; display: string }[] = []
  // Loaded once below; the clipboard and screen calls are synchronous.
  let el: typeof import('electron') | null = null
  const ctl = new RemoteSessionController({
    state: () => b.state(), end: () => b.end(), credential: o.credential, serverBase: o.serverBase, fetch,
    downloadsDir: () => join(process.env.HOME ?? '/tmp', 'Downloads'),
    clipboard: {
      read: () => el?.clipboard.readText() ?? '',
      write: (t) => { el?.clipboard.writeText(t) },
    },
    monitors: async () => {
      const { desktopCapturer } = await import('electron')
      const src = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      sources = src.map((x) => ({ id: x.id, display: x.display_id }))
      return src.map((x, i) => ({ id: x.id, name: x.name || `Screen ${i + 1}` }))
    },
    selectMonitor: (id) => {
      chosenSource = id
      return el ? regionFor(sources.find((x) => x.id === id)?.display ?? '', el.screen.getAllDisplays()) : null
    },
    openWindow: () => {
      // The window is created asynchronously; messages sent before it loads are queued until then.
      const q: [string, unknown][] = []
      let win: (CaptureWindow & { wc: Electron.WebContents }) | null = null
      let closed = false
      void captureWindow().then((w) => {
        if (closed) { w.close(); return }
        win = w; wc = w.wc
        w.wc.once('did-finish-load', () => { for (const [c, d] of q.splice(0)) w.send(c, d) })
      })
      return {
        send: (c, d) => { if (win && !win.wc.isLoading()) win.send(c, d); else q.push([c, d]) },
        close: () => { closed = true; win?.close(); wc = null },
      }
    },
  })
  void import('electron').then((m) => {
    el = m
    const { ipcMain } = m
    const from = (e: Electron.IpcMainEvent) => wc !== null && e.sender === wc
    ipcMain.on('rs:signal-out', (e, m) => { if (from(e)) void ctl.signalOut(m) })
    ipcMain.on('rs:input', (e, m) => { if (from(e)) void ctl.onInput(m) })
    ipcMain.on('rs:screen', (e, m) => { if (from(e)) ctl.setScreen(m) })
    ipcMain.on('rs:chat-in', (e, t) => { if (from(e)) ctl.chatIn(String(t)) })
    ipcMain.on('rs:ended', (e) => { if (from(e)) void ctl.ended() })
    ipcMain.on('rs:dc', (e, m) => { if (from(e)) void ctl.onMessage(m) })
    ipcMain.on('rs:dc-ack', (e) => { if (from(e)) ctl.dcAck() })
  })
  setInterval(() => { void ctl.tick() }, 1000).unref?.()
  handle('ws:remoteSupportChat', () => ctl.chatLog())
  handle('ws:remoteSupportSendChat', (text) => ctl.chatOut(text))
  handle('ws:remoteSupportState', () => b.state())
  handle('ws:remoteSupportDecide', (decision) => b.decide(decision))
  handle('ws:remoteSupportRevokeControl', () => b.revokeControl())
  handle('ws:remoteSupportDecideElevation', (allow) => b.decideElevation(allow === 'true'))
  handle('ws:remoteSupportSetClipboard', (on) => b.setClipboard(on === 'true'))
  // Files (issue #37): the list, the user's accept/decline of incoming files, and offering a file they pick.
  handle('ws:remoteSupportFiles', () => ctl.fileList())
  handle('ws:remoteSupportAcceptFile', (id) => ctl.files.accept(String(id)).catch(() => false))
  handle('ws:remoteSupportRejectFile', (id) => ctl.files.reject(String(id)).catch(() => false))
  handle('ws:remoteSupportOfferFile', async () => {
    if (!ctl.active()) return { ok: false, error: 'no_session' }
    const { dialog } = await import('electron')
    const r = await dialog.showOpenDialog({ properties: ['openFile'] })
    if (r.canceled || !r.filePaths[0]) return { ok: false, error: 'cancelled' }
    try { const f = await ctl.files.offer(r.filePaths[0]); return f ? { ok: true, value: f } : { ok: false, error: 'not_a_file' } } catch (e) { return { ok: false, error: (e as Error).message } }
  })
  handle('ws:remoteSupportEnd', () => b.end())
}
