// Admin console API (/admin/api/*) and static UI (/admin). Admins are users with role 'admin'; everything is scoped
// to the admin's organization. Session: random token in an HttpOnly, Secure, SameSite=Strict cookie (stored hashed,
// 8 h). CSRF: every API call must carry `X-WS-Admin: 1`, which a cross-site form cannot send and which CORS
// (never enabled here) would preflight. Remote wipe needs a second admin's approval (WSOS-WIPE-002).
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { issueCommand, revokeDevice, addUser, createEnrollmentToken, putCatalogItem, publishRelease, setReleaseState, promoteRelease, emergencyRelease, logRelease, RELEASE_PERMISSION } from './admin.ts';
import { secret, sha256, tx } from './db.ts';
import { HttpError, invalid, send, type Ctx, type Router } from './http.ts';
import { checkPassword } from './oauth.ts';
import { approvalsNeeded, checkApproval, requirePermission } from './approvals.ts';
import { APP_CSS, APP_HTML, APP_JS } from './console-ui.ts';
import { redactKiosk, type KioskPolicy } from './kiosk.ts';
import { setValidatedPolicy, validatePolicy } from './policy.ts';
import { qrMatrix } from './qr.ts';
import { Throttle } from './throttle.ts';
import { decideRequest, deploy, deployments, deviceSoftware, inventorySummary, reconcileRequired, validateAssignment, validDepartment } from './software.ts';
import { gatewayPeers, getVpnSettings, removePeer, setVpnSettings, validateVpnSettings } from './vpn.ts';

const SESSION_TTL = 8 * 3_600_000;
const COOKIE = 'ws_admin';
const ROUTINE = new Set(['RefreshPolicy', 'RequestLock', 'RebootDuringWindow', 'ScheduleUpdate', 'InstallApprovedApplication', 'RemoveApplication', 'CollectApprovedDiagnostics']);
/** CollectApprovedDiagnostics profiles: exactly what the device agent implements (services/device-agent/src/diagnostics.ts). */
export const DIAG_PROFILES = new Set(['basic', 'session', 'network', 'update']);

interface Admin { id: number; org_id: number; email: string; name: string }

// Re-exported: the console and the CLI (policy-set) share one validator, src/policy.ts.
export { validatePolicy };

const json = <T>(s: string | null): T => (s ? JSON.parse(s) : null) as T;

