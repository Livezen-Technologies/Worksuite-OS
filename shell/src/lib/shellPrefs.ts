// Shell ENH-01 preferences (WSOS-DSK-001): the user's favourites, taskbar pins and Start order, stored in the synced
// 'preferences/shell' object so they follow the user and work offline. Unknown or bad data falls back to defaults.
import { normaliseLayout, type WidgetLayout } from './widgets'

const ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/
const MAX = 64

/** widgets: the desktop widgets' layout (lib/widgets.ts), saved alongside the pins. */
export interface ShellPrefs { favorites?: string[]; taskbar?: string[]; order?: string[]; widgets?: WidgetLayout }

const ids = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && ID.test(x)))].slice(0, MAX) : undefined

/** Validated preferences from untrusted data (sync store, IPC). */
export function shellPrefsFrom(v: unknown): ShellPrefs {
  if (!v || typeof v !== 'object') return {}
  const o = v as Record<string, unknown>
  const out: ShellPrefs = {}
  for (const k of ['favorites', 'taskbar', 'order'] as const) { const l = ids(o[k]); if (l) out[k] = l }
  if (o.widgets && typeof o.widgets === 'object') out.widgets = normaliseLayout(o.widgets)
  return out
}

/** Apps with the user's favourites and order applied (apps keep their own defaults where the user has none). */
export function applyShellPrefs<T extends { id: string; fav?: boolean }>(apps: T[], p: ShellPrefs): T[] {
  const fav = p.favorites ? new Set(p.favorites) : null
  const out = fav ? apps.map((a) => ({ ...a, fav: fav.has(a.id) })) : [...apps]
  if (!p.order?.length) return out
  const rank = new Map(p.order.map((id, i) => [id, i]))
  return out.map((a, i) => ({ a, i })).sort((x, y) => (rank.get(x.a.id) ?? MAX + x.i) - (rank.get(y.a.id) ?? MAX + y.i)).map((x) => x.a)
}

/** Taskbar pins: the user's, else the shell's defaults. */
export const taskbarPins = (p: ShellPrefs, defaults: string[]): string[] => p.taskbar ?? defaults

/** Pin or unpin an app to Start; the result is what gets saved. */
export function toggleFavorite(p: ShellPrefs, apps: { id: string; fav?: boolean }[], id: string): ShellPrefs {
  const current = p.favorites ?? apps.filter((a) => a.fav).map((a) => a.id)
  const favorites = current.includes(id) ? current.filter((x) => x !== id) : [...current, id]
  return { ...p, favorites, order: p.order ?? favorites }
}
