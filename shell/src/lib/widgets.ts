// Desktop widgets: WorkSuite Desktop's Home cards on the OS wallpaper (src/modules/home in worksuite-desktop).
// The layout model (order, hidden, wide) follows Desktop's home/today.ts; it is stored in the synced
// 'preferences/shell' object (shellPrefs.ts) with a local fallback, so it follows the user to another device.
import type { WEvent, WNotice, WTask, WidgetsSnapshot } from '../../electron/widgets'

export type WidgetId = 'glance' | 'work' | 'calendar' | 'waiting' | 'announcements' | 'summary' | 'activity' | 'files'
export type WidgetSize = 'normal' | 'wide'

/** Desktop's cards, in its default order, with its stat tiles as "At a glance". */
export const WIDGETS: WidgetId[] = ['glance', 'work', 'calendar', 'waiting', 'announcements', 'summary', 'activity', 'files']

export const LAYOUT_VERSION = 1
export interface WidgetLayout { version: number; order: WidgetId[]; hidden: WidgetId[]; wide: WidgetId[] }

/** The wallpaper is not a page: the four busiest of Desktop's cards are on at first, the rest one click away. */
export const DEFAULT_LAYOUT: WidgetLayout = { version: LAYOUT_VERSION, order: [...WIDGETS], hidden: ['summary', 'activity', 'files'], wide: [] }

const known = new Set<string>(WIDGETS)
const ids = (raw: unknown): WidgetId[] => [...new Set((Array.isArray(raw) ? raw : []).filter((x): x is WidgetId => typeof x === 'string' && known.has(x)))]

/** A saved layout from untrusted data (sync store, local storage), made whole: unknown ids dropped, new ones appended. */
export function normaliseLayout(raw: unknown): WidgetLayout {
  if (!raw || typeof raw !== 'object') return DEFAULT_LAYOUT
  const r = raw as Record<string, unknown>
  const order = ids(r.order)
  for (const id of WIDGETS) if (!order.includes(id)) order.push(id)
  return { version: LAYOUT_VERSION, order, hidden: ids(r.hidden), wide: ids(r.wide) }
}

export const shown = (l: WidgetLayout): WidgetId[] => l.order.filter((id) => !l.hidden.includes(id))
export const sizeOf = (l: WidgetLayout, id: WidgetId): WidgetSize => (l.wide.includes(id) ? 'wide' : 'normal')
export const resize = (l: WidgetLayout, id: WidgetId, size: WidgetSize): WidgetLayout =>
  ({ ...l, wide: size === 'wide' ? [...l.wide.filter((x) => x !== id), id] : l.wide.filter((x) => x !== id) })
export const remove = (l: WidgetLayout, id: WidgetId): WidgetLayout => (l.hidden.includes(id) ? l : { ...l, hidden: [...l.hidden, id] })
/** Added back at the end of what is shown. */
export const add = (l: WidgetLayout, id: WidgetId): WidgetLayout => ({ ...l, hidden: l.hidden.filter((x) => x !== id), order: [...l.order.filter((x) => x !== id), id] })

/** Up or down past the next shown widget (keyboard and the Move buttons). */
export function move(l: WidgetLayout, id: WidgetId, by: -1 | 1): WidgetLayout {
  const vis = shown(l)
  const other = vis[vis.indexOf(id) + by]
  if (!vis.includes(id) || !other) return l
  const order = [...l.order]
  const i = order.indexOf(id); const j = order.indexOf(other)
  ;[order[i], order[j]] = [order[j]!, order[i]!]
  return { ...l, order }
}

/** Drag and drop: the widget goes where the other one is. */
export function place(l: WidgetLayout, id: WidgetId, before: WidgetId): WidgetLayout {
  if (id === before) return l
  const order = l.order.filter((x) => x !== id)
  const at = order.indexOf(before)
  if (at < 0) return l
  order.splice(at, 0, id)
  return { ...l, order }
}

const LOCAL = (user: string) => `ws.widgets.layout:${user}`
export function loadLocalLayout(user: string): WidgetLayout | null {
  try { const raw = localStorage.getItem(LOCAL(user)); return raw ? normaliseLayout(JSON.parse(raw)) : null } catch { return null }
}
export function saveLocalLayout(user: string, l: WidgetLayout): void {
  try { localStorage.setItem(LOCAL(user), JSON.stringify(l)) } catch { /* a convenience */ }
}

