// Files (§7.2): "This Computer" (home folders and removable drives) and "WorkSuite Cloud" (~/WorkSuite Drive, a real
// local sync folder). The renderer only names a root and a relative path; every path is resolved here and must stay
// inside its root (no "..", no following symlinks out of it).
import { existsSync, lstatSync, readdirSync, realpathSync, statfsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type Root = 'home' | 'drive' | `media:${string}`
export interface Entry { name: string; dir: boolean; size: number | null; modified: number | null; state: string; local: boolean }
type Reply<T> = { ok: true; value: T } | { ok: false; error: string }

export interface FileEnv { home: string; user: string; fileStates(dir: string): Promise<{ name: string; state: string }[] | null> }

export const driveDir = (home: string) => path.join(home, 'WorkSuite Drive')

/** Roots the user can browse: home, ~/WorkSuite Drive, and mounted removable media (udisks2 mounts). */
export function roots(env: Pick<FileEnv, 'home' | 'user'>): { id: Root; label: string; path: string }[] {
  const out: { id: Root; label: string; path: string }[] = [{ id: 'home', label: 'Home', path: env.home }]
  for (const base of [`/media/${env.user}`, `/run/media/${env.user}`]) {
    if (!existsSync(base)) continue
    for (const n of readdirSync(base)) out.push({ id: `media:${n}`, label: n, path: path.join(base, n) })
  }
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

const DRV_STATES = new Set(['synced', 'syncing', 'pending', 'conflict', 'online-only', 'error'])

export async function list(env: FileEnv, root: string, rel: string): Promise<Reply<Entry[]>> {
  const p = resolveIn(env, root, rel)
  if (!p) return { ok: false, error: 'not_found' }
  const entries = new Map<string, Entry>()
  if (existsSync(p.full)) {
    for (const name of readdirSync(p.full)) {
      if (name.startsWith('.')) continue
      try {
        const st = lstatSync(path.join(p.full, name))
        entries.set(name, { name, dir: st.isDirectory(), size: st.isFile() ? st.size : null, modified: st.mtimeMs, state: root === 'drive' ? 'pending' : 'local', local: true })
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
