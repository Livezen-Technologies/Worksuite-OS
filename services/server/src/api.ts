// desktop/v1 and desktop/v1/os (api-contracts/openapi.yaml). Tenant scoping comes from the authenticated user or
// device, never from the request. Idempotency-Key replays within 24 h return the stored response.
import { createPublicKey, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_WEB_APPS, nextSeq, secret, sha256, tx } from './db.ts';
import { HttpError, invalid, send, type Ctx, type Router } from './http.ts';
import { userFromBearer, type User } from './oauth.ts';
import { activeKey, signFlat } from './signing.ts';
import { licenceFor, revokeDevice } from './admin.ts';
import { issueLoginCode, setNewPassword, verifyDirectoryUser, type DirUserRow } from './identity.ts';
import { deviceVpnConfig, isWgKey, registerPeer, removePeer } from './vpn.ts';

export interface ApiOptions { publicUrl: string; issuer: string; updateHost: string; webUrl: string }

interface Device { id: string; org_id: number; revoked: number }

const DAY = 86_400_000;
const IDEM_TTL = DAY;
const LOCK_TTL = 10 * 60_000;
export const TOMBSTONE_WINDOW = 30 * DAY;
const MODULE_KEY = /^[a-z][a-z0-9_-]{0,63}$/;
const OBJECT_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ARCHES = new Set(['amd64', 'arm64']);
const RINGS = new Set(['development', 'pilot', 'stable']);

const json = <T>(s: string): T => JSON.parse(s) as T;

function deviceFromHeader(db: DatabaseSync, ctx: Ctx, required: true): Device;
function deviceFromHeader(db: DatabaseSync, ctx: Ctx, required: false): Device | undefined;
function deviceFromHeader(db: DatabaseSync, ctx: Ctx, required: boolean): Device | undefined {
  const cred = ctx.header('x-ws-device');
  if (!cred) { if (required) throw new HttpError(403, 'DEVICE_REQUIRED', 'device credential required'); return undefined; }
  const d = db.prepare('SELECT id, org_id, revoked FROM devices WHERE cred_hash = ?').get(sha256(cred)) as Device | undefined;
  if (!d) throw new HttpError(403, 'PERMISSION_DENIED', 'unknown device credential');
  if (d.revoked) throw new HttpError(403, 'DEVICE_REVOKED', 'device revoked');
  db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(Date.now(), d.id);
  return d;
}

/** User endpoints: bearer required; a device credential, when sent, must be valid and in the user's org. */
function userCtx(db: DatabaseSync, ctx: Ctx): { user: User; device?: Device } {
  const user = userFromBearer(db, ctx);
  const device = deviceFromHeader(db, ctx, false);
  if (device && device.org_id !== user.org_id) throw new HttpError(403, 'PERMISSION_DENIED', 'device belongs to another organization');
  const org = db.prepare('SELECT require_device FROM orgs WHERE id = ?').get(user.org_id) as { require_device: number };
  if (org.require_device && !device) throw new HttpError(403, 'DEVICE_REQUIRED', 'this organization requires an enrolled device');
  return { user, device };
}

/** Run once per (principal, Idempotency-Key); replays get the original status and body. */
async function idempotent(db: DatabaseSync, ctx: Ctx, principal: string, key: string | undefined, fn: () => Promise<{ status: number; body?: unknown }>) {
  if (!key || !/^[A-Za-z0-9-]{8,128}$/.test(key)) throw invalid('Idempotency-Key', 'required (UUID)');
  db.prepare('DELETE FROM idempotency WHERE at < ?').run(Date.now() - IDEM_TTL);
  const prev = db.prepare('SELECT status, body FROM idempotency WHERE principal = ? AND key = ?').get(principal, key) as { status: number; body: string | null } | undefined;
  if (prev) return send(ctx, prev.status, prev.body === null ? undefined : JSON.parse(prev.body), { 'idempotent-replay': 'true' });
  const r = await fn();
  if (r.status < 500) {
    db.prepare('INSERT OR IGNORE INTO idempotency (principal, key, status, body, at) VALUES (?, ?, ?, ?, ?)')
      .run(principal, key, r.status, r.body === undefined ? null : JSON.stringify(r.body), Date.now());
  }
  send(ctx, r.status, r.body);
}

const obj = (v: unknown, field = 'body'): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid(field, 'must be an object');
  return v as Record<string, unknown>;
};
const str = (o: Record<string, unknown>, k: string, max = 512): string => {
  const v = o[k];
  if (typeof v !== 'string' || !v || v.length > max) throw invalid(k, 'required string');
  return v;
};

