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
  /** #39: only when the policy turns activity_web_domains on; registrable host names, never URLs or page titles. */
  domains?: { domain: string; active_s: number }[];
}

/** A host name and nothing else: lowercase labels, no scheme, port, path, query, user info or IP literal. */
export const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

const isInt = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const only = (o: Record<string, unknown>, keys: string[], where: string) => {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw invalid(`${where}${k}`, 'not collected (activity reports carry aggregate metrics only)');
};

/** Closed schema: anything outside it is refused, not dropped, so a client cannot widen collection unnoticed. */
export function validateActivityReport(b: unknown, now = Date.now()): ActivityReport {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw invalid('body', 'must be an object');
  const o = b as Record<string, unknown>;
  only(o, ['day', 'active_s', 'idle_s', 'locked_s', 'first_active', 'last_active', 'apps', 'events', 'domains'], '');
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
  let domains: ActivityReport['domains'];
  if (o.domains !== undefined) {
    if (!Array.isArray(o.domains) || o.domains.length > 200) throw invalid('domains', 'at most 200');
    domains = o.domains.map((d, i) => {
      if (!d || typeof d !== 'object') throw invalid(`domains[${i}]`);
      const x = d as Record<string, unknown>;
      only(x, ['domain', 'active_s'], `domains[${i}].`);
      // Refused, not trimmed: a full URL or a title here means the client is collecting more than the policy allows.
      if (typeof x.domain !== 'string' || !DOMAIN_RE.test(x.domain)) throw invalid(`domains[${i}].domain`, 'a domain name only (no URL, path or title)');
      if (!isInt(x.active_s, 0, 90_000)) throw invalid(`domains[${i}].active_s`, 'seconds');
      return { domain: x.domain, active_s: x.active_s as number };
    });
  }
  return { day: o.day, active_s: o.active_s as number, idle_s: o.idle_s as number, locked_s: o.locked_s as number, first_active: ts('first_active'), last_active: ts('last_active'), apps, events, ...(domains ? { domains } : {}) };
}

// ---- #39: live state, device power events, the searchable log ----

export const LIVE_STATES = ['active', 'idle', 'locked'] as const;
export interface LiveState { state: (typeof LIVE_STATES)[number]; app_id: string | null }
/** A device that has not sent its 60 s heartbeat for this long is shown offline. */
export const LIVE_STALE_MS = 3 * 60_000;

export function validateLive(b: unknown): LiveState {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw invalid('body', 'must be an object');
  const o = b as Record<string, unknown>;
  only(o, ['state', 'app_id'], '');
  if (!(LIVE_STATES as readonly unknown[]).includes(o.state)) throw invalid('state', 'active, idle or locked');
  if (o.app_id !== null && o.app_id !== undefined && (typeof o.app_id !== 'string' || !/^[A-Za-z0-9._@+-]{1,128}$/.test(o.app_id))) throw invalid('app_id', 'application id');
  return { state: o.state as LiveState['state'], app_id: (o.app_id ?? null) as string | null };
}

/** Device startup/shutdown as the device agent recorded them (systemd unit worksuite-power-events.service). */
export function validatePowerEvents(v: unknown, now = Date.now()): { at: number; type: 'startup' | 'shutdown' }[] {
  if (!Array.isArray(v) || v.length > 500) throw invalid('power_events', 'at most 500');
  return v.map((e, i) => {
    if (!e || typeof e !== 'object') throw invalid(`power_events[${i}]`);
    const x = e as Record<string, unknown>;
    only(x, ['at', 'type'], `power_events[${i}].`);
    if (!isInt(x.at, now - 400 * DAY, now + DAY) || (x.type !== 'startup' && x.type !== 'shutdown')) throw invalid(`power_events[${i}]`);
    return { at: x.at as number, type: x.type };
  });
}

