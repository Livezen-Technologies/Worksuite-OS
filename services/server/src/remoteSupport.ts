// Admin Center › Device Management › Remote Support (issue #19). The server records sessions and delivers signed
// RemoteSupportRequest / RemoteSupportEnd commands; the device decides. A session is "requested" until the device
// reports what its user chose (active with the granted mode, or ended with a reason), so the console never shows
// access that the person at the device did not give. Everything is scoped to the administrator's organization.
//
// Controls: permission desktop.devices.remote_support; remote-control requests need the administrator's TOTP (MFA);
// the session token (command envelope) is time-limited by policy (remote_support.max_session_minutes, default 60,
// at most 240) and the device ends the session when it expires; unanswered requests expire after 3 minutes.
import { createHmac, randomUUID } from 'node:crypto';
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
CREATE INDEX IF NOT EXISTS remote_signals_session ON remote_signals(session_id, to_side, id);
CREATE TABLE IF NOT EXISTS remote_events (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, org_id INTEGER NOT NULL, side TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS remote_events_session ON remote_events(session_id, id);
CREATE TABLE IF NOT EXISTS remote_recordings (
  session_id TEXT NOT NULL, seq INTEGER NOT NULL, org_id INTEGER NOT NULL, data BLOB NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (session_id, seq)
);`;

/** Columns added after issue #19 (issue #37): recording allowed for this session, step-up state. */
export function migrate(db: DatabaseSync) {
  const cols = (db.prepare('PRAGMA table_info(remote_sessions)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('record')) db.exec('ALTER TABLE remote_sessions ADD COLUMN record INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('elevation')) db.exec('ALTER TABLE remote_sessions ADD COLUMN elevation TEXT');
  if (!cols.includes('clipboard')) db.exec('ALTER TABLE remote_sessions ADD COLUMN clipboard INTEGER NOT NULL DEFAULT 0');
}

const PENDING_MS = 3 * 60_000;
/** A device polls every 10 s: seen within this window counts as online. */
export const ONLINE_MS = 60_000;
const END_REASONS = new Set(['denied', 'consent_timeout', 'user_ended', 'admin_ended', 'expired', 'no_user', 'unenrolled', 'busy']);

// recording: the administrator's viewer may record sessions (the user is told in the consent dialog and indicator);
// recording_retention_days: recordings are deleted after this many days (1–365, default 30).
export interface RsPolicy { enabled?: boolean; unattended?: boolean; max_session_minutes?: number; recording?: boolean; recording_retention_days?: number }

export function validRsPolicy(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  for (const [k, x] of Object.entries(v)) {
    if ((k === 'enabled' || k === 'unattended' || k === 'recording') && typeof x === 'boolean') continue;
    if (k === 'recording_retention_days' && Number.isInteger(x) && (x as number) >= 1 && (x as number) <= 365) continue;
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

function requireTotp(db: DatabaseSync, a: Admin, otp: unknown, now: number) {
  const u = db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(a.id) as { totp_secret: string | null };
  if (!u.totp_secret) throw new HttpError(403, 'MFA_REQUIRED', 'remote control needs an authenticator (TOTP) on your administrator account');
  if (typeof otp !== 'string' || !verifyTotp(db, a.id, u.totp_secret, otp, now)) throw new HttpError(401, 'MFA_REQUIRED', 'enter the code from your authenticator');
}

export function requestSession(db: DatabaseSync, a: Admin, o: { device_id: string; mode: unknown; reason: unknown; otp?: unknown; record?: unknown; policy: Record<string, unknown>; ownership: string; org_name: string }, now = Date.now()) {
  sweep(db, now);
  const p = (o.policy.remote_support ?? {}) as RsPolicy;
  if (p.enabled === false) throw new HttpError(409, 'REMOTE_SUPPORT_DISABLED', 'remote support is turned off in the device policy');
  if (o.mode !== 'view' && o.mode !== 'control') throw invalid('mode', 'view or control');
  const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
  if (reason.length < 3 || reason.length > 500) throw invalid('reason', 'say why access is needed (3–500 characters)');
  // Recording is decided at request time, so the user sees it in the consent dialog before anything is shared.
  const record = o.record === true;
  if (record && p.recording !== true) throw new HttpError(409, 'RECORDING_NOT_ALLOWED', 'the device policy does not allow recording remote support sessions');
  // MFA for remote control: the administrator's authenticator code, every time.
  if (o.mode === 'control') requireTotp(db, a, o.otp, now);
  if (db.prepare("SELECT 1 FROM remote_sessions WHERE device_id = ? AND state IN ('requested', 'active')").get(o.device_id))
    throw new HttpError(409, 'DEVICE_BUSY', 'this device already has a remote support session');
  const minutes = p.max_session_minutes ?? 60;
  // Unattended access: organization policy AND a corporate-owned device. The device checks its own signed policy too.
  const unattended = p.unattended === true && o.ownership === 'corporate';
  const id = randomUUID();
  const commandId = issueCommand(db, o.device_id, 'RemoteSupportRequest', {
    session_id: id, mode: o.mode, reason, admin_name: a.name, org_name: o.org_name, ...(unattended ? { unattended: true } : {}), ...(record ? { record: true } : {}),
  }, minutes / 60);
  db.prepare(`INSERT INTO remote_sessions (id, org_id, device_id, admin_id, mode, reason, state, unattended, record, command_id, requested_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?)`).run(id, a.org_id, o.device_id, a.id, o.mode, reason, unattended ? 1 : 0, record ? 1 : 0, commandId, now, now + minutes * 60_000);
  return { session_id: id, command_id: commandId, unattended, record, expires_at: now + minutes * 60_000 };
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
    const elevation = b.elevation === 'granted' || b.elevation === 'denied' ? b.elevation : null;
    db.prepare('UPDATE remote_sessions SET state = ?, granted_mode = ?, consent = ?, started_at = COALESCE(started_at, ?), elevation = CASE WHEN ? IS NOT NULL THEN ? ELSE elevation END, clipboard = COALESCE(?, clipboard) WHERE id = ?')
      .run('active', granted, consent, now, elevation, elevation, typeof b.clipboard === 'boolean' ? (b.clipboard ? 1 : 0) : null, id);
  } else if (b.state === 'ended') {
    const reason = typeof b.end_reason === 'string' && END_REASONS.has(b.end_reason) ? b.end_reason : null;
    if (!reason) throw invalid('end_reason');
    db.prepare("UPDATE remote_sessions SET state = 'ended', end_reason = COALESCE(CASE WHEN state = 'ended' THEN end_reason END, ?), consent = COALESCE(consent, ?), granted_mode = NULL, ended_at = COALESCE(ended_at, ?) WHERE id = ?").run(reason, consent, now, id);
  } else throw invalid('state', 'active or ended');
  // Audit, against the administrator who asked, reported by the device.
  const what = b.state !== 'active' ? 'ended' : b.elevation === 'granted' || b.elevation === 'denied' ? `elevation_${b.elevation}` : typeof b.clipboard === 'boolean' ? `clipboard_${b.clipboard ? 'on' : 'off'}` : granted === 'control' ? 'control' : 'view';
  db.prepare('INSERT INTO admin_log (org_id, user_id, action, detail, at) VALUES (?, ?, ?, ?, ?)')
    .run(s.org_id, s.admin_id, `remote_support_${what}`, JSON.stringify({ session_id: id, device_id: deviceId, reported_by: 'device', consent, end_reason: b.end_reason ?? undefined }), now);
  return b.state as string;
}

/** Pending RemoteSupportRequest/End envelopes for a device (the agent's fast poll). */
export function pendingCommands(db: DatabaseSync, deviceId: string, now = Date.now()): unknown[] {
  return (db.prepare(`SELECT envelope FROM commands WHERE device_id = ? AND state = 'pending' AND expires > ?
    AND json_extract(envelope, '$.command') IN ('RemoteSupportRequest', 'RemoteSupportEnd', 'RemoteSupportElevate') ORDER BY rowid`).all(deviceId, now) as { envelope: string }[])
    .map((c) => JSON.parse(c.envelope));
}

/** Dashboard: overview cards, device list, session history. */
export function dashboard(db: DatabaseSync, orgId: number, now = Date.now()) {
  sweep(db, now);
  purgeRecordings(db, now);
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
      s.state, s.end_reason, s.unattended, s.record, s.elevation, s.clipboard, s.requested_at, s.started_at, s.ended_at, s.reason,
      (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM remote_recordings r WHERE r.session_id = s.id) AS recording_bytes
    FROM remote_sessions s JOIN users u ON u.id = s.admin_id JOIN devices d ON d.id = s.device_id
    WHERE s.org_id = ? ORDER BY s.requested_at DESC LIMIT ?`).all(orgId, limit) as Record<string, unknown>[])
    .map((s) => ({ ...s, unattended: !!s.unattended, record: !!s.record, clipboard: !!s.clipboard, duration_s: s.started_at ? Math.round((((s.ended_at as number | null) ?? now) - (s.started_at as number)) / 1000) : 0 }));
}

