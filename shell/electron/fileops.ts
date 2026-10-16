// Files (§7.2) operations beyond listing: places, Recent (XDG recently-used.xbel), Starred (~/.config/worksuite),
// search, new folder, rename, freedesktop.org Trash, copy/move jobs with conflict prompts, and eject.
// The renderer only names roots and relative paths; everything is resolved through resolveIn and stays inside a root.
import { execFile } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statfsSync, writeFileSync } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { resolveIn, roots, type FileEnv } from './files'

type Reply<T> = { ok: true; value: T } | { ok: false; error: string }
type Env = Pick<FileEnv, 'home' | 'user'>
export interface Hit { root: string; rel: string; name: string; dir: boolean; size: number | null; modified: number | null; where: string }

const HOME_FOLDERS = ['Documents', 'Downloads', 'Pictures', 'Music', 'Videos']
const okName = (n: string) => typeof n === 'string' && n.length > 0 && n.length <= 255 && !n.includes('/') && !n.includes('\0') && n !== '.' && n !== '..'
const join = (rel: string, name: string) => (rel ? `${rel}/${name}` : name)

/** Where a root+rel lives, for display: "~/Documents", "WorkSuite Drive/Shared", "KINGSTON/photos". */
export function displayDir(env: Env, root: string, rel: string): string {
  const label = root === 'home' ? '~' : roots(env).find((r) => r.id === root)?.label ?? root
  return rel ? `${label}/${rel}` : label
}

function mountOf(p: string): { source: string; target: string } | null {
  try {
    let best: { source: string; target: string } | null = null
    for (const line of readFileSync('/proc/self/mounts', 'utf8').split('\n')) {
      const [source, rawTarget] = line.split(' ')
      if (!source || !rawTarget) continue
      const target = rawTarget.replace(/\\040/g, ' ')
      if ((p === target || p.startsWith(target.endsWith('/') ? target : target + '/')) && (!best || target.length > best.target.length)) best = { source, target }
    }
    return best
  } catch { return null }
}

export function places(env: Env) {
  let disk: { device: string; used: number; total: number } | null = null
  try {
    const s = statfsSync(env.home)
    const m = mountOf(env.home)
    disk = { device: m ? path.basename(m.source) : '', used: (s.blocks - s.bfree) * s.bsize, total: s.blocks * s.bsize }
  } catch { /* unknown */ }
  return {
    user: env.user,
    folders: HOME_FOLDERS.filter((f) => existsSync(path.join(env.home, f))),
    media: roots(env).filter((r) => r.id.startsWith('media:')).map(({ id, label }) => ({ id, label })),
    disk,
  }
}

// ---- Starred ----
const starFile = (env: Env) => path.join(env.home, '.config', 'worksuite', 'starred.json')
export function starred(env: Env): string[] {
  try { const v = JSON.parse(readFileSync(starFile(env), 'utf8')); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [] } catch { return [] }
}
export function setStar(env: Env, root: string, rel: string, on: boolean): Reply<string[]> {
  if (!resolveIn(env, root, rel)) return { ok: false, error: 'not_found' }
  const key = `${root}:${rel}`
  const next = starred(env).filter((k) => k !== key)
  if (on) next.push(key)
  try { mkdirSync(path.dirname(starFile(env)), { recursive: true }); writeFileSync(starFile(env), JSON.stringify(next)) } catch { return { ok: false, error: 'write_failed' } }
  return { ok: true, value: next }
}

function hitFor(env: Env, root: string, rel: string): Hit | null {
  const p = resolveIn(env, root, rel)
  if (!p || !existsSync(p.full)) return null
  try {
    const st = lstatSync(p.full)
    const parent = rel.split('/').slice(0, -1).join('/')
    return { root, rel, name: path.basename(p.full), dir: st.isDirectory(), size: st.isFile() ? st.size : null, modified: st.mtimeMs, where: displayDir(env, root, parent) }
  } catch { return null }
}