function cookie(ctx: Ctx, name: string): string | undefined {
  for (const part of (ctx.header('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

/** Login throttling per client address: 10 failures per 15 minutes. */
const failures = new Throttle();
const throttled = (addr: string) => failures.blocked([addr]);

/** Pagination from ?page=&per_page= (1-based page, 10–100 rows, default 25). */
export function pageOf(query: URLSearchParams): { page: number; per_page: number; offset: number } {
  const n = (k: string, d: number) => { const v = Number(query.get(k) ?? d); return Number.isInteger(v) ? v : d; };
  const per_page = Math.min(100, Math.max(10, n('per_page', 25)));
  const page = Math.max(1, Math.min(100_000, n('page', 1)));
  return { page, per_page, offset: (page - 1) * per_page };
}

/** WSOS-INS-006: the link the console shows as a QR code. The token is in the fragment, which browsers never send to a
 *  server, so a phone that opens the link does not leave the token in a web server log. */
export function enrollmentLink(publicUrl: string, token: string): string {
  return `${new URL('enroll', publicUrl).toString()}#token=${encodeURIComponent(token)}`;
}

export function consoleRoutes(r: Router, db: DatabaseSync, o: { secureCookie: boolean; publicUrl?: string }) {
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
      failures.fail([addr]);
      log(a, 'reauth_failed', { action: 'wipe' });
      throw new HttpError(401, 'REAUTH_REQUIRED', 'enter your administrator password to confirm');
    }
    if (typeof b.confirm_name !== 'string' || b.confirm_name.trim() !== hostname) throw invalid('confirm_name', 'type the device name exactly to confirm');
  };
  const permissionsOf = (a: Admin): string[] =>
    json<string[]>((db.prepare('SELECT permissions FROM users WHERE id = ?').get(a.id) as { permissions: string }).permissions) ?? [];
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
      failures.fail([addr]);
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
    const rows = db.prepare(`SELECT d.id, d.hostname, d.arch, d.tpm_backed, d.revoked, d.enrolled_at, d.last_seen, d.heartbeat, d.ownership, d.wiped_at, d.department,
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
    const d = db.prepare('SELECT id, hostname, arch, tpm_backed, revoked, enrolled_at, last_seen, heartbeat, ownership, wiped_at, department FROM devices WHERE id = ?').get(ctx.params.id) as Record<string, unknown>;
    const commands = (db.prepare('SELECT id, envelope, state, reason, updated FROM commands WHERE device_id = ? ORDER BY rowid DESC LIMIT 50').all(ctx.params.id) as { id: string; envelope: string; state: string; reason: string | null; updated: number }[])
      .map((c) => { const e = json<{ command: string; issued_at: string; expires_at: string }>(c.envelope); return { id: c.id, command: e.command, issued_at: e.issued_at, expires_at: e.expires_at, state: c.state, reason: c.reason, updated: c.updated, observed: observedCommand(c.state, e.expires_at, Date.now()) }; });
    const policyRow = db.prepare('SELECT version, body FROM policies WHERE org_id = ?').get(a.org_id) as { version: number; body: string } | undefined;
    const requestedPolicy = policyRow?.version ?? null;
    const kiosk = json<{ kiosk?: KioskPolicy }>(policyRow?.body ?? null)?.kiosk;
    const inv = db.prepare('SELECT body, at FROM inventory WHERE device_id = ?').get(ctx.params.id) as { body: string; at: number } | undefined;
    const invBody = json<{ hardware?: unknown; software?: unknown[] }>(inv?.body ?? null);
    const updates = (db.prepare('SELECT body, at FROM update_results WHERE device_id = ? ORDER BY id DESC LIMIT 20').all(ctx.params.id) as { body: string; at: number }[])
      .map((u) => ({ ...json<Record<string, unknown>>(u.body), at: u.at }));
    send(ctx, 200, {
      ...d, tpm_backed: !!d.tpm_backed, revoked: !!d.revoked, heartbeat: json(d.heartbeat as string | null), commands, updates,
      kiosk: kiosk?.enabled && kiosk.devices?.includes(ctx.params.id) ? { user: kiosk.user, app: kiosk.app } : null,
      policy: observedPolicy(requestedPolicy, json<{ policy_version?: unknown }>(d.heartbeat as string | null)?.policy_version),
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
    if (command === 'InstallApprovedApplication' || command === 'RemoveApplication') {
      const id = String((b.args as Record<string, unknown> | undefined)?.catalog_id ?? '');
      if (!db.prepare('SELECT 1 FROM catalog WHERE id = ?').get(id)) throw invalid('args.catalog_id', 'not in the catalog');
      if (id.startsWith('appimage:')) throw invalid('args.catalog_id', 'AppImages are imported by the user, not deployed');
      // Through the deployment path so the app is allowlisted in the signed policy the device checks.
      const cid = deploy(db, a.org_id, d.id, command, id);
      if (!cid) throw new HttpError(409, 'ALREADY_PENDING', 'this app already has an open deployment on the device');
      log(a, 'command', { device_id: d.id, command, command_id: cid, catalog_id: id });
      return send(ctx, 201, { command_id: cid });
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

  // Ownership drives the CoreApprovalEngine waiver for personal devices (WSOS-WIPE-001).
  r.on('PUT', '/admin/api/devices/{id}/ownership', async (ctx) => {
    const a = admin(ctx);
    const d = device(a, ctx.params.id);
    const b = await body(ctx);
    if (b.ownership !== 'corporate' && b.ownership !== 'personal') throw invalid('ownership', 'corporate or personal');
    db.prepare('UPDATE devices SET ownership = ? WHERE id = ?').run(b.ownership, d.id);
    log(a, 'device_ownership', { device_id: d.id, ownership: b.ownership });
    send(ctx, 204);
  });

  // ---- wipes (two-person rule) ----
  r.on('GET', '/admin/api/wipes', (ctx) => {
    const a = admin(ctx);
    send(ctx, 200, { items: db.prepare(`SELECT w.id, w.device_id, d.hostname, w.scope, w.reason, w.requested_at, w.approved_at, w.command_id, w.cancelled, w.result, w.result_at,
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
    requirePermission('RemoteWipe', permissionsOf(a));
    reauth(ctx, a, b, d.hostname);
    const id = randomUUID();
    const own = db.prepare('SELECT ownership FROM devices WHERE id = ?').get(d.id) as { ownership: string };
    const pol = db.prepare('SELECT body FROM policies WHERE org_id = ?').get(a.org_id) as { body: string } | undefined;
    const needed = approvalsNeeded('RemoteWipe', { ownership: own.ownership, policy: json<Record<string, unknown>>(pol?.body ?? '{}') ?? {} });
    const out = tx(db, () => {
      db.prepare('INSERT INTO wipe_requests (id, org_id, device_id, scope, reason, requested_by, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, a.org_id, d.id, scope, reason, a.id, Date.now());
      if (needed > 0) return { id };
      // Policy waiver: the request is its own approval.
      const commandId = issueCommand(db, d.id, 'RemoteWipe', { scope, approval_id: id }, 30 * 24);
      db.prepare('UPDATE wipe_requests SET approved_by = ?, approved_at = ?, command_id = ? WHERE id = ?').run(a.id, Date.now(), commandId, id);
      return { id, command_id: commandId, waived_second_approver: true };
    });
    log(a, 'wipe_requested', { wipe_id: id, device_id: d.id, scope, ...(needed ? {} : { waived_second_approver: true, command_id: out.command_id }) });
    send(ctx, 201, out);
  });
  r.on('POST', '/admin/api/wipes/{id}/approve', async (ctx) => {
    const a = admin(ctx);
    const b = await body(ctx);
    const pending = db.prepare('SELECT d.hostname FROM wipe_requests w JOIN devices d ON d.id = w.device_id WHERE w.id = ? AND w.org_id = ?').get(ctx.params.id, a.org_id) as { hostname: string } | undefined;
    if (!pending) throw new HttpError(404, 'NOT_FOUND', 'no such wipe request');
    requirePermission('RemoteWipe', permissionsOf(a));
    reauth(ctx, a, b, pending.hostname);
    const out = tx(db, () => {
      const w = db.prepare('SELECT id, device_id, scope, requested_by, approved_by, cancelled FROM wipe_requests WHERE id = ? AND org_id = ?').get(ctx.params.id, a.org_id) as
        { id: string; device_id: string; scope: string; requested_by: number; approved_by: number | null; cancelled: number } | undefined;
      if (!w) throw new HttpError(404, 'NOT_FOUND', 'no such wipe request');
      checkApproval('RemoteWipe', { requested_by: w.requested_by, decided: !!(w.approved_by || w.cancelled) }, { id: a.id, permissions: permissionsOf(a) });
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
    send(ctx, 200, { items: (db.prepare('SELECT id, email, name, role, disabled, department FROM users WHERE org_id = ? ORDER BY name').all(a.org_id) as Record<string, unknown>[])
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
    const link = o.publicUrl ? enrollmentLink(o.publicUrl, token) : null;
    send(ctx, 201, { token, expires_at: new Date(Date.now() + hours * 3_600_000).toISOString(), uses, server: o.publicUrl ?? null, link, qr: link ? qrMatrix(link) : null }, { 'cache-control': 'no-store' });
  });

  // ---- policy ----
  r.on('GET', '/admin/api/policy', (ctx) => {
    const a = admin(ctx);
    const row = db.prepare('SELECT version, body FROM policies WHERE org_id = ?').get(a.org_id) as { version: number; body: string } | undefined;
    const policy = json<Record<string, unknown>>(row?.body ?? null) ?? {};
    if (policy.kiosk) policy.kiosk = redactKiosk(policy.kiosk as KioskPolicy);
    send(ctx, 200, { version: row?.version ?? 0, policy });
  });
  r.on('PUT', '/admin/api/policy', async (ctx) => {
    const a = admin(ctx);
    const version = setValidatedPolicy(db, a.org_id, (await body(ctx)).policy);
    // Devices pick it up on their hourly refresh; nudge the active ones now.
    const ids = db.prepare('SELECT id FROM devices WHERE org_id = ? AND revoked = 0').all(a.org_id) as { id: string }[];
    for (const d of ids) issueCommand(db, d.id, 'RefreshPolicy', {}, 24);
    log(a, 'policy_set', { version, devices_notified: ids.length });
    send(ctx, 200, { version, devices_notified: ids.length });
  });

  // ---- managed VPN (WSOS-INT-001) ----
  r.on('GET', '/admin/api/vpn', (ctx) => {
    const a = admin(ctx);
    const cur = getVpnSettings(db, a.org_id);
    send(ctx, 200, { version: cur?.version ?? 0, vpn: cur?.settings ?? null, peers: gatewayPeers(db, a.org_id) });
  });
  r.on('PUT', '/admin/api/vpn', async (ctx) => {
    const a = admin(ctx);
    const b = await body(ctx);
    const s = b.vpn === null ? null : validateVpnSettings(b.vpn);
    const version = setVpnSettings(db, a.org_id, s);
    const ids = db.prepare('SELECT id FROM devices WHERE org_id = ? AND revoked = 0').all(a.org_id) as { id: string }[];
    for (const d of ids) issueCommand(db, d.id, 'RefreshPolicy', {}, 24);   // the agent refreshes VPN with policy
    log(a, s ? 'vpn_set' : 'vpn_removed', { version, devices_notified: ids.length });
    send(ctx, 200, { version, devices_notified: ids.length });
  });
  // Rotation: forget the device's key; it generates a new keypair on its next refresh and registers the public half.
  r.on('POST', '/admin/api/vpn/peers/{id}/rotate', (ctx) => {
    const a = admin(ctx);
    const d = device(a, ctx.params.id);
    removePeer(db, d.id);
    issueCommand(db, d.id, 'RefreshPolicy', {}, 24);
    log(a, 'vpn_key_rotate', { device_id: d.id });
    send(ctx, 204);
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
    const assign = validateAssignment(b.assign);
    const item = { id, source, name, arches, required: b.required === true, blocked: b.blocked === true, ...(source === 'appimage' ? { sha256: b.sha256 } : {}),
      ...text('category', 40), ...text('summary', 200), ...text('publisher', 100), ...(assign ? { assign } : {}) };
    putCatalogItem(db, item);
    log(a, 'catalog_put', { id });
    // Required apps deploy to the devices they are assigned to straight away.
    const deployed = item.required && !item.blocked ? reconcileRequired(db, a.org_id).filter((x) => x.catalog_id === id).length : 0;
    send(ctx, 200, { ...item, deployed });
  });
  r.on('DELETE', '/admin/api/catalog/{id}', (ctx) => {
    const a = admin(ctx);
    db.prepare('DELETE FROM catalog WHERE id = ?').run(ctx.params.id);
    log(a, 'catalog_deleted', { id: ctx.params.id });
    send(ctx, 204);
  });

  // ---- Software Management (Device Management › Software Management) ----
  r.on('GET', '/admin/api/software/inventory', (ctx) => {
    const a = admin(ctx);
    send(ctx, 200, inventorySummary(db, a.org_id));
  });
  r.on('GET', '/admin/api/software/deployments', (ctx) => {
    const a = admin(ctx);
    send(ctx, 200, { items: deployments(db, a.org_id) });
  });
  r.on('GET', '/admin/api/devices/{id}/software', (ctx) => {
    const a = admin(ctx);
    device(a, ctx.params.id);
    send(ctx, 200, deviceSoftware(db, ctx.params.id));
  });
  /** Remote install or uninstall of one catalog app on several devices at once. */
  r.on('POST', '/admin/api/software/deploy', async (ctx) => {
    const a = admin(ctx);
    const b = await body(ctx);
    const catalogId = String(b.catalog_id ?? '');
    const action = b.action === 'uninstall' ? 'RemoveApplication' : b.action === 'install' ? 'InstallApprovedApplication' : null;
    if (!action) throw invalid('action', 'install or uninstall');
    const row = db.prepare('SELECT item FROM catalog WHERE id = ?').get(catalogId) as { item: string } | undefined;
    if (!row) throw invalid('catalog_id', 'not in the catalog');
    if (catalogId.startsWith('appimage:')) throw invalid('catalog_id', 'AppImages are imported by the user, not deployed');
    if (action === 'InstallApprovedApplication' && json<{ blocked?: boolean }>(row.item).blocked) throw invalid('catalog_id', 'the app is blocked');
    const ids = Array.isArray(b.devices) ? [...new Set(b.devices.map(String))].slice(0, 1000) : [];
    if (!ids.length) throw invalid('devices', 'at least one device');
    const results = ids.map((id) => {
      const d = db.prepare('SELECT id, revoked, arch FROM devices WHERE id = ? AND org_id = ?').get(id, a.org_id) as { id: string; revoked: number; arch: string } | undefined;
      if (!d) return { device_id: id, error: 'not_found' };
      if (d.revoked) return { device_id: id, error: 'revoked' };
      if (action === 'InstallApprovedApplication' && !json<{ arches: string[] }>(row.item).arches.includes(d.arch)) return { device_id: id, error: 'arch' };
      const cid = deploy(db, a.org_id, d.id, action, catalogId);
      return cid ? { device_id: id, command_id: cid } : { device_id: id, error: 'already_pending' };
    });
    log(a, action === 'RemoveApplication' ? 'software_uninstall' : 'software_install', { catalog_id: catalogId, devices: results.filter((x) => 'command_id' in x).length });
    send(ctx, 201, { results });
  });
  r.on('GET', '/admin/api/software/requests', (ctx) => {
    const a = admin(ctx);
    const state = ctx.url.searchParams.get('state');
    if (state && !['pending', 'approved', 'rejected'].includes(state)) throw invalid('state');
    const rows = db.prepare(`SELECT r.id, r.device_id, d.hostname, r.catalog_id, r.username, r.reason, r.state, r.note, r.at, r.decided_at, r.command_id,
      (SELECT c.state FROM commands c WHERE c.id = r.command_id) AS install_state
      FROM software_requests r LEFT JOIN devices d ON d.id = r.device_id WHERE r.org_id = ? ${state ? 'AND r.state = ?' : ''} ORDER BY r.state = 'pending' DESC, r.at DESC LIMIT 500`)
      .all(...(state ? [a.org_id, state] : [a.org_id]));
    send(ctx, 200, { items: rows });
  });
  const decide = (approve: boolean) => async (ctx: Ctx) => {
    const a = admin(ctx);
    const b = await ctx.body().catch(() => null) as Record<string, unknown> | null;
    const note = typeof b?.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 300) : null;
    const r = decideRequest(db, a.org_id, ctx.params.id, a.id, approve, note);
    if (!r) throw new HttpError(404, 'NOT_FOUND', 'no such request');
    log(a, approve ? 'software_request_approved' : 'software_request_rejected', { request_id: r.id, catalog_id: r.catalog_id, device_id: r.device_id });
    send(ctx, 200, r);
  };
  r.on('POST', '/admin/api/software/requests/{id}/approve', decide(true));
  r.on('POST', '/admin/api/software/requests/{id}/reject', decide(false));
  // Departments drive department assignments: a device's own, and its signed-in users'.
  r.on('PUT', '/admin/api/devices/{id}/department', async (ctx) => {
    const a = admin(ctx);
    const d = device(a, ctx.params.id);
    const dept = validDepartment((await body(ctx)).department);
    db.prepare('UPDATE devices SET department = ? WHERE id = ?').run(dept, d.id);
    log(a, 'device_department', { device_id: d.id, department: dept });
    reconcileRequired(db, a.org_id, Date.now(), d.id);
    send(ctx, 200, { department: dept });
  });
  r.on('PUT', '/admin/api/users/{id}/department', async (ctx) => {
    const a = admin(ctx);
    const dept = validDepartment((await body(ctx)).department);
    const res = db.prepare('UPDATE users SET department = ? WHERE id = ? AND org_id = ?').run(dept, Number(ctx.params.id), a.org_id);
    if (!res.changes) throw new HttpError(404, 'NOT_FOUND', 'no such user');
    log(a, 'user_department', { user_id: Number(ctx.params.id), department: dept });
    reconcileRequired(db, a.org_id);
    send(ctx, 200, { department: dept });
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

  // ---- problem reports (§11.6-d) ----
  r.on('GET', '/admin/api/problem-reports', (ctx) => {
    const a = admin(ctx);
    const p = pageOf(ctx.url.searchParams);
    const total = (db.prepare('SELECT COUNT(*) AS n FROM problem_reports WHERE org_id = ?').get(a.org_id) as { n: number }).n;
    const rows = db.prepare(`SELECT r.id, r.at, r.body, r.device_id, u.name AS user_name, u.email AS user_email, d.hostname
      FROM problem_reports r JOIN users u ON u.id = r.user_id LEFT JOIN devices d ON d.id = r.device_id AND d.org_id = r.org_id
      WHERE r.org_id = ? ORDER BY r.at DESC, r.id LIMIT ? OFFSET ?`).all(a.org_id, p.per_page, p.offset) as { id: string; at: number; body: string; device_id: string | null; user_name: string; user_email: string; hostname: string | null }[];
    send(ctx, 200, { page: p.page, per_page: p.per_page, total, items: rows.map(({ body: b, ...x }) => {
      const r = json<{ description: string; sections: { id: string; text: string }[] }>(b);
      return { ...x, summary: (r.description ?? '').slice(0, 140), sections: r.sections.map((s) => s.id) };
    }) });
  });
  r.on('GET', '/admin/api/problem-reports/{id}', (ctx) => {
    const a = admin(ctx);
    const row = db.prepare(`SELECT r.id, r.at, r.body, r.device_id, u.name AS user_name, u.email AS user_email, d.hostname
      FROM problem_reports r JOIN users u ON u.id = r.user_id LEFT JOIN devices d ON d.id = r.device_id AND d.org_id = r.org_id
      WHERE r.id = ? AND r.org_id = ?`).get(ctx.params.id, a.org_id) as { id: string; at: number; body: string; device_id: string | null; user_name: string; user_email: string; hostname: string | null } | undefined;
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'no such report');
    const { body: b, ...x } = row;
    log(a, 'problem_report_viewed', { id: row.id });
    send(ctx, 200, { ...x, ...json<{ description: string; sections: { id: string; text: string }[] }>(b) });
  });

  // ---- device package audit (WSOS-SEC-008, forwarded with POST desktop/v1/os/audit) ----
  r.on('GET', '/admin/api/device-audit', (ctx) => {
    const a = admin(ctx);
    const p = pageOf(ctx.url.searchParams);
    const dev = ctx.url.searchParams.get('device') ?? '';
    const type = ctx.url.searchParams.get('type') ?? '';
    if (dev && !/^[A-Za-z0-9_-]{1,64}$/.test(dev)) throw invalid('device');
    if (type && !/^package\.[a-z_]{1,64}$/.test(type)) throw invalid('type');
    const where = `d.org_id = ? AND x.principal = 'device:' || d.id AND x.type LIKE 'package.%'${dev ? ' AND d.id = ?' : ''}${type ? ' AND x.type = ?' : ''}`;
    const args: (string | number)[] = [a.org_id, ...(dev ? [dev] : []), ...(type ? [type] : [])];
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM audit x JOIN devices d ON x.principal = 'device:' || d.id WHERE ${where}`).get(...args) as { n: number }).n;
    const rows = db.prepare(`SELECT x.id, x.type, x.at, x.data, d.id AS device_id, d.hostname FROM audit x JOIN devices d ON x.principal = 'device:' || d.id
      WHERE ${where} ORDER BY x.at DESC, x.id LIMIT ? OFFSET ?`).all(...args, p.per_page, p.offset) as { id: string; type: string; at: string; data: string | null; device_id: string; hostname: string }[];
    const types = (db.prepare(`SELECT DISTINCT x.type FROM audit x JOIN devices d ON x.principal = 'device:' || d.id WHERE d.org_id = ? AND x.type LIKE 'package.%' ORDER BY x.type`).all(a.org_id) as { type: string }[]).map((t) => t.type);
    send(ctx, 200, { page: p.page, per_page: p.per_page, total, types, items: rows.map((x) => ({ ...x, data: json(x.data) })) });
  });

  // ---- activity ----
  r.on('GET', '/admin/api/log', (ctx) => {
    const a = admin(ctx);
    send(ctx, 200, { items: (db.prepare(`SELECT l.action, l.detail, l.at, u.name FROM admin_log l JOIN users u ON u.id = l.user_id
      WHERE l.org_id = ? ORDER BY l.id DESC LIMIT 200`).all(a.org_id) as { action: string; detail: string; at: number; name: string }[])
      .map((l) => ({ ...l, detail: json(l.detail) })) });
  });
}

/** WSOS-MDM-005: what the device has reported about a command, kept apart from the request itself. */
export function observedCommand(state: string, expiresAt: string, now: number): string {
  const expired = Date.parse(expiresAt) <= now;
  switch (state) {
    case 'pending': return expired ? 'expired — never received' : 'not yet received';
    case 'received': return expired ? 'expired — received, not started' : 'received — not yet started';
    case 'started': return 'in progress';
    case 'completed': return 'done';
    case 'failed': return 'failed';
    case 'rejected': return 'rejected by the device';
    default: return state;
  }
}

/** WSOS-MDM-005: requested policy version (server) vs the version the device last reported applying. */
export function observedPolicy(requested: number | null, reported: unknown): { requested_version: number | null; observed_version: number | null; state: 'applied' | 'pending' | 'not_reported' | 'none' } {
  const observed = reported === undefined || reported === null || reported === '' ? null : Number(reported);
  const obs = observed !== null && Number.isFinite(observed) ? observed : null;
  if (requested === null) return { requested_version: null, observed_version: obs, state: 'none' };
  if (obs === null) return { requested_version: requested, observed_version: null, state: 'not_reported' };
  return { requested_version: requested, observed_version: obs, state: obs >= requested ? 'applied' : 'pending' };
}