// ---- WebRTC signalling relay (issue #19 media path) ----
// SDP offers/answers and ICE candidates pass through here between the device (X-WS-Device) and the administrator's
// viewer (admin session cookie). The media itself goes peer to peer (or via the configured TURN server) and is
// encrypted end to end by DTLS-SRTP; the server never sees it. Nothing is relayed unless the device has reported the
// user's consent (session active), and the relay stops the moment the session ends.
export type Side = 'device' | 'admin';
const SIGNAL_TYPES = new Set(['offer', 'answer', 'ice', 'bye']);
const MAX_SIGNAL = 64 * 1024;

/**
 * STUN/TURN servers for both peers (issue #37). Configuration (environment of worksuite-server):
 *   WORKSUITE_STUN_URLS    comma-separated stun: URLs
 *   WORKSUITE_TURN_URLS    comma-separated turn:/turns: URLs of a coturn server with use-auth-secret
 *   WORKSUITE_TURN_SECRET  coturn's static-auth-secret: short-lived credentials per session (TURN REST API:
 *                          username "<expiry>:<session>", credential base64(HMAC-SHA1(secret, username)))
 *   WORKSUITE_TURN_TTL     credential lifetime in seconds (60–86400, default 3600)
 *   WORKSUITE_ICE_SERVERS  JSON RTCIceServer[] appended as is (e.g. a TURN server with fixed credentials)
 * None of them = same-network only (host candidates).
 */