/** Policy: widgets are off when the org turns them off, and always on a kiosk. */
export function widgetsAllowed(p: { desktop_widgets?: boolean | null; kiosk?: boolean } | null | undefined): boolean {
  return p?.desktop_widgets !== false && p?.kiosk !== true
}

// ── what the widgets show, as Desktop's Home counts it ──────────────────

const openTask = (t: WTask) => t.status !== 'done' && t.status !== 'cancelled'
const dayOf = (t: WTask) => (t.dueAt ? t.dueAt.slice(0, 10) : t.due)

/** Today's work: open tasks due today and overdue (by Desktop's Tasks views), soonest first. */
export function taskBuckets(tasks: WTask[], today: string, now = Date.now()): { today: WTask[]; overdue: WTask[] } {
  const open = tasks.filter(openTask)
  const late = (t: WTask) => { const d = dayOf(t); return !!d && (t.dueAt ? Date.parse(t.dueAt) < now : d < today) }
  const by = (a: WTask, b: WTask) => (dayOf(a) ?? '~').localeCompare(dayOf(b) ?? '~') || (a.dueAt ?? '~').localeCompare(b.dueAt ?? '~')
  return {
    overdue: open.filter((t) => late(t)).sort(by),
    today: open.filter((t) => dayOf(t) === today && !late(t)).sort(by),
  }
}

const minutes = (s: string) => { const m = /[T ](\d{2}):(\d{2})/.exec(s); return m ? Number(m[1]) * 60 + Number(m[2]) : 0 }

export interface AgendaRow { e: WEvent; start: number; end: number; past: boolean; live: boolean }
/** Today's agenda: all-day entries apart, timed ones in order with which has ended and which is on. */
export function agendaOf(events: WEvent[], today: string, now: number): { allDay: WEvent[]; timed: AgendaRow[]; meetings: number; next: AgendaRow | null } {
  const todays = events.filter((e) => e.start.slice(0, 10) === today || (e.end && e.start.slice(0, 10) < today && e.end.slice(0, 10) >= today))
  const timed = todays.filter((e) => !e.allDay).map((e) => {
    const start = e.start.slice(0, 10) < today ? 0 : minutes(e.start)
    const end = e.end ? (e.end.slice(0, 10) > today ? 1440 : Math.max(minutes(e.end), start)) : start + 60
    return { e, start, end, past: end <= now, live: start <= now && now < end }
  }).sort((a, b) => a.start - b.start || a.end - b.end)
  const meetings = timed.filter((r) => r.e.meeting)
  return { allDay: todays.filter((e) => e.allDay), timed, meetings: meetings.length, next: meetings.find((r) => !r.past) ?? null }
}

/** Announcements as Desktop ranks them: urgent, pinned, important, then newest; expired ones gone. */
export function rankNotices(items: WNotice[], now = Date.now()): WNotice[] {
  const rank = (a: WNotice) => (a.priority === 'urgent' ? 0 : a.pinned ? 1 : a.priority === 'important' ? 2 : 3)
  return items
    .filter((a) => !a.expires || Date.parse(`${a.expires.replace(' ', 'T')}${/Z|[+-]\d{2}:?\d{2}$/.test(a.expires) ? '' : 'Z'}`) > now)
    .sort((a, b) => rank(a) - rank(b) || (b.at ?? '').localeCompare(a.at ?? ''))
}

/** Which widgets have a source: one whose module the person cannot open is absent, as on Desktop. */
export function available(s: WidgetsSnapshot): Record<WidgetId, boolean> {
  const has = (k: 'tasks' | 'events' | 'announcements' | 'approvals' | 'dashboard' | 'summary') => s[k].state !== 'unavailable'
  return { glance: true, work: has('tasks'), calendar: has('events'), waiting: has('approvals'), announcements: has('announcements'), summary: has('summary'), activity: has('dashboard'), files: has('dashboard') }
}

/** "1.2K" past 999, as Desktop's counts. */
export function compactCount(n: number): string {
  return n < 1000 ? String(n) : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}
