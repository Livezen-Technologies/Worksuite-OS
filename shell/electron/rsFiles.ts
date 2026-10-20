// Remote support file transfer over the session's data channel (issue #37), on the device.
//   Administrator → device: the viewer offers a file; nothing is written until the person at the device accepts that
//   file; it then arrives in 64 KiB chunks (base64 in JSON), is checked against its size and SHA-256 and lands in
//   ~/Downloads under a name that never replaces an existing file.
//   Device → administrator: the person at the device picks a file to offer; the administrator downloads it from the
//   viewer. Nothing on the device is readable by the viewer unless it was offered this way.
// Every step (offered, accepted, rejected, completed, failed, cancelled) is reported for the server's audit, with the
// file's name, size and hash, never its contents.
import { createHash, randomBytes, type Hash } from 'node:crypto'
import { open, rename, rm, stat, mkdir, access, type FileHandle } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

export const FILE_MAX = 200 * 1024 * 1024
export const CHUNK = 64 * 1024
const MAX_PENDING = 5
const ID = /^[A-Za-z0-9_-]{6,40}$/

export type FileAction = 'offered' | 'accepted' | 'rejected' | 'completed' | 'failed' | 'cancelled'
export interface FileAudit { direction: 'to_device' | 'to_admin'; action: FileAction; name: string; size: number; sha256?: string; reason?: string }
export interface FileItem { id: string; name: string; size: number; direction: 'to_device' | 'to_admin'; state: 'offered' | 'receiving' | 'sending' | 'done' | 'failed'; done: number; saved_as?: string }

export interface FileDeps {
  downloadsDir(): string
  send(m: Record<string, unknown>): Promise<void> | void
  audit(e: FileAudit): void
  limit?: number
}

/** A name safe to create in Downloads: no path, no control characters, no leading dot, at most 200 characters. */
export function safeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let n = basename(raw.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f/]/g, '').trim().replace(/^\.+/, '')
  if (n.length > 200) { const e = extname(n).slice(0, 20); n = n.slice(0, 200 - e.length) + e }
  return n && n !== '.' && n !== '..' ? n : null
}

async function exists(p: string) { try { await access(p); return true } catch { return false } }

/** "report.pdf", "report (1).pdf", … the first one not taken. */
export async function uniquePath(dir: string, name: string): Promise<string> {
  const e = extname(name), stem = e ? name.slice(0, -e.length) : name
  for (let i = 0; i < 1000; i++) {
    const p = join(dir, i ? `${stem} (${i})${e}` : name)
    if (!(await exists(p))) return p
  }
  throw new Error('no_free_name')
}

interface Incoming extends FileItem { fh?: FileHandle; part?: string; hash?: Hash; seq: number }
interface Outgoing extends FileItem { path: string }

export class FileTransfers {
  private inc = new Map<string, Incoming>()
  private out = new Map<string, Outgoing>()
  private limit: number
  constructor(private d: FileDeps) { this.limit = d.limit ?? FILE_MAX }

  list(): FileItem[] {
    const strip = ({ id, name, size, direction, state, done, saved_as }: FileItem): FileItem => ({ id, name, size, direction, state, done, ...(saved_as ? { saved_as } : {}) })
    return [...this.inc.values(), ...this.out.values()].map(strip)
  }

  /** Data-channel messages whose type starts with "f-". Returns false for anything malformed. */
  async onMessage(m: Record<string, unknown>): Promise<boolean> {
    const id = typeof m.id === 'string' && ID.test(m.id) ? m.id : null
    if (!id) return false
    switch (m.t) {
      case 'f-offer': return this.offered(id, m)
      case 'f-chunk': return this.chunk(id, m)
      case 'f-end': return this.end(id, m)
      case 'f-cancel': await this.cancel(id, 'cancelled_by_admin'); return true
      case 'f-get': return this.upload(id)
      case 'f-reject': { const o = this.out.get(id); if (!o) return false; this.out.delete(id); this.d.audit({ direction: 'to_admin', action: 'rejected', name: o.name, size: o.size, reason: 'declined_by_admin' }); return true }
      default: return false
    }
  }

  private async offered(id: string, m: Record<string, unknown>): Promise<boolean> {
    const name = safeName(m.name)
    const size = m.size
    if (!name || !Number.isInteger(size) || (size as number) < 0 || this.inc.has(id)) return false
    if ((size as number) > this.limit || [...this.inc.values()].filter((f) => f.state === 'offered' || f.state === 'receiving').length >= MAX_PENDING) {
      await this.d.send({ t: 'f-reject', id, reason: (size as number) > this.limit ? 'too_large' : 'busy' })
      this.d.audit({ direction: 'to_device', action: 'rejected', name, size: size as number, reason: (size as number) > this.limit ? 'too_large' : 'busy' })
      return true
    }
    this.inc.set(id, { id, name, size: size as number, direction: 'to_device', state: 'offered', done: 0, seq: 0 })
    this.d.audit({ direction: 'to_device', action: 'offered', name, size: size as number })
    return true
  }

  /** The person at the device accepted this incoming file. */
  async accept(id: string): Promise<boolean> {
    const f = this.inc.get(id)
    if (!f || f.state !== 'offered') return false
    const dir = this.d.downloadsDir()
    await mkdir(dir, { recursive: true })
    f.part = join(dir, `.${f.name}.${randomBytes(4).toString('hex')}.wsrs-part`)
    f.fh = await open(f.part, 'wx', 0o600)
    f.hash = createHash('sha256')
    f.state = 'receiving'
    this.d.audit({ direction: 'to_device', action: 'accepted', name: f.name, size: f.size })
    await this.d.send({ t: 'f-accept', id })
    return true
  }

