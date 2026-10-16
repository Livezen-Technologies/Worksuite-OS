// Archives in Files (§7.2): compress to zip / 7z / tar.gz / tar.xz; list, browse and extract zip, 7z, rar, tar.*, and
// single gz / xz / bz2 / zst streams. Tools: 7z (Debian 7zip) for zip and 7z, and for rar when its build has the codec
// (Debian's has not); bsdtar (libarchive-tools) for rar otherwise and as a zip fallback; GNU tar for tar.*; gzip, xz,
// bzip2 and zstd for single streams; zip(1) when 7z is missing.
// - Passwords reach 7z on its stdin only: never argv, the environment, events or logs.
// - Extraction goes into a private hidden folder next to the destination, is checked before (listing) and after (the
//   extracted tree) against absolute paths, "..", links leaving the folder and device files (zip-slip), and is then
//   moved into place with the usual Replace / Skip / Keep both prompts.
// - Archive bombs: a size or expansion-ratio limit asks for confirmation first; a stream that grows past the limit is
//   paused (SIGSTOP) until the user says so, and an archive that writes more than it declared is stopped.
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readdirSync, readlinkSync, statSync, statfsSync } from 'node:fs'
import { lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { resolveIn, roots, type FileEnv } from './files'
import { archiveKind, stemOf, type Kind } from './archiveKinds'
import { displayDir, freeName, type FileStamp } from './fileops'

export { archiveKind, stemOf, type Kind }

type Reply<T> = { ok: true; value: T } | { ok: false; error: string }
type Env = Pick<FileEnv, 'home' | 'user'>
type Spawn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess

export type Format = 'zip' | '7z' | 'tar.gz' | 'tar.xz'
export const FORMATS: Format[] = ['zip', '7z', 'tar.gz', 'tar.xz']
const STREAM: Partial<Record<Kind, string>> = { gz: 'gzip', xz: 'xz', bz2: 'bzip2', zst: 'zstd' }

// ---- Tools ----
export interface Tools { sevenZ: string | null; sevenZRar: boolean; bsdtar: string | null; tar: string | null; zip: string | null; gzip: string | null; xz: string | null; bzip2: string | null; zstd: string | null }
export function which(n: string): string | null {
  for (const d of (process.env.PATH || '/usr/bin:/bin').split(':')) { const p = path.join(d || '.', n); try { if (statSync(p).isFile()) return p } catch { /* not here */ } }
  return null
}
let cached: Promise<Tools> | null = null
export function findTools(spawn: Spawn = nodeSpawn): Promise<Tools> {
  return (cached ??= (async () => {
    const sevenZ = which('7z') ?? which('7zz')
    // Debian's 7zip drops the RAR codec (DFSG); upstream builds list it under `7z i`.
    const sevenZRar = sevenZ ? /\bRar5?\b/.test((await run(spawn, sevenZ, ['i'], {})).out) : false
    return { sevenZ, sevenZRar, bsdtar: which('bsdtar'), tar: which('tar'), zip: which('zip'), gzip: which('gzip'), xz: which('xz'), bzip2: which('bzip2'), zstd: which('zstd') }
  })())
}
export const resetTools = () => { cached = null }

const ENV = () => ({ ...process.env, LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' })
const LIMIT_OUT = 64 * 1024 * 1024

/** Run a tool; `input` is written to stdin (the only way a password leaves this process). */
function run(spawn: Spawn, bin: string, args: string[], o: { cwd?: string; input?: string; onOut?: (s: string) => void; onErr?: (s: string) => void; stdout?: number; started?: (c: ChildProcess) => void }) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    let out = '', err = ''
    let c: ChildProcess
    try { c = spawn(bin, args, { cwd: o.cwd, env: ENV(), detached: true, stdio: ['pipe', o.stdout ?? 'pipe', 'pipe'] }) } catch { resolve({ code: -1, out, err }); return }
    o.started?.(c)
    c.stdout?.on('data', (b: Buffer) => { const s = b.toString('utf8'); if (out.length < LIMIT_OUT) out += s; o.onOut?.(s) })
    c.stderr?.on('data', (b: Buffer) => { const s = b.toString('utf8'); if (err.length < LIMIT_OUT) err += s; o.onErr?.(s) })
    c.stdin?.on('error', () => undefined)
    c.stdin?.end(o.input ?? '')
    c.on('error', () => resolve({ code: -1, out, err }))
    c.on('close', (code) => resolve({ code, out, err }))
  })
}
/** Signal a tool and its helpers (tar's gzip/xz): each tool runs in its own process group. */
function kill(c: ChildProcess | null, sig: NodeJS.Signals) {
  if (!c?.pid) return
  try { process.kill(-c.pid, sig) } catch { try { c.kill(sig) } catch { /* gone */ } }
}
const PW_RE = /wrong password|can ?not open encrypted archive|data error in encrypted file|enter password/i

