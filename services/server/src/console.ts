// Admin console API (/admin/api/*) and static UI (/admin). Admins are users with role 'admin'; everything is scoped
// to the admin's organization. Session: random token in an HttpOnly, Secure, SameSite=Strict cookie (stored hashed,
// 8 h). CSRF: every API call must carry `X-WS-Admin: 1`, which a cross-site form cannot send and which CORS
// (never enabled here) would preflight. Remote wipe needs a second admin's approval (WSOS-WIPE-002).
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { issueCommand, revokeDevice, setPolicy, addUser, createEnrollmentToken, putCatalogItem, publishRelease, setReleaseState, promoteRelease, emergencyRelease, logRelease, RELEASE_PERMISSION } from './admin.ts';
import { secret, sha256, tx } from './db.ts';
import { HttpError, invalid, send, type Ctx, type Router } from './http.ts';
import { checkPassword } from './oauth.ts';
import { APP_CSS, APP_HTML, APP_JS } from './console-ui.ts';

const SESSION_TTL = 8 * 3_600_000;
const COOKIE = 'ws_admin';
const ROUTINE = new Set(['RefreshPolicy', 'RequestLock', 'RebootDuringWindow', 'ScheduleUpdate', 'InstallApprovedApplication', 'CollectApprovedDiagnostics']);
const DIAG_PROFILES = new Set(['basic', 'network', 'update']);

interface Admin { id: number; org_id: number; email: string; name: string }

const json = <T>(s: string | null): T => (s ? JSON.parse(s) : null) as T;

