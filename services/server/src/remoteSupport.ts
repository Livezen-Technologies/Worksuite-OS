// Admin Center › Device Management › Remote Support (issue #19). The server records sessions and delivers signed
// RemoteSupportRequest / RemoteSupportEnd commands; the device decides. A session is "requested" until the device
// reports what its user chose (active with the granted mode, or ended with a reason), so the console never shows
// access that the person at the device did not give. Everything is scoped to the administrator's organization.
//
// Controls: permission desktop.devices.remote_support; remote-control requests need the administrator's TOTP (MFA);
// the session token (command envelope) is time-limited by policy (remote_support.max_session_minutes, default 60,
// at most 240) and the device ends the session when it expires; unanswered requests expire after 3 minutes.
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { issueCommand } from './admin.ts';
import { HttpError, invalid } from './http.ts';
import { verifyTotp } from './identity.ts';

export const REMOTE_SUPPORT_PERMISSION = 'desktop.devices.remote_support';
export const SCHEMA = `CREATE TABLE IF NOT EXISTS remote_sessions (
  id TEXT PRIMARY KEY, org_id INTEGER NOT NULL, device_id TEXT NOT NULL, admin_id INTEGER NOT NULL,
  mode TEXT NOT NULL, reason TEXT NOT NULL, state TEXT NOT NULL, granted_mode TEXT, consent TEXT, end_reason TEXT,
  unattended INTEGER NOT NULL DEFAULT 0, command_id TEXT, requested_at INTEGER NOT NULL, started_at INTEGER,
  ended_at INTEGER, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS remote_sessions_org ON remote_sessions(org_id, requested_at);
CREATE TABLE IF NOT EXISTS remote_signals (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, to_side TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS remote_signals_session ON remote_signals(session_id, to_side, id);`;

const PENDING_MS = 3 * 60_000;
/** A device polls every 10 s: seen within this window counts as online. */
export const ONLINE_MS = 60_000;
const END_REASONS = new Set(['denied', 'consent_timeout', 'user_ended', 'admin_ended', 'expired', 'no_user', 'unenrolled', 'busy']);

export interface RsPolicy { enabled?: boolean; unattended?: boolean; max_session_minutes?: number }

export function validRsPolicy(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  for (const [k, x] of Object.entries(v)) {
    if ((k === 'enabled' || k === 'unattended') && typeof x === 'boolean') continue;
    if (k === 'max_session_minutes' && Number.isInteger(x) && (x as number) >= 5 && (x as number) <= 240) continue;
    return false;
  }
  return true;
}

interface Admin { id: number; org_id: number; name: string }

/** Requests and active sessions that ran out without a device report are closed (lazily, on every read/write). */
export function sweep(db: DatabaseSync, now = Date.now()) {
  db.prepare("UPDATE remote_sessions SET state = 'ended', end_reason = 'consent_timeout', ended_at = ? WHERE state = 'requested' AND requested_at < ?").run(now, now - PENDING_MS);
  db.prepare("UPDATE remote_sessions SET state = 'ended', end_reason = 'expired', ended_at = expires_at WHERE state = 'active' AND expires_at <= ?").run(now);
}