// ---- Listing ----
export interface ArchEntry { path: string; type: 'file' | 'dir' | 'symlink' | 'hardlink' | 'other'; size: number | null; link: string | null; modified: number | null; encrypted: boolean }
export interface Listing { kind: Kind; entries: ArchEntry[]; encrypted: boolean; total: number | null; packed: number }

const typeOf = (c: string): ArchEntry['type'] => (c === '-' ? 'file' : c === 'd' ? 'dir' : c === 'l' ? 'symlink' : c === 'h' ? 'hardlink' : 'other')
const clean = (p: string) => p.replace(/^(\.\/)+/, '').replace(/\/+$/, '')

/** `7z l -slt` blocks after the "----------" line. */
export function parse7z(out: string): ArchEntry[] {
  const at = out.indexOf('\n----------\n')
  if (at < 0) return []
  return out.slice(at + 12).split(/\n\s*\n/).map((block) => {
    const f: Record<string, string> = {}
    for (const line of block.split('\n')) { const i = line.indexOf(' = '); if (i > 0) f[line.slice(0, i)] = line.slice(i + 3); else if (line.endsWith(' =')) f[line.slice(0, -2)] = '' }
    return f
  }).filter((f) => f.Path !== undefined).map((f) => {
    const mode = /(?:^|\s)([-dlcbps])[rwxsStT-]{9}/.exec(`${f.Mode ?? ''} ${f.Attributes ?? ''}`)?.[1]
    let type: ArchEntry['type'] = f.Folder === '+' || (f.Attributes ?? '').startsWith('D') ? 'dir' : mode ? typeOf(mode) : 'file'
    if (f['Hard Link']) type = 'hardlink'
    const mod = f.Modified ? Date.parse(f.Modified.replace(' ', 'T')) : NaN
    return { path: clean(f.Path.replace(/\\/g, '/')), type, size: type === 'file' && f.Size ? Number(f.Size) : type === 'file' ? null : 0, link: f['Symbolic Link'] || f['Hard Link'] || null, modified: Number.isFinite(mod) ? mod : null, encrypted: f.Encrypted === '+' }
  })
}

/** GNU tar --quoting-style=escape: \\, \n, \t, \ooo (bytes, UTF-8). */
export function unescapeTar(s: string): string {
  const bytes: number[] = []
  const enc = Buffer.from(s, 'utf8')
  for (let i = 0; i < enc.length; i++) {
    if (enc[i] !== 0x5c || i + 1 >= enc.length) { bytes.push(enc[i]); continue }
    const n = String.fromCharCode(enc[i + 1])
    if (/[0-7]/.test(n)) { const m = /^[0-7]{1,3}/.exec(enc.subarray(i + 1, i + 4).toString('latin1'))![0]; bytes.push(parseInt(m, 8)); i += m.length; continue }
    bytes.push(({ n: 10, t: 9, r: 13, f: 12, v: 11, b: 8, a: 7, '\\': 0x5c, ' ': 0x20 } as Record<string, number>)[n] ?? enc[i + 1]); i++
  }
  return Buffer.from(bytes).toString('utf8')
}

