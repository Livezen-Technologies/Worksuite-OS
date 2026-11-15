// Durable, crash-safe storage for the setup state (SetupPersistence). Each write goes to a temp file, is fsynced,
// renamed over the old file and the directory fsynced, so a power cut leaves either the old or the new state, never
// a torn one. During an OS install the state is mirrored: on the ESP (exists from the start of the install and
// survives the reboot) and on the target root once it is mounted. Loading takes the newest copy whose checksum is
// valid, so one damaged copy falls back to the other. Files are root-only (0600 in a 0700 directory).
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import path from 'node:path'
import { deserialize, type SetupPersistence } from './machine/core/SetupPersistence.ts'

export const FILE = 'state.json'

function writeAtomic(dir: string, body: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = path.join(dir, `.${FILE}.${process.pid}.tmp`)
  const fd = openSync(tmp, 'w', 0o600)
  try { writeSync(fd, body); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, path.join(dir, FILE))
  const d = openSync(dir, 'r')
  try { fsyncSync(d) } finally { closeSync(d) }
}

export class MirroredFileStore implements SetupPersistence {
  private dirs: string[]
  /** `dirs`: where copies live, most durable first. More can be added once mounted (`addMirror`). */
  constructor(dirs: string[]) { this.dirs = [...new Set(dirs)] }

  /** The target root became available (installer): keep a copy there from now on. */
  addMirror(dir: string) { if (!this.dirs.includes(dir)) this.dirs.push(dir) }
  mirrors(): readonly string[] { return this.dirs }

  async load(): Promise<string | null> {
    let best: { raw: string; at: number } | null = null
    for (const d of this.dirs) {
      let raw: string
      try { raw = readFileSync(path.join(d, FILE), 'utf8') } catch { continue }
      const r = deserialize(raw)
      if (r.ok && (!best || r.snapshot.updatedAt > best.at)) best = { raw, at: r.snapshot.updatedAt }
      // A damaged copy is skipped; if every copy is damaged, return one so the machine reports "corrupt".
      if (!r.ok && !best) best = { raw, at: -1 }
    }
    return best?.raw ?? null
  }

  async save(serialized: string) {
    const errors: string[] = []
    for (const d of this.dirs) { try { writeAtomic(d, serialized) } catch (e) { errors.push(`${d}: ${(e as Error).message}`) } }
    // At least one durable copy must exist, or setup must not continue as if its state were saved.
    if (errors.length === this.dirs.length) throw new Error(`setup state could not be saved: ${errors.join('; ')}`)
  }

  async clear() { for (const d of this.dirs) rmSync(path.join(d, FILE), { force: true }) }
}
