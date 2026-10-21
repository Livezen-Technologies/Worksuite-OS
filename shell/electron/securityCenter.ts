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
    last_scan: ScanRecord | null; last_full_scan: number | null
    /** #64 (absent from older agents): a scan can run now; the running scan's progress; the recent scans, newest first. */
    ready?: boolean
    progress?: { id: string; kind: string; trigger: string; started: number; files: number; detections: number; errors: number; current: string | null; elapsed_ms: number } | null
    scans?: ScanRecord[] }
  threats: { active: number; quarantined: number }
  history: { id: string; at: number; path: string; signature: string; action: string }[]
  firewall_alerts: { at: number; dst: string; dport: number | null; proto: string }[]
  retention_days: number
  // #38 protection layers (absent from older agents).
  realtime?: { enabled: boolean; prevention: boolean; state: string; downloads: boolean }
  protected_folders?: { folders: string[]; mode: 'block' | 'audit'; state: string }
  app_control?: { denied: number }
  web?: { dns_blocked: number; dns_feeds: number; dns_filter: boolean; dns_feed_entries: number }
  threat_intel?: { feeds: number; entries: number; updated: number | null; errors: string[] }
  auto_patch?: 'immediate' | 'window' | 'off'
  events?: ProtectionEvent[]
  suspended?: { id: string; at: number; path: string; exe: string | null; pid: number | null }[]
  quarantine?: { id: string; at: number; path: string; signature: string }[]
}
export interface ScanRecord { id: string; kind: string; trigger: string; started: number; finished: number; files: number; detections: number; errors?: number; error?: string }
export interface ProtectionEvent { id: string; at: number; kind: 'onaccess_blocked' | 'onaccess_detected' | 'write_blocked' | 'exec_blocked' | 'ransomware_suspended' | 'download_threat'; path: string; exe: string | null; signature: string | null; enforced: boolean; resolved: string | null }

export function readSecurity(path = SECURITY_STATUS): SecurityStatus | null {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'))
    return s && typeof s === 'object' && typeof s.overall === 'string' ? s as SecurityStatus : null
  } catch { return null }
}

export type Notice = { kind: 'threat_detected' | 'threat_quarantined' | 'firewall_alert' | 'protection_disabled' | 'signatures_outdated' | 'isolated' | 'isolation_ended' | 'blocked' | 'process_suspended'; title: string; body: string }

const base = (p: string) => p.split('/').pop() || p

/** #38: what real-time protection, protected folders, application control and Downloads scanning just did. */
function protectionNotices(prev: SecurityStatus, next: SecurityStatus): Notice[] {
  const seen = new Set((prev.events ?? []).map((e) => e.id))
  const fresh = (next.events ?? []).filter((e) => !seen.has(e.id) && e.enforced)
  const out: Notice[] = []
  const sus = fresh.filter((e) => e.kind === 'ransomware_suspended')
  if (sus.length) out.push({ kind: 'process_suspended', title: 'Suspicious program stopped', body: `${base(sus[0].exe ?? 'A program')} was changing many files in a protected folder and has been suspended. Open WorkSuite Security to resume or end it.` })
  const blocked = fresh.filter((e) => e.kind !== 'ransomware_suspended' && e.kind !== 'onaccess_detected')
  if (blocked.length === 1) {
    const e = blocked[0]
    const body = e.kind === 'write_blocked' ? `${base(e.exe ?? 'A program')} was not allowed to change ${base(e.path)} in a protected folder.`
      : e.kind === 'exec_blocked' ? `${base(e.path)} is blocked by your organization and was not started.`
      : e.kind === 'download_threat' ? `${base(e.path)} contained a threat and was moved to quarantine.`
      : `Access to ${base(e.path)} was blocked: it contains a threat.`
    out.push({ kind: 'blocked', title: 'WorkSuite Security blocked a threat', body })
  } else if (blocked.length > 1) out.push({ kind: 'blocked', title: 'WorkSuite Security blocked threats', body: `${blocked.length} actions were blocked. Open WorkSuite Security to review.` })
  return out
}

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
  out.push(...protectionNotices(prev, next))
  if (next.issues.includes('realtime_off') && !prev.issues.includes('realtime_off')) out.push({ kind: 'protection_disabled', title: 'Protection disabled', body: 'Real-time protection is not running.' })
  return out
}