/** `tar --numeric-owner --quoting-style=escape -tvf` (GNU) and `bsdtar --numeric-owner -tvf` lines. */
export function parseTarList(out: string, gnu: boolean): ArchEntry[] {
  const re = gnu ? /^(\S)\S{9}\S*\s+\S+\s+(\d+|\d+,\s*\d+)\s+\d{4}-\d\d-\d\d \d\d:\d\d(?::\d\d)?\s(.*)$/ : /^(\S)\S{9}\S*\s+\d+\s+\S+\s+\S+\s+(\d+|\d+,\s*\d+)\s+\S+\s+\d+\s+\S+\s(.*)$/
  const out2: ArchEntry[] = []
  for (const line of out.split('\n')) {
    const m = re.exec(line)
    if (!m) continue
    const type = typeOf(m[1])
    let name = m[3], link: string | null = null
    const sep = type === 'symlink' ? ' -> ' : type === 'hardlink' ? ' link to ' : null
    if (sep && name.includes(sep)) { const i = name.indexOf(sep); link = name.slice(i + sep.length); name = name.slice(0, i) }
    if (gnu) { name = unescapeTar(name); if (link) link = unescapeTar(link) }
    out2.push({ path: clean(name), type, size: type === 'file' ? Number(m[2]) : 0, link, modified: null, encrypted: false })
  }
  return out2
}

type Backend = '7z' | 'bsdtar' | 'tar' | 'stream'
function backendFor(kind: Kind, t: Tools): { b: Backend; bin: string } | null {
  if (STREAM[kind]) { const bin = t[STREAM[kind] as 'gzip']; return bin ? { b: 'stream', bin } : null }
  if (kind.startsWith('tar')) return t.tar ? { b: 'tar', bin: t.tar } : t.bsdtar ? { b: 'bsdtar', bin: t.bsdtar } : null
  if (kind === 'rar') return t.sevenZ && t.sevenZRar ? { b: '7z', bin: t.sevenZ } : t.bsdtar ? { b: 'bsdtar', bin: t.bsdtar } : null
  return t.sevenZ ? { b: '7z', bin: t.sevenZ } : t.bsdtar ? { b: 'bsdtar', bin: t.bsdtar } : null
}

export interface ArchiveOpts { spawn?: Spawn; tools?: Tools; limits?: Partial<Limits>; pollMs?: number }
export interface Limits { bytes: number; ratio: number; ratioFrom: number }
/** Ask before writing more than 8 GB, or more than 100× the archive once past 256 MB. */
export const LIMITS: Limits = { bytes: 8 * 1024 ** 3, ratio: 100, ratioFrom: 256 * 1024 ** 2 }

/** List an archive file. Errors: password (one is needed), wrong_password, tool_missing, failed. */
export async function listArchive(file: string, password: string | null, o: ArchiveOpts = {}): Promise<Reply<Listing>> {
  const kind = archiveKind(path.basename(file))
  if (!kind) return { ok: false, error: 'unsupported' }
  const spawn = o.spawn ?? nodeSpawn
  const t = o.tools ?? await findTools(spawn)
  const be = backendFor(kind, t)
  if (!be) return { ok: false, error: 'tool_missing' }
  let packed = 0
  try { packed = statSync(file).size } catch { return { ok: false, error: 'not_found' } }
  let entries: ArchEntry[]
  if (be.b === 'stream') entries = [{ path: stemOf(path.basename(file)), type: 'file', size: null, link: null, modified: null, encrypted: false }]
  else if (be.b === '7z') {
    const r = await run(spawn, be.bin, ['l', '-slt', '-sccUTF-8', '--', file], { input: `${password ?? ''}\n` })
    if (r.code !== 0) return { ok: false, error: PW_RE.test(r.out + r.err) ? (password ? 'wrong_password' : 'password') : 'failed' }
    entries = parse7z(r.out)
  } else {
    const r = await run(spawn, be.bin, be.b === 'tar' ? ['--numeric-owner', '--quoting-style=escape', '-tvf', file] : ['--numeric-owner', '-tvf', file], {})
    if (r.code !== 0) return { ok: false, error: /passphrase|encrypt/i.test(r.err) ? 'password_unsupported' : 'failed' }
    entries = parseTarList(r.out, be.b === 'tar')
  }
  entries = entries.filter((e) => e.path)
  const files = entries.filter((e) => e.type === 'file')
  const total = files.some((e) => e.size == null) ? null : files.reduce((a, e) => a + (e.size ?? 0), 0)
  return { ok: true, value: { kind, entries, encrypted: entries.some((e) => e.encrypted), total, packed } }
}