export function starredHits(env: Env): Hit[] {
  return starred(env).map((k) => { const i = k.indexOf(':', k.startsWith('media:') ? 6 : 0); return hitFor(env, k.slice(0, i), k.slice(i + 1)) }).filter((h): h is Hit => !!h)
}

// ---- Recent (XDG recently-used.xbel, written by GTK/Qt apps) ----
export function recent(env: Env, limit = 60): Hit[] {
  let xml = ''
  try { xml = readFileSync(path.join(env.home, '.local', 'share', 'recently-used.xbel'), 'utf8') } catch { return [] }
  const out: { hit: Hit; t: number }[] = []
  const seen = new Set<string>()
  for (const m of xml.matchAll(/<bookmark\b([^>]*)>/g)) {
    const href = /href="file:\/\/([^"]+)"/.exec(m[1])?.[1]
    if (!href) continue
    let full: string
    try { full = decodeURIComponent(href) } catch { continue }
    if (!full.startsWith(env.home + '/') || seen.has(full)) continue
    seen.add(full)
    const t = Date.parse(/(?:visited|modified)="([^"]+)"/.exec(m[1])?.[1] ?? '') || 0
    const h = hitFor(env, 'home', path.relative(env.home, full))
    if (h && !h.name.startsWith('.')) out.push({ hit: h, t })
  }
  return out.sort((a, b) => b.t - a.t).slice(0, limit).map((x) => x.hit)
}

