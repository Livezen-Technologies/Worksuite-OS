// Employee activity monitoring (issue #22). Only on a managed device whose signed policy turns activity_monitoring on;
// otherwise nothing is recorded and anything recorded earlier is deleted.
//
// What is recorded, per local day: active, idle and locked seconds; first and last active time; seconds and switches
// per application (its app id and display name from the window list, never the window title); session events
// (sign-in, sign-out, lock, unlock, idle, active). Nothing else: no keystrokes, no screenshots, no window titles,
// no web addresses, no file names, no camera or microphone. The server refuses any other field (services/server
// src/monitoring.ts).
//
// Event-driven: the focused app comes from the Wayland bridge's window list, idle from logind's IdleHint (swayidle
// idlehint), lock from logind Lock/Unlock. No polling. Kept in ~/.local/state/worksuite/activity.json (0600) for the
// retention period, sent to the organization every 15 minutes and again after the device comes back online.
// Electron-free so it can be unit tested.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const DISCLOSURE_VERSION = 1
const DAY = 86_400_000

export interface ActivityPolicy { enabled: boolean; org_name: string | null; retention_days: number; idle_threshold_s: number }

/** From the device agent's status.json and the effective policy.json (both 0644). Unmanaged → off. */
export function activityPolicy(read: (p: string) => string | null, statusPath = '/run/worksuite-device-agent/status.json', policyPath = '/run/worksuite-device-agent/policy.json'): ActivityPolicy {
  const off: ActivityPolicy = { enabled: false, org_name: null, retention_days: 90, idle_threshold_s: 300 }
  try {
    const st = JSON.parse(read(statusPath) ?? 'null')
    if (!st?.managed) return off
    const p = JSON.parse(read(policyPath) ?? 'null')
    if (!p || p.activity_monitoring !== true) return { ...off, org_name: st.org_name ?? null }
    const int = (v: unknown, lo: number, hi: number, d: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? v as number : d
    return { enabled: true, org_name: st.org_name ?? null, retention_days: int(p.activity_retention_days, 1, 730, 90), idle_threshold_s: int(p.activity_idle_threshold_s, 60, 3600, 300) }
  } catch { return off }
}

export type EventType = 'login' | 'logout' | 'lock' | 'unlock' | 'startup' | 'shutdown' | 'idle' | 'active'
export interface AppTime { app_id: string; name: string; active_s: number; switches: number }
export interface DayReport { day: string; active_s: number; idle_s: number; locked_s: number; first_active: number | null; last_active: number | null; apps: AppTime[]; events: { at: number; type: EventType }[] }
export interface Store { version: 1; disclosure_ack: number; days: Record<string, DayReport>; sent: Record<string, number>; changed: Record<string, number> }

export const emptyStore = (): Store => ({ version: 1, disclosure_ack: 0, days: {}, sent: {}, changed: {} })

/** Local calendar day "YYYY-MM-DD" (the employee's working day). */
export function localDay(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function nextMidnight(t: number): number { const d = new Date(t); d.setHours(24, 0, 0, 0); return d.getTime() }

type State = 'active' | 'idle' | 'locked'

/**
 * Aggregates segments of (state, focused app) into day reports. An idle stretch shorter than the policy threshold
 * counts as active (reading is work): swayidle reports idle after 60 s, the policy decides when it becomes idle time.
 */
export class ActivityTracker {
  private state: State = 'active'
  private since: number
  private app: { id: string; name: string } | null = null
  private idleAt: number | null = null
  readonly store: Store
  private o: { now: () => number; idleThresholdS: number; idleHintDelayS?: number }

  constructor(store: Store, o: { now: () => number; idleThresholdS: number; idleHintDelayS?: number }) {
    this.store = store; this.o = o; this.since = o.now()
  }

  private day(d: string): DayReport {
    return this.store.days[d] ??= { day: d, active_s: 0, idle_s: 0, locked_s: 0, first_active: null, last_active: null, apps: [], events: [] }
  }

  /** Adds [from, to) in `state` to the day buckets, split at midnight. */
  private add(state: State, from: number, to: number, app: { id: string; name: string } | null) {
    let a = from
    while (a < to) {
      const b = Math.min(to, nextMidnight(a))
      const s = Math.round((b - a) / 1000)
      const r = this.day(localDay(a))
      if (s > 0) {
        if (state === 'active') {
          r.active_s += s
          r.first_active = r.first_active === null ? a : Math.min(r.first_active, a)
          r.last_active = Math.max(r.last_active ?? 0, b)
          if (app) {
            const x = r.apps.find((p) => p.app_id === app.id) ?? (r.apps.push({ app_id: app.id, name: app.name, active_s: 0, switches: 0 }), r.apps[r.apps.length - 1])
            x.active_s += s
          }
        } else if (state === 'idle') r.idle_s += s
        else r.locked_s += s
        this.store.changed[r.day] = this.o.now()
      }
      a = b
    }
  }

  private close(now: number) {
    this.add(this.state, this.since, now, this.app)
    this.since = now
  }

  /** The activated window's app changed (null: no window focused, e.g. the desktop). */
  focus(app: { id: string; name: string } | null) {
    if (app?.id === this.app?.id) return
    const now = this.o.now()
    this.close(now)
    this.app = app && /^[A-Za-z0-9._@+-]{1,128}$/.test(app.id) ? { id: app.id, name: app.name.slice(0, 80) } : null
    if (this.app && this.state === 'active') {
      const r = this.day(localDay(now))
      const x = r.apps.find((p) => p.app_id === this.app!.id) ?? (r.apps.push({ app_id: this.app.id, name: this.app.name, active_s: 0, switches: 0 }), r.apps[r.apps.length - 1])
      x.switches++
      this.store.changed[r.day] = now
    }
  }

  /** logind IdleHint. The hint comes idleHintDelayS (60 s) after the last input. */
  idle(on: boolean) {
    const now = this.o.now()
    if (this.state === 'locked') return
    if (on && this.state === 'active') {
      const start = Math.max(this.since, now - (this.o.idleHintDelayS ?? 60) * 1000)
      this.close(start)
      this.state = 'idle'; this.idleAt = start
      this.since = start
    } else if (!on && this.state === 'idle') {
      const start = this.idleAt ?? this.since
      const long = now - start >= this.o.idleThresholdS * 1000
      // Short pause: counted as active time in the app that had the focus.
      this.add(long ? 'idle' : 'active', start, now, this.app)
      if (long) { this.event('idle', start); this.event('active', now) }
      this.state = 'active'; this.since = now; this.idleAt = null
    }
  }

  lock(on: boolean) {
    const now = this.o.now()
    if (on && this.state !== 'locked') {
      if (this.state === 'idle') this.idle(false)
      this.close(now); this.state = 'locked'; this.event('lock', now)
    } else if (!on && this.state === 'locked') {
      this.close(now); this.state = 'active'; this.event('unlock', now)
    }
  }

  event(type: EventType, at = this.o.now()) {
    const r = this.day(localDay(at))
    if (r.events.length < 1000) r.events.push({ at, type })
    this.store.changed[r.day] = this.o.now()
  }

  /** Brings the running segment into the totals (before showing or sending). */
  flush() { this.close(this.o.now()) }

  /** Drops days older than the retention period. */
  prune(retentionDays: number) {
    const keep = localDay(this.o.now() - retentionDays * DAY)
    for (const d of Object.keys(this.store.days)) if (d < keep) { delete this.store.days[d]; delete this.store.sent[d]; delete this.store.changed[d] }
  }

  /** Days changed since they were last sent (at most 31, oldest first). */
  unsent(): DayReport[] {
    return Object.keys(this.store.days).sort().filter((d) => (this.store.changed[d] ?? 0) > (this.store.sent[d] ?? 0)).slice(-31).map((d) => this.store.days[d])
  }

  markSent(days: string[], at: number) { for (const d of days) this.store.sent[d] = at }
}

export function storePath(home: string) { return path.join(home, '.local/state/worksuite/activity.json') }

export function loadStore(file: string): Store {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'))
    if (s?.version === 1 && s.days && typeof s.days === 'object') return { ...emptyStore(), ...s }
  } catch { /* none yet */ }
  return emptyStore()
}

export function saveStore(file: string, s: Store) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file + '.tmp', JSON.stringify(s), { mode: 0o600 })
  renameSync(file + '.tmp', file)
}

