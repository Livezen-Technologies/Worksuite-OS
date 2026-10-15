// Start menu data: the org's WorkSuite web apps, WorkSuite Office when installed, and installed Linux apps.
import type { InstalledApp } from './os'
import { t } from '../i18n'

export type Kind = 'WorkSuite' | 'Linux app' | 'System'

/** How a tile starts: a desktop entry via gtk-launch, WorkSuite Office (start centre or new document), or a shell screen. */
export type Launch = { desktop: string } | { office: 'start' | 'docs' | 'sheets' | 'slides' } | { screen: 'appcenter' | 'files' }

export interface LauncherApp { id: string; name: string; mark: string; bg: string; fg: string; kind: Kind; fav?: boolean; launch: Launch; keywords: string[] }

/** Launcher marks for the WorkSuite modules; the .desktop id is worksuite-<module>. */
const WS_STYLE: Record<string, { name: string; mark: string; bg: string; fg: string; fav?: boolean }> = {
  mail: { name: 'Mail', mark: 'M', bg: '#dbeafe', fg: '#1d4ed8', fav: true },
  calendar: { name: 'Calendar', mark: 'C', bg: '#e0e7ff', fg: '#4338ca', fav: true },
  chat: { name: 'Chat', mark: 'Ch', bg: '#dcfce7', fg: '#15803d', fav: true },
  drive: { name: 'Drive', mark: 'D', bg: '#e0f2fe', fg: '#0369a1', fav: true },
  tasks: { name: 'Tasks', mark: 'T', bg: '#fef3c7', fg: '#b45309' },
  projects: { name: 'Projects', mark: 'P', bg: '#fae8ff', fg: '#a21caf' },
  crm: { name: 'CRM', mark: 'CR', bg: '#ffe4e6', fg: '#be123c' },
  meet: { name: 'Meet', mark: 'Me', bg: '#ccfbf1', fg: '#0f766e' },
  'pdf-studio': { name: 'PDF Studio', mark: 'PDF', bg: '#fee2e2', fg: '#b91c1c' },
}

/** Shown when the org's list can't be read (not signed in, offline); each tile opens a window with a sign-in state. */
export const FALLBACK_WEB_APPS = Object.keys(WS_STYLE).map((id) => ({ id, name: WS_STYLE[id].name }))

const OFFICE_STYLE = { bg: '#ffedd5', fg: '#c2410c' }
const LINUX_FAV = new Set(['firefox-esr', 'firefox', 'org.mozilla.firefox'])

export const APP_CENTER: LauncherApp = { id: 'appcenter', name: 'App Center', mark: 'A', bg: '#2563eb', fg: '#ffffff', kind: 'System', launch: { screen: 'appcenter' }, keywords: ['software', 'install'] }

function initials(name: string) {
  const w = name.replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean)
  if (w.length > 1) return (w[0][0] + w[1][0]).toUpperCase()
  const one = w[0] ?? '?'
  return one.charAt(0).toUpperCase() + one.slice(1, 2).toLowerCase()
}

/**
 * webApps: the org's enabled modules, or null when unknown (fallback list). installed: XDG entries, or null when
 * the bridge isn't available. office: the detected WorkSuite Office desktop id, or null when it isn't installed.
 */
export function buildLauncherApps(webApps: { id: string; name: string }[] | null, installed: InstalledApp[] | null, office: string | null): LauncherApp[] {
  const out: LauncherApp[] = []
  for (const a of webApps ?? FALLBACK_WEB_APPS) {
    const st = WS_STYLE[a.id]
    out.push({
      id: `worksuite-${a.id}`, name: st?.name ?? a.name, mark: st?.mark ?? initials(a.name), bg: st?.bg ?? '#e2e8f0', fg: st?.fg ?? '#1e293b',
      kind: 'WorkSuite', fav: st?.fav, launch: { desktop: `worksuite-${a.id}` }, keywords: ['worksuite', a.id],
    })
  }
  if (office) {
    out.push(
      { id: 'office', name: 'Office', mark: 'O', ...OFFICE_STYLE, kind: 'WorkSuite', fav: true, launch: { office: 'start' }, keywords: ['worksuite office', 'documents', 'editor'] },
      { id: 'office-docs', name: t('files.documents'), mark: 'Do', bg: '#dbeafe', fg: '#1d4ed8', kind: 'WorkSuite', launch: { office: 'docs' }, keywords: ['office', 'word', 'docx', 'writer', 'new document'] },
      { id: 'office-sheets', name: t('setup.app.sheets'), mark: 'Sh', bg: '#dcfce7', fg: '#15803d', kind: 'WorkSuite', launch: { office: 'sheets' }, keywords: ['office', 'excel', 'xlsx', 'calc', 'new spreadsheet'] },
      { id: 'office-slides', name: t('launcher.presentations'), mark: 'Sl', ...OFFICE_STYLE, kind: 'WorkSuite', launch: { office: 'slides' }, keywords: ['office', 'powerpoint', 'pptx', 'slides', 'new presentation'] },
    )
  }
  for (const e of installed ?? []) {
    if (e.id === office || e.id.startsWith('worksuite-')) continue
    const terminal = e.categories.includes('TerminalEmulator')
    out.push({
      id: e.id, name: e.name, mark: terminal ? '>_' : initials(e.name), bg: terminal ? '#0f172a' : '#f1f5f9', fg: terminal ? '#e2e8f0' : '#334155',
      kind: 'Linux app', fav: LINUX_FAV.has(e.id), launch: { desktop: e.id },
      keywords: [e.generic_name ?? '', e.comment ?? '', ...e.keywords, ...e.categories].filter(Boolean),
    })
  }
  out.push(APP_CENTER)
  return out
}

export type LauncherTab = 'all' | 'ws' | 'linux' | 'fav'

/** Tab and search filter. Search matches name, generic name, comment, keywords and categories. */
export function filterApps(apps: LauncherApp[], tab: LauncherTab, query: string): LauncherApp[] {
  const q = query.trim().toLowerCase()
  return apps.filter((a) => {
    if (tab === 'ws' && a.kind !== 'WorkSuite') return false
    if (tab === 'linux' && a.kind !== 'Linux app') return false
    if (tab === 'fav' && !a.fav) return false
    // App Center lives in the footer; it joins the grid only as a search hit so Recent stays visible.
    if (!q) return a.id !== 'appcenter'
    return a.name.toLowerCase().includes(q) || a.keywords.some((k) => k.toLowerCase().includes(q))
  }).sort((a, b) => (q ? rank(a, q) - rank(b, q) : 0))
}

const rank = (a: LauncherApp, q: string) => (a.name.toLowerCase().startsWith(q) ? 0 : a.name.toLowerCase().includes(q) ? 1 : 2)

/** Taskbar pins that exist in the current list (an app the org disabled or that isn't installed drops out). */
export function taskbarApps(apps: LauncherApp[], pins: string[]): LauncherApp[] {
  return pins.map((id) => apps.find((a) => a.id === id)).filter((a): a is LauncherApp => !!a)
}
