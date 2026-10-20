// The shell's own windows (Files, Settings, App Center, System monitor, Snipping Tool) inside the desktop work area,
// managed like Windows 11 windows (issues #15, #33): several open at once, stacked in the order they were last used,
// each one movable by its title bar, resizable from its edges and corners down to a minimum size, minimized to the
// taskbar, maximized to the work area and restored to where it was. Pure state and geometry; components/ShellWindow.tsx
// draws the frame and App.tsx keeps the state.
import type { WindowApp } from '../screens/types'

export interface Rect { x: number; y: number; w: number; h: number }
export interface Size { w: number; h: number }
export interface ShellWin { app: WindowApp; minimized: boolean; maximized: boolean; rect: Rect | null }
/** Open windows, bottom to top: the last one that is not minimized is the active window. */
export type ShellWins = ShellWin[]

/** Minimum sizes: below these the screens' own layouts (navigation pane + page) stop working. */
export const MIN_SIZE: Record<WindowApp, Size> = {
  files: { w: 640, h: 420 },
  settings: { w: 720, h: 480 },
  appcenter: { w: 720, h: 480 },
  monitor: { w: 640, h: 420 },
  snip: { w: 520, h: 360 },
}
/** Title bar height (Windows 11: 32 px at 100 %; the shell scales with the page zoom, so every scale gets the same look). */
export const TITLE_BAR = 32
/** How much of a window must stay inside the work area when it is dragged away (it can always be dragged back). */
export const KEEP_VISIBLE = 96

export type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
export const EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

/** The active (focused) window: the topmost one that is not minimized. */
export function activeWin(wins: ShellWins): WindowApp | null {
  for (let i = wins.length - 1; i >= 0; i--) if (!wins[i].minimized) return wins[i].app
  return null
}
export const anyVisible = (wins: ShellWins) => wins.some((w) => !w.minimized)

/** Opens a window, or restores and raises it when it is already open (one window per shell app, like Settings). */
export function openWin(wins: ShellWins, app: WindowApp): ShellWins {
  const cur = wins.find((w) => w.app === app)
  return [...wins.filter((w) => w.app !== app), cur ? { ...cur, minimized: false } : { app, minimized: false, maximized: false, rect: null }]
}
export const closeWin = (wins: ShellWins, app: WindowApp): ShellWins => wins.filter((w) => w.app !== app)
/** Raises a window over the others (a click anywhere in it) and restores it if it was minimized. */
export function focusWin(wins: ShellWins, app: WindowApp): ShellWins {
  const cur = wins.find((w) => w.app === app)
  if (!cur) return wins
  if (wins[wins.length - 1] === cur && !cur.minimized) return wins
  return [...wins.filter((w) => w.app !== app), { ...cur, minimized: false }]
}
/** Minimizes a window: it keeps its place in the stack (and its contents), the next one down becomes active. */
export const minimizeWin = (wins: ShellWins, app: WindowApp): ShellWins => wins.map((w) => (w.app === app ? { ...w, minimized: true } : w))
export function toggleMaxWin(wins: ShellWins, app: WindowApp): ShellWins {
  return focusWin(wins, app).map((w) => (w.app === app ? { ...w, maximized: !w.maximized } : w))
}
export function setRect(wins: ShellWins, app: WindowApp, rect: Rect): ShellWins {
  return wins.map((w) => (w.app === app ? { ...w, rect, maximized: false } : w))
}
/** The taskbar button: restores a minimized window, minimizes the active one, raises any other (Windows 11). */
export function taskbarClick(wins: ShellWins, app: WindowApp): ShellWins {
  const cur = wins.find((w) => w.app === app)
  if (!cur) return openWin(wins, app)
  if (!cur.minimized && activeWin(wins) === app) return minimizeWin(wins, app)
  return focusWin(wins, app)
}

/** Where a window opens: centred in the work area, 80 % of it but never under the minimum, cascaded by its stack index. */
export function defaultRect(app: WindowApp, area: Size, index = 0): Rect {
  const min = MIN_SIZE[app]
  const w = Math.min(area.w, Math.max(min.w, Math.round(area.w * 0.8)))
  const h = Math.min(area.h, Math.max(min.h, Math.round(area.h * 0.84)))
  const step = 28 * (index % 5)
  return clampRect({ x: Math.round((area.w - w) / 2) + step, y: Math.round((area.h - h) / 2) + step, w, h }, area, min)
}

/** Keeps a window usable: at least its minimum size (or the whole work area when that is smaller), no larger than the
 *  work area, its title bar never above the top edge or below the bottom, and at least KEEP_VISIBLE px of it inside
 *  the work area sideways. */
export function clampRect(r: Rect, area: Size, min: Size): Rect {
  const w = Math.min(area.w, Math.max(Math.min(min.w, area.w), Math.round(r.w)))
  const h = Math.min(area.h, Math.max(Math.min(min.h, area.h), Math.round(r.h)))
  const keep = Math.min(KEEP_VISIBLE, w)
  // A window as wide (or tall) as the work area sits flush with it.
  const x = w >= area.w ? 0 : Math.min(area.w - keep, Math.max(keep - w, Math.round(r.x)))
  const y = h >= area.h ? 0 : Math.min(area.h - TITLE_BAR, Math.max(0, Math.round(r.y)))
  return { x, y, w, h }
}

/** A drag of the title bar by (dx, dy) from where it started. */
export const moveRect = (start: Rect, dx: number, dy: number, area: Size, min: Size): Rect =>
  clampRect({ ...start, x: start.x + dx, y: start.y + dy }, area, min)

/** A drag of an edge or corner by (dx, dy): the opposite edge stays put, the size stops at the minimum and at the
 *  work area's edges. */
export function resizeRect(start: Rect, edge: Edge, dx: number, dy: number, area: Size, min: Size): Rect {
  let { x, y, w, h } = start
  const right = start.x + start.w, bottom = start.y + start.h
  const mw = Math.min(min.w, area.w), mh = Math.min(min.h, area.h)
  if (edge.includes('e')) w = Math.max(mw, Math.min(area.w - start.x, start.w + dx))
  if (edge.includes('s')) h = Math.max(mh, Math.min(area.h - start.y, start.h + dy))
  if (edge.includes('w')) { x = Math.max(0, Math.min(right - mw, start.x + dx)); w = right - x }
  if (edge.includes('n')) { y = Math.max(0, Math.min(bottom - mh, start.y + dy)); h = bottom - y }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
}

/** The CSS cursor for an edge. */
export const edgeCursor = (e: Edge) => `${e}-resize`
