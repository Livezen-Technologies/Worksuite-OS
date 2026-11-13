// Files a person picked to install (a local .deb, an offline .wsupdate on a USB drive) reach the package service
// through its inbox: this process, running as the person, copies the file into /var/spool/worksuite-incoming (root,
// 1733) under a random name, the service reads it there (its AppArmor profile allows that directory and nothing in
// home folders or on removable media), and the copy is removed once the call returns. The service stages its own
// root-owned copy during the call, so nothing it does later depends on this file.
import { randomUUID } from 'node:crypto'
import { constants, promises as fsp } from 'node:fs'
import path from 'node:path'

export const INBOX = '/var/spool/worksuite-incoming'

export interface InboxFs {
  copyFile(src: string, dest: string, mode: number): Promise<void>
  chmod(p: string, mode: number): Promise<void>
  rm(p: string, o: { force: boolean }): Promise<void>
}
const realFs: InboxFs = { copyFile: (s, d, m) => fsp.copyFile(s, d, m), chmod: (p, m) => fsp.chmod(p, m), rm: (p, o) => fsp.rm(p, o) }

/** Copy `src` into the inbox, run `fn` with the copy's path, remove the copy. A failed copy is 'inbox_failed'. */
export async function viaInbox<T>(src: string, ext: '.deb' | '.wsupdate', fn: (p: string) => Promise<T>,
  o: { fs?: InboxFs; dir?: string } = {}): Promise<T | { ok: false; error: string }> {
  const fs = o.fs ?? realFs
  const dest = path.join(o.dir ?? INBOX, `${randomUUID()}${ext}`)
  try {
    // COPYFILE_EXCL: never write through a name someone else created first.
    await fs.copyFile(src, dest, constants.COPYFILE_EXCL)
    await fs.chmod(dest, 0o600)
  } catch {
    await fs.rm(dest, { force: true }).catch(() => {})
    return { ok: false, error: 'inbox_failed' }
  }
  try { return await fn(dest) } finally { await fs.rm(dest, { force: true }).catch(() => {}) }
}