export function requestSession(db: DatabaseSync, a: Admin, o: { device_id: string; mode: unknown; reason: unknown; otp?: unknown; policy: Record<string, unknown>; ownership: string; org_name: string }, now = Date.now()) {
  sweep(db, now);
  const p = (o.policy.remote_support ?? {}) as RsPolicy;
  if (p.enabled === false) throw new HttpError(409, 'REMOTE_SUPPORT_DISABLED', 'remote support is turned off in the device policy');
  if (o.mode !== 'view' && o.mode !== 'control') throw invalid('mode', 'view or control');
  const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
  if (reason.length < 3 || reason.length > 500) throw invalid('reason', 'say why access is needed (3–500 characters)');
  if (o.mode === 'control') {
    // MFA for remote control: the administrator's authenticator code, every time.
    const u = db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(a.id) as { totp_secret: string | null };
    if (!u.totp_secret) throw new HttpError(403, 'MFA_REQUIRED', 'remote control needs an authenticator (TOTP) on your administrator account');
    if (typeof o.otp !== 'string' || !verifyTotp(db, a.id, u.totp_secret, o.otp, now)) throw new HttpError(401, 'MFA_REQUIRED', 'enter the code from your authenticator');
  }
  if (db.prepare("SELECT 1 FROM remote_sessions WHERE device_id = ? AND state IN ('requested', 'active')").get(o.device_id))
    throw new HttpError(409, 'DEVICE_BUSY', 'this device already has a remote support session');
  const minutes = p.max_session_minutes ?? 60;
  // Unattended access: organization policy AND a corporate-owned device. The device checks its own signed policy too.
  const unattended = p.unattended === true && o.ownership === 'corporate';
  const id = randomUUID();
  const commandId = issueCommand(db, o.device_id, 'RemoteSupportRequest', {
    session_id: id, mode: o.mode, reason, admin_name: a.name, org_name: o.org_name, ...(unattended ? { unattended: true } : {}),
  }, minutes / 60);
  db.prepare(`INSERT INTO remote_sessions (id, org_id, device_id, admin_id, mode, reason, state, unattended, command_id, requested_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?)`).run(id, a.org_id, o.device_id, a.id, o.mode, reason, unattended ? 1 : 0, commandId, now, now + minutes * 60_000);
  return { session_id: id, command_id: commandId, unattended, expires_at: now + minutes * 60_000 };
}

export function terminateSession(db: DatabaseSync, a: Admin, id: string, now = Date.now()) {
  sweep(db, now);
  const s = db.prepare('SELECT device_id, state FROM remote_sessions WHERE id = ? AND org_id = ?').get(id, a.org_id) as { device_id: string; state: string } | undefined;
  if (!s) throw new HttpError(404, 'NOT_FOUND', 'no such session');
  if (s.state === 'ended') return { state: 'ended' };
  issueCommand(db, s.device_id, 'RemoteSupportEnd', { session_id: id }, 1);
  db.prepare("UPDATE remote_sessions SET state = 'ended', end_reason = 'admin_ended', ended_at = ? WHERE id = ?").run(now, id);
  return { state: 'ended' };
}

/** Device report (the agent's RsReport). Only the device the session was sent to can report on it. */
export function deviceReport(db: DatabaseSync, deviceId: string, id: string, b: Record<string, unknown>, now = Date.now()) {
  const s = db.prepare('SELECT org_id, admin_id, state FROM remote_sessions WHERE id = ? AND device_id = ?').get(id, deviceId) as { org_id: number; admin_id: number; state: string } | undefined;
  if (!s) throw new HttpError(404, 'NOT_FOUND', 'no such session for this device');
  const granted = b.granted_mode === 'view' || b.granted_mode === 'control' ? b.granted_mode : null;
  const consent = b.consent === 'user' || b.consent === 'unattended_policy' ? b.consent : null;
  if (b.state === 'active') {
    if (!granted || !consent) throw invalid('granted_mode', 'active needs granted_mode and consent');
    if (s.state === 'ended') return s.state;   // already ended (admin or expiry): the device is told separately
    const mode = (db.prepare('SELECT mode FROM remote_sessions WHERE id = ?').get(id) as { mode: string }).mode;
    if (granted === 'control' && mode !== 'control') throw invalid('granted_mode', 'more than requested');
    db.prepare('UPDATE remote_sessions SET state = ?, granted_mode = ?, consent = ?, started_at = COALESCE(started_at, ?) WHERE id = ?').run('active', granted, consent, now, id);
  } else if (b.state === 'ended') {
    const reason = typeof b.end_reason === 'string' && END_REASONS.has(b.end_reason) ? b.end_reason : null;
    if (!reason) throw invalid('end_reason');
    db.prepare("UPDATE remote_sessions SET state = 'ended', end_reason = COALESCE(CASE WHEN state = 'ended' THEN end_reason END, ?), consent = COALESCE(consent, ?), granted_mode = NULL, ended_at = COALESCE(ended_at, ?) WHERE id = ?").run(reason, consent, now, id);
  } else throw invalid('state', 'active or ended');
  // Audit, against the administrator who asked, reported by the device.
  db.prepare('INSERT INTO admin_log (org_id, user_id, action, detail, at) VALUES (?, ?, ?, ?, ?)')
    .run(s.org_id, s.admin_id, `remote_support_${b.state === 'active' ? (granted === 'control' ? 'control' : 'view') : 'ended'}`, JSON.stringify({ session_id: id, device_id: deviceId, reported_by: 'device', consent, end_reason: b.end_reason ?? undefined }), now);
  return b.state as string;
}

