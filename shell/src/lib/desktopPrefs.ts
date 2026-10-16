// Desktops preferences (WSOS-DSK-003) as stored in the synced 'preferences/shell' object, validated. Pure (no React),
// so the Electron main process can check what it stores (shellPrefsFrom).

/** Wallpaper ids of lib/displays WALLPAPERS. */
export const WALLPAPER_IDS = ['default', 'dusk', 'teal', 'graphite', 'sunrise']
export const MAX_DESKTOPS = 16
export const NAME_MAX = 40
export type Scope = 'current' | 'all'

/** One desktop as saved: its own name ("" = "Desktop N") and wallpaper id (lib/displays WALLPAPERS; "" = the monitor's). */
export interface SavedDesktop { name: string; wallpaper: string }
export interface DesktopPrefs {
  list: SavedDesktop[]
  /** Apps whose windows are on every desktop. */
  stickyApps: string[]
  /** Settings › Multitasking: which windows the taskbar and Alt+Tab show; both "Only the desktop I'm using". */
  taskbar: Scope
  altTab: Scope
  /** Settings › Multitasking › Show Task View button. */
  taskViewButton: boolean
}
export const DEFAULT_DESKTOP_PREFS: DesktopPrefs = { list: [{ name: '', wallpaper: '' }], stickyApps: [], taskbar: 'current', altTab: 'current', taskViewButton: true }

const APP = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/
export const cleanName = (s: unknown) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX)

/** Validated desktops preferences from untrusted data (sync store, IPC); undefined when there are none. */
export function desktopPrefsFrom(v: unknown): DesktopPrefs | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const list = Array.isArray(o.list)
    ? o.list.slice(0, MAX_DESKTOPS).map((d) => {
      const x = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>
      const wp = typeof x.wallpaper === 'string' && WALLPAPER_IDS.includes(x.wallpaper) ? x.wallpaper : ''
      return { name: cleanName(x.name), wallpaper: wp }
    })
    : []
  return {
    list: list.length ? list : DEFAULT_DESKTOP_PREFS.list,
    stickyApps: Array.isArray(o.stickyApps) ? [...new Set(o.stickyApps.filter((a): a is string => typeof a === 'string' && APP.test(a)))].slice(0, 64) : [],
    taskbar: o.taskbar === 'all' ? 'all' : 'current',
    altTab: o.altTab === 'all' ? 'all' : 'current',
    taskViewButton: o.taskViewButton !== false,
  }
}