/** Monitoring turned off (or the device left the organization): everything recorded is deleted; the ack is kept. */
export function clearStore(file: string, keepAck: number) {
  if (keepAck) saveStore(file, { ...emptyStore(), disclosure_ack: keepAck }); else rmSync(file, { force: true })
}

export type SendFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>

/** POST desktop/v1/activity with the user's token and the device credential (both required by the server). */
export async function sendActivity(reports: DayReport[], s: { token: string; apiBase: string } | null, device: string | null, fetchFn: SendFetch): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!reports.length) return { ok: true }
  if (!s) return { ok: false, error: 'not_signed_in' }
  if (!device) return { ok: false, error: 'not_enrolled' }
  try {
    const r = await fetchFn(new URL('desktop/v1/activity', s.apiBase).toString(), {
      method: 'POST',
      headers: { authorization: `Bearer ${s.token}`, 'x-ws-device': device, 'content-type': 'application/json' },
      body: JSON.stringify({ reports: reports.map(({ day, active_s, idle_s, locked_s, first_active, last_active, apps, events }) => ({ day, active_s, idle_s, locked_s, first_active, last_active, apps, events })) }),
    })
    if (r.status === 401) return { ok: false, error: 'auth_required' }
    if (r.status === 403) return { ok: false, error: 'disabled' }
    return r.ok ? { ok: true } : { ok: false, error: 'server_error' }
  } catch { return { ok: false, error: 'offline' } }
}

/** What Settings and the indicator show: the policy, the disclosure state and the employee's own recorded days. */
export function activityView(p: ActivityPolicy, s: Store, lastSent: number | null) {
  return {
    enabled: p.enabled, org_name: p.org_name, retention_days: p.retention_days, idle_threshold_s: p.idle_threshold_s,
    disclosure_needed: p.enabled && s.disclosure_ack < DISCLOSURE_VERSION, last_sent: lastSent,
    days: Object.values(s.days).sort((a, b) => b.day.localeCompare(a.day)).slice(0, 14)
      .map((d) => ({ ...d, apps: [...d.apps].sort((a, b) => b.active_s - a.active_s) })),
  }
}
export type ActivityView = ReturnType<typeof activityView>
