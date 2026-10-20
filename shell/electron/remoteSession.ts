// Remote support media session on the device (issue #19), main process. Nothing happens until the device agent's
// published session (remote-support.json) is "active", that is, the person at the device allowed it (or the
// organization's disclosed unattended policy did). Then a hidden capture window (rsCapture.ts) shares the screen over
// WebRTC; signalling is relayed through the WorkSuite server with the device credential (X-WS-Device); the server
// relays only for a consented, active session. Input from the viewer is applied only while the session's granted mode
// is "control", re-checked on every event, so "View only" or "End" in the taskbar takes effect immediately.
import type { Exec } from './system'
import { applyInput, openInput, parseInput, type InputBackend } from './rsInput'
import type { RsSession } from './remoteSupport'

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
  exec: Exec
  now?: () => number
}

export class RemoteSessionController {
  private cur: { id: string; win: CaptureWindow; after: number; started: boolean } | null = null
  private input: InputBackend | null = null
  private opening: Promise<InputBackend> | null = null
  private granted: RsSession['granted_mode'] = null
  private screen = { w: 1920, h: 1080 }
  private chat: ChatLine[] = []
  private busy = false
  readonly stats = { applied: 0, dropped: 0 }

  constructor(private d: RemoteSessionDeps) {}

  chatLog(): ChatLine[] { return [...this.chat] }
  active(): string | null { return this.cur?.id ?? null }

  private url(id: string, q = '') {
    const b = this.d.serverBase()
    return b ? new URL(`desktop/v1/os/remote-support/sessions/${encodeURIComponent(id)}/signal${q}`, b).toString() : null
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
      if (!this.cur && s?.state === 'active') this.cur = { id: s.session_id, win: this.d.openWindow(), after: 0, started: false }
      if (this.cur) await this.pull()
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
    if (!c.started) { c.started = true; c.win.send('rs:start', { iceServers: body.ice_servers ?? [], maxFps: 30 }) }
    for (const m of body.messages ?? []) { c.after = Math.max(c.after, m.id); c.win.send('rs:signal-in', m) }
  }

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
      if (!this.input) this.input = await (this.opening ??= (this.d.openInput ?? (() => openInput(this.d.exec)))())
      await applyInput(this.input, m, this.screen)
      this.stats.applied++
    } catch { this.stats.dropped++ } finally { this.opening = null }
  }

  chatIn(text: string) { if (this.cur && text.trim()) this.chat.push({ from: 'admin', text: text.slice(0, 500), at: (this.d.now ?? Date.now)() }); this.chat = this.chat.slice(-100) }
  chatOut(text: string): boolean {
    const t = text.trim().slice(0, 500)
    if (!this.cur || !t) return false
    this.cur.win.send('rs:chat-out', t)
    this.chat.push({ from: 'user', text: t, at: (this.d.now ?? Date.now)() })
    return true
  }

  /** Capture refused or stopped from outside (Stop sharing, emergency stop): the whole session ends. */
  async ended() { await this.d.end().catch(() => {}); await this.stop() }

  private async closeInput() { const i = this.input; this.input = null; await i?.close().catch(() => {}) }

  async stop() {
    const c = this.cur
    if (!c) return
    this.cur = null
    await this.closeInput()
    const url = this.url(c.id), h = this.headers(true)
    if (url && h) await this.d.fetch(url, { method: 'POST', headers: h, body: JSON.stringify({ type: 'bye' }), redirect: 'error' }).catch(() => {})
    c.win.close()
    this.chat = []
  }
}