function page<T>(rows: { id: string; item: string }[], limit: number): { items: T[]; next_cursor: string | null } {
  const items = rows.slice(0, limit).map((r) => json<T>(r.item));
  return { items, next_cursor: rows.length > limit ? rows[limit - 1].id : null };
}
const limitOf = (ctx: Ctx) => {
  const l = Number(ctx.url.searchParams.get('limit') ?? 100);
  if (!Number.isInteger(l) || l < 1 || l > 500) throw invalid('limit', '1..500');
  return l;
};

/** Org directory settings (orgs.directory). */
export interface DirectorySettings { type?: string; offline_login_days?: number; password_max_age_days?: number; domain?: string; netbios_domain?: string; upn_suffixes?: string[] }

export function policyFor(db: DatabaseSync, orgId: number) {
  const row = db.prepare('SELECT version, body FROM policies WHERE org_id = ?').get(orgId) as { version: number; body: string } | undefined;
  const body = row ? json<Record<string, unknown>>(row.body) : { update_ring: 'stable', update_mode: 'automatic', usb_storage: 'allow', bluetooth: true };
  return signFlat(activeKey(db), { ...body, version: String(row?.version ?? 0) });
}

/** Purge tombstones past the window; cursors older than the newest purged change get 410 CURSOR_EXPIRED. */
export function purgeTombstones(db: DatabaseSync, now = Date.now()) {
  tx(db, () => {
    const old = db.prepare('SELECT user_id, module, MAX(seq) AS seq FROM records WHERE deleted = 1 AND updated < ? GROUP BY user_id, module').all(now - TOMBSTONE_WINDOW) as
      { user_id: number; module: string; seq: number }[];
    for (const o of old) {
      db.prepare(`INSERT INTO stream_horizon (user_id, module, min_seq) VALUES (?, ?, ?)
        ON CONFLICT(user_id, module) DO UPDATE SET min_seq = MAX(min_seq, excluded.min_seq)`).run(o.user_id, o.module, o.seq);
    }
    db.prepare('DELETE FROM records WHERE deleted = 1 AND updated < ?').run(now - TOMBSTONE_WINDOW);
    db.prepare('DELETE FROM mutations WHERE at < ?').run(now - TOMBSTONE_WINDOW);
  });
}

interface RecordRow { revision: number; deleted: number; data: string | null }

function applyMutation(db: DatabaseSync, userId: number, m: Record<string, unknown>) {
  const mutation_id = m.mutation_id;
  if (typeof mutation_id !== 'string' || !UUID.test(mutation_id)) return { mutation_id: String(mutation_id ?? ''), status: 'rejected', error: { code: 'VALIDATION', message: 'mutation_id must be a UUID', field: 'mutation_id' } };
  const reject = (field: string, message: string) => ({ mutation_id, status: 'rejected', error: { code: 'VALIDATION', message, field } });
  const { module, object_id, operation, base_revision } = m;
  if (typeof module !== 'string' || !MODULE_KEY.test(module)) return reject('module', 'invalid module');
  if (typeof object_id !== 'string' || !OBJECT_ID.test(object_id)) return reject('object_id', 'invalid object_id');
  if (operation !== 'create' && operation !== 'update' && operation !== 'delete') return reject('operation', 'create, update or delete');
  if (base_revision !== null && !(Number.isInteger(base_revision) && (base_revision as number) >= 0)) return reject('base_revision', 'integer or null');
  if (operation !== 'delete' && m.payload === undefined) return reject('payload', 'required');
  const data = operation === 'delete' ? null : JSON.stringify(m.payload);
  if (data && data.length > 512 * 1024) return { mutation_id, status: 'rejected', error: { code: 'PAYLOAD_TOO_LARGE', message: 'payload over 512 KiB' } };

  return tx(db, () => {
    const dup = db.prepare('SELECT revision FROM mutations WHERE user_id = ? AND mutation_id = ?').get(userId, mutation_id) as { revision: number } | undefined;
    if (dup) return { mutation_id, status: 'duplicate', revision: dup.revision };
    const cur = db.prepare('SELECT revision, deleted, data FROM records WHERE user_id = ? AND module = ? AND object_id = ?').get(userId, module, object_id) as RecordRow | undefined;
    const live = cur && !cur.deleted;
    const conflict = () => ({
      mutation_id, status: 'conflict', revision: cur?.revision ?? 0,
      server_version: live ? JSON.parse(cur!.data ?? 'null') : null, ...(!live ? { server_deleted: true } : {}),
    });
    if (operation === 'create') {
      if (live && !m.force) return conflict();
    } else {
      if (!live) return conflict();
      if (!m.force && base_revision !== cur!.revision) return conflict();
    }
    const revision = (cur?.revision ?? 0) + 1;
    db.prepare(`INSERT INTO records (user_id, module, object_id, revision, deleted, data, seq, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, module, object_id) DO UPDATE SET revision = excluded.revision, deleted = excluded.deleted, data = excluded.data, seq = excluded.seq, updated = excluded.updated`)
      .run(userId, module, object_id, revision, operation === 'delete' ? 1 : 0, data, nextSeq(db), Date.now());
    db.prepare('INSERT INTO mutations (user_id, mutation_id, revision, at) VALUES (?, ?, ?, ?)').run(userId, mutation_id, revision, Date.now());
    return { mutation_id, status: 'applied', revision };
  });
}