// ---- Search (names; file contents are not indexed) ----
const DOC_EXT = new Set(['doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'pdf', 'ppt', 'pptx', 'odp'])
const SHEET_EXT = new Set(['xls', 'xlsx', 'ods', 'csv'])
export async function search(env: Env, root: string, rel: string, query: string, kind: string, days: number): Promise<Reply<{ hits: Hit[]; ms: number; truncated: boolean }>> {
  const p = resolveIn(env, root, rel)
  const q = query.trim().toLowerCase()
  if (!p || !q) return { ok: false, error: 'not_found' }
  const t0 = Date.now(), since = days > 0 ? Date.now() - days * 86_400_000 : 0
  const hits: Hit[] = []
  let scanned = 0, truncated = false
  const queue: string[] = [rel]
  while (queue.length) {
    const r = queue.shift() as string
    let names: string[]
    try { names = await readdir(path.join(p.base, ...r.split('/').filter(Boolean))) } catch { continue }
    for (const name of names) {
      if (name.startsWith('.')) continue
      if (++scanned > 50_000 || hits.length >= 300) { truncated = true; queue.length = 0; break }
      const childRel = join(r, name)
      let st
      try { st = await lstat(path.join(p.base, ...childRel.split('/'))) } catch { continue }
      if (st.isDirectory()) queue.push(childRel)
      if (!name.toLowerCase().includes(q)) continue
      const ext = name.split('.').pop()?.toLowerCase() ?? ''
      if (kind === 'documents' && (st.isDirectory() || !DOC_EXT.has(ext))) continue
      if (kind === 'spreadsheets' && (st.isDirectory() || !SHEET_EXT.has(ext))) continue
      if (since && st.mtimeMs < since) continue
      hits.push({ root, rel: childRel, name, dir: st.isDirectory(), size: st.isFile() ? st.size : null, modified: st.mtimeMs, where: displayDir(env, root, r) })
    }
  }
  return { ok: true, value: { hits, ms: Date.now() - t0, truncated } }
}

// ---- New folder, rename ----
export function mkdirIn(env: Env, root: string, rel: string, name: string): Reply<string> {
  const p = resolveIn(env, root, rel)
  if (!p || !okName(name)) return { ok: false, error: 'invalid' }
  const target = path.join(p.full, name)
  if (existsSync(target)) return { ok: false, error: 'exists' }
  try { mkdirSync(target) } catch { return { ok: false, error: 'write_failed' } }
  return { ok: true, value: join(rel, name) }
}

export async function renameIn(env: Env, root: string, rel: string, name: string): Promise<Reply<string>> {
  const p = resolveIn(env, root, rel)
  if (!p || !rel || !okName(name)) return { ok: false, error: 'invalid' }
  const target = path.join(path.dirname(p.full), name)
  if (existsSync(target)) return { ok: false, error: 'exists' }
  try { await rename(p.full, target) } catch { return { ok: false, error: 'write_failed' } }
  return { ok: true, value: join(rel.split('/').slice(0, -1).join('/'), name) }
}

// ---- freedesktop.org Trash ($XDG_DATA_HOME/Trash) ----
const trashDir = (env: Env) => path.join(env.home, '.local', 'share', 'Trash')
const pad = (n: number) => String(n).padStart(2, '0')
const trashDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

async function moveAcross(from: string, to: string) {
  try { await rename(from, to) } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    await cpTree(from, to); await rm(from, { recursive: true, force: true })
  }
}
async function cpTree(from: string, to: string) {
  const st = await lstat(from)
  if (st.isDirectory()) { await mkdir(to, { recursive: true }); for (const n of await readdir(from)) await cpTree(path.join(from, n), path.join(to, n)) }
  else if (st.isFile()) await copyFile(from, to)
}

export async function trash(env: Env, root: string, rels: string[]): Promise<Reply<number>> {
  const t = trashDir(env)
  mkdirSync(path.join(t, 'files'), { recursive: true }); mkdirSync(path.join(t, 'info'), { recursive: true })
  let n = 0
  for (const rel of rels) {
    const p = resolveIn(env, root, rel)
    if (!p || !rel || !existsSync(p.full)) continue
    const base = path.basename(p.full)
    let id = base, i = 1
    while (existsSync(path.join(t, 'files', id)) || existsSync(path.join(t, 'info', `${id}.trashinfo`))) id = `${base}.${++i}`
    writeFileSync(path.join(t, 'info', `${id}.trashinfo`), `[Trash Info]\nPath=${encodeURI(p.full)}\nDeletionDate=${trashDate(new Date())}\n`, { flag: 'wx' })
    try { await moveAcross(p.full, path.join(t, 'files', id)); n++ } catch { await rm(path.join(t, 'info', `${id}.trashinfo`), { force: true }) }
  }
  return n ? { ok: true, value: n } : { ok: false, error: 'not_found' }
}

async function treeSize(p: string): Promise<number> {
  try {
    const st = await lstat(p)
    if (!st.isDirectory()) return st.size
    let n = 0
    for (const c of await readdir(p)) n += await treeSize(path.join(p, c))
    return n
  } catch { return 0 }
}

export interface TrashItem { id: string; name: string; dir: boolean; size: number; orig: string; where: string; deleted: number | null }
export async function trashList(env: Env): Promise<TrashItem[]> {
  const t = trashDir(env)
  let infos: string[] = []
  try { infos = readdirSync(path.join(t, 'info')).filter((n) => n.endsWith('.trashinfo')) } catch { return [] }
  const out: TrashItem[] = []
  for (const info of infos) {
    const id = info.slice(0, -'.trashinfo'.length)
    const f = path.join(t, 'files', id)
    if (!existsSync(f)) continue
    const txt = readFileSync(path.join(t, 'info', info), 'utf8')
    let orig = /^Path=(.*)$/m.exec(txt)?.[1] ?? ''
    try { orig = decodeURIComponent(orig) } catch { /* keep raw */ }
    if (!orig.startsWith('/')) orig = path.join(env.home, orig)
    const d = /^DeletionDate=(.*)$/m.exec(txt)?.[1]
    const dir = path.dirname(orig)
    out.push({ id, name: path.basename(orig), dir: lstatSync(f).isDirectory(), size: await treeSize(f), orig, where: dir === env.home ? '~' : dir.startsWith(env.home + '/') ? `~/${path.relative(env.home, dir)}` : dir, deleted: d ? Date.parse(d) || null : null })
  }
  return out.sort((a, b) => (b.deleted ?? 0) - (a.deleted ?? 0))
}

const validId = (id: string) => okName(id) && !id.endsWith('.trashinfo')
export async function trashRestore(env: Env, ids: string[]): Promise<Reply<{ restored: number; skipped: number }>> {
  const items = await trashList(env)
  const bases = roots(env).filter((r) => r.id !== 'drive').map((r) => r.path)
  let restored = 0, skipped = 0
  for (const id of ids) {
    const it = items.find((x) => x.id === id)
    if (!it || !validId(id) || !bases.some((b) => it.orig.startsWith(b + '/')) || existsSync(it.orig)) { skipped++; continue }
    try {
      mkdirSync(path.dirname(it.orig), { recursive: true })
      await moveAcross(path.join(trashDir(env), 'files', id), it.orig)
      await rm(path.join(trashDir(env), 'info', `${id}.trashinfo`), { force: true })
      restored++
    } catch { skipped++ }
  }
  return { ok: true, value: { restored, skipped } }
}

export async function trashDelete(env: Env, ids: string[] | 'all'): Promise<Reply<number>> {
  const list = ids === 'all' ? (await trashList(env)).map((x) => x.id) : ids.filter(validId)
  let n = 0
  for (const id of list) {
    await rm(path.join(trashDir(env), 'files', id), { recursive: true, force: true })
    await rm(path.join(trashDir(env), 'info', `${id}.trashinfo`), { force: true })
    n++
  }
  return { ok: true, value: n }
}

// ---- Copy / move jobs ----
export interface FileStamp { size: number; modified: number }
export interface JobEvent {
  id: string; op: 'copy' | 'move'; dest: string; state: 'running' | 'conflict' | 'done' | 'failed' | 'cancelled'
  done: number; total: number; bytes_done: number; bytes_total: number
  conflict: { name: string; incoming: FileStamp; existing: FileStamp; remaining: number } | null
}
export type Resolution = 'replace' | 'skip' | 'keep' | 'cancel'

/** "Budget 2027.xlsx" -> "Budget 2027 (2).xlsx", the first name not taken in dir. */
export function freeName(dir: string, name: string): string {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 2; ; i++) { const n = `${stem} (${i})${ext}`; if (!existsSync(path.join(dir, n))) return n }
}