  async reject(id: string): Promise<boolean> {
    const f = this.inc.get(id)
    if (!f || f.state !== 'offered') return false
    this.inc.delete(id)
    this.d.audit({ direction: 'to_device', action: 'rejected', name: f.name, size: f.size, reason: 'declined' })
    await this.d.send({ t: 'f-reject', id, reason: 'declined' })
    return true
  }

  private async chunk(id: string, m: Record<string, unknown>): Promise<boolean> {
    const f = this.inc.get(id)
    if (!f || f.state !== 'receiving' || m.seq !== f.seq || typeof m.data !== 'string' || m.data.length > Math.ceil(CHUNK / 3) * 4) return false
    const b = Buffer.from(m.data, 'base64')
    if (f.done + b.length > f.size) { await this.fail(f, 'size_mismatch'); return false }
    await f.fh!.write(b)
    f.hash!.update(b)
    f.done += b.length
    f.seq++
    return true
  }

  private async end(id: string, m: Record<string, unknown>): Promise<boolean> {
    const f = this.inc.get(id)
    if (!f || f.state !== 'receiving') return false
    const sha = f.hash!.digest('hex')
    if (f.done !== f.size || m.sha256 !== sha) { await this.fail(f, f.done !== f.size ? 'size_mismatch' : 'hash_mismatch'); return false }
    await f.fh!.close(); f.fh = undefined
    const dest = await uniquePath(this.d.downloadsDir(), f.name)
    await rename(f.part!, dest)
    Object.assign(f, { state: 'done', saved_as: basename(dest) })
    this.d.audit({ direction: 'to_device', action: 'completed', name: f.name, size: f.size, sha256: sha })
    await this.d.send({ t: 'f-done', id, ok: true })
    return true
  }

  private async fail(f: Incoming, reason: string) {
    await f.fh?.close().catch(() => {}); f.fh = undefined
    if (f.part) await rm(f.part, { force: true })
    f.state = 'failed'
    this.d.audit({ direction: 'to_device', action: 'failed', name: f.name, size: f.size, reason })
    await this.d.send({ t: 'f-done', id: f.id, ok: false, reason })
  }

  async cancel(id: string, reason = 'cancelled') {
    const f = this.inc.get(id)
    if (f && (f.state === 'offered' || f.state === 'receiving')) {
      await f.fh?.close().catch(() => {}); f.fh = undefined
      if (f.part) await rm(f.part, { force: true })
      this.inc.delete(id)
      this.d.audit({ direction: 'to_device', action: 'cancelled', name: f.name, size: f.size, reason })
    }
  }

  /** The person at the device offers one of their files to the administrator. */
  async offer(path: string): Promise<FileItem | null> {
    const st = await stat(path).catch(() => null)
    const name = safeName(basename(path))
    if (!st?.isFile() || !name) return null
    if (st.size > this.limit) throw new Error('too_large')
    const id = randomBytes(12).toString('base64url')
    const o: Outgoing = { id, name, size: st.size, direction: 'to_admin', state: 'offered', done: 0, path }
    this.out.set(id, o)
    this.d.audit({ direction: 'to_admin', action: 'offered', name, size: st.size })
    await this.d.send({ t: 'f-offer', id, name, size: st.size })
    return { id, name, size: st.size, direction: 'to_admin', state: 'offered', done: 0 }
  }

  /** The administrator asked for an offered file: it is streamed with its hash at the end. */
  private async upload(id: string): Promise<boolean> {
    const o = this.out.get(id)
    if (!o || o.state !== 'offered') return false
    o.state = 'sending'
    const h = createHash('sha256')
    let fh: FileHandle | null = null
    try {
      fh = await open(o.path, 'r')
      const buf = Buffer.alloc(CHUNK)
      for (let seq = 0; ; seq++) {
        const { bytesRead } = await fh.read(buf, 0, CHUNK, null)
        if (!bytesRead) break
        if (o.done + bytesRead > o.size) throw new Error('file_changed')
        const b = buf.subarray(0, bytesRead)
        h.update(b)
        o.done += bytesRead
        await this.d.send({ t: 'f-chunk', id, seq, data: b.toString('base64') })
        if (!this.out.has(id)) throw new Error('cancelled')
      }
      if (o.done !== o.size) throw new Error('file_changed')
      const sha256 = h.digest('hex')
      await this.d.send({ t: 'f-end', id, sha256 })
      o.state = 'done'
      this.d.audit({ direction: 'to_admin', action: 'completed', name: o.name, size: o.size, sha256 })
      return true
    } catch (e) {
      o.state = 'failed'
      this.d.audit({ direction: 'to_admin', action: 'failed', name: o.name, size: o.size, reason: String((e as Error).message).slice(0, 60) })
      await this.d.send({ t: 'f-cancel', id })
      return false
    } finally { await fh?.close().catch(() => {}) }
  }

  /** Session over: unfinished incoming files are removed, offers withdrawn. */
  async clear() {
    for (const id of [...this.inc.keys()]) await this.cancel(id, 'session_ended')
    this.inc.clear(); this.out.clear()
  }
}