/** Pending RemoteSupportRequest/End envelopes for a device (the agent's fast poll). */
export function pendingCommands(db: DatabaseSync, deviceId: string, now = Date.now()): unknown[] {
  return (db.prepare(`SELECT envelope FROM commands WHERE device_id = ? AND state = 'pending' AND expires > ?
    AND json_extract(envelope, '$.command') IN ('RemoteSupportRequest', 'RemoteSupportEnd') ORDER BY rowid`).all(deviceId, now) as { envelope: string }[])
    .map((c) => JSON.parse(c.envelope));
}

/** Dashboard: overview cards, device list, session history. */
export function dashboard(db: DatabaseSync, orgId: number, now = Date.now()) {
  sweep(db, now);
  const org = (db.prepare('SELECT name FROM orgs WHERE id = ?').get(orgId) as { name: string }).name;
  const busy = new Set((db.prepare("SELECT device_id FROM remote_sessions WHERE org_id = ? AND state IN ('requested', 'active')").all(orgId) as { device_id: string }[]).map((r) => r.device_id));
  const devices = (db.prepare('SELECT id, hostname, last_seen, heartbeat, last_ip, assigned_user FROM devices WHERE org_id = ? AND revoked = 0 ORDER BY hostname').all(orgId) as { id: string; hostname: string; last_seen: number | null; heartbeat: string | null; last_ip: string | null; assigned_user: string | null }[])
    .map((d) => {
      const hb = d.heartbeat ? JSON.parse(d.heartbeat) as { os_version?: string } : {};
      const online = !!d.last_seen && now - d.last_seen < ONLINE_MS;
      return { id: d.id, name: d.hostname, assigned_user: d.assigned_user, organization: org, ip_address: d.last_ip, os_version: hb.os_version ?? null, status: busy.has(d.id) ? 'busy' : online ? 'online' : 'offline', last_seen: d.last_seen };
    });
  const n = (sql: string, ...p: (string | number)[]) => (db.prepare(sql).get(...p) as { n: number }).n;
  const technicians = (db.prepare("SELECT permissions FROM users WHERE org_id = ? AND role = 'admin' AND disabled = 0").all(orgId) as { permissions: string }[])
    .filter((u) => (JSON.parse(u.permissions) as string[]).includes(REMOTE_SUPPORT_PERMISSION)).length;
  return {
    cards: {
      online_devices: devices.filter((d) => d.status !== 'offline').length,
      offline_devices: devices.filter((d) => d.status === 'offline').length,
      active_sessions: n("SELECT COUNT(*) AS n FROM remote_sessions WHERE org_id = ? AND state = 'active'", orgId),
      pending_requests: n("SELECT COUNT(*) AS n FROM remote_sessions WHERE org_id = ? AND state = 'requested'", orgId),
      support_technicians: technicians,
      completed_sessions: n("SELECT COUNT(*) AS n FROM remote_sessions WHERE org_id = ? AND state = 'ended' AND started_at IS NOT NULL", orgId),
    },
    devices,
    history: history(db, orgId, now),
  };
}

export function history(db: DatabaseSync, orgId: number, now = Date.now(), limit = 100) {
  return (db.prepare(`SELECT s.id, u.name AS administrator, d.hostname AS device, d.assigned_user AS user, s.mode, s.granted_mode, s.consent,
      s.state, s.end_reason, s.unattended, s.requested_at, s.started_at, s.ended_at, s.reason
    FROM remote_sessions s JOIN users u ON u.id = s.admin_id JOIN devices d ON d.id = s.device_id
    WHERE s.org_id = ? ORDER BY s.requested_at DESC LIMIT ?`).all(orgId, limit) as Record<string, unknown>[])
    .map((s) => ({ ...s, unattended: !!s.unattended, duration_s: s.started_at ? Math.round((((s.ended_at as number | null) ?? now) - (s.started_at as number)) / 1000) : 0 }));
}