function cookie(ctx: Ctx, name: string): string | undefined {
  for (const part of (ctx.header('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

/** Login throttling per client address: 10 failures per 15 minutes. */
const failures = new Map<string, number[]>();
function throttled(addr: string) {
  const now = Date.now();
  const recent = (failures.get(addr) ?? []).filter((t) => t > now - 15 * 60_000);
  failures.set(addr, recent);
  return recent.length >= 10;
}

const POLICY_FIELDS: Record<string, (v: unknown) => boolean> = {
  update_ring: (v) => v === 'development' || v === 'pilot' || v === 'stable',
  update_mode: (v) => v === 'automatic' || v === 'notify' || v === 'manual',
  maintenance_window: (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(v),
  lock_timeout_max_s: (v) => Number.isInteger(v) && (v as number) >= 60 && (v as number) <= 86_400,
  offline_access_days: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 365,
  usb_storage: (v) => v === 'allow' || v === 'read_only' || v === 'block',
  bluetooth: (v) => typeof v === 'boolean',
  login_failures_max: (v) => Number.isInteger(v) && (v as number) >= 3 && (v as number) <= 20,
  login_lockout_s: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 86_400,
  app_allowlist: (v) => Array.isArray(v) && v.length <= 1000 && v.every((x) => typeof x === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(x)),
  approved_remotes: (v) => Array.isArray(v) && v.length <= 50 && v.every((x) => typeof x === 'string' && x.length <= 200),
  offline_wipe_days: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 365,
  // AppImages (WSOS-AIM-002) and local .deb files (WSOS-APT-005).
  appimages: (v) => v === 'allow' || v === 'block',
  appimage_trusted_keys: (v) => Array.isArray(v) && v.length <= 50 && v.every((x) => typeof x === 'string' && /^[0-9A-Fa-f ]{40,80}$/.test(x)),
  allow_local_debs: (v) => typeof v === 'boolean',
  update_mirror: (v) => typeof v === 'string' && /^https:\/\/[^\s/]+(\/\S*)?$/.test(v),
};

export function validatePolicy(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('policy', 'must be an object');
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === null || v === '' || k === 'version' || k === 'signature') continue;   // cleared fields are omitted
    const check = POLICY_FIELDS[k];
    if (!check) throw invalid(k, 'unknown policy field');
    if (!check(v)) throw invalid(k, 'invalid value');
    out[k] = v;
  }
  return out;
}

export function consoleRoutes(r: Router, db: DatabaseSync, o: { secureCookie: boolean }) {
  const log = (a: Admin, action: string, detail: Record<string, unknown> = {}) =>
    db.prepare('INSERT INTO admin_log (org_id, user_id, action, detail, at) VALUES (?, ?, ?, ?, ?)').run(a.org_id, a.id, action, JSON.stringify(detail), Date.now());

  const admin = (ctx: Ctx): Admin => {
    if (ctx.header('x-ws-admin') !== '1') throw new HttpError(403, 'PERMISSION_DENIED', 'missing X-WS-Admin header');
    const t = cookie(ctx, COOKIE);
    const row = t ? db.prepare(`SELECT u.id, u.org_id, u.email, u.name, u.role, u.disabled, s.expires FROM admin_sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ?`)
      .get(sha256(t)) as (Admin & { role: string; disabled: number; expires: number }) | undefined : undefined;
    if (!row || row.expires < Date.now() || row.disabled || row.role !== 'admin') throw new HttpError(401, 'TOKEN_EXPIRED', 'sign in to the admin console');
    return { id: row.id, org_id: row.org_id, email: row.email, name: row.name };
  };
  const device = (a: Admin, id: string) => {
    const d = db.prepare('SELECT id, org_id, hostname, revoked FROM devices WHERE id = ? AND org_id = ?').get(id, a.org_id) as { id: string; hostname: string; revoked: number } | undefined;
    if (!d) throw new HttpError(404, 'NOT_FOUND', 'no such device');
    return d;
  };
  /** WSOS-WIPE-001: destructive actions need the admin's password again and the device name typed exactly. */
  const reauth = (ctx: Ctx, a: Admin, b: Record<string, unknown>, hostname: string) => {
    const addr = ctx.req.socket.remoteAddress ?? '?';
    if (throttled(addr)) throw new HttpError(429, 'RATE_LIMITED', 'too many failed attempts; try again later', { retryable: true });
    const u = typeof b.password === 'string' ? checkPassword(db, a.email, b.password) : undefined;
    if (!u || u.id !== a.id) {
      failures.get(addr)!.push(Date.now());
      log(a, 'reauth_failed', { action: 'wipe' });
      throw new HttpError(401, 'REAUTH_REQUIRED', 'enter your administrator password to confirm');
    }
    if (typeof b.confirm_name !== 'string' || b.confirm_name.trim() !== hostname) throw invalid('confirm_name', 'type the device name exactly to confirm');
  };
  const body = async (ctx: Ctx) => {
    const b = await ctx.body();
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw invalid('body', 'must be an object');
    return b as Record<string, unknown>;
  };

  // ---- static UI ----
  const csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";
  r.on('GET', '/admin', (ctx) => send(ctx, 200, APP_HTML, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }));
  r.on('GET', '/admin/app.js', (ctx) => send(ctx, 200, APP_JS, { 'content-type': 'text/javascript; charset=utf-8', 'x-content-type-options': 'nosniff' }));
  r.on('GET', '/admin/app.css', (ctx) => send(ctx, 200, APP_CSS, { 'content-type': 'text/css; charset=utf-8', 'x-content-type-options': 'nosniff' }));

  // ---- session ----
  r.on('POST', '/admin/api/login', async (ctx) => {
    if (ctx.header('x-ws-admin') !== '1') throw new HttpError(403, 'PERMISSION_DENIED', 'missing X-WS-Admin header');
    const addr = ctx.req.socket.remoteAddress ?? '?';
    if (throttled(addr)) throw new HttpError(429, 'RATE_LIMITED', 'too many failed sign-ins; try again later', { retryable: true });
    const b = await body(ctx);
    const u = checkPassword(db, String(b.email ?? ''), String(b.password ?? ''));
    const role = u ? (db.prepare('SELECT role FROM users WHERE id = ?').get(u.id) as { role: string }).role : null;
    if (!u || role !== 'admin') {
      failures.get(addr)!.push(Date.now());
      throw new HttpError(401, 'PERMISSION_DENIED', 'email or password is incorrect, or this account is not an administrator');
    }
    const t = secret('wsadm');
    db.prepare('DELETE FROM admin_sessions WHERE expires < ?').run(Date.now());
    db.prepare('INSERT INTO admin_sessions (hash, user_id, expires) VALUES (?, ?, ?)').run(sha256(t), u.id, Date.now() + SESSION_TTL);
    log(u, 'sign_in');
    send(ctx, 200, { name: u.name, email: u.email }, {
      'set-cookie': `${COOKIE}=${t}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}${o.secureCookie ? '; Secure' : ''}`,
    });
  });
  r.on('POST', '/admin/api/logout', (ctx) => {
    const t = cookie(ctx, COOKIE);
    if (t) db.prepare('DELETE FROM admin_sessions WHERE hash = ?').run(sha256(t));
    send(ctx, 204, undefined, { 'set-cookie': `${COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0${o.secureCookie ? '; Secure' : ''}` });
  });
  r.on('GET', '/admin/api/me', (ctx) => {
    const a = admin(ctx);
    const org = db.prepare('SELECT name FROM orgs WHERE id = ?').get(a.org_id) as { name: string };
    send(ctx, 200, { ...a, org_name: org.name });
  });

  // ---- overview ----
  r.on('GET', '/admin/api/overview', (ctx) => {
    const a = admin(ctx);
    const n = (sql: string, ...p: (string | number)[]) => (db.prepare(sql).get(...p) as { n: number }).n;
    const day = Date.now() - 86_400_000;
    send(ctx, 200, {
      devices: n('SELECT COUNT(*) AS n FROM devices WHERE org_id = ? AND revoked = 0', a.org_id),
      devices_seen_24h: n('SELECT COUNT(*) AS n FROM devices WHERE org_id = ? AND revoked = 0 AND last_seen > ?', a.org_id, day),
      users: n('SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND disabled = 0', a.org_id),
      pending_wipes: n('SELECT COUNT(*) AS n FROM wipe_requests WHERE org_id = ? AND approved_by IS NULL AND cancelled = 0', a.org_id),
      failed_updates_24h: n(`SELECT COUNT(*) AS n FROM update_results r JOIN devices d ON d.id = r.device_id WHERE d.org_id = ? AND r.at > ?
        AND json_extract(r.body, '$.result') <> 'success'`, a.org_id, day),
      policy_version: (db.prepare('SELECT version FROM policies WHERE org_id = ?').get(a.org_id) as { version: number } | undefined)?.version ?? 0,
    });
  });

  // ---- devices ----
  r.on('GET', '/admin/api/devices', (ctx) => {
    const a = admin(ctx);
    const rows = db.prepare(`SELECT d.id, d.hostname, d.arch, d.tpm_backed, d.revoked, d.enrolled_at, d.last_seen, d.heartbeat,
      (SELECT COUNT(*) FROM commands c WHERE c.device_id = d.id AND c.state IN ('pending','received','started') AND c.expires > ?) AS pending
      FROM devices d WHERE d.org_id = ? ORDER BY d.revoked, d.hostname`).all(Date.now(), a.org_id) as Record<string, unknown>[];
    send(ctx, 200, { items: rows.map(({ heartbeat, ...d }) => {
      const hb = json<Record<string, unknown>>(heartbeat as string | null) ?? {};
      return { ...d, tpm_backed: !!d.tpm_backed, revoked: !!d.revoked, os_version: hb.os_version ?? null, policy_version: hb.policy_version ?? null, update_status: hb.update_status ?? null, encrypted: (hb.observed as { encrypted?: boolean } | undefined)?.encrypted ?? null };
    }) });
  });
  r.on('GET', '/admin/api/devices/{id}', (ctx) => {
    const a = admin(ctx);
    device(a, ctx.params.id);
    const d = db.prepare('SELECT id, hostname, arch, tpm_backed, revoked, enrolled_at, last_seen, heartbeat FROM devices WHERE id = ?').get(ctx.params.id) as Record<string, unknown>;
    const commands = (db.prepare('SELECT id, envelope, state, reason, updated FROM commands WHERE device_id = ? ORDER BY rowid DESC LIMIT 50').all(ctx.params.id) as { id: string; envelope: string; state: string; reason: string | null; updated: number }[])
      .map((c) => { const e = json<{ command: string; issued_at: string; expires_at: string }>(c.envelope); return { id: c.id, command: e.command, issued_at: e.issued_at, expires_at: e.expires_at, state: c.state, reason: c.reason, updated: c.updated }; });
    const inv = db.prepare('SELECT body, at FROM inventory WHERE device_id = ?').get(ctx.params.id) as { body: string; at: number } | undefined;
    const invBody = json<{ hardware?: unknown; software?: unknown[] }>(inv?.body ?? null);
    const updates = (db.prepare('SELECT body, at FROM update_results WHERE device_id = ? ORDER BY id DESC LIMIT 20').all(ctx.params.id) as { body: string; at: number }[])
      .map((u) => ({ ...json<Record<string, unknown>>(u.body), at: u.at }));
    send(ctx, 200, {
      ...d, tpm_backed: !!d.tpm_backed, revoked: !!d.revoked, heartbeat: json(d.heartbeat as string | null), commands, updates,
      inventory: inv ? { at: inv.at, hardware: invBody?.hardware ?? null, software_count: invBody?.software?.length ?? 0 } : null,
      break_glass_escrowed: !!db.prepare('SELECT 1 FROM break_glass WHERE device_id = ?').get(ctx.params.id),
    });
  });
  r.on('POST', '/admin/api/devices/{id}/commands', async (ctx) => {
    const a = admin(ctx);
    const d = device(a, ctx.params.id);
    if (d.revoked) throw new HttpError(409, 'DEVICE_REVOKED', 'device is revoked');
    const b = await body(ctx);
    const command = String(b.command ?? '');
    if (!ROUTINE.has(command)) throw invalid('command', command === 'RemoteWipe' ? 'use a wipe request (needs a second admin)' : 'not an allowed command');
    const args: Record<string, unknown> = {};
    if (command === 'InstallApprovedApplication') {
      const id = String((b.args as Record<string, unknown> | undefined)?.catalog_id ?? '');
      if (!db.prepare('SELECT 1 FROM catalog WHERE id = ?').get(id)) throw invalid('args.catalog_id', 'not in the catalog');
      args.catalog_id = id;
    }
    if (command === 'CollectApprovedDiagnostics') {
      const p = String((b.args as Record<string, unknown> | undefined)?.bundle_profile ?? 'basic');
      if (!DIAG_PROFILES.has(p)) throw invalid('args.bundle_profile');
      args.bundle_profile = p;
    }
    const id = issueCommand(db, d.id, command, args);
    log(a, 'command', { device_id: d.id, command, command_id: id });
    send(ctx, 201, { command_id: id });
  });
  r.on('POST', '/admin/api/devices/{id}/revoke', (ctx) => {
    const a = admin(ctx);
    const d = device(a, ctx.params.id);
    revokeDevice(db, d.id);
    log(a, 'device_revoked', { device_id: d.id, hostname: d.hostname });
    send(ctx, 204);
  });

  // ---- wipes (two-person rule) ----
  r.on('GET', '/admin/api/wipes', (ctx) => {
    const a = admin(ctx);
    send(ctx, 200, { items: db.prepare(`SELECT w.id, w.device_id, d.hostname, w.scope, w.reason, w.requested_at, w.approved_at, w.command_id, w.cancelled,
      ru.name AS requested_by, au.name AS approved_by, w.requested_by = ? AS mine
      FROM wipe_requests w JOIN devices d ON d.id = w.device_id JOIN users ru ON ru.id = w.requested_by LEFT JOIN users au ON au.id = w.approved_by
      WHERE w.org_id = ? ORDER BY w.requested_at DESC LIMIT 100`).all(a.id, a.org_id) });
  });
  r.on('POST', '/admin/api/wipes', async (ctx) => {
    const a = admin(ctx);
    const b = await body(ctx);
    const d = device(a, String(b.device_id ?? ''));
    if (d.revoked) throw new HttpError(409, 'DEVICE_REVOKED', 'device is revoked');
    const scope = b.scope;
    if (scope !== 'worksuite_data' && scope !== 'full_device') throw invalid('scope', 'worksuite_data or full_device');
    const reason = String(b.reason ?? '').trim();
    if (reason.length < 5 || reason.length > 500) throw invalid('reason', '5 to 500 characters');
    reauth(ctx, a, b, d.hostname);
    const id = randomUUID();
    db.prepare('INSERT INTO wipe_requests (id, org_id, device_id, scope, reason, requested_by, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, a.org_id, d.id, scope, reason, a.id, Date.now());
    log(a, 'wipe_requested', { wipe_id: id, device_id: d.id, scope });
    send(ctx, 201, { id });
  });
  r.on('POST', '/admin/api/wipes/{id}/approve', async (ctx) => {
    const a = admin(ctx);
    const b = await body(ctx);
    const pending = db.prepare('SELECT d.hostname FROM wipe_requests w JOIN devices d ON d.id = w.device_id WHERE w.id = ? AND w.org_id = ?').get(ctx.params.id, a.org_id) as { hostname: string } | undefined;
    if (!pending) throw new HttpError(404, 'NOT_FOUND', 'no such wipe request');
    reauth(ctx, a, b, pending.hostname);
    const out = tx(db, () => {
      const w = db.prepare('SELECT id, device_id, scope, requested_by, approved_by, cancelled FROM wipe_requests WHERE id = ? AND org_id = ?').get(ctx.params.id, a.org_id) as
        { id: string; device_id: string; scope: string; requested_by: number; approved_by: number | null; cancelled: number } | undefined;
      if (!w) throw new HttpError(404, 'NOT_FOUND', 'no such wipe request');
      if (w.approved_by || w.cancelled) throw new HttpError(409, 'CONFLICT', 'already decided');
      if (w.requested_by === a.id) throw new HttpError(403, 'PERMISSION_DENIED', 'a different administrator must approve a wipe');
      const commandId = issueCommand(db, w.device_id, 'RemoteWipe', { scope: w.scope, approval_id: w.id }, 30 * 24);
      db.prepare('UPDATE wipe_requests SET approved_by = ?, approved_at = ?, command_id = ? WHERE id = ?').run(a.id, Date.now(), commandId, w.id);
      return { command_id: commandId, device_id: w.device_id };
    });
    log(a, 'wipe_approved', { wipe_id: ctx.params.id, ...out });
    send(ctx, 200, out);
  });
  r.on('POST', '/admin/api/wipes/{id}/cancel', (ctx) => {
    const a = admin(ctx);
    const res = db.prepare('UPDATE wipe_requests SET cancelled = 1 WHERE id = ? AND org_id = ? AND approved_by IS NULL AND cancelled = 0').run(ctx.params.id, a.org_id);
    if (!res.changes) throw new HttpError(409, 'CONFLICT', 'not pending');
    log(a, 'wipe_cancelled', { wipe_id: ctx.params.id });
    send(ctx, 204);
  });

  // ---- users ----
  r.on('GET', '/admin/api/users', (ctx) => {
    const a = admin(ctx);
    send(ctx, 200, { items: (db.prepare('SELECT id, email, name, role, disabled FROM users WHERE org_id = ? ORDER BY name').all(a.org_id) as Record<string, unknown>[])
      .map((u) => ({ ...u, disabled: !!u.disabled })) });
  });
  r.on('POST', '/admin/api/users', async (ctx) => {
    const a = admin(ctx);
    const b = await body(ctx);
    const role = b.role === 'admin' ? 'admin' : 'user';
    let id: number;
    try { id = addUser(db, a.org_id, String(b.email ?? ''), String(b.name ?? '').trim() || String(b.email ?? ''), String(b.password ?? ''), role); }
    catch (e) {
      const m = String((e as Error).message);
      throw new HttpError(400, 'VALIDATION', m.includes('UNIQUE') ? 'a user with this email already exists' : m);
    }
    log(a, 'user_added', { user_id: id, email: b.email, role });
    send(ctx, 201, { id });
  });
  const setDisabled = (disabled: 0 | 1) => (ctx: Ctx) => {
    const a = admin(ctx);
    const id = Number(ctx.params.id);
    if (id === a.id) throw new HttpError(409, 'CONFLICT', 'you cannot disable your own account');
    const res = db.prepare('UPDATE users SET disabled = ? WHERE id = ? AND org_id = ?').run(disabled, id, a.org_id);
    if (!res.changes) throw new HttpError(404, 'NOT_FOUND', 'no such user');
    if (disabled) {
      db.prepare('UPDATE tokens SET revoked = 1 WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(id);
    }
    log(a, disabled ? 'user_disabled' : 'user_enabled', { user_id: id });
    send(ctx, 204);
  };
  r.on('POST', '/admin/api/users/{id}/disable', setDisabled(1));
  r.on('POST', '/admin/api/users/{id}/enable', setDisabled(0));

  // ---- enrollment ----
  r.on('POST', '/admin/api/enrollment-tokens', async (ctx) => {
    const a = admin(ctx);
    const b = await body(ctx);
    const hours = Number(b.hours ?? 24), uses = Number(b.uses ?? 1);
    if (!Number.isInteger(hours) || hours < 1 || hours > 720) throw invalid('hours', '1 to 720');
    if (!Number.isInteger(uses) || uses < 1 || uses > 1000) throw invalid('uses', '1 to 1000');
    const token = createEnrollmentToken(db, a.org_id, { hours, uses });
    log(a, 'enrollment_token_created', { hours, uses });
    send(ctx, 201, { token, expires_at: new Date(Date.now() + hours * 3_600_000).toISOString(), uses });
  });

  // ---- policy ----
  r.on('GET', '/admin/api/policy', (ctx) => {
    const a = admin(ctx);
    const row = db.prepare('SELECT version, body FROM policies WHERE org_id = ?').get(a.org_id) as { version: number; body: string } | undefined;
    send(ctx, 200, { version: row?.version ?? 0, policy: json(row?.body ?? null) ?? {} });
  });
  r.on('PUT', '/admin/api/policy', async (ctx) => {
    const a = admin(ctx);
    const p = validatePolicy((await body(ctx)).policy);
    const version = setPolicy(db, a.org_id, p);
    // Devices pick it up on their hourly refresh; nudge the active ones now.
    const ids = db.prepare('SELECT id FROM devices WHERE org_id = ? AND revoked = 0').all(a.org_id) as { id: string }[];
    for (const d of ids) issueCommand(db, d.id, 'RefreshPolicy', {}, 24);
    log(a, 'policy_set', { version, devices_notified: ids.length });
    send(ctx, 200, { version, devices_notified: ids.length });
  });

  // ---- catalog (global in this single-organization MVP) ----
  r.on('GET', '/admin/api/catalog', (ctx) => {
    admin(ctx);
    send(ctx, 200, { items: (db.prepare('SELECT item FROM catalog ORDER BY id').all() as { item: string }[]).map((c) => json(c.item)) });
  });
  r.on('PUT', '/admin/api/catalog/{id}', async (ctx) => {
    const a = admin(ctx);
    const b = await body(ctx);
    const id = ctx.params.id;
    const source = b.source;
    if (source !== 'apt' && source !== 'flatpak' && source !== 'appimage') throw invalid('source', 'apt, flatpak or appimage');
    if (!id.startsWith(`${source}:`) || !/^[A-Za-z0-9._:-]{3,200}$/.test(id)) throw invalid('id', `must look like ${source}:<name>`);
    const name = String(b.name ?? '').trim();
    if (!name || name.length > 100) throw invalid('name');
    const arches = Array.isArray(b.arches) ? b.arches.filter((x) => x === 'amd64' || x === 'arm64') : [];
    if (!arches.length) throw invalid('arches', 'amd64 and/or arm64');
    if (source === 'appimage' && !/^[0-9a-f]{64}$/.test(String(b.sha256 ?? ''))) throw invalid('sha256', 'AppImages need a sha256');
    const text = (k: string, max: number) => (typeof b[k] === 'string' && (b[k] as string).trim() ? { [k]: (b[k] as string).trim().slice(0, max) } : {});
    const item = { id, source, name, arches, required: b.required === true, blocked: b.blocked === true, ...(source === 'appimage' ? { sha256: b.sha256 } : {}),
      ...text('category', 40), ...text('summary', 200), ...text('publisher', 100) };
    putCatalogItem(db, item);
    log(a, 'catalog_put', { id });
    send(ctx, 200, item);
  });
  r.on('DELETE', '/admin/api/catalog/{id}', (ctx) => {
    const a = admin(ctx);
    db.prepare('DELETE FROM catalog WHERE id = ?').run(ctx.params.id);
    log(a, 'catalog_deleted', { id: ctx.params.id });
    send(ctx, 204);
  });

  // ---- releases (read-only here: publishing signs with the release key, via the CLI) ----
  r.on('GET', '/admin/api/releases', (ctx) => {
    admin(ctx);
    send(ctx, 200, { items: (db.prepare('SELECT manifest FROM releases ORDER BY ring, arch').all() as { manifest: string }[])
      .map((m) => { const { signature: _s, ...rest } = json<Record<string, unknown>>(m.manifest); return rest; }) });
  });

  // Release management (WSOS-AUP-013): admins with desktop.releases.manage only. Every change re-signs the manifest.
  const releaseManager = (ctx: Ctx): Admin => {
    const a = admin(ctx);
    const row = db.prepare('SELECT permissions FROM users WHERE id = ?').get(a.id) as { permissions: string };
    if (!(json<string[]>(row.permissions) ?? []).includes(RELEASE_PERMISSION)) throw new HttpError(403, 'PERMISSION_DENIED', `requires ${RELEASE_PERMISSION}`);
    return a;
  };
  const releaseAction = (fn: (a: Admin, b: Record<string, unknown>, ctx: Ctx) => unknown, action: string) => async (ctx: Ctx) => {
    const a = releaseManager(ctx);
    const b = await body(ctx);
    let out: unknown;
    try { out = fn(a, b, ctx); } catch (e) { throw invalid('release', (e as Error).message); }
    log(a, action, { ...ctx.params, ...b });
    send(ctx, 200, { items: (out as Record<string, unknown>[]).map(({ signature: _s, ...rest }) => rest) });
  };
  r.on('POST', '/admin/api/releases/publish', releaseAction((a, b) => {
    const m = b.manifest as Record<string, unknown>;
    const signed = publishRelease(db, m) as Record<string, unknown>;
    logRelease(db, a.email, 'release_published', { release_id: signed.release_id, ring: signed.ring, arch: signed.arch });
    return [signed];
  }, 'release_published'));
  r.on('POST', '/admin/api/releases/{ring}/{op}', releaseAction((a, b, ctx) => {
    const state = ({ pause: 'paused', resume: 'active', pull: 'pulled' } as const)[ctx.params.op as 'pause' | 'resume' | 'pull'];
    if (!state) throw new Error('operation must be pause, resume or pull');
    return setReleaseState(db, ctx.params.ring, b.arch as string | undefined, state, a.email);
  }, 'release_state'));
  r.on('POST', '/admin/api/releases/promote', releaseAction((a, b) =>
    promoteRelease(db, String(b.from ?? ''), String(b.to ?? ''), b.arch as string | undefined, { rollout_percent: b.rollout_percent as number | undefined }, a.email), 'release_promoted'));
  r.on('POST', '/admin/api/releases/emergency', releaseAction((a, b) =>
    emergencyRelease(db, (b.manifest ?? {}) as Record<string, unknown>, b.arch as string | undefined, a.email), 'release_emergency'));

  // ---- activity ----
  r.on('GET', '/admin/api/log', (ctx) => {
    const a = admin(ctx);
    send(ctx, 200, { items: (db.prepare(`SELECT l.action, l.detail, l.at, u.name FROM admin_log l JOIN users u ON u.id = l.user_id
      WHERE l.org_id = ? ORDER BY l.id DESC LIMIT 200`).all(a.org_id) as { action: string; detail: string; at: number; name: string }[])
      .map((l) => ({ ...l, detail: json(l.detail) })) });
  });
}
