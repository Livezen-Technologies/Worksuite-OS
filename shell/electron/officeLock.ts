// WSOS-DRV-003: opening a Drive document in WorkSuite Office takes the server file lock through the sync service
// (LockFile/UnlockFile, services/sync/src/locks.ts) and releases it once the document is closed. Office may hand the
// file to an already running instance and exit at once, so "still open" means: our launch is still running, or
// Office's own lock file sits next to the document (.~lock.<name># or ~$<name>). When someone else holds the lock
// the user gets a read-only copy instead, so two people never edit the same Drive document.
import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const OFFICE_EXT = /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf)$/i
export const isOfficeDoc = (name: string) => OFFICE_EXT.test(name)

/** Lock files Office editors keep next to an open document. */
export function officeLockFiles(full: string): string[] {
  const dir = path.dirname(full); const name = path.basename(full)
  return [path.join(dir, `.~lock.${name}#`), path.join(dir, `~$${name}`)]
}

type Reply = { ok: true; value: unknown } | { ok: false; error: string }
export interface OfficeLockDeps {
  syncCall(method: string, params: Record<string, unknown>): Promise<Reply>
  /** Starts Office on `file`; resolves when that process exits. */
  launch(file: string): Promise<void>
  exists?(p: string): boolean
  copyReadOnly?(full: string): string
  sleep?(ms: number): Promise<void>
  pollMs?: number
}

export type OpenOutcome = 'locked_and_open' | 'read_only_copy' | 'opened_unlocked'

const realCopy = (full: string): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'worksuite-readonly-'))
  const out = path.join(dir, path.basename(full))
  copyFileSync(full, out)
  chmodSync(out, 0o444)
  return out
}

/**
 * Opens a Drive document in Office under the server lock. `rel` is the Drive-relative path the sync service knows.
 * Resolves as soon as Office has been started; the lock is released in the background when the document closes.
 */
export async function openWithLock(rel: string, full: string, d: OfficeLockDeps): Promise<{ outcome: OpenOutcome; released: Promise<void> }> {
  const exists = d.exists ?? existsSync
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const r = await d.syncCall('LockFile', { path: rel })
  const lock = r.ok ? (r.value as { ok: boolean; error?: string }) : { ok: false, error: r.error }
  if (!lock.ok && lock.error === 'locked') {
    void d.launch((d.copyReadOnly ?? realCopy)(full))
    return { outcome: 'read_only_copy', released: Promise.resolve() }
  }
  const running = d.launch(full)
  if (!lock.ok) return { outcome: 'opened_unlocked', released: Promise.resolve() }
  const released = (async () => {
    let exited = false
    void running.then(() => { exited = true })
    // Give Office time to create its lock file before trusting "no lock file".
    await sleep(d.pollMs ?? 10_000)
    while (!exited || officeLockFiles(full).some(exists)) await sleep(d.pollMs ?? 10_000)
    await d.syncCall('UnlockFile', { path: rel })
  })()
  return { outcome: 'locked_and_open', released }
}

/** Runs the scoped Office command and resolves when it exits. */
export function launchAndWait(cmd: [string, string[]]): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn(cmd[0], cmd[1], { stdio: 'ignore' })
    p.on('error', () => resolve())
    p.on('exit', () => resolve())
  })
}
