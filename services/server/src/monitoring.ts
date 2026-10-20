// Employee activity reports (issue #22) and the Security Center overview (issue #20).
//
// Activity: managed devices whose policy turns activity_monitoring on send one aggregate report per user, device and
// day: active/idle/locked seconds, work sessions, time per application and session events (sign-in, lock, …). The
// schema is closed: no window titles, URLs, keystrokes, screenshots or file names are accepted, so they can never be
// stored even if a client sent them. Reports older than the policy's activity_retention_days are deleted.
import type { DatabaseSync } from 'node:sqlite';
import { HttpError, invalid } from './http.ts';

const DAY = 86_400_000;
export const ACTIVITY_EVENTS = ['login', 'logout', 'lock', 'unlock', 'startup', 'shutdown', 'idle', 'active'] as const;

export interface ActivityReport {
  day: string;
  active_s: number;
  idle_s: number;
  locked_s: number;
  first_active: number | null;
  last_active: number | null;
  apps: { app_id: string; name: string; active_s: number; switches: number }[];
  events: { at: number; type: (typeof ACTIVITY_EVENTS)[number] }[];
}

const isInt = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const only = (o: Record<string, unknown>, keys: string[], where: string) => {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw invalid(`${where}${k}`, 'not collected (activity reports carry aggregate metrics only)');
};

/** Closed schema: anything outside it is refused, not dropped, so a client cannot widen collection unnoticed. */
export function validateActivityReport(b: unknown, now = Date.now()): ActivityReport {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw invalid('body', 'must be an object');
  const o = b as Record<string, unknown>;
  only(o, ['day', 'active_s', 'idle_s', 'locked_s', 'first_active', 'last_active', 'apps', 'events'], '');
  if (typeof o.day !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(o.day) || Number.isNaN(Date.parse(o.day + 'T00:00:00Z'))) throw invalid('day', 'YYYY-MM-DD');
  const dayStart = Date.parse(o.day + 'T00:00:00Z');
  if (dayStart > now + DAY || dayStart < now - 400 * DAY) throw invalid('day', 'out of range');
  for (const k of ['active_s', 'idle_s', 'locked_s'] as const) if (!isInt(o[k], 0, 86_400 + 3_600)) throw invalid(k, 'seconds in a day');
  const ts = (k: 'first_active' | 'last_active') => {
    if (o[k] === null || o[k] === undefined) return null;
    if (!isInt(o[k], dayStart - 2 * DAY, dayStart + 3 * DAY)) throw invalid(k, 'time in that day (ms)');
    return o[k] as number;
  };
  if (!Array.isArray(o.apps) || o.apps.length > 200) throw invalid('apps', 'at most 200');
  const apps = o.apps.map((a, i) => {
    if (!a || typeof a !== 'object') throw invalid(`apps[${i}]`);
    const x = a as Record<string, unknown>;
    only(x, ['app_id', 'name', 'active_s', 'switches'], `apps[${i}].`);
    if (typeof x.app_id !== 'string' || !/^[A-Za-z0-9._@+-]{1,128}$/.test(x.app_id)) throw invalid(`apps[${i}].app_id`, 'application id');
    if (typeof x.name !== 'string' || x.name.length > 80) throw invalid(`apps[${i}].name`);
    if (!isInt(x.active_s, 0, 90_000) || !isInt(x.switches ?? 0, 0, 100_000)) throw invalid(`apps[${i}]`, 'counts');
    return { app_id: x.app_id, name: x.name, active_s: x.active_s as number, switches: (x.switches ?? 0) as number };
  });
  if (!Array.isArray(o.events) || o.events.length > 1000) throw invalid('events', 'at most 1000');
  const events = o.events.map((e, i) => {
    if (!e || typeof e !== 'object') throw invalid(`events[${i}]`);
    const x = e as Record<string, unknown>;
    only(x, ['at', 'type'], `events[${i}].`);
    if (!isInt(x.at, dayStart - 2 * DAY, dayStart + 3 * DAY) || !(ACTIVITY_EVENTS as readonly unknown[]).includes(x.type)) throw invalid(`events[${i}]`);
    return { at: x.at as number, type: x.type as ActivityReport['events'][number]['type'] };
  });
  return { day: o.day, active_s: o.active_s as number, idle_s: o.idle_s as number, locked_s: o.locked_s as number, first_active: ts('first_active'), last_active: ts('last_active'), apps, events };
}

