// Remote support media session on the device (issue #19), main process. Nothing happens until the device agent's
// published session (remote-support.json) is "active", that is, the person at the device allowed it (or the
// organization's disclosed unattended policy did). Then a hidden capture window (rsCapture.ts) shares the screen over
// WebRTC; signalling is relayed through the WorkSuite server with the device credential (X-WS-Device); the server
// relays only for a consented, active session. Input from the viewer is applied only while the session's granted mode
// is "control", re-checked on every event, so "View only" or "End" in the taskbar takes effect immediately.
//
// Issue #37 adds, over the same data channel: file transfer both ways (rsFiles.ts; the user accepts each incoming
// file), text clipboard sync while the user has it on (rsClipboard.ts), monitor switching and quality presets asked by
// the viewer, and the chat / file-transfer audit reported to the server (metadata only). ICE servers (with short-lived
// TURN credentials) come from the server and are refreshed before they expire.
import { applyInput, openInput, parseInput, type InputBackend, type Region } from './rsInput'
import type { RsSession } from './remoteSupport'
import { ClipboardSync } from './rsClipboard'
import { FileTransfers, type FileAudit, type FileItem } from './rsFiles'
import { DEFAULT_QUALITY, isPreset, QUALITY, type QualityPreset } from './rsQuality'

export interface CaptureWindow { send(channel: string, data: unknown): void; close(): void }
export interface ChatLine { from: 'admin' | 'user'; text: string; at: number }

export interface RemoteSessionDeps {
  state(): Promise<RsSession | null>
  end(): Promise<unknown>
  credential(): string | null
  /** https://<server>/ from the agent's status, or null when not enrolled. */
  serverBase(): string | null
  fetch: typeof fetch
  openWindow(): CaptureWindow
  openInput?(): Promise<InputBackend>
  now?: () => number
  /** ~/Downloads of the signed-in user (incoming files). */
  downloadsDir(): string
  clipboard?: { read(): string; write(text: string): void }
  /** Screens the capture can switch to, and where one sits in the layout (for absolute pointer motion). */
  monitors?(): Promise<{ id: string; name: string }[]>
  selectMonitor?(id: string): Region | null
}

const ICE_REFRESH_MS = 30 * 60_000
const MAX_INFLIGHT = 16

export class RemoteSessionController {
  private cur: { id: string; win: CaptureWindow; after: number; started: boolean; iceAt: number; quality: QualityPreset; monitor: string | null } | null = null
  private input: InputBackend | null = null
  private opening: Promise<InputBackend> | null = null
  private granted: RsSession['granted_mode'] = null
  private screen = { w: 1920, h: 1080 }
  private chat: ChatLine[] = []
  private busy = false
  private region: Region | null = null
  private inflight = 0
  private drained: (() => void)[] = []
  readonly stats = { applied: 0, dropped: 0 }
  readonly files: FileTransfers
  private clip: ClipboardSync | null

  constructor(private d: RemoteSessionDeps) {
    this.files = new FileTransfers({ downloadsDir: () => d.downloadsDir(), send: (m) => this.sendDc(m), audit: (e) => this.auditFile(e) })
    this.clip = d.clipboard ? new ClipboardSync({ read: d.clipboard.read, write: d.clipboard.write, send: (m) => { void this.sendDc(m) } }) : null
  }

  chatLog(): ChatLine[] { return [...this.chat] }
  active(): string | null { return this.cur?.id ?? null }

  private url(id: string, q = '', what = 'signal') {
    const b = this.d.serverBase()
    return b ? new URL(`desktop/v1/os/remote-support/sessions/${encodeURIComponent(id)}/${what}${q}`, b).toString() : null
  }
  private headers(json = false): Record<string, string> | null {
    const c = this.d.credential()
    return c ? { 'x-ws-device': c, ...(json ? { 'content-type': 'application/json' } : {}) } : null
  }