// ---- WebRTC signalling relay (issue #19 media path) ----
// SDP offers/answers and ICE candidates pass through here between the device (X-WS-Device) and the administrator's
// viewer (admin session cookie). The media itself goes peer to peer (or via the configured TURN server) and is
// encrypted end to end by DTLS-SRTP; the server never sees it. Nothing is relayed unless the device has reported the
// user's consent (session active), and the relay stops the moment the session ends.
export type Side = 'device' | 'admin';
const SIGNAL_TYPES = new Set(['offer', 'answer', 'ice', 'bye']);
const MAX_SIGNAL = 64 * 1024;

/** STUN/TURN servers for both peers, from WORKSUITE_ICE_SERVERS (JSON RTCIceServer[]); none = same-network only. */
export function iceServers(env: string | undefined = process.env.WORKSUITE_ICE_SERVERS): unknown[] {
  try {
    const v = JSON.parse(env ?? '[]');
    return Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && (typeof x.urls === 'string' || Array.isArray(x.urls))) : [];
  } catch { return []; }
}

function activeSession(db: DatabaseSync, id: string, where: { device_id?: string; org_id?: number }, now: number) {
  sweep(db, now);
  const s = (where.device_id
    ? db.prepare('SELECT id, org_id, admin_id, state, granted_mode FROM remote_sessions WHERE id = ? AND device_id = ?').get(id, where.device_id)
    : db.prepare('SELECT id, org_id, admin_id, state, granted_mode FROM remote_sessions WHERE id = ? AND org_id = ?').get(id, where.org_id!)) as
    { id: string; org_id: number; admin_id: number; state: string; granted_mode: string | null } | undefined;
  if (!s) throw new HttpError(404, 'NOT_FOUND', 'no such session');
  if (s.state !== 'active') {
    db.prepare('DELETE FROM remote_signals WHERE session_id = ?').run(id);
    throw new HttpError(409, 'CONSENT_REQUIRED', s.state === 'requested' ? 'waiting for the user to allow the session' : 'the session has ended');
  }
  return s;
}

export function postSignal(db: DatabaseSync, from: Side, id: string, where: { device_id?: string; org_id?: number }, b: Record<string, unknown>, now = Date.now()) {
  const s = activeSession(db, id, where, now);
  if (typeof b.type !== 'string' || !SIGNAL_TYPES.has(b.type)) throw invalid('type', 'offer, answer, ice or bye');
  if (from === 'device' && b.type === 'answer') throw invalid('type', 'the device makes the offer');
  if (from === 'admin' && b.type === 'offer') throw invalid('type', 'the device makes the offer');
  const body = JSON.stringify({ type: b.type, sdp: typeof b.sdp === 'string' ? b.sdp : undefined, candidate: b.candidate && typeof b.candidate === 'object' ? b.candidate : undefined });
  if (body.length > MAX_SIGNAL) throw invalid('body', 'too large');
  // A new offer (first connect or reconnect) starts negotiation afresh: older messages would only confuse the peers.
  if (b.type === 'offer') db.prepare('DELETE FROM remote_signals WHERE session_id = ?').run(id);
  db.prepare('INSERT INTO remote_signals (session_id, to_side, body, at) VALUES (?, ?, ?, ?)').run(id, from === 'device' ? 'admin' : 'device', body, now);
  if (b.type === 'offer' || b.type === 'answer')
    db.prepare('INSERT INTO admin_log (org_id, user_id, action, detail, at) VALUES (?, ?, ?, ?, ?)')
      .run(s.org_id, s.admin_id, `remote_support_${b.type === 'offer' ? 'stream_offered' : 'stream_answered'}`, JSON.stringify({ session_id: id, by: from }), now);
}

/** Messages for one side after cursor `after`, with the session's current grant (the viewer shows view-only). */
export function getSignals(db: DatabaseSync, to: Side, id: string, where: { device_id?: string; org_id?: number }, after: number, now = Date.now()) {
  const s = activeSession(db, id, where, now);
  const rows = db.prepare('SELECT id, body FROM remote_signals WHERE session_id = ? AND to_side = ? AND id > ? ORDER BY id LIMIT 200').all(id, to, after) as { id: number; body: string }[];
  db.prepare('DELETE FROM remote_signals WHERE session_id = ? AND at < ?').run(id, now - 10 * 60_000);
  return { granted_mode: s.granted_mode, ice_servers: iceServers(), messages: rows.map((r) => ({ id: r.id, ...JSON.parse(r.body) })) };
}