/** Zip-slip guard on a listing: null when safe, else the offending entry. */
export function unsafeEntry(entries: ArchEntry[]): string | null {
  const links = new Set<string>()
  const bad = (p: string) => !p || p.includes('\0') || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').some((s) => s === '..')
  for (const e of entries) {
    if (bad(e.path) || e.type === 'other') return e.path || '(empty)'
    if (e.type === 'symlink') {
      if (!e.link || e.link.startsWith('/')) return e.path
      const to = path.posix.normalize(path.posix.join(path.posix.dirname(e.path), e.link))
      if (to === '..' || to.startsWith('../') || to.startsWith('/')) return e.path
      links.add(e.path)
    }
    if (e.type === 'hardlink' && (!e.link || bad(clean(e.link)))) return e.path
  }
  for (const e of entries) for (const l of links) if (e.path.startsWith(l + '/')) return e.path
  return null
}

/** Zip-slip guard on an extracted tree: null when every link stays inside root and there are no devices or fifos. */
export function unsafeTree(root: string): string | null {
  const walk = (dir: string): string | null => {
    for (const n of readdirSync(dir)) {
      const p = path.join(dir, n), st = lstatSync(p)
      if (st.isSymbolicLink()) {
        const to = path.resolve(dir, readlinkSync(p))
        if (to !== root && !to.startsWith(root + path.sep)) return path.relative(root, p)
      } else if (st.isDirectory()) { const r = walk(p); if (r) return r }
      else if (!st.isFile()) return path.relative(root, p)
    }
    return null
  }
  return walk(root)
}

function treeBytes(p: string): number {
  let n = 0
  const walk = (d: string) => { let names: string[] = []; try { names = readdirSync(d) } catch { return } for (const x of names) { try { const st = lstatSync(path.join(d, x)); if (st.isDirectory()) walk(path.join(d, x)); else n += st.size } catch { /* gone */ } } }
  try { const st = lstatSync(p); if (st.isDirectory()) walk(p); else n = st.size } catch { /* none */ }
  return n
}
const freeAt = (dir: string) => { try { const s = statfsSync(dir); return s.bavail * s.bsize } catch { return null } }

// ---- Jobs ----
export type ArchiveAnswer = 'replace' | 'skip' | 'keep' | 'cancel' | 'continue'
export interface ArchiveJobEvent {
  id: string; op: 'compress' | 'extract'; dest: string; name: string
  state: 'running' | 'conflict' | 'password' | 'confirm' | 'done' | 'failed' | 'cancelled'
  done: number; total: number; bytes_done: number; bytes_total: number
  conflict: { name: string; incoming: FileStamp; existing: FileStamp; remaining: number } | null
  /** password: wrong is true after a wrong one. confirm: bytes the archive will write (null: unknown) and the expansion ratio. */
  ask: { wrong?: boolean; bytes?: number | null; ratio?: number | null } | null
  error: string | null
}
export interface CompressOpts { format: Format; name: string; level: number; password?: string | null }

const okName = (n: string) => typeof n === 'string' && n.length > 0 && n.length <= 255 && !n.includes('/') && !n.includes('\0') && !n.includes('\n') && n !== '.' && n !== '..' && !n.startsWith('.')

