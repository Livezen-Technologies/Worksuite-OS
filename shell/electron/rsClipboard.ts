// Remote support clipboard sync (issue #37): text only, and only while the person at the device has turned it on for
// this session (the agent's published session.clipboard). Turning it off, dropping to a new session or ending stops it
// at once: nothing is read from or written to the clipboard while it is off.
export const CLIP_MAX = 64 * 1024

// Electron 44+ clipboard reads and writes are asynchronous (readText/writeText return promises).
export interface ClipDeps { read(): string | Promise<string>; write(text: string): void | Promise<void>; send(m: { t: 'clip'; text: string }): void }

export class ClipboardSync {
  private last: string | null = null
  private on = false
  constructor(private d: ClipDeps) {}

  get enabled() { return this.on }

  /** Follows the user's switch; when it turns on, the current text is the baseline (not sent unasked). */
  async setEnabled(on: boolean): Promise<void> {
    if (on === this.on) return
    this.on = on
    this.last = null
    if (!on) return
    const t = await this.safeRead()
    // Turned off again while reading: keep nothing.
    if (this.on) this.last = t
  }

  /** Every second while enabled: a changed local clipboard is sent to the viewer. */
  async poll(): Promise<boolean> {
    if (!this.on) return false
    const t = await this.safeRead()
    if (!this.on || t === null || t === this.last) return false
    this.last = t
    if (!t || t.length > CLIP_MAX) return false
    this.d.send({ t: 'clip', text: t })
    return true
  }

  /** From the viewer. Ignored while off; oversize or non-text is dropped. */
  incoming(m: unknown): boolean {
    if (!this.on || !m || typeof m !== 'object') return false
    const text = (m as { text?: unknown }).text
    if (typeof text !== 'string' || !text || text.length > CLIP_MAX) return false
    this.last = text
    try { void Promise.resolve(this.d.write(text)).catch(() => {}) } catch { /* clipboard unavailable */ }
    return true
  }

  private async safeRead(): Promise<string | null> { try { return await this.d.read() } catch { return null } }
}