export interface IceEnv { WORKSUITE_STUN_URLS?: string; WORKSUITE_TURN_URLS?: string; WORKSUITE_TURN_SECRET?: string; WORKSUITE_TURN_TTL?: string; WORKSUITE_ICE_SERVERS?: string }

export function iceServers(sessionId: string, now = Date.now(), env: IceEnv = process.env as IceEnv): { urls: string | string[]; username?: string; credential?: string }[] {
  const list = (v: string | undefined, re: RegExp) => (v ?? '').split(',').map((x) => x.trim()).filter((x) => re.test(x) && x.length <= 300);
  const out: { urls: string | string[]; username?: string; credential?: string }[] = [];
  const stun = list(env.WORKSUITE_STUN_URLS, /^stuns?:[^\s]+$/);
  if (stun.length) out.push({ urls: stun });
  const turn = list(env.WORKSUITE_TURN_URLS, /^turns?:[^\s]+$/);
  if (turn.length && env.WORKSUITE_TURN_SECRET) {
    const ttl = Math.min(86_400, Math.max(60, Number(env.WORKSUITE_TURN_TTL) || 3600));
    const username = `${Math.floor(now / 1000) + ttl}:${sessionId}`;
    out.push({ urls: turn, username, credential: createHmac('sha1', env.WORKSUITE_TURN_SECRET).update(username).digest('base64') });
  }
  try {
    const v = JSON.parse(env.WORKSUITE_ICE_SERVERS ?? '[]');
    if (Array.isArray(v)) out.push(...v.filter((x) => x && typeof x === 'object' && (typeof x.urls === 'string' || Array.isArray(x.urls))));
  } catch { /* ignored: a malformed value adds nothing */ }
  return out;
}

function activeSession(db: DatabaseSync, id: string, where: { device_id?: string; org_id?: number }, now: number) {
  sweep(db, now);
  const s = (where.device_id
    ? db.prepare('SELECT id, org_id, admin_id, device_id, state, granted_mode, record, elevation FROM remote_sessions WHERE id = ? AND device_id = ?').get(id, where.device_id)
    : db.prepare('SELECT id, org_id, admin_id, device_id, state, granted_mode, record, elevation FROM remote_sessions WHERE id = ? AND org_id = ?').get(id, where.org_id!)) as
    { id: string; org_id: number; admin_id: number; device_id: string; state: string; granted_mode: string | null; record: number; elevation: string | null } | undefined;
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
  return { granted_mode: s.granted_mode, record: !!s.record, ice_servers: iceServers(id, now), messages: rows.map((r) => ({ id: r.id, ...JSON.parse(r.body) })) };
}

/** ICE servers for one side of an active session (both the viewer and the device fetch them before connecting). */
export function sessionIceServers(db: DatabaseSync, id: string, where: { device_id?: string; org_id?: number }, now = Date.now()) {
  activeSession(db, id, where, now);
  return { ice_servers: iceServers(id, now) };
}

