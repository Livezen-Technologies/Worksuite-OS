// Attendance and HR integration (#39): a daily summary per employee (first active, last active, total active time)
// derived from the activity reports (src/monitoring.ts), as JSON for the console, as CSV, and pushed to an HR system
// through a signed outbound webhook the administrator configures. Nothing beyond those three figures leaves: no
// applications, domains or events.
import { createHmac, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError, invalid } from './http.ts';
import { orgPolicy } from './monitoring.ts';

const DAY = 86_400_000;

export interface AttendanceRow { day: string; user_id: number; name: string; email: string; first_active: number | null; last_active: number | null; active_s: number; devices: number }

export function migrateAttendance(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS hr_webhooks (
    org_id INTEGER PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    last_day TEXT, last_status TEXT, last_at INTEGER)`);
}

const isDay = (s: string) => /^\d{4}-\d\d-\d\d$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

/** Per employee and day, over all their devices: earliest first activity, latest last activity, summed active time. */
export function attendance(db: DatabaseSync, orgId: number, from: string, to: string): AttendanceRow[] {
  if (!isDay(from)) throw invalid('from', 'YYYY-MM-DD');
  if (!isDay(to)) throw invalid('to', 'YYYY-MM-DD');
  if (Date.parse(to) - Date.parse(from) > 366 * DAY || to < from) throw invalid('to', 'at most a year after from');
  const rows = db.prepare(`SELECT r.user_id, u.name, u.email, r.day, r.body FROM activity_reports r JOIN users u ON u.id = r.user_id
    WHERE r.org_id = ? AND r.day >= ? AND r.day <= ? ORDER BY r.day, u.name`).all(orgId, from, to) as { user_id: number; name: string; email: string; day: string; body: string }[];
  const by = new Map<string, AttendanceRow>();
  for (const r of rows) {
    const b = JSON.parse(r.body) as { active_s: number; first_active: number | null; last_active: number | null };
    const k = `${r.day}|${r.user_id}`;
    const a = by.get(k) ?? { day: r.day, user_id: r.user_id, name: r.name, email: r.email, first_active: null, last_active: null, active_s: 0, devices: 0 };
    a.active_s += b.active_s; a.devices++;
    if (b.first_active !== null) a.first_active = a.first_active === null ? b.first_active : Math.min(a.first_active, b.first_active);
    if (b.last_active !== null) a.last_active = Math.max(a.last_active ?? 0, b.last_active);
    by.set(k, a);
  }
  return [...by.values()];
}

const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV with ISO 8601 UTC times and seconds and hours of active time. */
export function attendanceCsv(rows: AttendanceRow[]): string {
  const iso = (t: number | null) => (t === null ? '' : new Date(t).toISOString());
  const head = ['date', 'employee', 'email', 'first_active', 'last_active', 'active_seconds', 'active_hours', 'devices'];
  return [head.join(','), ...rows.map((r) => [r.day, r.name, r.email, iso(r.first_active), iso(r.last_active), r.active_s, (r.active_s / 3600).toFixed(2), r.devices].map(csvCell).join(','))].join('\r\n') + '\r\n';
}

/** HTTPS only, no user info; a fixed URL the administrator typed. */
export function validateWebhookUrl(u: unknown): string {
  if (typeof u !== 'string' || u.length > 2048) throw invalid('url');
  let url: URL;
  try { url = new URL(u); } catch { throw invalid('url', 'a URL'); }
  if (url.protocol !== 'https:') throw invalid('url', 'https only');
  if (url.username || url.password) throw invalid('url', 'no credentials in the URL; verify the signature instead');
  return url.toString();
}

export function getHrWebhook(db: DatabaseSync, orgId: number) {
  const w = db.prepare('SELECT url, enabled, last_day, last_status, last_at FROM hr_webhooks WHERE org_id = ?').get(orgId) as { url: string; enabled: number; last_day: string | null; last_status: string | null; last_at: number | null } | undefined;
  return w ? { configured: true, url: w.url, enabled: !!w.enabled, last_day: w.last_day, last_status: w.last_status, last_at: w.last_at } : { configured: false };
}

/** Creates or changes the webhook. The signing secret is generated here and returned only when created or rotated. */
export function setHrWebhook(db: DatabaseSync, orgId: number, b: { url?: unknown; enabled?: unknown; rotate_secret?: unknown }): { secret?: string } {
  const cur = db.prepare('SELECT secret FROM hr_webhooks WHERE org_id = ?').get(orgId) as { secret: string } | undefined;
  if (b.url === null) { db.prepare('DELETE FROM hr_webhooks WHERE org_id = ?').run(orgId); return {}; }
  const url = validateWebhookUrl(b.url);
  const enabled = b.enabled === undefined ? true : b.enabled === true;
  const fresh = !cur || b.rotate_secret === true;
  const secret = fresh ? 'whsec_' + randomBytes(32).toString('base64url') : cur!.secret;
  db.prepare(`INSERT INTO hr_webhooks (org_id, url, secret, enabled) VALUES (?, ?, ?, ?)
    ON CONFLICT(org_id) DO UPDATE SET url = excluded.url, secret = excluded.secret, enabled = excluded.enabled`).run(orgId, url, secret, enabled ? 1 : 0);
  return fresh ? { secret } : {};
}

/** `X-WorkSuite-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, like common webhook schemes. */
export function signWebhook(secret: string, body: string, t: number): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

export type WebhookFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; redirect: 'error'; signal?: AbortSignal }) => Promise<{ status: number }>;

