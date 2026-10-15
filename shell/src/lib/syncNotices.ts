// Turn successive sync service Status snapshots into desktop notices (WSOS-INT-007 notifications, WSOS-SYN-004
// per-record errors surfaced to the user, WSOS-IDN-006 revoked device, WSOS-SYN-005 sign-in needed).
export interface SyncStatus { state: string; pending: number; failed: number; conflicts: number; last_sync: number | null }
export interface Notice { id: string; tone: 'ok' | 'warn' | 'error'; title: string; body: string }

const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`

export function diffStatus(prev: SyncStatus | null, next: SyncStatus): Notice[] {
  if (!prev) return []
  const out: Notice[] = []
  const stamp = String(next.last_sync ?? Date.now())
  if (prev.state === 'offline' && next.state === 'idle') {
    const sent = Math.max(0, prev.pending - next.pending)
    out.push({ id: `online-${stamp}`, tone: 'ok', title: sent ? `Back online — ${n(sent, 'change')} synced` : 'Back online',
      body: sent ? 'Changes you made offline reached the server.' : 'WorkSuite is connected again.' })
  }
  if (next.failed > prev.failed) {
    const k = next.failed - prev.failed
    out.push({ id: `failed-${next.failed}-${stamp}`, tone: 'error', title: `${n(k, 'change')} couldn’t be saved`, body: 'The server didn’t accept them. Open the record to fix it and try again.' })
  }
  if (next.conflicts > prev.conflicts) {
    const k = next.conflicts - prev.conflicts
    out.push({ id: `conflict-${next.conflicts}-${stamp}`, tone: 'warn', title: `${n(k, 'conflict')} — both versions kept`, body: 'Something was changed here and on the server. Nothing was overwritten.' })
  }
  if (next.state === 'auth_required' && prev.state !== 'auth_required') {
    out.push({ id: `auth-${stamp}`, tone: 'warn', title: 'Sign in again to keep syncing', body: 'Your changes are kept on this computer until you sign in. Settings › Accounts.' })
  }
  if (next.state === 'device_revoked' && prev.state !== 'device_revoked') {
    out.push({ id: `revoked-${stamp}`, tone: 'error', title: 'This device was disconnected by your organization', body: 'Syncing has stopped. Contact your IT team.' })
  }
  return out
}