// ---- Step-up (issue #37) ----
// A view-only session becomes remote control only with the administrator's TOTP now and a fresh "Allow" from the
// person at the device (RemoteSupportElevate → the device's step-up dialog). Until the device reports the answer the
// grant stays view.
export function elevateSession(db: DatabaseSync, a: Admin, id: string, otp: unknown, now = Date.now()) {
  const s = activeSession(db, id, { org_id: a.org_id }, now);
  if (s.granted_mode === 'control') throw new HttpError(409, 'ALREADY_CONTROL', 'the user already allowed remote control');
  if (s.elevation === 'requested') throw new HttpError(409, 'ELEVATION_PENDING', 'the user is already being asked');
  requireTotp(db, a, otp, now);
  const commandId = issueCommand(db, s.device_id, 'RemoteSupportElevate', { session_id: id }, 1);
  db.prepare("UPDATE remote_sessions SET mode = 'control', elevation = 'requested' WHERE id = ?").run(id);
  db.prepare('INSERT INTO admin_log (org_id, user_id, action, detail, at) VALUES (?, ?, ?, ?, ?)')
    .run(s.org_id, a.id, 'remote_support_elevation_requested', JSON.stringify({ session_id: id, device_id: s.device_id, mfa: 'totp' }), now);
  return { command_id: commandId, elevation: 'requested' };
}

// ---- Session audit: chat and file transfer metadata (issue #37) ----
// Both peers report what passed over the data channel; message text and file contents are never sent here.
const EVENT_KINDS = new Set(['chat', 'file']);
const FILE_ACTIONS = new Set(['offered', 'accepted', 'rejected', 'completed', 'failed', 'cancelled']);

export function recordEvent(db: DatabaseSync, side: Side, id: string, where: { device_id?: string; org_id?: number }, b: Record<string, unknown>, actor: number | null, now = Date.now()) {
  const s = activeSession(db, id, where, now);
  if (typeof b.kind !== 'string' || !EVENT_KINDS.has(b.kind)) throw invalid('kind', 'chat or file');
  const dir = b.direction === 'to_device' || b.direction === 'to_admin' ? b.direction : null;
  if (!dir) throw invalid('direction', 'to_device or to_admin');
  let detail: Record<string, unknown>;
  if (b.kind === 'chat') {
    if (!Number.isInteger(b.length) || (b.length as number) < 1 || (b.length as number) > 500) throw invalid('length', '1–500');
    detail = { direction: dir, length: b.length };
  } else {
    if (typeof b.action !== 'string' || !FILE_ACTIONS.has(b.action)) throw invalid('action');
    const name = typeof b.name === 'string' ? b.name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) : '';
    if (!name) throw invalid('name');
    if (!Number.isInteger(b.size) || (b.size as number) < 0) throw invalid('size');
    if (b.sha256 !== undefined && (typeof b.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(b.sha256))) throw invalid('sha256');
    detail = { direction: dir, action: b.action, name, size: b.size, ...(b.sha256 ? { sha256: b.sha256 } : {}), ...(typeof b.reason === 'string' ? { reason: b.reason.slice(0, 60) } : {}) };
  }
  const n = (db.prepare('SELECT COUNT(*) AS n FROM remote_events WHERE session_id = ?').get(id) as { n: number }).n;
  if (n >= 5000) throw new HttpError(429, 'TOO_MANY_EVENTS', 'event limit for this session reached');
  db.prepare('INSERT INTO remote_events (session_id, org_id, side, kind, detail, at) VALUES (?, ?, ?, ?, ?, ?)').run(id, s.org_id, side, b.kind, JSON.stringify(detail), now);
  db.prepare('INSERT INTO admin_log (org_id, user_id, action, detail, at) VALUES (?, ?, ?, ?, ?)')
    .run(s.org_id, actor ?? s.admin_id, `remote_support_${b.kind}${b.kind === 'file' ? '_' + b.action : ''}`, JSON.stringify({ session_id: id, reported_by: side, ...detail }), now);
}

export function sessionEvents(db: DatabaseSync, orgId: number, id: string) {
  if (!db.prepare('SELECT 1 FROM remote_sessions WHERE id = ? AND org_id = ?').get(id, orgId)) throw new HttpError(404, 'NOT_FOUND', 'no such session');
  return (db.prepare('SELECT side, kind, detail, at FROM remote_events WHERE session_id = ? ORDER BY id').all(id) as { side: string; kind: string; detail: string; at: number }[])
    .map((e) => ({ side: e.side, kind: e.kind, at: e.at, ...JSON.parse(e.detail) }));
}

