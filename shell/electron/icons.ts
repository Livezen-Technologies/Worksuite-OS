// App icons for the launcher, taskbar and search: a desktop entry's Icon= resolved as the freedesktop Icon Theme
// Specification does it (current theme and the themes it inherits, then hicolor, then /usr/share/pixmaps), read
// only from icon directories and handed to the renderer as data: URLs (its CSP allows img-src data:). Nothing else
// on disk can be read through here: names are checked, files are resolved through symlinks and must stay inside an
// icon directory, and only PNG and SVG files of a bounded size are returned.
import { readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { xdgDirs } from './xdgDirs'

/** An icon name as a desktop entry gives it (no path); an extension some entries add is dropped. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._+@-]{0,200}$/
const THEME = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,100}$/
const MAX_BYTES = 1024 * 1024
const EXTS = ['svg', 'png'] as const

export interface IconEnv {
  /** Base directories in spec order: $HOME/.icons, $XDG_DATA_HOME/icons, $XDG_DATA_DIRS/icons. */
  bases: string[]
  /** Unthemed fallbacks: /usr/share/pixmaps. */
  pixmaps: string[]
  /** The user's icon theme. */
  theme: string
}

/** The icon directories and theme for this session. */
export function iconEnv(env: NodeJS.ProcessEnv = process.env, readText: (f: string) => string | null = safeRead): IconEnv {
  const home = env.HOME || '/'
  const dirs = xdgDirs(home, env)
  const data = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter((d) => path.isAbsolute(d))
  const bases = [path.join(home, '.icons'), path.join(dirs.data, 'icons'), ...data.map((d) => path.join(d, 'icons'))]
  return { bases: [...new Set(bases)], pixmaps: ['/usr/share/pixmaps'], theme: currentTheme(env, dirs.config, readText) }
}

/** WS_ICON_THEME, else gtk-icon-theme-name from GTK's settings.ini, else Adwaita. */
export function currentTheme(env: NodeJS.ProcessEnv, configHome: string, readText: (f: string) => string | null = safeRead): string {
  const pick = (v: string | undefined | null) => (v && THEME.test(v.trim()) ? v.trim() : null)
  const fromEnv = pick(env.WS_ICON_THEME)
  if (fromEnv) return fromEnv
  for (const f of [path.join(configHome, 'gtk-4.0', 'settings.ini'), path.join(configHome, 'gtk-3.0', 'settings.ini')]) {
    const m = /^\s*gtk-icon-theme-name\s*=\s*"?([^"\n]+)"?\s*$/m.exec(readText(f) ?? '')
    const v = pick(m?.[1])
    if (v) return v
  }
  return 'Adwaita'
}

function safeRead(f: string): string | null {
  try { return readFileSync(f, 'utf8') } catch { return null }
}

export interface ThemeDir { dir: string; size: number; scale: number; type: 'Fixed' | 'Scalable' | 'Threshold'; min: number; max: number; threshold: number }
export interface ThemeIndex { inherits: string[]; dirs: ThemeDir[] }

/** index.theme's [Icon Theme] Directories (and ScaledDirectories) with their sizes, and Inherits. */
export function parseIndexTheme(text: string): ThemeIndex {
  const groups = new Map<string, Record<string, string>>()
  let cur: Record<string, string> | null = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const g = /^\[(.+)\]$/.exec(line)
    if (g) { cur = {}; groups.set(g[1], cur); continue }
    const eq = line.indexOf('=')
    if (cur && eq > 0) cur[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  const head = groups.get('Icon Theme') ?? {}
  const list = (v?: string) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const dirs: ThemeDir[] = []
  for (const d of [...new Set([...list(head.Directories), ...list(head.ScaledDirectories)])]) {
    const kv = groups.get(d)
    const size = Number(kv?.Size)
    if (!kv || !Number.isFinite(size) || size <= 0 || d.split('/').includes('..') || path.isAbsolute(d)) continue
    const type = kv.Type === 'Fixed' || kv.Type === 'Scalable' ? kv.Type : 'Threshold'
    const num = (v: string | undefined, dflt: number) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : dflt)
    dirs.push({ dir: d, size, scale: num(kv.Scale, 1), type, min: num(kv.MinSize, size), max: num(kv.MaxSize, size), threshold: num(kv.Threshold, 2) })
  }
  return { inherits: list(head.Inherits).filter((x) => THEME.test(x)), dirs }
}

