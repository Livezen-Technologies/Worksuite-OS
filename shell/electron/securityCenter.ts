// WorkSuite Security in the shell (issue #20): the device agent's status (/run/worksuite-device-agent/security.json)
// for Settings › Privacy & security › WorkSuite Security, "Scan now" over lk.worksuite.DeviceAgent1 (polkit
// lk.worksuite.security.scan), and desktop notifications when something changes that needs the user.
import dbus from 'dbus-next'
import { readFileSync } from 'node:fs'

export const SECURITY_STATUS = '/run/worksuite-device-agent/security.json'

export interface SecurityStatus {
  overall: 'protected' | 'attention' | 'at_risk' | 'unavailable'
  issues: string[]
  managed: boolean
  scanning?: boolean
  firewall: { active: boolean; policy_rules: number; log_blocked: boolean }
  isolation: { since: number; until: number } | null
  antivirus: { enabled: boolean; installed: boolean; engine: string | null; signatures: number | null; signatures_at: number | null; signatures_age_days: number | null; updates: string; schedule: string; exclusions: number
    last_scan: { id: string; kind: string; trigger: string; started: number; finished: number; files: number; detections: number; error?: string } | null; last_full_scan: number | null }
  threats: { active: number; quarantined: number }
  history: { id: string; at: number; path: string; signature: string; action: string }[]
  firewall_alerts: { at: number; dst: string; dport: number | null; proto: string }[]
  retention_days: number
}

export function readSecurity(path = SECURITY_STATUS): SecurityStatus | null {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'))
    return s && typeof s === 'object' && typeof s.overall === 'string' ? s as SecurityStatus : null
  } catch { return null }
}

export type Notice = { kind: 'threat_detected' | 'threat_quarantined' | 'firewall_alert' | 'protection_disabled' | 'signatures_outdated' | 'isolated' | 'isolation_ended'; title: string; body: string }

/** What changed between two status reads that deserves a notification. Nothing on the first read (no stale alerts). */
export function securityNotices(prev: SecurityStatus | null, next: SecurityStatus | null): Notice[] {
  if (!prev || !next) return []
  const out: Notice[] = []
  const seen = new Set(prev.history.map((h) => h.id))
  const fresh = next.history.filter((h) => !seen.has(h.id))
  const q = fresh.filter((h) => h.action === 'quarantined').length, det = fresh.filter((h) => h.action === 'detected').length
  if (det) out.push({ kind: 'threat_detected', title: 'Threat detected', body: `WorkSuite Security found ${det === 1 ? 'a potentially malicious file' : `${det} potentially malicious files`} that could not be moved to quarantine. Open WorkSuite Security to review.` })
  if (q) out.push({ kind: 'threat_quarantined', title: 'Threat quarantined', body: `${q === 1 ? 'A detected threat has' : `${q} detected threats have`} been moved to quarantine.` })
  const newestAlert = (s: SecurityStatus) => s.firewall_alerts[0]?.at ?? 0
  if (newestAlert(next) > newestAlert(prev)) out.push({ kind: 'firewall_alert', title: 'Firewall alert', body: 'A connection was blocked by your organization\'s firewall policy.' })
  const off = (s: SecurityStatus) => !s.firewall.active || (s.antivirus.enabled && s.antivirus.installed && s.antivirus.updates !== 'active')
  if (off(next) && !off(prev)) out.push({ kind: 'protection_disabled', title: 'Protection disabled', body: !next.firewall.active ? 'The firewall is not running.' : 'Virus definition updates are not running.' })
  if (next.issues.includes('signatures_outdated') && !prev.issues.includes('signatures_outdated')) out.push({ kind: 'signatures_outdated', title: 'Security update available', body: 'Virus definitions are out of date. They update automatically when the device is online.' })
  if (next.isolation && !prev.isolation) out.push({ kind: 'isolated', title: 'Device isolated by your organization', body: 'Network access is limited to your organization\'s management server while IT reviews a security issue.' })
  if (!next.isolation && prev.isolation) out.push({ kind: 'isolation_ended', title: 'Network access restored', body: 'Your organization has ended the network isolation of this device.' })
  return out
}

/** Starts a scan through the device agent; polkit decides (active local users are allowed). */
export async function startScan(kind: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (kind !== 'quick' && kind !== 'full') return { ok: false, error: 'invalid_argument' }
  const bus = dbus.systemBus()
  try {
    const obj = await bus.getProxyObject('lk.worksuite.DeviceAgent1', '/lk/worksuite/DeviceAgent1')
    await obj.getInterface('lk.worksuite.DeviceAgent1').StartSecurityScan(kind)
    return { ok: true }
  } catch (e) {
    const err = e as { type?: string; text?: string }
    if (err.type === 'lk.worksuite.Error.NotAuthorized') return { ok: false, error: 'auth_cancelled' }
    if (err.text === 'ANTIVIRUS_DISABLED' || err.text === 'NOT_SUPPORTED') return { ok: false, error: 'unavailable' }
    return { ok: false, error: 'agent_unavailable' }
  } finally { bus.disconnect() }
}

type Handle = (channel: string, fn: (...args: string[]) => unknown) => void

export function startSecurity(handle: Handle, notify: (n: Notice) => void, broadcast: (channel: string, payload: unknown) => void, path = SECURITY_STATUS) {
  let last = readSecurity(path)
  handle('ws:securityStatus', () => (last = readSecurity(path) ?? last))
  handle('ws:securityScan', (kind) => startScan(String(kind)))
  const t = setInterval(() => {
    const next = readSecurity(path)
    for (const n of securityNotices(last, next)) notify(n)
    if (next && JSON.stringify(next) !== JSON.stringify(last)) broadcast('ws:securityChanged', next)
    if (next) last = next
  }, 30_000)
  t.unref?.()
}