// ---- Session recordings (issue #37) ----
// The viewer records with MediaRecorder (WebM) only when the session was requested with recording, which the policy
// must allow and the user saw in the consent dialog. Chunks of at most 1 MiB arrive in order while the session is
// active; downloads are audited; recordings are deleted after the policy's retention.
export const MAX_RECORDING_BYTES = 1024 * 1024 * 1024;

export function appendRecording(db: DatabaseSync, a: Admin, id: string, seq: number, data: Buffer, now = Date.now()) {
  const s = activeSession(db, id, { org_id: a.org_id }, now);
  if (!s.record) throw new HttpError(409, 'RECORDING_NOT_ALLOWED', 'this session was not requested with recording');
  if (!Number.isInteger(seq) || seq < 0) throw invalid('seq');
  if (!data.length) throw invalid('body', 'empty');
  const cur = db.prepare('SELECT COALESCE(MAX(seq), -1) AS last, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM remote_recordings WHERE session_id = ?').get(id) as { last: number; bytes: number };
  if (seq <= cur.last) return { bytes: cur.bytes };   // a retried chunk
  if (seq !== cur.last + 1) throw new HttpError(409, 'OUT_OF_ORDER', `expected chunk ${cur.last + 1}`);
  if (cur.bytes + data.length > MAX_RECORDING_BYTES) throw new HttpError(413, 'RECORDING_TOO_LARGE', 'recording size limit reached');
  db.prepare('INSERT INTO remote_recordings (session_id, seq, org_id, data, at) VALUES (?, ?, ?, ?, ?)').run(id, seq, s.org_id, data, now);
  if (seq === 0) db.prepare('INSERT INTO admin_log (org_id, user_id, action, detail, at) VALUES (?, ?, ?, ?, ?)')
    .run(s.org_id, a.id, 'remote_support_recording_started', JSON.stringify({ session_id: id }), now);
  return { bytes: cur.bytes + data.length };
}

/** The whole recording for download; every access is audited. */
export function readRecording(db: DatabaseSync, a: Admin, id: string, now = Date.now()): Buffer {
  purgeRecordings(db, now);
  if (!db.prepare('SELECT 1 FROM remote_sessions WHERE id = ? AND org_id = ?').get(id, a.org_id)) throw new HttpError(404, 'NOT_FOUND', 'no such session');
  const rows = db.prepare('SELECT data FROM remote_recordings WHERE session_id = ? ORDER BY seq').all(id) as { data: Uint8Array }[];
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'no recording for this session');
  const buf = Buffer.concat(rows.map((r) => Buffer.from(r.data)));
  db.prepare('INSERT INTO admin_log (org_id, user_id, action, detail, at) VALUES (?, ?, ?, ?, ?)')
    .run(a.org_id, a.id, 'remote_support_recording_downloaded', JSON.stringify({ session_id: id, bytes: buf.length }), now);
  return buf;
}

/** Deletes recordings older than each organization's retention (policy remote_support.recording_retention_days, default 30). */
export function purgeRecordings(db: DatabaseSync, now = Date.now()) {
  const orgs = db.prepare('SELECT DISTINCT org_id FROM remote_recordings').all() as { org_id: number }[];
  for (const { org_id } of orgs) {
    const pol = db.prepare('SELECT body FROM policies WHERE org_id = ?').get(org_id) as { body: string } | undefined;
    let days = 30;
    try { days = (JSON.parse(pol?.body ?? '{}').remote_support as RsPolicy | undefined)?.recording_retention_days ?? 30; } catch { /* default */ }
    const old = db.prepare(`SELECT DISTINCT r.session_id, s.admin_id FROM remote_recordings r JOIN remote_sessions s ON s.id = r.session_id
      WHERE r.org_id = ? AND COALESCE(s.ended_at, s.requested_at) < ?`).all(org_id, now - days * 86_400_000) as { session_id: string; admin_id: number }[];
    for (const { session_id, admin_id } of old) {
      db.prepare('DELETE FROM remote_recordings WHERE session_id = ?').run(session_id);
      db.prepare('INSERT INTO admin_log (org_id, user_id, action, detail, at) VALUES (?, ?, ?, ?, ?)')
        .run(org_id, admin_id, 'remote_support_recording_expired', JSON.stringify({ session_id, retention_days: days }), now);
    }
  }
}
