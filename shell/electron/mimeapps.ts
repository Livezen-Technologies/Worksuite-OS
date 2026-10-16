// Default applications (WSOS-DSK-009): read and write XDG mimeapps.list (MIME Applications Associations spec 1.0.1).
// Settings › Default apps shows one choice per category; the choice is written to the user's
// $XDG_CONFIG_HOME/mimeapps.list, which every XDG-aware program (xdg-open, GIO, Qt, the shell's own openPath) reads.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { DesktopEntry } from './xdg'
import { xdgDirs } from './xdgDirs'

export interface Category { id: string; mimes: string[] }

/** The categories Settings offers; the first MIME type decides which apps qualify, all of them are written. */
export const CATEGORIES: Category[] = [
  { id: 'web', mimes: ['x-scheme-handler/http', 'x-scheme-handler/https', 'text/html'] },
  { id: 'mail', mimes: ['x-scheme-handler/mailto'] },
  { id: 'pdf', mimes: ['application/pdf'] },
  { id: 'image', mimes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] },
  { id: 'text', mimes: ['text/plain'] },
  { id: 'video', mimes: ['video/mp4', 'video/webm', 'video/x-matroska'] },
  { id: 'audio', mimes: ['audio/mpeg', 'audio/ogg', 'audio/flac'] },
  { id: 'document', mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.oasis.opendocument.text', 'application/msword'] },
  { id: 'spreadsheet', mimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.oasis.opendocument.spreadsheet', 'application/vnd.ms-excel'] },
  { id: 'presentation', mimes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.oasis.opendocument.presentation', 'application/vnd.ms-powerpoint'] },
]

const DEFAULT_GROUP = 'Default Applications'
const DESKTOP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/

/** [Default Applications] of one mimeapps.list: MIME type → desktop ids in order. */
export function parseDefaults(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let group = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('[')) { group = line.slice(1, -1); continue }
    if (group !== DEFAULT_GROUP) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const ids = line.slice(eq + 1).split(';').map((s) => s.trim()).filter(Boolean)
    out.set(line.slice(0, eq).trim(), ids)
  }
  return out
}

/** Sets `mime=<id>;` for each type in [Default Applications]; every other line and group is kept as it was. */
export function setDefaults(text: string, mimes: string[], desktopFile: string): string {
  const lines = text ? text.replace(/\n$/, '').split('\n') : []
  const todo = new Set(mimes)
  let start = -1, end = lines.length
  lines.forEach((l, i) => {
    const s = l.trim()
    if (!s.startsWith('[')) return
    if (s === `[${DEFAULT_GROUP}]`) start = i
    else if (start >= 0 && end === lines.length && i > start) end = i
  })
  if (start < 0) {
    if (lines.length && lines[lines.length - 1].trim()) lines.push('')
    lines.push(`[${DEFAULT_GROUP}]`)
    start = lines.length - 1
    end = lines.length
  }
  for (let i = start + 1; i < end; i++) {
    const eq = lines[i].indexOf('=')
    const key = eq > 0 ? lines[i].slice(0, eq).trim() : ''
    if (todo.has(key)) { lines[i] = `${key}=${desktopFile};`; todo.delete(key) }
  }
  // Insert after the group's last entry, not after trailing blank lines.
  let at = end
  while (at > start + 1 && !lines[at - 1].trim()) at--
  lines.splice(at, 0, ...[...todo].map((m) => `${m}=${desktopFile};`))
  return lines.join('\n') + '\n'
}

/**
 * mimeapps.list files in lookup order (spec §2): user config, system config, then the applications directories,
 * each with the desktop-specific `<desktop>-mimeapps.list` first.
 */
export function lookupFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME || '/'
  const configHome = xdgDirs(home, env).config
  const configDirs = (env.XDG_CONFIG_DIRS || '/etc/xdg').split(':').filter(Boolean)
  const dataHome = xdgDirs(home, env).data
  const dataDirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean)
  const desktops = (env.XDG_CURRENT_DESKTOP || '').split(':').filter(Boolean).map((d) => d.toLowerCase())
  const names = [...desktops.map((d) => `${d}-mimeapps.list`), 'mimeapps.list']
  const dirs = [configHome, ...configDirs, ...[dataHome, ...dataDirs].map((d) => path.join(d, 'applications'))]
  return dirs.flatMap((d) => names.map((n) => path.join(d, n)))
}

const read = (f: string) => { try { return readFileSync(f, 'utf8') } catch { return null } }

/** The default desktop id for a MIME type: the first listed id that is installed, across the lookup files. */
export function currentDefault(mime: string, installed: Set<string>, files: string[], readFile: (f: string) => string | null = read): string | null {
  for (const f of files) {
    const text = readFile(f)
    if (text === null) continue
    for (const id of parseDefaults(text).get(mime) ?? []) {
      const bare = id.replace(/\.desktop$/, '')
      if (installed.has(bare)) return bare
    }
  }
  return null
}

export interface CategoryState { category: string; current: string | null; candidates: { id: string; name: string }[] }

/** Each category with the apps whose desktop entry declares its first MIME type, and the current default. */
export function defaultApps(entries: DesktopEntry[], env: NodeJS.ProcessEnv = process.env, readFile: (f: string) => string | null = read): CategoryState[] {
  const files = lookupFiles(env)
  const installed = new Set(entries.map((e) => e.id))
  return CATEGORIES.map((c) => ({
    category: c.id,
    current: currentDefault(c.mimes[0], installed, files, readFile),
    candidates: entries.filter((e) => e.mime_types.includes(c.mimes[0])).map((e) => ({ id: e.id, name: e.name })),
  }))
}

/**
 * Writes the user's choice to $XDG_CONFIG_HOME/mimeapps.list (atomically), and also to the user's
 * <desktop>-mimeapps.list when that file exists and already names one of the types, since it takes precedence.
 */
export function setDefaultApp(category: string, id: string, entries: DesktopEntry[], env: NodeJS.ProcessEnv = process.env): { ok: true; value: true } | { ok: false; error: string } {
  const c = CATEGORIES.find((x) => x.id === category)
  if (!c || !DESKTOP_ID.test(id)) return { ok: false, error: 'invalid_argument' }
  if (!entries.some((e) => e.id === id && e.mime_types.includes(c.mimes[0]))) return { ok: false, error: 'not_a_candidate' }
  const configHome = xdgDirs(env.HOME || '/', env).config
  const desktops = (env.XDG_CURRENT_DESKTOP || '').split(':').filter(Boolean).map((d) => `${d.toLowerCase()}-mimeapps.list`)
  try {
    mkdirSync(configHome, { recursive: true })
    const write = (f: string, text: string) => { const tmp = `${f}.tmp-${process.pid}`; writeFileSync(tmp, text, { mode: 0o644 }); renameSync(tmp, f) }
    const main = path.join(configHome, 'mimeapps.list')
    write(main, setDefaults(read(main) ?? '', c.mimes, `${id}.desktop`))
    for (const n of desktops) {
      const f = path.join(configHome, n)
      const text = read(f)
      if (text !== null && c.mimes.some((m) => parseDefaults(text).has(m))) write(f, setDefaults(text, c.mimes, `${id}.desktop`))
    }
    return { ok: true, value: true }
  } catch { return { ok: false, error: 'write_failed' } }
}