export function jobs(env: Env, emit: (e: JobEvent) => void) {
  const live = new Map<string, { resolve: ((r: Resolution, all: boolean) => void) | null; cancel: boolean }>()
  let seq = 0

  async function run(id: string, op: 'copy' | 'move', srcRoot: string, rels: string[], dstRoot: string, dstRel: string, duplicate: boolean) {
    const dst = resolveIn(env, dstRoot, dstRel)
    const ctl = live.get(id)!
    const ev: JobEvent = { id, op, dest: displayDir(env, dstRoot, dstRel), state: 'running', done: 0, total: 0, bytes_done: 0, bytes_total: 0, conflict: null }
    if (!dst || !existsSync(dst.full)) { emit({ ...ev, state: 'failed' }); return }
    // Enumerate files (folders are created as needed and merged).
    const plan: { from: string; to: string; size: number; mtime: number; top: string }[] = []
    const tops: string[] = []
    const walk = async (from: string, to: string, top: string) => {
      const st = await lstat(from)
      if (st.isDirectory()) { for (const n of await readdir(from)) await walk(path.join(from, n), path.join(to, n), top) }
      else if (st.isFile()) plan.push({ from, to, size: st.size, mtime: st.mtimeMs, top })
    }
    for (const rel of rels) {
      const s = resolveIn(env, srcRoot, rel)
      if (!s || !rel || !existsSync(s.full)) continue
      if (dst.full === s.full || dst.full.startsWith(s.full + path.sep)) continue      // into itself
      let name = path.basename(s.full)
      if (duplicate || path.dirname(s.full) === dst.full) name = freeName(dst.full, name)
      tops.push(s.full)
      try { await walk(s.full, path.join(dst.full, name), s.full) } catch { /* unreadable */ }
    }
    ev.total = plan.length; ev.bytes_total = plan.reduce((a, f) => a + f.size, 0)
    emit({ ...ev })
    let applyAll: Resolution | null = null
    const conflicts = plan.filter((f) => existsSync(f.to)).length
    let seen = 0
    let last = 0
    for (const f of plan) {
      if (ctl.cancel) { emit({ ...ev, state: 'cancelled' }); live.delete(id); return }
      let to = f.to
      if (existsSync(to)) {
        seen++
        let choice: Resolution | null = applyAll as Resolution | null
        if (!choice) {
          const ex = await stat(to)
          choice = await new Promise<Resolution>((resolve) => {
            ctl.resolve = (r, all) => { if (all) applyAll = r; resolve(r) }
            emit({ ...ev, state: 'conflict', conflict: { name: path.basename(to), incoming: { size: f.size, modified: f.mtime }, existing: { size: ex.size, modified: ex.mtimeMs }, remaining: conflicts - seen } })
          })
          ctl.resolve = null
        }
        if (choice === 'cancel') { emit({ ...ev, state: 'cancelled' }); live.delete(id); return }
        if (choice === 'skip') { ev.done++; ev.bytes_done += f.size; continue }
        if (choice === 'keep') to = path.join(path.dirname(to), freeName(path.dirname(to), path.basename(to)))
      }
      try {
        await mkdir(path.dirname(to), { recursive: true })
        if (op === 'move') await moveAcross(f.from, to); else await copyFile(f.from, to)
      } catch { emit({ ...ev, state: 'failed' }); live.delete(id); return }
      ev.done++; ev.bytes_done += f.size
      if (Date.now() - last > 150) { last = Date.now(); emit({ ...ev }) }
    }
    if (op === 'move') for (const t of tops) await rm(t, { recursive: true, force: true }).catch(() => undefined)
    emit({ ...ev, state: 'done' }); live.delete(id)
  }

  return {
    start(op: string, srcRoot: string, rels: string[], dstRoot: string, dstRel: string): Reply<string> {
      if (!['copy', 'move', 'duplicate'].includes(op) || !Array.isArray(rels) || !rels.every((r) => typeof r === 'string')) return { ok: false, error: 'invalid' }
      const id = `job${++seq}`
      live.set(id, { resolve: null, cancel: false })
      void run(id, op === 'move' ? 'move' : 'copy', srcRoot, rels, dstRoot, dstRel, op === 'duplicate')
      return { ok: true, value: id }
    },
    resolve(id: string, r: string, all: boolean): Reply<true> {
      const j = live.get(id)
      if (!j || !['replace', 'skip', 'keep', 'cancel'].includes(r)) return { ok: false, error: 'not_found' }
      if (r === 'cancel') j.cancel = true
      j.resolve?.(r as Resolution, all)
      return { ok: true, value: true }
    },
  }
}

// ---- Eject (udisksctl); archives are in ./archives ----
export function eject(env: Env, id: string): Promise<Reply<true>> {
  const r = roots(env).find((x) => x.id === id && id.startsWith('media:'))
  const m = r ? mountOf(r.path) : null
  if (!r || !m || m.target !== r.path || !m.source.startsWith('/dev/')) return Promise.resolve({ ok: false, error: 'not_found' })
  return new Promise((resolve) => execFile('udisksctl', ['unmount', '-b', m.source], (err) => resolve(err ? { ok: false, error: 'busy' } : { ok: true, value: true })))
}