  /** One step (every second): start, stop, and relay signalling for the current session. */
  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const s = await this.d.state().catch(() => null)
      this.granted = s?.state === 'active' ? s.granted_mode : null
      if (this.granted !== 'control') await this.closeInput()
      if (this.cur && (!s || s.state !== 'active' || s.session_id !== this.cur.id)) await this.stop()
      if (!this.cur && s?.state === 'active') this.cur = { id: s.session_id, win: this.d.openWindow(), after: 0, started: false, iceAt: 0, quality: DEFAULT_QUALITY, monitor: null }
      // Clipboard sync follows the user's switch for this session, and is off whenever there is no session.
      this.clip?.setEnabled(!!this.cur && s?.state === 'active' && s.clipboard === true)
      this.clip?.poll()
      if (this.cur) await this.pull()
      if (this.cur?.started && (this.d.now ?? Date.now)() - this.cur.iceAt > ICE_REFRESH_MS) await this.refreshIce()
    } finally { this.busy = false }
  }

  private async pull() {
    const c = this.cur!
    const url = this.url(c.id, `?after=${c.after}`), h = this.headers()
    if (!url || !h) return
    let r: Response
    try { r = await this.d.fetch(url, { headers: h, redirect: 'error', signal: AbortSignal.timeout(10_000) }) } catch { return }
    if (r.status === 409 || r.status === 404) { await this.stop(); return }
    if (!r.ok) return
    const body = await r.json() as { ice_servers?: unknown[]; messages?: { id: number; type: string }[] }
    if (!c.started) { c.started = true; c.iceAt = (this.d.now ?? Date.now)(); c.win.send('rs:start', { iceServers: body.ice_servers ?? [], maxFps: 30, quality: QUALITY[c.quality] }) }
    for (const m of body.messages ?? []) { c.after = Math.max(c.after, m.id); c.win.send('rs:signal-in', m) }
  }

  /** Fresh TURN credentials before the old ones expire (used by the next reconnect). */
  private async refreshIce() {
    const c = this.cur!
    c.iceAt = (this.d.now ?? Date.now)()
    const url = this.url(c.id, '', 'ice-servers'), h = this.headers()
    if (!url || !h) return
    try {
      const r = await this.d.fetch(url, { headers: h, redirect: 'error', signal: AbortSignal.timeout(10_000) })
      if (r.ok) c.win.send('rs:ice', ((await r.json()) as { ice_servers?: unknown[] }).ice_servers ?? [])
    } catch { /* keep the current ones */ }
  }

  /** Audit of chat and file transfers: metadata only (lengths, names, sizes, hashes), best effort. */
  private async event(body: Record<string, unknown>) {
    const c = this.cur
    const url = c && this.url(c.id, '', 'events'), h = this.headers(true)
    if (!url || !h) return
    await this.d.fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10_000) }).catch(() => {})
  }
  private auditFile(e: FileAudit) { void this.event({ kind: 'file', ...e }) }

  /** To the viewer over the data channel, paced by the capture window's acknowledgements. */
  async sendDc(m: Record<string, unknown>): Promise<void> {
    const c = this.cur
    if (!c) throw new Error('no_session')
    while (this.inflight >= MAX_INFLIGHT) await new Promise<void>((r) => this.drained.push(r))
    if (this.cur !== c) throw new Error('no_session')
    this.inflight++
    c.win.send('rs:dc-send', JSON.stringify(m))
  }
  /** The capture window sent one message (and its buffer is below its high-water mark). */
  dcAck() { this.inflight = Math.max(0, this.inflight - 1); this.drained.shift()?.() }

  /** Other data-channel messages from the viewer: files, clipboard, quality, monitors. */
  async onMessage(raw: unknown) {
    const c = this.cur
    if (!c || !raw || typeof raw !== 'object') return
    const m = raw as Record<string, unknown>
    if (typeof m.t !== 'string') return
    if (m.t.startsWith('f-')) { await this.files.onMessage(m).catch(() => false); return }
    if (m.t === 'clip') { this.clip?.incoming(m); return }
    if (m.t === 'q' && isPreset(m.preset)) { c.quality = m.preset; c.win.send('rs:quality', QUALITY[m.preset]); return }
    if (m.t === 'mon-list' && this.d.monitors) {
      const items = await this.d.monitors().catch(() => [])
      await this.sendDc({ t: 'mons', items, current: c.monitor }).catch(() => {})
      return
    }
    if (m.t === 'mon' && typeof m.id === 'string' && this.d.monitors && this.d.selectMonitor) {
      const items = await this.d.monitors().catch(() => [])
      if (!items.some((x) => x.id === m.id)) return
      c.monitor = m.id
      this.region = this.d.selectMonitor(m.id)
      ;(this.input as { setRegion?(r: Region | null): void } | null)?.setRegion?.(this.region)
      c.win.send('rs:switch', { id: m.id })
    }
  }

  fileList(): FileItem[] { return this.cur ? this.files.list() : [] }

  /** From the capture window. */
  async signalOut(m: unknown) {
    const c = this.cur
    const url = c && this.url(c.id), h = this.headers(true)
    if (!url || !h || !m || typeof m !== 'object') return
    await this.d.fetch(url, { method: 'POST', headers: h, body: JSON.stringify(m), redirect: 'error', signal: AbortSignal.timeout(10_000) }).catch(() => {})
  }

  setScreen(s: unknown) {
    const v = s as { w?: unknown; h?: unknown }
    if (Number.isInteger(v?.w) && Number.isInteger(v?.h) && (v.w as number) > 0 && (v.h as number) > 0) this.screen = { w: v.w as number, h: v.h as number }
  }

  /** Viewer input: applied only while the user's grant is "control" for this very session. */
  async onInput(raw: unknown) {
    const m = parseInput(raw)
    if (!m || !this.cur) { this.stats.dropped++; return }
    const s = await this.d.state().catch(() => null)
    if (!s || s.state !== 'active' || s.session_id !== this.cur.id || s.granted_mode !== 'control') { this.stats.dropped++; await this.closeInput(); return }
    try {
      if (!this.input) {
        this.input = await (this.opening ??= (this.d.openInput ?? (() => openInput()))())
        ;(this.input as { setRegion?(r: Region | null): void }).setRegion?.(this.region)
      }
      await applyInput(this.input, m, this.screen)
      this.stats.applied++
    } catch { this.stats.dropped++ } finally { this.opening = null }
  }

  chatIn(text: string) {
    const t = text.slice(0, 500)
    if (!this.cur || !t.trim()) return
    this.chat.push({ from: 'admin', text: t, at: (this.d.now ?? Date.now)() })
    this.chat = this.chat.slice(-100)
    void this.event({ kind: 'chat', direction: 'to_device', length: t.length })
  }
  chatOut(text: string): boolean {
    const t = text.trim().slice(0, 500)
    if (!this.cur || !t) return false
    this.cur.win.send('rs:chat-out', t)
    this.chat.push({ from: 'user', text: t, at: (this.d.now ?? Date.now)() })
    void this.event({ kind: 'chat', direction: 'to_admin', length: t.length })
    return true
  }

  /** Capture refused or stopped from outside (Stop sharing, emergency stop): the whole session ends. */
  async ended() { await this.d.end().catch(() => {}); await this.stop() }

  private async closeInput() { const i = this.input; this.input = null; await i?.close().catch(() => {}) }

  async stop() {
    const c = this.cur
    if (!c) return
    await this.files.clear().catch(() => {})
    this.cur = null
    await this.closeInput()
    this.clip?.setEnabled(false)
    this.region = null
    this.inflight = 0
    for (const r of this.drained.splice(0)) r()
    const url = this.url(c.id), h = this.headers(true)
    if (url && h) await this.d.fetch(url, { method: 'POST', headers: h, body: JSON.stringify({ type: 'bye' }), redirect: 'error' }).catch(() => {})
    c.win.close()
    this.chat = []
  }
}
