// Start menu data: the org's WorkSuite apps (in WorkSuite Desktop when installed, else web app windows), WorkSuite
// Office when installed, and installed Linux apps.
import type { InstalledApp } from './os'
import { t } from '../i18n'
import { WHATSAPP_APP_ID } from '../../electron/whatsapp'

export type Kind = 'WorkSuite' | 'Linux app' | 'System'

/** How a tile starts: a desktop entry via gtk-launch, WorkSuite Office (start centre or new document), or a shell screen. */
export type Launch = { desktop: string } | { office: 'start' | 'docs' | 'sheets' | 'slides' } | { worksuite: DesktopModule } | { screen: 'appcenter' | 'files' | 'monitor' | 'settings' }

/** Modules WorkSuite Desktop opens with `--module=<id>`. */
export type DesktopModule = 'home' | 'mail' | 'chat' | 'calendar' | 'tasks' | 'files' | 'crm' | 'hr'

/**
 * The WorkSuite Desktop module for an org web app id, or null when the desktop has none (Projects, Meet, PDF Studio
 * and anything else keep their worksuite-app web window). Drive is the desktop's Files.
 */
export const DESKTOP_MODULE_FOR: Record<string, DesktopModule> = {
  mail: 'mail', chat: 'chat', calendar: 'calendar', tasks: 'tasks', drive: 'files', files: 'files', crm: 'crm', hr: 'hr',
}

/**
 * icon: the desktop entry's Icon= (theme name or path), resolved by the main process; apps the OS knows by id use
 * bundled icons (lib/brandIcons.ts). mark/bg/fg: the letter mark drawn when there is no icon. appIds: Wayland
 * app_ids / StartupWMClass its windows carry besides its id.
 */
export interface LauncherApp { id: string; name: string; mark: string; bg: string; fg: string; kind: Kind; fav?: boolean; launch: Launch; keywords: string[]; offline?: OfflineLevel; icon?: string | null; appIds?: string[] }
/** Offline level the app declares (WSOS-SYN-009); shown in the launcher. */
export type OfflineLevel = 'full_offline' | 'cached_read' | 'online_only'

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
/** WhatsApp Web in its own window (lk.worksuite.whatsapp.desktop, `worksuite-app whatsapp`); pinned by default. */
export const WHATSAPP: LauncherApp = {
  id: WHATSAPP_APP_ID, name: 'WhatsApp', mark: 'Wa', bg: '#25D366', fg: '#ffffff', kind: 'Linux app', fav: true,
  launch: { desktop: WHATSAPP_APP_ID }, icon: WHATSAPP_APP_ID, appIds: [WHATSAPP_APP_ID, 'whatsapp'],
  keywords: ['whatsapp', 'chat', 'messages', 'messenger', 'InstantMessaging'],
}

export const MONITOR: LauncherApp = { id: 'monitor', get name() { return t('monitor.title') }, mark: '~', bg: '#dcfce7', fg: '#15803d', kind: 'System', launch: { screen: 'monitor' }, keywords: ['task manager', 'processes', 'cpu', 'memory', 'performance'] }

function initials(name: string) {
  const w = name.replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean)
  if (w.length > 1) return (w[0][0] + w[1][0]).toUpperCase()
  const one = w[0] ?? '?'
  return one.charAt(0).toUpperCase() + one.slice(1, 2).toLowerCase()
}

/**
 * webApps: the org's enabled modules, or null when unknown (fallback list). installed: XDG entries, or null when
 * the bridge isn't available. office: the detected WorkSuite Office desktop id, or null when it isn't installed.
 * desktop: the WorkSuite Desktop entry id when it is installed: its modules open there (`--module=<id>`), the rest
 * in worksuite-app web windows. whatsapp: false when policy turns WhatsApp off (or on a kiosk).
 */
