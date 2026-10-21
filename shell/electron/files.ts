// Files (§7.2): "This Computer" (home folders and removable drives) and "WorkSuite Cloud" (~/WorkSuite Drive, a real
// local sync folder). The renderer only names a root and a relative path; every path is resolved here and must stay
// inside its root (no "..", no following symlinks out of it).
import { existsSync, lstatSync, readdirSync, realpathSync, statfsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extraMounts, readMounts } from './volumes'

export type Root = 'home' | 'drive' | `media:${string}` | `vol:${string}`
export interface Entry { name: string; dir: boolean; size: number | null; modified: number | null; state: string; local: boolean; items?: number | null }
type Reply<T> = { ok: true; value: T } | { ok: false; error: string }

export interface FileEnv { home: string; user: string; fileStates(dir: string): Promise<{ name: string; state: string }[] | null> }

export const driveDir = (home: string) => path.join(home, 'WorkSuite Drive')

/** Roots the user can browse: home, ~/WorkSuite Drive, mounted removable media (udisks2 mounts) and other mounted
 *  volumes under /mnt, /media and /run/media (This Computer, #63). What the user may read inside them is up to the
 *  filesystem's own permissions. */
export function roots(env: Pick<FileEnv, 'home' | 'user'>, mounts: () => string = readMounts): { id: Root; label: string; path: string }[] {
  const out: { id: Root; label: string; path: string }[] = [{ id: 'home', label: 'Home', path: env.home }]
  for (const base of [`/media/${env.user}`, `/run/media/${env.user}`]) {
    if (!existsSync(base)) continue
    try { for (const n of readdirSync(base)) out.push({ id: `media:${n}`, label: n, path: path.join(base, n) }) } catch { /* not readable */ }
  }
  for (const m of extraMounts(mounts(), env.user)) out.push({ id: `vol:${m}`, label: path.basename(m), path: m })
  out.push({ id: 'drive', label: 'WorkSuite Drive', path: driveDir(env.home) })
  return out
}

/** Resolve root + relative path; null if it would leave the root. */
export function resolveIn(env: Pick<FileEnv, 'home' | 'user'>, root: string, rel: string): { base: string; full: string } | null {
  const r = roots(env).find((x) => x.id === root)
  if (!r || typeof rel !== 'string' || rel.length > 4096 || rel.includes('\0')) return null
  const segs = rel.split('/').filter(Boolean)
  if (segs.some((s) => s === '..' || s === '.')) return null
  const full = path.join(r.path, ...segs)
  if (!existsSync(full)) return segs.length === 0 ? { base: r.path, full } : null
  const real = realpathSync(full), realBase = realpathSync(r.path)
  if (real !== realBase && !real.startsWith(realBase + path.sep)) return null   // symlink pointing outside the root
  return { base: r.path, full }
}

/**
 * A path dropped on Files from another app (WSOS-DSK-013) → the Files root and relative path it lies in, or null when
 * it is outside the user's places (e.g. /etc) or is a root itself. Symlinks are resolved first.
 */
export function locate(env: Pick<FileEnv, 'home' | 'user'>, abs: unknown): { root: string; rel: string } | null {
  if (typeof abs !== 'string' || !path.isAbsolute(abs) || abs.length > 4096 || abs.includes('\0')) return null
  let real: string
  try { real = realpathSync(abs) } catch { return null }
  // Longest root first: WorkSuite Drive lies inside home.
  for (const r of [...roots(env)].sort((a, b) => b.path.length - a.path.length)) {
    let base: string
    try { base = realpathSync(r.path) } catch { continue }
    if (real === base) return null
    if (real.startsWith(base + path.sep)) return { root: r.id, rel: path.relative(base, real).split(path.sep).join('/') }
  }
  return null
}

/** Dropped paths grouped by root for copy jobs; anything outside the user's places is counted as rejected. */
export function dropPlan(env: Pick<FileEnv, 'home' | 'user'>, paths: unknown[]): { groups: { root: string; rels: string[] }[]; rejected: number } {
  const by = new Map<string, string[]>()
  let rejected = 0
  for (const p of paths.slice(0, 1000)) {
    const at = locate(env, p)
    if (!at) { rejected++; continue }
    by.set(at.root, [...(by.get(at.root) ?? []), at.rel])
  }
  return { groups: [...by].map(([root, rels]) => ({ root, rels })), rejected }
}

const DRV_STATES = new Set(['synced', 'syncing', 'pending', 'conflict', 'online-only', 'error'])

export async function list(env: FileEnv, root: string, rel: string): Promise<Reply<Entry[]>> {
  const p = resolveIn(env, root, rel)
  if (!p) return { ok: false, error: 'not_found' }
  const entries = new Map<string, Entry>()
  if (existsSync(p.full)) {
    let names: string[]
    try { names = readdirSync(p.full) } catch (e) { return { ok: false, error: (e as NodeJS.ErrnoException).code === 'EACCES' ? 'denied' : 'not_found' } }
    for (const name of names) {
      if (name.startsWith('.')) continue
      try {
        const st = lstatSync(path.join(p.full, name))
        const dir = st.isDirectory()
        let items: number | null = null
        if (dir) try { items = readdirSync(path.join(p.full, name)).filter((n) => !n.startsWith('.')).length } catch { /* unreadable */ }
        entries.set(name, { name, dir, size: st.isFile() ? st.size : null, modified: st.mtimeMs, state: root === 'drive' ? 'pending' : 'local', local: true, ...(dir ? { items } : {}) })
      } catch { /* vanished or unreadable */ }
    }
  }
  if (root === 'drive') {
    const states = await env.fileStates(rel.split('/').filter(Boolean).join('/'))
    if (states === null) for (const e of entries.values()) e.state = 'unknown'          // sync service not running
    else for (const s of states) {
      if (!DRV_STATES.has(s.state)) continue
      const e = entries.get(s.name)
      if (e) e.state = s.state
      else entries.set(s.name, { name: s.name, dir: false, size: null, modified: null, state: s.state, local: false })  // online-only
    }
    // Folders carry no state of their own.
    for (const e of entries.values()) if (e.dir && e.local) e.state = 'folder'
  }
  return { ok: true, value: [...entries.values()].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)) }
}

export function freeBytes(dir: string): number | null {
  try { const s = statfsSync(dir); return s.bavail * s.bsize } catch { return null }
}

export const defaultEnv = (fileStates: FileEnv['fileStates']): FileEnv => ({ home: os.homedir(), user: os.userInfo().username, fileStates })
