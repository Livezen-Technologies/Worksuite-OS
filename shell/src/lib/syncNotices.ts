// Turn successive sync service Status snapshots into desktop notices (WSOS-INT-007 notifications, WSOS-SYN-004
// per-record errors surfaced to the user, WSOS-IDN-006 revoked device, WSOS-SYN-005 sign-in needed).
import { t } from '../i18n'
export interface SyncStatus { state: string; pending: number; failed: number; conflicts: number; last_sync: number | null }
export interface Notice {
  id: string; tone: 'ok' | 'warn' | 'error'; title: string; body: string
  /** App notifications (WSOS-INT-007): sending app, and buttons for its actions. */
  app?: string; actions?: { key: string; label: string }[]
  /** The sending app's icon (theme name or icon path), shown instead of the tone mark when it resolves. */
  icon?: string
  /** Progress (0–100) an app notification carries in its "value" hint. */
  value?: number
}


export function diffStatus(prev: SyncStatus | null, next: SyncStatus): Notice[] {
  if (!prev) return []
  const out: Notice[] = []
  const stamp = String(next.last_sync ?? Date.now())
  if (prev.state === 'offline' && next.state === 'idle') {
    const sent = Math.max(0, prev.pending - next.pending)
    out.push({ id: `online-${stamp}`, tone: 'ok', title: sent ? (sent === 1 ? t('sync.onlineOne') : t('sync.onlineMany', { count: sent })) : t('sync.online'),
      body: sent ? t('sync.onlineBody') : t('sync.connected') })
  }
  if (next.failed > prev.failed) {
    const k = next.failed - prev.failed
    out.push({ id: `failed-${next.failed}-${stamp}`, tone: 'error', title: k === 1 ? t('sync.failedOne') : t('sync.failedMany', { count: k }), body: t('sync.failedBody') })
  }
  if (next.conflicts > prev.conflicts) {
    const k = next.conflicts - prev.conflicts
    out.push({ id: `conflict-${next.conflicts}-${stamp}`, tone: 'warn', title: k === 1 ? t('sync.conflictOne') : t('sync.conflictMany', { count: k }), body: t('sync.conflictBody') })
  }
  if (next.state === 'auth_required' && prev.state !== 'auth_required') {
    out.push({ id: `auth-${stamp}`, tone: 'warn', title: t('sync.auth'), body: t('sync.authBody') })
  }
  if (next.state === 'device_revoked' && prev.state !== 'device_revoked') {
    out.push({ id: `revoked-${stamp}`, tone: 'error', title: t('sync.revoked'), body: t('sync.revokedBody') })
  }
  return out
}