export function migrateMonitoring(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS activity_reports (
    org_id INTEGER NOT NULL, user_id INTEGER NOT NULL, device_id TEXT NOT NULL, day TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY (user_id, device_id, day))`);
  db.exec('CREATE INDEX IF NOT EXISTS activity_reports_org_day ON activity_reports (org_id, day)');
  // #39: the latest 60 s state per user and device (one row each, replaced), and the searchable log: session and
  // device events, plus one row per application and per domain and day. Rebuilt from each day's report.
  db.exec(`CREATE TABLE IF NOT EXISTS activity_live (
    org_id INTEGER NOT NULL, user_id INTEGER NOT NULL, device_id TEXT NOT NULL, state TEXT NOT NULL, app_id TEXT, at INTEGER NOT NULL,
    PRIMARY KEY (user_id, device_id))`);
  db.exec(`CREATE TABLE IF NOT EXISTS activity_log (
    org_id INTEGER NOT NULL, user_id INTEGER, device_id TEXT NOT NULL, day TEXT NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL,
    app_id TEXT, name TEXT, duration_s INTEGER)`);
  db.exec('CREATE INDEX IF NOT EXISTS activity_log_org_at ON activity_log (org_id, at)');
  db.exec('CREATE INDEX IF NOT EXISTS activity_log_user_day ON activity_log (user_id, device_id, day)');
}

export const orgPolicy = (db: DatabaseSync, orgId: number) =>
  JSON.parse((db.prepare('SELECT body FROM policies WHERE org_id = ?').get(orgId) as { body: string } | undefined)?.body ?? '{}') as Record<string, unknown>;

export const retentionDays = (p: Record<string, unknown>) => isInt(p.activity_retention_days, 1, 730) ? p.activity_retention_days : 90;

/** Stores (replaces) one day's report. Monitoring off in the organization's policy → refused, nothing stored. */
export function storeActivity(db: DatabaseSync, orgId: number, userId: number, deviceId: string, r: ActivityReport, now = Date.now()) {
  const p = orgPolicy(db, orgId);
  if (p.activity_monitoring !== true) throw new HttpError(403, 'MONITORING_DISABLED', 'activity monitoring is not enabled for this organization');
  checkDomainsAllowed(db, orgId, r);
  if (Date.parse(r.day + 'T00:00:00Z') < now - retentionDays(p) * DAY) return;
  db.prepare(`INSERT INTO activity_reports (org_id, user_id, device_id, day, body, at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, device_id, day) DO UPDATE SET body = excluded.body, at = excluded.at, org_id = excluded.org_id`)
    .run(orgId, userId, deviceId, r.day, JSON.stringify(r), now);
  // The log rows for that day follow the report (it replaces the previous one).
  db.prepare("DELETE FROM activity_log WHERE user_id = ? AND device_id = ? AND day = ? AND type NOT IN ('startup', 'shutdown')").run(userId, deviceId, r.day);
  const ins = db.prepare('INSERT INTO activity_log (org_id, user_id, device_id, day, at, type, app_id, name, duration_s) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const noon = Date.parse(r.day + 'T12:00:00Z');
  for (const e of r.events) ins.run(orgId, userId, deviceId, r.day, e.at, e.type, null, null, null);
  for (const a of r.apps) ins.run(orgId, userId, deviceId, r.day, r.first_active ?? noon, 'app', a.app_id, a.name, a.active_s);
  for (const d of r.domains ?? []) ins.run(orgId, userId, deviceId, r.day, r.first_active ?? noon, 'web', null, d.domain, d.active_s);
}

/** Refused when web tracking is off: checked before storing so nothing of it is kept. */
export function checkDomainsAllowed(db: DatabaseSync, orgId: number, r: ActivityReport) {
  if (r.domains?.length && orgPolicy(db, orgId).activity_web_domains !== true)
    throw new HttpError(403, 'WEB_TRACKING_DISABLED', 'website tracking is not enabled for this organization');
}

export function storeLive(db: DatabaseSync, orgId: number, userId: number, deviceId: string, l: LiveState, now = Date.now()) {
  if (orgPolicy(db, orgId).activity_monitoring !== true) throw new HttpError(403, 'MONITORING_DISABLED', 'activity monitoring is not enabled for this organization');
  db.prepare(`INSERT INTO activity_live (org_id, user_id, device_id, state, app_id, at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, device_id) DO UPDATE SET state = excluded.state, app_id = excluded.app_id, at = excluded.at, org_id = excluded.org_id`)
    .run(orgId, userId, deviceId, l.state, l.app_id, now);
}

/** From the device heartbeat. Monitoring off → dropped (returns 0); the device agent also stops recording them. */
export function storePowerEvents(db: DatabaseSync, orgId: number, deviceId: string, events: { at: number; type: string }[]): number {
  if (!events.length || orgPolicy(db, orgId).activity_monitoring !== true) return 0;
  const seen = db.prepare('SELECT 1 FROM activity_log WHERE device_id = ? AND at = ? AND type = ?');
  const ins = db.prepare('INSERT INTO activity_log (org_id, user_id, device_id, day, at, type) VALUES (?, NULL, ?, ?, ?, ?)');
  let n = 0;
  for (const e of events) if (!seen.get(deviceId, e.at, e.type)) { ins.run(orgId, deviceId, new Date(e.at).toISOString().slice(0, 10), e.at, e.type); n++; }
  return n;
}

/** Admin Center › Employee monitoring › Live: each user and device's latest state; stale heartbeats read offline. */
export function liveOverview(db: DatabaseSync, orgId: number, now = Date.now()) {
  const rows = db.prepare(`SELECT l.user_id, u.name, u.email, l.device_id, d.hostname, l.state, l.app_id, l.at FROM activity_live l
    JOIN users u ON u.id = l.user_id LEFT JOIN devices d ON d.id = l.device_id WHERE l.org_id = ? ORDER BY u.name, d.hostname`)
    .all(orgId) as { user_id: number; name: string; email: string; device_id: string; hostname: string | null; state: string; app_id: string | null; at: number }[];
  const names = appNames(db, orgId);
  return {
    enabled: orgPolicy(db, orgId).activity_monitoring === true, stale_after_s: LIVE_STALE_MS / 1000,
    items: rows.map((r) => {
      const offline = now - r.at > LIVE_STALE_MS;
      return { user_id: r.user_id, name: r.name, email: r.email, device_id: r.device_id, device: r.hostname ?? r.device_id,
        status: offline ? 'offline' : r.state, app_id: offline ? null : r.app_id, app_name: offline || !r.app_id ? null : names.get(r.app_id) ?? r.app_id, last_seen: r.at };
    }),
  };
}

const appNames = (db: DatabaseSync, orgId: number) => new Map((db.prepare("SELECT app_id, name FROM activity_log WHERE org_id = ? AND type = 'app' GROUP BY app_id").all(orgId) as { app_id: string; name: string }[]).map((r) => [r.app_id, r.name]));

export const LOG_TYPES = [...ACTIVITY_EVENTS, 'app', 'web'] as const;
export interface LogFilter { user_id?: number; device_id?: string; from?: string; to?: string; type?: string; app?: string; page: number; per_page: number }

/** Parses ?user=&device=&from=&to=&type=&app=&page=&per_page= (dates YYYY-MM-DD, inclusive). */
export function logFilter(q: URLSearchParams): LogFilter {
  const f: LogFilter = { page: 1, per_page: 50 };
  const day = (k: 'from' | 'to') => { const v = q.get(k); if (!v) return; if (!/^\d{4}-\d\d-\d\d$/.test(v)) throw invalid(k, 'YYYY-MM-DD'); f[k] = v; };
  day('from'); day('to');
  if (q.get('user')) { const n = Number(q.get('user')); if (!Number.isInteger(n) || n < 1) throw invalid('user'); f.user_id = n; }
  if (q.get('device')) f.device_id = String(q.get('device')).slice(0, 64);
  if (q.get('type')) { if (!(LOG_TYPES as readonly string[]).includes(q.get('type')!)) throw invalid('type', LOG_TYPES.join(', ')); f.type = q.get('type')!; }
  if (q.get('app')) f.app = String(q.get('app')).slice(0, 128);
  const n = (k: string, d: number, lo: number, hi: number) => { const v = Number(q.get(k) ?? d); return Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  f.page = n('page', 1, 1, 100_000); f.per_page = n('per_page', 50, 10, 200);
  return f;
}

/** Admin Center › Employee monitoring › Activity log: filtered, newest first, paginated. */
export function searchLog(db: DatabaseSync, orgId: number, f: LogFilter) {
  const where = ['l.org_id = ?']; const args: (string | number)[] = [orgId];
  if (f.user_id) { where.push('l.user_id = ?'); args.push(f.user_id); }
  if (f.device_id) { where.push('l.device_id = ?'); args.push(f.device_id); }
  if (f.from) { where.push('l.day >= ?'); args.push(f.from); }
  if (f.to) { where.push('l.day <= ?'); args.push(f.to); }
  if (f.type) { where.push('l.type = ?'); args.push(f.type); }
  // An application id or name, or a domain (web rows keep the domain in name).
  if (f.app) { where.push("(l.app_id = ? OR l.name LIKE ? ESCAPE '\\')"); args.push(f.app, '%' + f.app.replace(/[\\%_]/g, (c) => '\\' + c) + '%'); }
  const w = where.join(' AND ');
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM activity_log l WHERE ${w}`).get(...args) as { n: number }).n;
  const items = db.prepare(`SELECT l.at, l.day, l.type, l.app_id, l.name, l.duration_s, l.user_id, u.name AS user_name, l.device_id, d.hostname
    FROM activity_log l LEFT JOIN users u ON u.id = l.user_id LEFT JOIN devices d ON d.id = l.device_id WHERE ${w}
    ORDER BY l.at DESC, l.rowid DESC LIMIT ? OFFSET ?`).all(...args, f.per_page, (f.page - 1) * f.per_page) as Record<string, unknown>[];
  return {
    total, page: f.page, per_page: f.per_page, pages: Math.max(1, Math.ceil(total / f.per_page)),
    items: items.map((r) => ({ at: r.at, day: r.day, type: r.type, user_id: r.user_id, user: r.user_name ?? null, device_id: r.device_id, device: r.hostname ?? r.device_id,
      app_id: r.app_id, ...(r.type === 'web' ? { domain: r.name } : { app_name: r.name }), duration_s: r.duration_s })),
  };
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
  // #39 tables follow the same rules; website rows go as soon as website tracking is turned off.
  for (const { org_id } of db.prepare('SELECT DISTINCT org_id FROM activity_log UNION SELECT DISTINCT org_id FROM activity_live').all() as { org_id: number }[]) {
    const p = orgPolicy(db, org_id);
    if (p.activity_monitoring !== true) { db.prepare('DELETE FROM activity_log WHERE org_id = ?').run(org_id); db.prepare('DELETE FROM activity_live WHERE org_id = ?').run(org_id); continue; }
    db.prepare('DELETE FROM activity_log WHERE org_id = ? AND day < ?').run(org_id, new Date(now - retentionDays(p) * DAY).toISOString().slice(0, 10));
    if (p.activity_web_domains !== true) db.prepare("DELETE FROM activity_log WHERE org_id = ? AND type = 'web'").run(org_id);
    db.prepare('DELETE FROM activity_live WHERE org_id = ? AND at < ?').run(org_id, now - DAY);
  }
}

/** A user's own reports (Settings › Privacy & security › Employee monitoring › "What your organization has"). */
export function ownActivity(db: DatabaseSync, userId: number) {
  return (db.prepare('SELECT device_id, day, body, at FROM activity_reports WHERE user_id = ? ORDER BY day DESC LIMIT 400').all(userId) as { device_id: string; day: string; body: string; at: number }[])
    .map((r) => ({ device_id: r.device_id, day: r.day, received_at: r.at, ...JSON.parse(r.body) }));
}

/** #39 transparency: the user's latest live state and the startup/shutdown events of the devices they reported from. */
export function ownLiveAndDevices(db: DatabaseSync, userId: number) {
  const live = db.prepare('SELECT device_id, state, app_id, at FROM activity_live WHERE user_id = ? ORDER BY at DESC').all(userId) as { device_id: string; state: string; app_id: string | null; at: number }[];
  const device_events = db.prepare(`SELECT device_id, at, type FROM activity_log WHERE user_id IS NULL AND type IN ('startup', 'shutdown')
    AND device_id IN (SELECT DISTINCT device_id FROM activity_reports WHERE user_id = ?) ORDER BY at DESC LIMIT 200`).all(userId) as { device_id: string; at: number; type: string }[];
  return { live, device_events };
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