/** DirectoryMatchesSize from the spec. */
export function dirMatches(d: ThemeDir, size: number, scale: number): boolean {
  if (d.scale !== scale) return false
  if (d.type === 'Fixed') return d.size === size
  if (d.type === 'Scalable') return d.min <= size && size <= d.max
  return d.size - d.threshold <= size && size <= d.size + d.threshold
}

/** DirectorySizeDistance from the spec. */
export function dirDistance(d: ThemeDir, size: number, scale: number): number {
  const want = size * scale
  if (d.type === 'Fixed') return Math.abs(d.size * d.scale - want)
  if (d.type === 'Scalable') {
    if (want < d.min * d.scale) return d.min * d.scale - want
    if (want > d.max * d.scale) return want - d.max * d.scale
    return 0
  }
  if (want < (d.size - d.threshold) * d.scale) return d.min * d.scale - want
  if (want > (d.size + d.threshold) * d.scale) return want - d.max * d.scale
  return 0
}

/** File system the resolver uses (tests pass a fake). */
export interface IconFs {
  isFile(p: string): boolean
  readText(p: string): string | null
}
const realFs: IconFs = {
  isFile: (p) => { try { return statSync(p).isFile() } catch { return false } },
  readText: safeRead,
}

/** The theme chain: the theme, the themes it inherits (depth first, once each), then hicolor. */
export function themeChain(theme: string, index: (name: string) => ThemeIndex | null): string[] {
  const out: string[] = []
  const visit = (t: string, depth: number) => {
    if (out.includes(t) || depth > 10) return
    const idx = index(t)
    if (!idx) return
    out.push(t)
    for (const p of idx.inherits) if (p !== 'hicolor') visit(p, depth + 1)
  }
  visit(theme, 0)
  if (!out.includes('hicolor') && index('hicolor')) out.push('hicolor')
  return out
}

/** Canonical name: the Icon= value without a .png/.svg/.xpm some entries add, or null when it isn't a plain name. */
export function iconName(v: string): string | null {
  const n = v.replace(/\.(png|svg|xpm)$/i, '')
  return NAME.test(n) && !n.includes('..') ? n : null
}

/**
 * The icon file for an Icon= value at `size` (logical px) and `scale`, or null. A name is looked up in each theme of
 * the chain (an exact size match first; else the closest size, scalable SVG winning a tie), then in pixmaps. An
 * absolute path is accepted only when it lies inside one of the icon directories (checked again on read).
 */
export function lookupIcon(value: string, size: number, scale: number, env: IconEnv, fs: IconFs = realFs): string | null {
  if (path.isAbsolute(value)) {
    const norm = path.normalize(value)
    const ext = path.extname(norm).slice(1).toLowerCase()
    return (EXTS as readonly string[]).includes(ext) && insideAny(norm, roots(env)) && fs.isFile(norm) ? norm : null
  }
  const name = iconName(value)
  if (!name) return null
  const indexCache = new Map<string, ThemeIndex | null>()
  const index = (t: string) => {
    if (!indexCache.has(t)) {
      let found: ThemeIndex | null = null
      for (const b of env.bases) {
        const text = fs.readText(path.join(b, t, 'index.theme'))
        if (text !== null) { found = parseIndexTheme(text); break }
      }
      indexCache.set(t, found)
    }
    return indexCache.get(t)!
  }
  for (const theme of themeChain(env.theme, index)) {
    const idx = index(theme)!
    let best: { file: string; dist: number; svg: boolean } | null = null
    for (const d of idx.dirs) {
      for (const b of env.bases) {
        for (const ext of EXTS) {
          const file = path.join(b, theme, d.dir, `${name}.${ext}`)
          if (!fs.isFile(file)) continue
          const dist = dirMatches(d, size, scale) ? 0 : dirDistance(d, size, scale) + 0.5
          const svg = ext === 'svg'
          if (!best || dist < best.dist || (dist === best.dist && svg && !best.svg)) best = { file, dist, svg }
        }
      }
    }
    if (best) return best.file
  }
  for (const p of env.pixmaps) {
    for (const ext of EXTS) {
      const file = path.join(p, `${name}.${ext}`)
      if (fs.isFile(file)) return file
    }
  }
  return null
}