export function archiveJobs(env: Env, emit: (e: ArchiveJobEvent) => void, o: ArchiveOpts = {}) {
  const spawn = o.spawn ?? nodeSpawn
  const limits: Limits = { ...LIMITS, ...o.limits }
  const pollMs = o.pollMs ?? 300
  interface Ctl { cancel: boolean; child: ChildProcess | null; answer: ((a: ArchiveAnswer, all: boolean) => void) | null; password: ((pw: string | null) => void) | null }
  const live = new Map<string, Ctl>()
  let seq = 0

  const ask = (ctl: Ctl, ev: ArchiveJobEvent, state: 'conflict' | 'confirm', extra: Partial<ArchiveJobEvent>) => new Promise<{ a: ArchiveAnswer; all: boolean }>((resolve) => {
    ctl.answer = (a, all) => { ctl.answer = null; resolve({ a, all }) }
    emit({ ...ev, ...extra, state })
  })
  const askPassword = (ctl: Ctl, ev: ArchiveJobEvent, wrong: boolean) => new Promise<string | null>((resolve) => {
    ctl.password = (pw) => { ctl.password = null; resolve(pw) }
    emit({ ...ev, state: 'password', ask: { wrong } })
  })
  const finish = (id: string, ev: ArchiveJobEvent, state: 'done' | 'failed' | 'cancelled', error: string | null = null) => { live.delete(id); emit({ ...ev, state, error, conflict: null, ask: null }) }

  // ---- Compress ----
  async function compress(id: string, root: string, rels: string[], opts: CompressOpts) {
    const ctl = live.get(id)!
    const ps = rels.map((r) => (r ? resolveIn(env, root, r) : null))
    const parentRel = rels[0]?.split('/').slice(0, -1).join('/') ?? ''
    const ev: ArchiveJobEvent = { id, op: 'compress', dest: displayDir(env, root, parentRel), name: '', state: 'running', done: 0, total: rels.length, bytes_done: 0, bytes_total: 0, conflict: null, ask: null, error: null }
    if (!ps.length || ps.some((p) => !p || !existsSync(p.full)) || ps.some((p) => path.dirname(p!.full) !== path.dirname(ps[0]!.full))) return finish(id, ev, 'failed', 'invalid')
    const dir = path.dirname(ps[0]!.full), names = ps.map((p) => path.basename(p!.full))
    const t = o.tools ?? await findTools(spawn)
    const ext = `.${opts.format}`
    let name = opts.name.toLowerCase().endsWith(ext) ? opts.name : opts.name + ext
    ev.name = name
    const pw = opts.password || null
    if (!okName(name) || (pw && !['zip', '7z'].includes(opts.format)) || (pw && pw.includes('\n'))) return finish(id, ev, 'failed', 'invalid')
    // 7-Zip only takes printable ASCII passwords for zip (the format has no charset for them).
    if (pw && opts.format === 'zip' && !/^[\x20-\x7e]+$/.test(pw)) return finish(id, ev, 'failed', 'password_ascii')
    const use7z = (opts.format === 'zip' || opts.format === '7z') && t.sevenZ
    if (!use7z && (opts.format === '7z' || (opts.format === 'zip' && (pw || !t.zip)) || (opts.format.startsWith('tar') && (!t.tar || !(opts.format === 'tar.gz' ? t.gzip : t.xz))))) return finish(id, ev, 'failed', 'tool_missing')
    ev.bytes_total = names.reduce((a, n) => a + treeBytes(path.join(dir, n)), 0)
    emit({ ...ev })
    // Name taken: Replace / Keep both / Skip (= nothing to do).
    if (existsSync(path.join(dir, name))) {
      const ex = await stat(path.join(dir, name))
      const { a } = await ask(ctl, ev, 'conflict', { conflict: { name, incoming: { size: ev.bytes_total, modified: Date.now() }, existing: { size: ex.size, modified: ex.mtimeMs }, remaining: 0 } })
      if (a === 'cancel' || a === 'skip' || ctl.cancel) return finish(id, ev, 'cancelled')
      if (a === 'keep') { name = freeName(dir, name); ev.name = name }
      emit({ ...ev })
    }
    const part = path.join(dir, `.${name}.part-${process.pid}-${id}`)
    const level = Math.max(0, Math.min(9, Math.round(Number(opts.level) || 0)))
    let bin: string, args: string[], input = ''
    let onOut: ((s: string) => void) | undefined, onErr: ((s: string) => void) | undefined
    if (use7z) {
      bin = t.sevenZ!
      args = ['a', `-t${opts.format}`, `-mx=${level}`, '-snl', '-spd', '-bsp1', '-bso0', '-bse1']
      if (pw) { args.push(...(opts.format === 'zip' ? ['-mem=AES256'] : ['-mhe=on']), '-p'); input = `${pw}\n` }
      args.push('--', part, ...names)
      onOut = (s) => { const m = [...s.matchAll(/(\d{1,3})%/g)].pop(); if (m) { ev.bytes_done = Math.round((Number(m[1]) / 100) * ev.bytes_total); tick() } }
    } else if (opts.format === 'zip') {
      bin = t.zip!; args = ['-r', '-y', `-${level}`, '-q', part, '-@']; input = names.join('\n') + '\n'
      if (names.some((n) => n.includes('\n'))) return finish(id, ev, 'failed', 'invalid')
    } else {
      bin = t.tar!
      args = ['-c', '-f', part, `--use-compress-program=${opts.format === 'tar.gz' ? 'gzip' : 'xz -T0'} -${level}`, '--checkpoint=50', '--checkpoint-action=echo=#%u', '--', ...names]
      onErr = (s) => { const m = [...s.matchAll(/#(\d+)/g)].pop(); if (m) { ev.bytes_done = Math.min(ev.bytes_total, Number(m[1]) * 10240); tick() } }
    }
    let last = 0
    const tick = () => { if (Date.now() - last > 150) { last = Date.now(); emit({ ...ev }) } }
    const r = await run(spawn, bin, args, { cwd: dir, input, onOut, onErr, started: (c) => { ctl.child = c } })
    ctl.child = null
    if (ctl.cancel || r.code !== 0) { await rm(part, { force: true }); return ctl.cancel ? finish(id, ev, 'cancelled') : finish(id, ev, 'failed', 'failed') }
    try { await rename(part, path.join(dir, name)) } catch { await rm(part, { force: true }); return finish(id, ev, 'failed', 'failed') }
    ev.done = ev.total; ev.bytes_done = ev.bytes_total
    finish(id, ev, 'done')
  }

  // ---- Extract ----
  async function extract(id: string, root: string, rel: string, mode: 'here' | 'folder', items: string[], password: string | null) {
    const ctl = live.get(id)!
    const a = rel ? resolveIn(env, root, rel) : null
    const parentRel = rel.split('/').slice(0, -1).join('/')
    const ev: ArchiveJobEvent = { id, op: 'extract', dest: displayDir(env, root, parentRel), name: path.basename(rel), state: 'running', done: 0, total: 0, bytes_done: 0, bytes_total: 0, conflict: null, ask: null, error: null }
    if (!a || !existsSync(a.full) || !statSync(a.full).isFile()) return finish(id, ev, 'failed', 'not_found')
    const kind = archiveKind(path.basename(a.full))
    const t = o.tools ?? await findTools(spawn)
    const be = kind ? backendFor(kind, t) : null
    if (!kind) return finish(id, ev, 'failed', 'unsupported')
    if (!be) return finish(id, ev, 'failed', 'tool_missing')
    const dir = path.dirname(a.full)
    const stem = stemOf(path.basename(a.full))
    const dest = mode === 'folder' ? path.join(dir, stem) : dir
    if (mode === 'folder') ev.dest = displayDir(env, root, parentRel ? `${parentRel}/${stem}` : stem)
    emit({ ...ev })
    // 1. List (asking for a password when the archive needs one).
    let pw = password, listing: Listing | null = null, wrong = false
    for (;;) {
      const l = await listArchive(a.full, pw, { spawn, tools: t })
      if (ctl.cancel) return finish(id, ev, 'cancelled')
      if (l.ok && (!l.value.encrypted || pw)) { listing = l.value; break }
      if (!l.ok && l.error !== 'password' && l.error !== 'wrong_password') return finish(id, ev, 'failed', l.error)
      if (be.b !== '7z') return finish(id, ev, 'failed', 'password_unsupported')
      pw = await askPassword(ctl, ev, wrong || (!l.ok && l.error === 'wrong_password'))
      wrong = false
      if (pw === null || ctl.cancel) return finish(id, ev, 'cancelled')
      emit({ ...ev })
    }
    // 2. Zip-slip and bomb checks on the listing.
    if (unsafeEntry(listing.entries)) return finish(id, ev, 'failed', 'unsafe')
    const chosen = items.length ? listing.entries.filter((e) => items.some((i) => e.path === i || e.path.startsWith(i + '/'))) : listing.entries
    if (items.length && !chosen.length) return finish(id, ev, 'failed', 'not_found')
    const files = chosen.filter((e) => e.type === 'file')
    const total = files.some((e) => e.size == null) ? null : files.reduce((s, e) => s + (e.size ?? 0), 0)
    ev.total = chosen.filter((e) => e.type !== 'dir').length; ev.bytes_total = total ?? 0
    const free = freeAt(dir)
    if (total != null && free != null && total > free) return finish(id, ev, 'failed', 'no_space')
    let confirmed = false
    const tooBig = (n: number) => n > limits.bytes || (n > limits.ratioFrom && n / Math.max(1, listing!.packed) > limits.ratio)
    if (total != null && tooBig(total)) {
      const r = await ask(ctl, ev, 'confirm', { ask: { bytes: total, ratio: Math.round(total / Math.max(1, listing.packed)) } })
      if (r.a !== 'continue' || ctl.cancel) return finish(id, ev, 'cancelled')
      confirmed = true
      emit({ ...ev, ask: null })
    }
    // 3. Extract into a private folder next to the destination.
    let tmp: string
    try { tmp = mkdtempSync(path.join(dir, '.ws-extract-')) } catch { return finish(id, ev, 'failed', 'write_failed') }
    const cleanup = () => rm(tmp, { recursive: true, force: true }).catch(() => undefined)
    const names = chosen.filter((e) => !chosen.some((p) => p !== e && e.path.startsWith(p.path + '/'))).map((e) => e.path)
    for (;;) {
      let bin = be.bin, args: string[], input = '', outFd: number | undefined
      if (be.b === '7z') { args = ['x', '-y', '-spd', '-bso0', '-bsp0', `-o${tmp}`, '--', a.full, ...(items.length ? names : [])]; input = `${pw ?? ''}\n` }
      else if (be.b === 'tar') args = ['-x', '-f', a.full, '-C', tmp, '--no-same-owner', '--no-wildcards', '--no-unquote', '--', ...(items.length ? names : [])]
      else if (be.b === 'bsdtar') args = ['-x', '-f', a.full, '-C', tmp, '--no-same-owner', ...(items.length ? ['--', ...names] : [])]
      else { outFd = openSync(path.join(tmp, stem), 'wx', 0o644); args = ['-d', '-c', '--', a.full]; bin = be.bin }
      let stopped = false, failure: string | null = null
      const poll = setInterval(() => {
        ev.bytes_done = treeBytes(tmp)
        const allowed = total != null ? total * 1.05 + 1024 * 1024 : null
        if (!confirmed && allowed != null && ev.bytes_done > allowed) { failure = 'bomb'; kill(ctl.child, 'SIGKILL') }
        else if (!confirmed && total == null && !stopped && tooBig(ev.bytes_done) && ctl.child) {
          // A stream with no declared size grew past the limit: pause it and ask.
          stopped = true; kill(ctl.child, 'SIGSTOP')
          void ask(ctl, ev, 'confirm', { ask: { bytes: null, ratio: Math.round(ev.bytes_done / Math.max(1, listing!.packed)) } }).then((r) => {
            if (r.a === 'continue' && !ctl.cancel) { confirmed = true; emit({ ...ev, state: 'running', ask: null }); kill(ctl.child, 'SIGCONT') }
            else { ctl.cancel = true; kill(ctl.child, 'SIGCONT'); kill(ctl.child, 'SIGKILL') }
          })
        } else if (!stopped || confirmed) emit({ ...ev, state: 'running' })
      }, pollMs)
      const r = await run(spawn, bin, args, { input, stdout: outFd, started: (c) => { ctl.child = c } })
      clearInterval(poll)
      if (outFd !== undefined) closeSync(outFd)
      ctl.child = null
      if (ctl.cancel) { await cleanup(); return finish(id, ev, 'cancelled') }
      if (failure) { await cleanup(); return finish(id, ev, 'failed', failure) }
      if (r.code !== 0 && be.b === '7z' && PW_RE.test(r.out + r.err)) {
        await rm(tmp, { recursive: true, force: true }); await mkdir(tmp)
        pw = await askPassword(ctl, ev, true)
        if (pw === null || ctl.cancel) { await cleanup(); return finish(id, ev, 'cancelled') }
        emit({ ...ev, ask: null })
        continue
      }
      if (r.code !== 0) { await cleanup(); return finish(id, ev, 'failed', 'failed') }
      break
    }
    if (unsafeTree(tmp)) { await cleanup(); return finish(id, ev, 'failed', 'unsafe') }
    ev.bytes_done = treeBytes(tmp); ev.bytes_total = ev.bytes_done
    // 4. Move into place with Replace / Skip / Keep both.
    const plan: { from: string; to: string; size: number; mtime: number }[] = []
    const dirs: string[] = []
    const walk = async (from: string, to: string) => {
      const st = await lstat(from)
      if (st.isDirectory()) { dirs.push(to); for (const n of await readdir(from)) await walk(path.join(from, n), path.join(to, n)) }
      else plan.push({ from, to, size: st.size, mtime: st.mtimeMs })
    }
    for (const n of await readdir(tmp)) await walk(path.join(tmp, n), path.join(dest, n))
    ev.total = plan.length; ev.done = 0
    const conflicts = plan.filter((f) => existsSync(f.to)).length
    let seen = 0, applyAll: ArchiveAnswer | null = null
    try {
      await mkdir(dest, { recursive: true })
      for (const d of dirs) if (!existsSync(d)) await mkdir(d, { recursive: true })
      for (const f of plan) {
        if (ctl.cancel) { await cleanup(); return finish(id, ev, 'cancelled') }
        let to = f.to
        if (existsSync(to) || lstatExists(to)) {
          seen++
          let choice = applyAll
          if (!choice) {
            const ex = lstatSync(to)
            const r = await ask(ctl, ev, 'conflict', { conflict: { name: path.basename(to), incoming: { size: f.size, modified: f.mtime }, existing: { size: ex.size, modified: ex.mtimeMs }, remaining: conflicts - seen } })
            choice = r.a; if (r.all) applyAll = r.a
            emit({ ...ev, conflict: null })
          }
          if (choice === 'cancel' || ctl.cancel) { await cleanup(); return finish(id, ev, 'cancelled') }
          if (choice === 'skip') { ev.done++; continue }
          if (choice === 'keep') to = path.join(path.dirname(to), freeName(path.dirname(to), path.basename(to)))
          else await rm(to, { recursive: true, force: true })
        }
        await rename(f.from, to)
        ev.done++
        emit({ ...ev })
      }
    } catch { await cleanup(); return finish(id, ev, 'failed', 'write_failed') }
    await cleanup()
    finish(id, ev, 'done')
  }
  const lstatExists = (p: string) => { try { lstatSync(p); return true } catch { return false } }

  const add = () => { const id = `arc${++seq}`; live.set(id, { cancel: false, child: null, answer: null, password: null }); return id }
  return {
    compress(root: string, rels: string[], opts: CompressOpts): Reply<string> {
      if (!Array.isArray(rels) || !rels.length || !rels.every((r) => typeof r === 'string') || !opts || !FORMATS.includes(opts.format) || typeof opts.name !== 'string') return { ok: false, error: 'invalid' }
      const id = add()
      void compress(id, root, rels, opts).catch(() => { live.delete(id) })
      return { ok: true, value: id }
    },
    extract(root: string, rel: string, mode: string, items: string[], password: string | null): Reply<string> {
      if (typeof rel !== 'string' || !['here', 'folder'].includes(mode) || !Array.isArray(items) || !items.every((x) => typeof x === 'string')) return { ok: false, error: 'invalid' }
      const id = add()
      void extract(id, root, rel, mode as 'here' | 'folder', items, password || null).catch(() => { live.delete(id) })
      return { ok: true, value: id }
    },
    /** Replace / Skip / Keep both, Continue (size limit), or Cancel; Cancel also stops a running tool. */
    resolve(id: string, r: string, all: boolean): Reply<true> {
      const j = live.get(id)
      if (!j || !['replace', 'skip', 'keep', 'cancel', 'continue'].includes(r)) return { ok: false, error: 'not_found' }
      if (r === 'cancel') { j.cancel = true; kill(j.child, 'SIGCONT'); kill(j.child, 'SIGTERM'); j.password?.(null) }
      j.answer?.(r as ArchiveAnswer, all)
      return { ok: true, value: true }
    },
    /** The answer to a password prompt; null cancels. */
    password(id: string, pw: string | null): Reply<true> {
      const j = live.get(id)
      if (!j?.password) return { ok: false, error: 'not_found' }
      if (pw === null) j.cancel = true
      j.password(pw)
      return { ok: true, value: true }
    },
  }
}

/** An archive under one of the Files roots, for "open with Files" from elsewhere (worksuite-open-archive). */
export function locate(env: Env, full: string): { root: string; rel: string } | null {
  if (typeof full !== 'string' || !path.isAbsolute(full)) return null
  const abs = path.resolve(full)
  const r = roots(env).filter((x) => abs.startsWith(x.path + path.sep)).sort((x, y) => y.path.length - x.path.length)[0]
  if (!r) return null
  const rel = path.relative(r.path, abs)
  return resolveIn(env, r.id, rel) && archiveKind(path.basename(abs)) ? { root: r.id, rel } : null
}

export async function listIn(env: Env, root: string, rel: string, password: string | null, o: ArchiveOpts = {}): Promise<Reply<Listing>> {
  const p = rel ? resolveIn(env, root, rel) : null
  if (!p || !existsSync(p.full)) return { ok: false, error: 'not_found' }
  return listArchive(p.full, password || null, o)
}
