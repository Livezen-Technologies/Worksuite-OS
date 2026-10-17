// Shutting down, restarting and signing out like macOS: the shell's overlay asks every app window to close, waits
// for them, checks logind's inhibitors, then hands over to systemd (whose Plymouth splash shows the same picture).
// Apps that keep a window open (unsaved work) or block shutdown get "These apps are preventing shutdown" with
// Cancel / … anyway. Pure helpers here; the overlay is components/SessionEnd.tsx.
import type { PanelWindow } from './panel'
import type { EndAction, Inhibitor } from './sessionApi'
import type { MessageKey } from '../i18n'

/** The shell's own surfaces are never closed. */
const OWN = new Set(['worksuite', 'worksuite-shell', 'electron', 'worksuite-osk', 'wvkbd'])
/** How long apps get to close their windows before the dialog lists those still open. */
export const CLOSE_TIMEOUT_MS = 8000

export function appWindows(ws: PanelWindow[]): PanelWindow[] {
  return ws.filter((w) => !OWN.has(w.appId.toLowerCase()))
}

export interface Blocker { name: string; reason: string | null }

/** Apps still open after the timeout (one row per app) plus inhibitors, by name, an inhibitor's reason first. */
export function blockers(left: PanelWindow[], inhibitors: Inhibitor[], nameOf: (appId: string, title: string) => string): Blocker[] {
  const out = new Map<string, Blocker>()
  for (const i of inhibitors) {
    const name = i.who.trim() || i.what
    if (!out.has(name)) out.set(name, { name, reason: i.why.trim() || null })
  }
  for (const w of appWindows(left)) {
    const name = nameOf(w.appId, w.title)
    if (!out.has(name)) out.set(name, { name, reason: null })
  }
  return [...out.values()]
}

/** 0…1 while windows close; the last fifth is the hand-over to systemd. */
export function closeProgress(total: number, left: number): number {
  if (total <= 0) return 0.8
  return Math.max(0, Math.min(0.8, ((total - left) / total) * 0.8))
}

export const TITLE: Record<EndAction, MessageKey> = { shutdown: 'end.shutdown', restart: 'end.restart', logout: 'end.logout' }
export const SUB: Record<EndAction, MessageKey> = { shutdown: 'end.shutdownSub', restart: 'end.restartSub', logout: 'end.logoutSub' }
export const BLOCKED_TITLE: Record<EndAction, MessageKey> = { shutdown: 'end.blockedShutdown', restart: 'end.blockedRestart', logout: 'end.blockedLogout' }
export const ANYWAY: Record<EndAction, MessageKey> = { shutdown: 'end.anywayShutdown', restart: 'end.anywayRestart', logout: 'end.anywayLogout' }