/** A D-Bus failure from the device agent → what Settings says (#64: the reason a scan cannot start is shown). */
export function agentError(e: unknown): string {
  const err = e as { type?: string; text?: string }
  if (err?.type === 'lk.worksuite.Error.NotAuthorized') return 'auth_cancelled'
  const codes: Record<string, string> = {
    NO_SIGNATURES: 'no_signatures', ANTIVIRUS_MISSING: 'missing', ANTIVIRUS_DISABLED: 'unavailable', NOT_SUPPORTED: 'unavailable',
    NOT_SCANNING: 'not_scanning', UPDATE_FAILED: 'update_failed', STILL_DETECTED: 'still_detected', PATH_EXISTS: 'path_exists',
  }
  if (err?.text && codes[err.text]) return codes[err.text]
  // Anything else from the agent itself failed; no reply at all (not running, not on the bus) is "agent unavailable".
  return err?.type?.startsWith('lk.worksuite.Error.') ? 'failed' : 'agent_unavailable'
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
    return { ok: false, error: agentError(e) }
  } finally { bus.disconnect() }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Quarantine restore/delete and suspended programs (#38) through the device agent; polkit
 * lk.worksuite.security.quarantine asks for an administrator. Restore re-scans first and refuses a file still detected.
 * #64: cancel the running scan and update virus definitions (lk.worksuite.security.scan).
 */
export async function securityAction(method: string, args: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const ok = (method === 'RestoreQuarantined' || method === 'DeleteQuarantined') && args.length === 1 && UUID.test(args[0])
    || method === 'ResolveSuspendedProcess' && args.length === 2 && UUID.test(args[0]) && (args[1] === 'resume' || args[1] === 'terminate')
    || (method === 'CancelSecurityScan' || method === 'UpdateSecurityDefinitions') && args.length === 0
  if (!ok) return { ok: false, error: 'invalid_argument' }
  const bus = dbus.systemBus()
  try {
    const obj = await bus.getProxyObject('lk.worksuite.DeviceAgent1', '/lk/worksuite/DeviceAgent1')
    await obj.getInterface('lk.worksuite.DeviceAgent1')[method](...args)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: agentError(e) }
  } finally { bus.disconnect() }
}

/** How often the status file is re-read: every 2 s while a scan runs (progress), else every 30 s. */
export const pollInterval = (s: SecurityStatus | null) => (s?.scanning ? 2_000 : 30_000)

type Handle = (channel: string, fn: (...args: string[]) => unknown) => void

export function startSecurity(handle: Handle, notify: (n: Notice) => void, broadcast: (channel: string, payload: unknown) => void, path = SECURITY_STATUS) {
  let last = readSecurity(path)
  handle('ws:securityStatus', () => (last = readSecurity(path) ?? last))
  const refresh = () => { const next = readSecurity(path); if (next) { last = next; broadcast('ws:securityChanged', next) } }
  let timer: ReturnType<typeof setTimeout> | null = null
  const poll = () => {
    const next = readSecurity(path)
    for (const n of securityNotices(last, next)) notify(n)
    if (next && JSON.stringify(next) !== JSON.stringify(last)) broadcast('ws:securityChanged', next)
    if (next) last = next
    schedule()
  }
  const schedule = (ms = pollInterval(last)) => { if (timer) clearTimeout(timer); timer = setTimeout(poll, ms); timer.unref?.() }
  handle('ws:securityScan', async (kind) => {
    const r = await startScan(String(kind))
    // The agent publishes "scanning" as it starts: show it now and follow the progress closely.
    if (r.ok) { refresh(); schedule(1_000) }
    return r
  })
  handle('ws:securityAction', async (method, ...args) => {
    const r = await securityAction(String(method), args.map(String))
    refresh()
    if (r.ok) schedule(1_000)
    return r
  })
  schedule()
}