/** Sends one day's attendance. Refused while monitoring is off; the result is recorded on the webhook. */
export async function deliverAttendance(db: DatabaseSync, orgId: number, day: string, fetchFn: WebhookFetch, now = Date.now()): Promise<{ ok: boolean; status: string; employees: number }> {
  const w = db.prepare('SELECT url, secret, enabled FROM hr_webhooks WHERE org_id = ?').get(orgId) as { url: string; secret: string; enabled: number } | undefined;
  if (!w) throw new HttpError(404, 'NOT_FOUND', 'no HR webhook configured');
  if (orgPolicy(db, orgId).activity_monitoring !== true) throw new HttpError(403, 'MONITORING_DISABLED', 'activity monitoring is not enabled for this organization');
  const rows = attendance(db, orgId, day, day);
  const body = JSON.stringify({
    type: 'attendance.daily', day, generated_at: new Date(now).toISOString(),
    employees: rows.map((r) => ({ email: r.email, name: r.name, first_active: r.first_active === null ? null : new Date(r.first_active).toISOString(), last_active: r.last_active === null ? null : new Date(r.last_active).toISOString(), active_seconds: r.active_s })),
  });
  let status: string;
  try {
    const res = await fetchFn(w.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), body,
      headers: { 'content-type': 'application/json', 'user-agent': 'WorkSuite-Server', 'x-worksuite-event': 'attendance.daily', 'x-worksuite-signature': signWebhook(w.secret, body, Math.floor(now / 1000)) } });
    status = String(res.status);
  } catch (e) { status = 'error: ' + (e instanceof Error ? e.message : String(e)).slice(0, 120); }
  const ok = /^2\d\d$/.test(status);
  db.prepare('UPDATE hr_webhooks SET last_status = ?, last_at = ?' + (ok ? ', last_day = ?' : '') + ' WHERE org_id = ?').run(...(ok ? [status, now, day, orgId] : [status, now, orgId]));
  return { ok, status, employees: rows.length };
}

/** Hourly: each enabled webhook gets every finished day since the last one it accepted (yesterday at first, at most 7). */
export async function runHrWebhooks(db: DatabaseSync, fetchFn: WebhookFetch, now = Date.now()) {
  const yesterday = new Date(now - DAY).toISOString().slice(0, 10);
  for (const w of db.prepare('SELECT org_id, last_day FROM hr_webhooks WHERE enabled = 1').all() as { org_id: number; last_day: string | null }[]) {
    if (orgPolicy(db, w.org_id).activity_monitoring !== true) continue;
    let d = w.last_day && w.last_day >= new Date(now - 7 * DAY).toISOString().slice(0, 10) ? new Date(Date.parse(w.last_day) + DAY).toISOString().slice(0, 10) : yesterday;
    while (d <= yesterday) {
      const r = await deliverAttendance(db, w.org_id, d, fetchFn, now).catch(() => ({ ok: false }));
      if (!r.ok) break;   // retried next hour, in order
      d = new Date(Date.parse(d) + DAY).toISOString().slice(0, 10);
    }
  }
}
