// First-run setup choices (appearance, privacy, WorkSuite apps) and their persistence.
// The OS bridge has no settings store yet, so choices live in localStorage; every access is guarded
// because storage can be missing or throw (private profile, blocked site data).

export type Theme = 'Light' | 'Dark' | 'Auto'
export const THEMES: Theme[] = ['Light', 'Dark', 'Auto']
export const ACCENTS = [
  { name: 'Blue', color: '#1F6BFF' },
  { name: 'Cyan', color: '#18D4F0' },
  { name: 'Green', color: '#3DBE7F' },
  { name: 'Orange', color: '#F08A3C' },
  { name: 'Pink', color: '#E0559B' },
  { name: 'Purple', color: '#8B5CF6' },
] as const
export type AccentName = (typeof ACCENTS)[number]['name']

export interface Appearance { theme: Theme; accent: AccentName }
export const DEFAULT_APPEARANCE: Appearance = { theme: 'Dark', accent: 'Blue' }

/** Everything is off unless the person turns it on, except security updates (setup board copy). */
export interface Privacy { location: boolean; updates: boolean; crash: boolean; usage: boolean }
export const DEFAULT_PRIVACY: Privacy = { location: false, updates: true, crash: false, usage: false }

export interface SetupApp { id: string; name: string; desc: string; color: string }
export const SETUP_APPS: SetupApp[] = [
  { id: 'docs', name: 'Docs', desc: 'Documents & PDFs', color: '#1F6BFF' },
  { id: 'sheets', name: 'Sheets', desc: 'Spreadsheets', color: '#2E9E6A' },
  { id: 'mail', name: 'Mail', desc: 'Email & calendar', color: '#D9572B' },
  { id: 'chat', name: 'Chat', desc: 'Team messaging', color: '#7A4FE0' },
  { id: 'drive', name: 'Drive', desc: 'Cloud files', color: '#0E8FA8' },
  { id: 'notes', name: 'Notes', desc: 'Quick notes', color: '#B7791F' },
]
export const DEFAULT_APPS = SETUP_APPS.map((a) => a.id)

export const KEYS = { appearance: 'ws.appearance', privacy: 'ws.privacy', apps: 'ws.setup.apps', done: 'ws.firstRunDone' } as const

type Store = Pick<Storage, 'getItem' | 'setItem'> | null | undefined
function defaultStore(): Store { try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null } }

export function readJson<T>(key: string, fallback: T, store: Store = defaultStore()): T {
  try {
    const raw = store?.getItem(key)
    if (!raw) return fallback
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? { ...fallback, ...v } : fallback
  } catch { return fallback }
}
export function writeJson(key: string, value: unknown, store: Store = defaultStore()): boolean {
  try { if (!store) return false; store.setItem(key, JSON.stringify(value)); return true } catch { return false }
}

export function loadAppearance(store?: Store): Appearance {
  const a = readJson<Appearance>(KEYS.appearance, DEFAULT_APPEARANCE, store)
  return {
    theme: THEMES.includes(a.theme) ? a.theme : DEFAULT_APPEARANCE.theme,
    accent: ACCENTS.some((x) => x.name === a.accent) ? a.accent : DEFAULT_APPEARANCE.accent,
  }
}
export const accentColor = (name: AccentName) => ACCENTS.find((a) => a.name === name)?.color ?? ACCENTS[0].color

/** Theme → <html data-theme> (Auto follows the system); accent → the shell's accent token. */
export function applyAppearance(a: Appearance, root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement) {
  if (!root) return
  if (a.theme === 'Auto') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', a.theme.toLowerCase())
  root.style.setProperty('--color-ws-accent', accentColor(a.accent))
}

/**
 * Rows for the Ready step. The shell has no install-progress API for WorkSuite apps, so every chosen
 * app is reported as queued rather than with an invented percentage.
 */
export function readyRows(chosen: string[]) {
  return SETUP_APPS.filter((a) => chosen.includes(a.id)).map((a) => ({ ...a, initial: a.name[0], label: 'Queued', percent: 0 }))
}