export function migrateMonitoring(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS activity_reports (
    org_id INTEGER NOT NULL, user_id INTEGER NOT NULL, device_id TEXT NOT NULL, day TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY (user_id, device_id, day))`);
  db.exec('CREATE INDEX IF NOT EXISTS activity_reports_org_day ON activity_reports (org_id, day)');
}

const orgPolicy = (db: DatabaseSync, orgId: number) =>
  JSON.parse((db.prepare('SELECT body FROM policies WHERE org_id = ?').get(orgId) as { body: string } | undefined)?.body ?? '{}') as Record<string, unknown>;

export const retentionDays = (p: Record<string, unknown>) => isInt(p.activity_retention_days, 1, 730) ? p.activity_retention_days : 90;

/** Stores (replaces) one day's report. Monitoring off in the organization's policy → refused, nothing stored. */
export function storeActivity(db: DatabaseSync, orgId: number, userId: number, deviceId: string, r: ActivityReport, now = Date.now()) {
  const p = orgPolicy(db, orgId);
  if (p.activity_monitoring !== true) throw new HttpError(403, 'MONITORING_DISABLED', 'activity monitoring is not enabled for this organization');
  if (Date.parse(r.day + 'T00:00:00Z') < now - retentionDays(p) * DAY) return;
  db.prepare(`INSERT INTO activity_reports (org_id, user_id, device_id, day, body, at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, device_id, day) DO UPDATE SET body = excluded.body, at = excluded.at, org_id = excluded.org_id`)
    .run(orgId, userId, deviceId, r.day, JSON.stringify(r), now);
}

/** Retention per organization; an organization that turned monitoring off keeps nothing. */
export function purgeActivity(db: DatabaseSync, now = Date.now()) {
  const orgs = db.prepare('SELECT DISTINCT org_id FROM activity_reports').all() as { org_id: number }[];
  for (const { org_id } of orgs) {
    const p = orgPolicy(db, org_id);
    if (p.activity_monitoring !== true) { db.prepare('DELETE FROM activity_reports WHERE org_id = ?').run(org_id); continue; }
    const cut = new Date(now - retentionDays(p) * DAY).toISOString().slice(0, 10);
    db.prepare('DELETE FROM activity_reports WHERE org_id = ? AND day < ?').run(org_id, cut);
  }
}

/** A user's own reports (Settings › Privacy & security › Employee monitoring › "What your organization has"). */
export function ownActivity(db: DatabaseSync, userId: number) {
  return (db.prepare('SELECT device_id, day, body, at FROM activity_reports WHERE user_id = ? ORDER BY day DESC LIMIT 400').all(userId) as { device_id: string; day: string; body: string; at: number }[])
    .map((r) => ({ device_id: r.device_id, day: r.day, received_at: r.at, ...JSON.parse(r.body) }));
}

/** Admin Center › Employee monitoring: per employee over the last `days` days, plus per-day rows for one employee. */
export function monitoringOverview(db: DatabaseSync, orgId: number, days: number, now = Date.now()) {
  const since = new Date(now - (days - 1) * DAY).toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT r.user_id, u.name, u.email, r.device_id, d.hostname, r.day, r.body, r.at FROM activity_reports r
    JOIN users u ON u.id = r.user_id LEFT JOIN devices d ON d.id = r.device_id WHERE r.org_id = ? AND r.day >= ? ORDER BY r.day DESC`)
    .all(orgId, since) as { user_id: number; name: string; email: string; device_id: string; hostname: string | null; day: string; body: string; at: number }[];
  const by = new Map<number, { user_id: number; name: string; email: string; active_s: number; idle_s: number; locked_s: number; days: Set<string>; last_report: number; apps: Map<string, { name: string; active_s: number }>; devices: Set<string> }>();
  for (const r of rows) {
    const b = JSON.parse(r.body) as ActivityReport;
    const e = by.get(r.user_id) ?? { user_id: r.user_id, name: r.name, email: r.email, active_s: 0, idle_s: 0, locked_s: 0, days: new Set(), last_report: 0, apps: new Map(), devices: new Set() };
    e.active_s += b.active_s; e.idle_s += b.idle_s; e.locked_s += b.locked_s; e.days.add(r.day); e.last_report = Math.max(e.last_report, r.at);
    e.devices.add(r.hostname ?? r.device_id);
    for (const a of b.apps) { const x = e.apps.get(a.app_id) ?? { name: a.name, active_s: 0 }; x.active_s += a.active_s; e.apps.set(a.app_id, x); }
    by.set(r.user_id, e);
  }
  const p = orgPolicy(db, orgId);
  return {
    enabled: p.activity_monitoring === true, retention_days: retentionDays(p), days, since,
    employees: [...by.values()].map((e) => ({
      user_id: e.user_id, name: e.name, email: e.email, active_s: e.active_s, idle_s: e.idle_s, locked_s: e.locked_s, days_reported: e.days.size,
      last_report: e.last_report, devices: [...e.devices],
      top_apps: [...e.apps.entries()].map(([app_id, a]) => ({ app_id, ...a })).sort((x, y) => y.active_s - x.active_s).slice(0, 10),
    })).sort((x, y) => x.name.localeCompare(y.name)),
    daily: rows.map((r) => { const b = JSON.parse(r.body) as ActivityReport; return { user_id: r.user_id, name: r.name, device: r.hostname ?? r.device_id, day: r.day, active_s: b.active_s, idle_s: b.idle_s, locked_s: b.locked_s, first_active: b.first_active, last_active: b.last_active, events: b.events.length }; }),
  };
}

/** Admin Center › Security Center: each device's last reported security summary (from its check-in). */
export function securityOverview(db: DatabaseSync, orgId: number) {
  const rows = db.prepare('SELECT id, hostname, last_seen, heartbeat FROM devices WHERE org_id = ? AND revoked = 0 ORDER BY hostname').all(orgId) as { id: string; hostname: string; last_seen: number | null; heartbeat: string | null }[];
  const devices = rows.map((d) => {
    const s = (d.heartbeat ? JSON.parse(d.heartbeat) : {})?.security ?? null;
    return { id: d.id, hostname: d.hostname, last_seen: d.last_seen, security: s && typeof s === 'object' ? s : null };
  });
  const count = (f: (s: Record<string, any>) => boolean) => devices.filter((d) => d.security && f(d.security)).length;
  return {
    totals: {
      devices: devices.length, reporting: count(() => true),
      protected: count((s) => s.overall === 'protected'), attention: count((s) => s.overall === 'attention'), at_risk: count((s) => s.overall === 'at_risk'),
      isolated: count((s) => !!s.isolation), active_threats: devices.reduce((n, d) => n + (Number(d.security?.threats?.active) || 0), 0),
      firewall_off: count((s) => s.firewall?.active === false),
    },
    devices,
  };
}