export function apiRoutes(r: Router, db: DatabaseSync, o: ApiOptions) {
  r.on('GET', '/.well-known/worksuite-desktop', (ctx) =>
    send(ctx, 200, { api_base: o.publicUrl, oneauth_issuer: o.issuer, update_host: o.updateHost }));

  // ---- user endpoints ----
  // Web apps enabled for the org, each with the URL the desktop opens in its app window.
  const webApps = (orgId: number) => {
    const row = db.prepare('SELECT web_apps FROM orgs WHERE id = ?').get(orgId) as { web_apps: string | null };
    const keys: string[] | null = row.web_apps ? json(row.web_apps) : null;
    return DEFAULT_WEB_APPS.filter((a) => !keys || keys.includes(a.id)).map((a) => ({ ...a, web_url: new URL(`${a.id}/`, o.webUrl).toString() }));
  };

  r.on('GET', '/desktop/v1/bootstrap', (ctx) => {
    const { user } = userCtx(db, ctx);
    const org = db.prepare('SELECT id, name, modules FROM orgs WHERE id = ?').get(user.org_id) as { id: number; name: string; modules: string };
    send(ctx, 200, {
      user: { id: String(user.id), name: user.name, email: user.email },
      org: { id: String(org.id), name: org.name },
      modules: json(org.modules),
      apps: webApps(org.id),
      settings: {},
    });
  });

  r.on('GET', '/desktop/v1/apps', (ctx) => {
    userCtx(db, ctx);
    const limit = limitOf(ctx);
    const rows = db.prepare('SELECT id, item FROM apps WHERE id > ? ORDER BY id LIMIT ?').all(ctx.url.searchParams.get('cursor') ?? '', limit + 1) as { id: string; item: string }[];
    send(ctx, 200, page(rows, limit));
  });

  r.on('GET', '/desktop/v1/links/resolve', (ctx) => {
    const { user } = userCtx(db, ctx);
    let u: URL;
    try { u = new URL(ctx.url.searchParams.get('url') ?? ''); } catch { throw invalid('url'); }
    if (u.protocol !== 'worksuite:' || !MODULE_KEY.test(u.hostname)) throw new HttpError(404, 'NOT_FOUND', 'unknown link');
    const route = u.pathname || '/';
    const app = webApps(user.org_id).find((a) => a.id === u.hostname);
    // web_url: where the app window opens this link; null when the org has no such web app.
    const web_url = app ? new URL(route.replace(/^\/+/, '') + u.search, app.web_url).toString() : null;
    send(ctx, 200, { app_id: u.hostname, route, web_url });
  });

  /*
   * Search and recent files over the caller's own synced records (desktop/v1/search, files/search, files/recent).
   * The real platform answers these from GET api/search/global, GET api/files/search and
   * GET api/drive/list?view=recent (worksuite: app/Modules/Search/Config/Routes.php, app/Modules/Files/Config/Routes.php);
   * this stub searches the `records` table, which is scoped by user_id, so one account never sees another's.
   */
  const SEARCH_TYPES: Record<string, string> = { mail: 'mail', files: 'file', drive: 'file', contacts: 'contact', crm: 'crm', tasks: 'task', chat: 'chat', calendar: 'event', notes: 'note', projects: 'project', docs: 'document' };
  type Rec = { module: string; object_id: string; data: string | null; updated: number };
  const textOf = (d: Record<string, unknown>, ...k: string[]) => { for (const x of k) if (typeof d[x] === 'string' && d[x]) return d[x] as string; return ''; };
  const hit = (r: Rec, q: string) => {
    const d = (r.data ? JSON.parse(r.data) : {}) as Record<string, unknown>;
    const title = textOf(d, 'title', 'subject', 'name') || r.object_id;
    const subtitle = textOf(d, 'subtitle', 'from', 'email', 'snippet', 'body').slice(0, 90);
    const hay = [title, subtitle, textOf(d, 'body')].join(' ').toLowerCase();
    if (q && !hay.includes(q)) return null;
    const t = title.toLowerCase();
    const score = !q ? 0 : t === q ? 1 : t.startsWith(q) ? 0.8 : t.includes(q) ? 0.6 : 0.3;
    return { id: `${r.module}:${r.object_id}`, type: SEARCH_TYPES[r.module], title, subtitle: subtitle || null, link: `worksuite://${r.module}/${encodeURIComponent(r.object_id)}`, at: new Date(r.updated).toISOString(), score, d };
  };
  const records = (userId: number, modules: string[]) => modules.length === 0 ? [] : db.prepare(
    `SELECT module, object_id, data, updated FROM records WHERE user_id = ? AND deleted = 0 AND module IN (${modules.map(() => '?').join(',')}) ORDER BY updated DESC LIMIT 2000`,
  ).all(userId, ...modules) as Rec[];
  const fileOut = (h: NonNullable<ReturnType<typeof hit>>) => ({
    id: h.id, name: h.title, ext: (h.title.split('.').pop() ?? '').toLowerCase(), folder: textOf(h.d, 'folder', 'folder_name') || null,
    size: typeof h.d.size === 'number' ? h.d.size : null, modified: h.at, link: h.link, score: h.score,
  });
  const queryOf = (ctx: Ctx) => {
    const q = (ctx.url.searchParams.get('q') ?? '').trim().toLowerCase();
    if (q.length < 1 || q.length > 200) throw invalid('q', '1 to 200 characters');
    return q;
  };

  r.on('GET', '/desktop/v1/search', (ctx) => {
    const { user } = userCtx(db, ctx);
    const q = queryOf(ctx);
    const want = (ctx.url.searchParams.get('types') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const modules = Object.keys(SEARCH_TYPES).filter((m) => SEARCH_TYPES[m] !== 'file' && (!want.length || want.includes(SEARCH_TYPES[m])));
    const limit = Math.min(50, limitOf(ctx));
    const results = records(user.id, modules).map((r) => hit(r, q)).filter((h) => h !== null)
      .sort((a, b) => b.score - a.score).slice(0, limit).map(({ d: _d, ...h }) => h);
    send(ctx, 200, { query: q, results, state: 'ready' });
  });

  r.on('GET', '/desktop/v1/files/search', (ctx) => {
    const { user } = userCtx(db, ctx);
    const q = queryOf(ctx);
    const files = records(user.id, ['files', 'drive']).map((r) => hit(r, q)).filter((h) => h !== null)
      .sort((a, b) => b.score - a.score).slice(0, Math.min(50, limitOf(ctx))).map(fileOut);
    send(ctx, 200, { query: q, files });
  });

  r.on('GET', '/desktop/v1/files/recent', (ctx) => {
    const { user } = userCtx(db, ctx);
    const files = records(user.id, ['files', 'drive']).slice(0, Math.min(50, limitOf(ctx))).map((r) => fileOut(hit(r, '')!));
    send(ctx, 200, { files });
  });

  r.on('POST', '/desktop/v1/audit', async (ctx) => {
    const { user } = userCtx(db, ctx);
    await idempotent(db, ctx, `user:${user.id}`, ctx.header('idempotency-key'), async () => {
      const b = obj(await ctx.body());
      if (!Array.isArray(b.events) || b.events.length > 500) throw invalid('events', 'array of at most 500');
      const ins = db.prepare('INSERT OR IGNORE INTO audit (id, principal, type, at, data) VALUES (?, ?, ?, ?, ?)');
      tx(db, () => { for (const e of b.events as Record<string, unknown>[]) {
        const ev = obj(e, 'events[]');
        ins.run(str(ev, 'id', 64), `user:${user.id}`, str(ev, 'type', 128), str(ev, 'at', 64), ev.data === undefined ? null : JSON.stringify(ev.data));
      } });
      return { status: 202 };
    });
  });

  r.on('GET', '/desktop/v1/sync/changes', (ctx) => {
    const { user } = userCtx(db, ctx);
    const stream = ctx.url.searchParams.get('stream') ?? '';
    if (!MODULE_KEY.test(stream)) throw invalid('stream');
    const limit = limitOf(ctx);
    const rawCursor = ctx.url.searchParams.get('cursor');
    const cursor = rawCursor === null || rawCursor === '' ? 0 : Number(rawCursor);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw invalid('cursor');
    const h = db.prepare('SELECT min_seq FROM stream_horizon WHERE user_id = ? AND module = ?').get(user.id, stream) as { min_seq: number } | undefined;
    if (h && cursor > 0 && cursor < h.min_seq) throw new HttpError(410, 'CURSOR_EXPIRED', 'cursor older than the tombstone window; resync');
    const rows = db.prepare('SELECT object_id, revision, deleted, data, seq FROM records WHERE user_id = ? AND module = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(user.id, stream, cursor, limit + 1) as { object_id: string; revision: number; deleted: number; data: string | null; seq: number }[];
    const has_more = rows.length > limit;
    const out = rows.slice(0, limit);
    send(ctx, 200, {
      changes: out.map((c) => ({ module: stream, object_id: c.object_id, revision: c.revision, deleted: !!c.deleted, data: c.deleted ? null : JSON.parse(c.data ?? 'null') })),
      next_cursor: String(out.length ? out[out.length - 1].seq : cursor),
      has_more,
    });
  });

  r.on('POST', '/desktop/v1/sync/events', async (ctx) => {
    userCtx(db, ctx);
    obj(await ctx.body());
    send(ctx, 202);
  });

  r.on('POST', '/desktop/v1/sync/mutations', async (ctx) => {
    const { user } = userCtx(db, ctx);
    await idempotent(db, ctx, `user:${user.id}`, ctx.header('idempotency-key'), async () => {
      const b = obj(await ctx.body());
      if (typeof b.batch_id !== 'string' || !UUID.test(b.batch_id)) throw invalid('batch_id', 'UUID');
      if (!Array.isArray(b.mutations) || b.mutations.length > 100) throw invalid('mutations', 'array of at most 100');
      // One bad record does not fail the batch.
      const results = (b.mutations as unknown[]).map((m) => m && typeof m === 'object'
        ? applyMutation(db, user.id, m as Record<string, unknown>)
        : { mutation_id: '', status: 'rejected', error: { code: 'VALIDATION', message: 'mutation must be an object' } });
      return { status: 200, body: { results } };
    });
  });

  r.on('POST', '/desktop/v1/files/{id}/lock', (ctx) => {
    const { user } = userCtx(db, ctx);
    const id = ctx.params.id;
    if (!OBJECT_ID.test(id)) throw invalid('id');
    const out = tx(db, () => {
      const cur = db.prepare('SELECT user_id, lock_id, expires FROM locks WHERE file_id = ?').get(id) as { user_id: number; lock_id: string; expires: number } | undefined;
      if (cur && cur.expires > Date.now() && cur.user_id !== user.id) return undefined;
      const lock_id = cur && cur.user_id === user.id && cur.expires > Date.now() ? cur.lock_id : randomUUID();
      const expires = Date.now() + LOCK_TTL;
      db.prepare('INSERT INTO locks (file_id, user_id, lock_id, expires) VALUES (?, ?, ?, ?) ON CONFLICT(file_id) DO UPDATE SET user_id = excluded.user_id, lock_id = excluded.lock_id, expires = excluded.expires')
        .run(id, user.id, lock_id, expires);
      return { lock_id, expires_at: new Date(expires).toISOString() };
    });
    if (!out) throw new HttpError(409, 'LOCKED', 'locked by another user');
    send(ctx, 200, out);
  });

  r.on('DELETE', '/desktop/v1/files/{id}/lock', (ctx) => {
    const { user } = userCtx(db, ctx);
    db.prepare('DELETE FROM locks WHERE file_id = ? AND user_id = ?').run(ctx.params.id, user.id);
    send(ctx, 204);
  });

  // ---- devices ----
  r.on('POST', '/desktop/v1/devices/register', async (ctx) => {
    const bearer = /^Bearer (\S+)$/.exec(ctx.header('authorization') ?? '')?.[1];
    const b = obj(await ctx.body());
    // The agent sends the enrollment token as the bearer; the contract also allows it in the body.
    const token = typeof b.enrollment_token === 'string' ? b.enrollment_token : bearer;
    if (!token) throw new HttpError(401, 'TOKEN_EXPIRED', 'enrollment token required');
    await idempotent(db, ctx, `enroll:${sha256(token)}`, ctx.header('idempotency-key'), async () => {
      const public_key = str(b, 'public_key', 8192);
      try { createPublicKey(public_key); } catch { throw invalid('public_key', 'PEM public key'); }
      const arch = str(b, 'arch', 16);
      if (!ARCHES.has(arch)) throw invalid('arch', 'amd64 or arm64');
      const hostname = typeof b.hostname === 'string' ? b.hostname.slice(0, 253) : '';
      // Optional: the device's WireGuard public key for the managed VPN. Only ever the public half.
      if (b.wg_public_key !== undefined && !isWgKey(b.wg_public_key)) throw invalid('wg_public_key', 'WireGuard public key (base64, 32 bytes)');
      return tx(db, () => {
        const t = db.prepare('SELECT org_id, expires, uses_left FROM enroll_tokens WHERE hash = ?').get(sha256(token)) as { org_id: number; expires: number; uses_left: number } | undefined;
        if (!t || t.expires < Date.now() || t.uses_left < 1) throw new HttpError(401, 'TOKEN_EXPIRED', 'enrollment token invalid, used or expired');
        db.prepare('UPDATE enroll_tokens SET uses_left = uses_left - 1 WHERE hash = ?').run(sha256(token));
        const device_id = randomUUID(), credential = secret('wsd');
        db.prepare('INSERT INTO devices (id, org_id, cred_hash, public_key, tpm_backed, arch, hostname, enrolled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(device_id, t.org_id, sha256(credential), public_key, b.tpm_backed === true ? 1 : 0, arch, hostname, Date.now());
        if (typeof b.wg_public_key === 'string') registerPeer(db, t.org_id, device_id, b.wg_public_key);
        const org = db.prepare('SELECT name FROM orgs WHERE id = ?').get(t.org_id) as { name: string };
        return { status: 201, body: { device_id, credential, org_name: org.name } };
      });
    });
  });

  r.on('POST', '/desktop/v1/devices/heartbeat', async (ctx) => {
    const d = deviceFromHeader(db, ctx, true);
    const b = obj(await ctx.body());
    for (const k of ['os_version', 'shell_version', 'kernel_version', 'policy_version']) str(b, k);
    db.prepare('UPDATE devices SET heartbeat = ? WHERE id = ?').run(JSON.stringify(b).slice(0, 64 * 1024), d.id);
    const cmds = db.prepare("SELECT envelope FROM commands WHERE device_id = ? AND state IN ('pending', 'received') AND expires > ? ORDER BY rowid")
      .all(d.id, Date.now()) as { envelope: string }[];
    send(ctx, 200, { commands: cmds.map((c) => json(c.envelope)) });
  });

  r.on('POST', '/desktop/v1/devices/commands/{id}/ack', async (ctx) => {
    const d = deviceFromHeader(db, ctx, true);
    await idempotent(db, ctx, `device:${d.id}`, ctx.header('idempotency-key'), async () => {
      const b = obj(await ctx.body());
      const state = str(b, 'state', 16);
      if (!['received', 'started', 'completed', 'failed', 'rejected'].includes(state)) throw invalid('state');
      const res = db.prepare('UPDATE commands SET state = ?, reason = ?, updated = ? WHERE id = ? AND device_id = ?')
        .run(state, typeof b.reason === 'string' ? b.reason.slice(0, 200) : null, Date.now(), ctx.params.id, d.id);
      if (!res.changes) throw new HttpError(404, 'NOT_FOUND', 'no such command for this device');
      // A wipe that has started ends the device's VPN access too (its key is on the disk being wiped).
      if (state === 'started' || state === 'completed') {
        const c = db.prepare('SELECT envelope FROM commands WHERE id = ?').get(ctx.params.id) as { envelope: string };
        if (json<{ command: string }>(c.envelope).command === 'RemoteWipe') removePeer(db, d.id);
      }
      // WSOS-WIPE-008: the result is recorded against the approved request and audited; a completed wipe marks the
      // device "Wiped" and revokes its credential, so it has to enroll again. A full-device wipe reports "started"
      // last (the crypto-erase destroys the agent), so that is when it is marked.
      if (state !== 'received') {
        const w = db.prepare('SELECT id, org_id, requested_by, scope FROM wipe_requests WHERE command_id = ? AND device_id = ?').get(ctx.params.id, d.id) as { id: string; org_id: number; requested_by: number; scope: string } | undefined;
        if (w) {
          const wiped = state === 'completed' || (state === 'started' && w.scope === 'full_device');
          const now = Date.now();
          db.prepare('UPDATE wipe_requests SET result = ?, result_at = ? WHERE id = ?').run(state, now, w.id);
          db.prepare('INSERT INTO admin_log (org_id, user_id, action, detail, at) VALUES (?, ?, ?, ?, ?)')
            .run(w.org_id, w.requested_by, `wipe_${state}`, JSON.stringify({ wipe_id: w.id, device_id: d.id, reported_by: 'device', reason: typeof b.reason === 'string' ? b.reason.slice(0, 200) : undefined }), now);
          if (wiped) {
            db.prepare('UPDATE devices SET wiped_at = ? WHERE id = ?').run(now, d.id);
            revokeDevice(db, d.id);
          }
        }
      }
      return { status: 204 };
    });
  });

  r.on('GET', '/desktop/v1/policies', (ctx) => {
    const d = deviceFromHeader(db, ctx, false);
    const orgId = d ? d.org_id : userFromBearer(db, ctx).org_id;
    send(ctx, 200, policyFor(db, orgId));
  });

  // ---- desktop/v1/os ----
  r.on('GET', '/desktop/v1/os/catalog', (ctx) => {
    deviceFromHeader(db, ctx, true);
    const arch = ctx.url.searchParams.get('arch') ?? '';
    if (!ARCHES.has(arch)) throw invalid('arch', 'amd64 or arm64');
    const limit = limitOf(ctx);
    const rows = (db.prepare('SELECT id, item FROM catalog WHERE id > ? ORDER BY id').all(ctx.url.searchParams.get('cursor') ?? '') as { id: string; item: string }[])
      .filter((r) => (json<{ arches: string[] }>(r.item).arches ?? []).includes(arch)).slice(0, limit + 1);
    send(ctx, 200, page(rows, limit));
  });

  // WSOS-AUP-012: the organization's licence state for the update coordinator (signed, device-bound, 7 days).
  r.on('GET', '/desktop/v1/os/licence', (ctx) => {
    const d = deviceFromHeader(db, ctx, true);
    send(ctx, 200, licenceFor(db, d.org_id, d.id), { 'cache-control': 'no-store' });
  });

  // Managed WireGuard VPN (WSOS-INT-001): signed per-device config; the device registers only its public key.
  r.on('GET', '/desktop/v1/os/vpn', (ctx) => {
    const d = deviceFromHeader(db, ctx, true);
    send(ctx, 200, deviceVpnConfig(db, d.org_id, d.id), { 'cache-control': 'no-store' });
  });
  r.on('PUT', '/desktop/v1/os/vpn/peer', async (ctx) => {
    const d = deviceFromHeader(db, ctx, true);
    await idempotent(db, ctx, `device:${d.id}`, ctx.header('idempotency-key'), async () => {
      const b = obj(await ctx.body());
      if ('private_key' in b) throw invalid('private_key', 'never send the private key');
      registerPeer(db, d.org_id, d.id, b.public_key as string);
      return { status: 200, body: deviceVpnConfig(db, d.org_id, d.id) };
    });
  });

  const deviceReport = (path: string, table: 'inventory' | 'update_results' | 'diagnostics', required: string[]) =>
    r.on('POST', path, async (ctx) => {
      const d = deviceFromHeader(db, ctx, true);
      await idempotent(db, ctx, `device:${d.id}`, ctx.header('idempotency-key'), async () => {
        const b = obj(await ctx.body());
        for (const k of required) if (b[k] === undefined) throw invalid(k, 'required');
        if (table === 'inventory') db.prepare('INSERT INTO inventory (device_id, body, at) VALUES (?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET body = excluded.body, at = excluded.at').run(d.id, JSON.stringify(b), Date.now());
        else db.prepare(`INSERT INTO ${table} (device_id, body, at) VALUES (?, ?, ?)`).run(d.id, JSON.stringify(b), Date.now());
        return { status: 202 };
      });
    });
  deviceReport('/desktop/v1/os/inventory', 'inventory', ['collected_at', 'hardware', 'software']);
  deviceReport('/desktop/v1/os/update-results', 'update_results', ['release_id', 'result', 'os_version', 'shell_version', 'kernel_version']);
  // MVP: JSON diagnostic summaries; resumable binary bundles (Upload-Length/Offset) are not implemented yet.
  deviceReport('/desktop/v1/os/diagnostics', 'diagnostics', []);

  r.on('GET', '/desktop/v1/os/directory', (ctx) => {
    const d = deviceFromHeader(db, ctx, true);
    const org = db.prepare('SELECT directory FROM orgs WHERE id = ?').get(d.org_id) as { directory: string };
    send(ctx, 200, json(org.directory));
  });

  // Directory sign-in for the OS PAM helper (WSOS-DIR-002/005/009). Device-bound: only an enrolled, unrevoked device
  // of the user's organization may verify a password. The reply carries no secret; the client derives its own
  // offline verifier. Constant work whether or not the account exists.
  r.on('POST', '/desktop/v1/os/directory/authenticate', async (ctx) => {
    const d = deviceFromHeader(db, ctx, true);
    const b = obj(await ctx.body());
    const username = str(b, 'username', 320).trim().toLowerCase();
    const password = str(b, 'password', 1024);
    const dir = json<DirectorySettings>((db.prepare('SELECT directory FROM orgs WHERE id = ?').get(d.org_id) as { directory: string }).directory);
    const v = verifyDirectoryUser(db, d.org_id, username, password, { otp: typeof b.otp === 'string' ? b.otp : undefined, maxAgeDays: dir.password_max_age_days });
    if (!v.ok) {
      if (v.code === 'ACCOUNT_DISABLED') throw new HttpError(403, 'ACCOUNT_DISABLED', 'account disabled');
      if (v.code === 'PASSWORD_EXPIRED') throw new HttpError(401, 'PASSWORD_EXPIRED', 'the password has expired and must be changed');
      if (v.code === 'MFA_REQUIRED') throw new HttpError(401, 'MFA_REQUIRED', 'a verification code is required');
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'wrong username or password');
    }
    send(ctx, 200, loginReply(v.user, dir, d.id));
  });
  const loginReply = (u: DirUserRow, dir: DirectorySettings, deviceId: string) => ({
    username: u.email, user_id: u.id, name: u.name, groups: [u.role === 'admin' ? 'worksuite-admins' : 'worksuite-users'],
    offline_login_days: dir.offline_login_days ?? 7, mfa: !!u.totp_secret,
    // WSOS-DIR-008: exchanged by the session's token broker (os-login grant), bound to this device.
    login_code: issueLoginCode(db, u.id, deviceId),
  });

  // WSOS-DIR-007: change an expired (or admin-reset) password at the greeter. Needs the current password (and code).
  r.on('POST', '/desktop/v1/os/directory/change-password', async (ctx) => {
    const d = deviceFromHeader(db, ctx, true);
    const b = obj(await ctx.body());
    const username = str(b, 'username', 320).trim().toLowerCase();
    const oldPw = str(b, 'old_password', 1024);
    const newPw = str(b, 'new_password', 1024);
    const v = verifyDirectoryUser(db, d.org_id, username, oldPw, { otp: typeof b.otp === 'string' ? b.otp : undefined });
    if (!v.ok && v.code !== 'PASSWORD_EXPIRED') {
      if (v.code === 'ACCOUNT_DISABLED') throw new HttpError(403, 'ACCOUNT_DISABLED', 'account disabled');
      if (v.code === 'MFA_REQUIRED') throw new HttpError(401, 'MFA_REQUIRED', 'a verification code is required');
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'wrong username or password');
    }
    const user = v.user!;
    const plain = user.totp_secret && typeof b.otp !== 'string' ? oldPw.replace(/\d{6}$/, '') : oldPw;
    try { setNewPassword(db, user.id, plain, newPw); } catch (e) { throw invalid('new_password', (e as Error).message); }
    db.prepare('UPDATE tokens SET revoked = 1 WHERE user_id = ?').run(user.id);   // other sessions sign in again
    db.prepare('INSERT OR IGNORE INTO audit (id, principal, type, at, data) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), `device:${d.id}`, 'directory.password_changed', new Date().toISOString(), JSON.stringify({ user_id: user.id }));
    // The change is the sign-in: same reply as authenticate (a TOTP code is single use, so no second check).
    if (user.disabled) throw new HttpError(403, 'ACCOUNT_DISABLED', 'account disabled');
    const dir = json<DirectorySettings>((db.prepare('SELECT directory FROM orgs WHERE id = ?').get(d.org_id) as { directory: string }).directory);
    send(ctx, 200, loginReply(user, dir, d.id));
  });

  // Break-glass audit (WSOS-DIR-010): every use and every rotation is recorded against the device.
  r.on('POST', '/desktop/v1/os/break-glass/events', async (ctx) => {
    const d = deviceFromHeader(db, ctx, true);
    await idempotent(db, ctx, `device:${d.id}`, ctx.header('idempotency-key'), async () => {
      const b = obj(await ctx.body());
      const type = str(b, 'type', 32);
      if (type !== 'used' && type !== 'rotated') throw invalid('type', 'used or rotated');
      db.prepare('INSERT OR IGNORE INTO audit (id, principal, type, at, data) VALUES (?, ?, ?, ?, ?)')
        .run(str(b, 'id', 64), `device:${d.id}`, `break_glass.${type}`, str(b, 'at', 64), JSON.stringify({ username: str(b, 'username', 64), ...(typeof b.reason === 'string' && b.reason ? { reason: b.reason.slice(0, 200) } : {}) }));
      return { status: 202 };
    });
  });

  r.on('POST', '/desktop/v1/os/break-glass', async (ctx) => {
    const d = deviceFromHeader(db, ctx, true);
    await idempotent(db, ctx, `device:${d.id}`, ctx.header('idempotency-key'), async () => {
      const b = obj(await ctx.body());
      for (const k of ['username', 'encrypted_secret', 'rotated_at']) str(b, k, 16384);
      db.prepare('INSERT INTO break_glass (device_id, body, at) VALUES (?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET body = excluded.body, at = excluded.at')
        .run(d.id, JSON.stringify(b), Date.now());
      return { status: 204 };
    });
  });

  // ---- release manifests (public; integrity comes from the Ed25519 signature) ----
  const manifest = (ctx: Ctx, ring: string, arch: string) => {
    if (!RINGS.has(ring)) throw invalid('ring');
    if (!ARCHES.has(arch)) throw invalid('arch');
    const row = db.prepare('SELECT manifest FROM releases WHERE ring = ? AND arch = ?').get(ring, arch) as { manifest: string } | undefined;
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'no release for this ring and arch');
    send(ctx, 200, json(row.manifest), { 'cache-control': 'public, max-age=300' });
  };
  r.on('GET', '/os/manifests/{ring}/{file}', (ctx) => {
    const m = /^(amd64|arm64)\.json$/.exec(ctx.params.file);
    if (!m) throw new HttpError(404, 'NOT_FOUND', 'not found');
    manifest(ctx, ctx.params.ring, m[1]);
  });
  r.on('GET', '/desktop/v1/releases/manifest', (ctx) => {
    const q = ctx.url.searchParams;
    if (q.get('platform') !== 'os') throw new HttpError(404, 'NOT_FOUND', 'only platform=os is served here');
    manifest(ctx, q.get('ring') ?? '', q.get('arch') ?? '');
  });
}