const roots = (env: IconEnv) => [...env.bases, ...env.pixmaps]

/** Whether `file` lies strictly inside one of `dirs` (both already resolved). */
export function insideAny(file: string, dirs: string[]): boolean {
  return dirs.some((d) => { const rel = path.relative(d, file); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) })
}

export interface ReadFs { realpath(p: string): string; size(p: string): number; read(p: string): Buffer }
const realReadFs: ReadFs = {
  realpath: (p) => realpathSync(p),
  size: (p) => { const s = statSync(p); return s.isFile() ? s.size : -1 },
  read: (p) => readFileSync(p),
}

/**
 * The icon at `file` as a data: URL, or null. The file's real path (symlinks followed) must still be inside an icon
 * directory's real path, be a regular PNG or SVG file and at most 1 MiB; a PNG must carry the PNG signature.
 */
export function iconDataUrl(file: string, env: IconEnv, fs: ReadFs = realReadFs): string | null {
  try {
    const real = fs.realpath(file)
    const realRoots = roots(env).map((r) => { try { return fs.realpath(r) } catch { return null } }).filter((r): r is string => !!r)
    if (!insideAny(real, realRoots)) return null
    const ext = path.extname(real).slice(1).toLowerCase()
    if (!(EXTS as readonly string[]).includes(ext)) return null
    const size = fs.size(real)
    if (size <= 0 || size > MAX_BYTES) return null
    const buf = fs.read(real)
    if (ext === 'png') {
      if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null
      return `data:image/png;base64,${buf.toString('base64')}`
    }
    if (!/<svg[\s>]/i.test(buf.subarray(0, 4096).toString('utf8'))) return null
    return `data:image/svg+xml;base64,${buf.toString('base64')}`
  } catch { return null }
}

/** Resolves and caches icons for the IPC handler; the cache is cleared when the theme changes. */
export class IconCache {
  private cache = new Map<string, string | null>()
  private envKey = ''
  constructor(private getEnv: () => IconEnv = () => iconEnv(), private fs: IconFs = realFs, private readFs: ReadFs = realReadFs) {}

  /** Data URLs (or null) for each requested Icon= value at `size` px and `scale`. Bad input yields an empty map. */
  resolve(values: unknown, size: unknown, scale: unknown): Record<string, string | null> {
    if (!Array.isArray(values)) return {}
    const px = Math.min(512, Math.max(8, Math.round(Number(size) || 32)))
    const sc = Math.min(4, Math.max(1, Math.round(Number(scale) || 1)))
    const env = this.getEnv()
    const key = JSON.stringify(env)
    if (key !== this.envKey) { this.cache.clear(); this.envKey = key }
    const out: Record<string, string | null> = {}
    for (const v of values.slice(0, 512)) {
      if (typeof v !== 'string' || !v || v.length > 1024 || v in out) continue
      const k = `${v}\0${px}\0${sc}`
      if (!this.cache.has(k)) {
        const file = lookupIcon(v, px, sc, env, this.fs)
        this.cache.set(k, file ? iconDataUrl(file, env, this.readFs) : null)
      }
      out[v] = this.cache.get(k)!
    }
    return out
  }
}
