// Rollback handles: taken before a reversible or destructive step, verified, and used to undo it. A provider that
// cannot give a real handle returns null, and the machine then never offers rollback for that step.
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Checkpoint } from './machine/core/SetupPersistence.ts'

export type Handle = NonNullable<Checkpoint['rollback']>
export interface Runner { run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> }

export interface Provider {
  kind: Handle['kind']
  take(): Promise<Handle | null>
  verify(h: Handle): Promise<boolean>
  undo(h: Handle): Promise<string>   // what was done, for the log
}

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')

/** Configuration files the final step changes: copies plus a hash manifest; files that did not exist are deleted
 *  again on undo. */
export function configBackup(dir: string, files: () => string[]): Provider {
  return {
    kind: 'config-backup',
    async take() {
      const id = randomUUID(), at = path.join(dir, id)
      mkdirSync(at, { recursive: true, mode: 0o700 })
      const manifest = files().map((f, i) => {
        if (!existsSync(f)) return { f, copy: null, sum: null }
        const copy = path.join(at, String(i)); copyFileSync(f, copy)
        return { f, copy, sum: sha(copy) }
      })
      writeFileSync(path.join(at, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 })
      const h: Handle = { kind: 'config-backup', ref: id, verified: false }
      h.verified = await this.verify(h)
      return h
    },
    async verify(h) {
      try {
        const m = JSON.parse(readFileSync(path.join(dir, h.ref, 'manifest.json'), 'utf8')) as { copy: string | null; sum: string | null }[]
        return m.every((e) => e.copy === null || sha(e.copy) === e.sum)
      } catch { return false }
    },
    async undo(h) {
      if (!(await this.verify(h))) throw new Error('the configuration backup is damaged; nothing was changed')
      const m = JSON.parse(readFileSync(path.join(dir, h.ref, 'manifest.json'), 'utf8')) as { f: string; copy: string | null }[]
      for (const e of m) {
        if (e.copy === null) { rmSync(e.f, { force: true }); continue }
        const tmp = `${e.f}.worksuite-restore`; copyFileSync(e.copy, tmp); renameSync(tmp, e.f)
      }
      return `restored ${m.length} configuration file(s)`
    },
  }
}

/** Packages: the installed set before the step; undo removes only what was added since, never what was there. */
export function packageTransaction(dir: string, runner: Runner): Provider {
  const list = async () => {
    const r = await runner.run('dpkg-query', ['-W', '-f=${Package}\\n'])
    if (r.code !== 0) throw new Error(`dpkg-query failed: ${r.stderr.trim()}`)
    return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  }
  return {
    kind: 'package-transaction',
    async take() {
      const id = randomUUID(); mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(path.join(dir, `${id}.list`), (await list()).join('\n'), { mode: 0o600 })
      return { kind: 'package-transaction', ref: id, verified: await this.verify({ kind: 'package-transaction', ref: id, verified: false }) }
    },
    async verify(h) { try { return readFileSync(path.join(dir, `${h.ref}.list`), 'utf8').split('\n').filter(Boolean).length > 0 } catch { return false } },
    async undo(h) {
      const before = new Set(readFileSync(path.join(dir, `${h.ref}.list`), 'utf8').split('\n').filter(Boolean))
      const added = (await list()).filter((p) => !before.has(p))
      if (!added.length) return 'no packages to remove'
      // Package names come from dpkg itself; still refuse anything that is not a package name.
      if (!added.every((p) => /^[a-z0-9][a-z0-9+.:-]*$/.test(p))) throw new Error('unexpected package name from dpkg')
      const r = await runner.run('apt-get', ['-y', '-q', '-o', 'DPkg::Lock::Timeout=300', 'remove', '--', ...added])
      if (r.code !== 0) throw new Error(`apt-get remove failed: ${r.stderr.trim().split('\n')[0]}`)
      return `removed ${added.length} package(s): ${added.join(' ')}`
    },
  }
}

/** A read-only btrfs snapshot of an existing system before it is replaced. Only on btrfs; ext4 (the default
 *  layout) has no snapshot, so OS rollback is not offered there. Undo makes the snapshot the default subvolume:
 *  the previous system starts at the next boot. Files written since are not merged back. */
export function btrfsSnapshot(root: () => string | null, runner: Runner): Provider {
  return {
    kind: 'snapshot',
    async take() {
      const r = root(); if (!r) return null
      const fs = await runner.run('findmnt', ['-no', 'FSTYPE', '--target', r])
      if (fs.code !== 0 || fs.stdout.trim() !== 'btrfs') return null
      const name = `worksuite-setup-${Date.now()}`
      const dest = path.join(r, '.snapshots', name)
      await runner.run('mkdir', ['-p', path.join(r, '.snapshots')])
      const s = await runner.run('btrfs', ['subvolume', 'snapshot', '-r', r, dest])
      if (s.code !== 0) return null
      const h: Handle = { kind: 'snapshot', ref: dest, verified: false }
      h.verified = await this.verify(h)
      return h
    },
    async verify(h) { return (await runner.run('btrfs', ['subvolume', 'show', h.ref])).code === 0 },
    async undo(h) {
      if (!(await this.verify(h))) throw new Error('the snapshot is gone; the previous system cannot be restored')
      const id = await runner.run('btrfs', ['subvolume', 'show', h.ref])
      const m = /Subvolume ID:\s+(\d+)/.exec(id.stdout); if (!m) throw new Error('could not read the snapshot id')
      const r = await runner.run('btrfs', ['subvolume', 'set-default', m[1], h.ref])
      if (r.code !== 0) throw new Error(`btrfs set-default failed: ${r.stderr.trim()}`)
      return 'the previous system starts at the next restart'
    },
  }
}