export function buildLauncherApps(webApps: { id: string; name: string; offline_level?: OfflineLevel }[] | null, installed: InstalledApp[] | null, office: string | null, desktop: string | null = null, whatsapp = true): LauncherApp[] {
  const out: LauncherApp[] = []
  if (desktop) {
    out.push({ id: 'worksuite-desktop', name: 'WorkSuite', mark: 'W', bg: '#2563eb', fg: '#ffffff', kind: 'WorkSuite', fav: true, launch: { worksuite: 'home' }, keywords: ['worksuite', 'home', 'desktop'] })
  }
  for (const a of (webApps ?? FALLBACK_WEB_APPS) as { id: string; name: string; offline_level?: OfflineLevel }[]) {
    const st = WS_STYLE[a.id]
    const mod = desktop ? DESKTOP_MODULE_FOR[a.id] : undefined
    out.push({
      id: `worksuite-${a.id}`, name: st?.name ?? a.name, mark: st?.mark ?? initials(a.name), bg: st?.bg ?? '#e2e8f0', fg: st?.fg ?? '#1e293b',
      kind: 'WorkSuite', fav: st?.fav, launch: mod ? { worksuite: mod } : { desktop: `worksuite-${a.id}` }, keywords: ['worksuite', a.id],
      ...(a.offline_level ? { offline: a.offline_level } : {}),
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
  if (whatsapp) out.push(WHATSAPP)
  for (const e of installed ?? []) {
    if (e.id === office || e.id === desktop || e.id.startsWith('worksuite-') || e.id === WHATSAPP_APP_ID) continue
    const terminal = e.categories.includes('TerminalEmulator')
    out.push({
      id: e.id, name: e.name, mark: terminal ? '>_' : initials(e.name), bg: terminal ? '#0f172a' : '#f1f5f9', fg: terminal ? '#e2e8f0' : '#334155',
      kind: 'Linux app', fav: LINUX_FAV.has(e.id), launch: { desktop: e.id }, icon: e.icon, ...(e.wm_class ? { appIds: [e.wm_class] } : {}),
      keywords: [e.generic_name ?? '', e.comment ?? '', ...e.keywords, ...e.categories].filter(Boolean),
    })
  }
  out.push(MONITOR, APP_CENTER)
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

const lum = (hex: string) => {
  const n = parseInt(hex.replace('#', ''), 16)
  return Number.isFinite(n) ? 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255) : 0
}
/** Tile colour on the dark Start menu (G02): the darker of the app's two marks, with white text on it. */
export function tileColor(a: Pick<LauncherApp, 'bg' | 'fg'>): string {
  return lum(a.bg) <= lum(a.fg) ? a.bg : a.fg
}

/** Start menu pins (G02): favourites, then other apps, up to `max`, always ending with App Center and the system monitor. */
export function startPins(apps: LauncherApp[], max = 12, tail: LauncherApp[] = []): LauncherApp[] {
  const sys = new Set(['appcenter', 'monitor'])
  const own = apps.filter((a) => !sys.has(a.id))
  const end = [...apps.filter((a) => a.id === 'appcenter'), ...tail, ...apps.filter((a) => a.id === 'monitor')]
  return [...own.filter((a) => a.fav), ...own.filter((a) => !a.fav)].slice(0, Math.max(0, max - end.length)).concat(end)
}

/** "All apps" (G02): A–Z groups by first letter; digits and symbols under '#'. */
export function alphaGroups(apps: LauncherApp[]): { letter: string; apps: LauncherApp[] }[] {
  const by = new Map<string, LauncherApp[]>()
  for (const a of [...apps].sort((x, y) => x.name.localeCompare(y.name))) {
    const c = a.name.charAt(0).toLocaleUpperCase()
    const k = /\p{L}/u.test(c) ? c : '#'
    by.set(k, [...(by.get(k) ?? []), a])
  }
  return [...by.entries()].map(([letter, apps]) => ({ letter, apps }))
}

const rank = (a: LauncherApp, q: string) => (a.name.toLowerCase().startsWith(q) ? 0 : a.name.toLowerCase().includes(q) ? 1 : 2)

/**
 * Recovery launcher list (WSOS-SES-005): installed apps without terminals or shells, and without the WorkSuite web app
 * windows (they need the shell that just crashed), sorted by name.
 */
export function safeApps<T extends InstalledApp>(apps: T[]): T[] {
  const TERMINAL = new Set(['TerminalEmulator', 'ConsoleOnly'])
  return apps.filter((a) => !a.categories.some((c) => TERMINAL.has(c)) && !a.id.startsWith('worksuite-'))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The launcher app a running window belongs to, from its Wayland app_id: the desktop id itself, the entry's
 * StartupWMClass, a WorkSuite app window (lk.worksuite.<module>), or a reverse-DNS id's last part (org.gnome.Nautilus
 * → nautilus, and the other way round). Case is ignored. Undefined when nothing matches.
 */
export function appForWindow(apps: LauncherApp[], appId: string): LauncherApp | undefined {
  const w = appId.trim().toLowerCase()
  if (!w) return undefined
  const ws = /^lk\.worksuite\.(.+)$/.exec(w)
  const hit = ws && apps.find((a) => a.id === `worksuite-${ws[1]}`)
  if (hit) return hit
  const last = (s: string) => s.split('.').pop() ?? s
  return apps.find((a) => a.id.toLowerCase() === w)
    ?? apps.find((a) => a.appIds?.some((x) => x.toLowerCase() === w))
    ?? apps.find((a) => a.kind === 'Linux app' && (last(a.id.toLowerCase()) === w || a.id.toLowerCase() === last(w)))
}

/** Taskbar pins that exist in the current list (an app the org disabled or that isn't installed drops out). */
export function taskbarApps(apps: LauncherApp[], pins: string[]): LauncherApp[] {
  return pins.map((id) => apps.find((a) => a.id === id)).filter((a): a is LauncherApp => !!a)
}
