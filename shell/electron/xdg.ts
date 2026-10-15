// Installed applications from XDG desktop entries (Desktop Entry Specification), for the launcher.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

export interface DesktopEntry {
  /** Desktop file id (basename without .desktop), what gtk-launch takes. */
  id: string
  name: string
  generic_name: string | null
  comment: string | null
  icon: string | null
  categories: string[]
  keywords: string[]
  exec: string | null
}

/** Main [Desktop Entry] group as key → value (unlocalised keys plus Name[<lang>] when it matches). */
export function parseDesktopFile(text: string, lang = ''): Record<string, string> {
  const out: Record<string, string> = {}
  let inMain = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('[')) { inMain = line === '[Desktop Entry]'; continue }
    if (!inMain) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    const m = /^([A-Za-z0-9-]+)\[([^\]]+)\]$/.exec(key)
    if (m) { if (lang && (m[2] === lang || m[2] === lang.split('_')[0])) out[`${m[1]}@l`] = value; continue }
    out[key] = value
  }
  return out
}

const list = (v: string | undefined) => (v ?? '').split(';').map((s) => s.trim()).filter(Boolean)

/** A visible application entry for this desktop, or null (Type, NoDisplay, Hidden, OnlyShowIn/NotShowIn, TryExec not checked). */
export function toEntry(id: string, kv: Record<string, string>, desktops: string[]): DesktopEntry | null {
  if (kv.Type !== 'Application' || kv.NoDisplay === 'true' || kv.Hidden === 'true') return null
  const only = list(kv.OnlyShowIn)
  if (only.length && !only.some((d) => desktops.includes(d))) return null
  if (list(kv.NotShowIn).some((d) => desktops.includes(d))) return null
  const name = kv['Name@l'] ?? kv.Name
  if (!name) return null
  return {
    id, name,
    generic_name: kv['GenericName@l'] ?? kv.GenericName ?? null,
    comment: kv['Comment@l'] ?? kv.Comment ?? null,
    icon: kv.Icon ?? null,
    categories: list(kv.Categories),
    keywords: list(kv['Keywords@l'] ?? kv.Keywords),
    exec: kv.Exec ?? null,
  }
}

/** $XDG_DATA_HOME/applications first, then $XDG_DATA_DIRS; the first directory holding an id wins. */
export function applicationDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.XDG_DATA_HOME || path.join(env.HOME || '/', '.local/share')
  const dirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean)
  return [home, ...dirs].map((d) => path.join(d, 'applications'))
}

/** Desktop file ids, including subdirectory ids (kde/foo.desktop → kde-foo). */
function walk(dir: string, prefix = ''): [string, string][] {
  let names: import('node:fs').Dirent[]
  try { names = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const out: [string, string][] = []
  for (const d of names) {
    const full = path.join(dir, d.name)
    if (d.isDirectory()) out.push(...walk(full, `${prefix}${d.name}-`))
    else if (d.name.endsWith('.desktop')) out.push([`${prefix}${d.name.slice(0, -'.desktop'.length)}`, full])
  }
  return out
}

export function installedApps(env: NodeJS.ProcessEnv = process.env): DesktopEntry[] {
  const desktops = (env.XDG_CURRENT_DESKTOP || 'WorkSuite').split(':')
  const lang = (env.LC_ALL || env.LC_MESSAGES || env.LANG || '').split('.')[0]
  const seen = new Set<string>()
  const out: DesktopEntry[] = []
  for (const dir of applicationDirs(env)) {
    for (const [id, file] of walk(dir)) {
      if (seen.has(id)) continue
      seen.add(id) // a hidden user override still shadows the system entry
      let text: string
      try { text = readFileSync(file, 'utf8') } catch { continue }
      const e = toEntry(id, parseDesktopFile(text, lang), desktops)
      if (e) out.push(e)
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * WorkSuite Office (the native desktop editors, a rebranded ONLYOFFICE DesktopEditors build) is found by its entry
 * rather than a fixed id: an entry whose id, Name or Exec mentions worksuite-office or desktopeditors.
 */
export function findOffice(entries: DesktopEntry[]): DesktopEntry | null {
  const re = /worksuite[- ]office|desktopeditors/i
  return entries.find((e) => re.test(e.id) || re.test(e.name) || re.test(e.exec ?? '')) ?? null
}

/** Program of an Exec line (first word, quotes removed); field codes and arguments are dropped. */
export function execProgram(exec: string | null): string | null {
  if (!exec) return null
  const m = /^\s*(?:"([^"]+)"|(\S+))/.exec(exec)
  const p = m?.[1] ?? m?.[2] ?? null
  return p && !p.startsWith('%') && !/^(env|sh|bash)$/.test(path.basename(p)) ? p : null
}

/** ONLYOFFICE DesktopEditors' "new document" switches. */
export const OFFICE_NEW: Record<string, string> = { docs: '--new:word', sheets: '--new:cell', slides: '--new:slide' }

/**
 * WorkSuite Desktop (the native client, package worksuite-desktop from github.com/Livezen-Technologies/worksuite-desktop)
 * installs /usr/share/applications/worksuite.desktop with Exec=/opt/WorkSuite/worksuite %U. Found by that id, or by
 * an Exec whose program is .../WorkSuite/worksuite or worksuite.
 */
export function findWorkSuiteDesktop(entries: DesktopEntry[]): DesktopEntry | null {
  return entries.find((e) => e.id === 'worksuite') ??
    entries.find((e) => { const p = execProgram(e.exec); return !!p && /(^|\/)(WorkSuite\/)?worksuite$/.test(p) }) ?? null
}

/** Modules WorkSuite Desktop opens with --module=<id> (its shared/os-mode.ts LAUNCH_MODULES). */
export const DESKTOP_MODULES = ['home', 'mail', 'chat', 'calendar', 'tasks', 'files', 'crm', 'hr'] as const
