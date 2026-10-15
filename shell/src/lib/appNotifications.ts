// Renderer side of electron/notifications.ts (WSOS-INT-007): app notifications join the sync notices in the same
// centre. Without the bridge (browser preview) there are none.
import type { Notice } from './syncNotices'

export interface AppNotification { id: number; app: string; summary: string; body: string; actions: { key: string; label: string }[]; urgency: 0 | 1 | 2; at: number }
export interface NotificationsApi {
  list(): Promise<AppNotification[]>
  invoke(id: number, key: string): Promise<boolean>
  dismiss(id: number): Promise<boolean>
  onChange(cb: (list: AppNotification[]) => void): () => void
}
declare global {
  interface Window { worksuiteNotifications?: NotificationsApi }
}
export const notificationsApi = (): NotificationsApi | null => (typeof window !== 'undefined' && window.worksuiteNotifications) || null

export const APP_PREFIX = 'app-'
export const appIdOf = (n: { id: string }): number | null => (n.id.startsWith(APP_PREFIX) ? Number(n.id.slice(APP_PREFIX.length)) : null)

export function toNotice(n: AppNotification): Notice & { at: number } {
  return { id: `${APP_PREFIX}${n.id}`, tone: n.urgency === 2 ? 'error' : 'ok', title: n.summary || n.app, body: n.body, app: n.app, actions: n.actions, at: n.at }
}

/**
 * Applies a new server list to the centre: new or replaced app notifications go on top (and are returned so one can be
 * toasted), ones the app or user closed disappear, sync notices stay as they are.
 */
export function mergeApp<T extends Notice & { at: number }>(current: T[], list: AppNotification[]): { next: (T | (Notice & { at: number }))[]; fresh: (Notice & { at: number })[] } {
  const live = new Map(list.map((n) => [`${APP_PREFIX}${n.id}`, n]))
  const known = new Map(current.filter((n) => n.id.startsWith(APP_PREFIX)).map((n) => [n.id, n]))
  const fresh = list.filter((n) => { const k = known.get(`${APP_PREFIX}${n.id}`); return !k || k.at !== n.at }).map(toNotice)
  const freshIds = new Set(fresh.map((f) => f.id))
  const kept = current.filter((n) => !n.id.startsWith(APP_PREFIX) || (live.has(n.id) && !freshIds.has(n.id)))
  return { next: [...fresh, ...kept].slice(0, 100), fresh }
}
