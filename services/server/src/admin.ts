// Administrative operations (CLI today; an admin console later). Each takes the database and plain values.
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_MODULES, DEFAULT_WEB_APPS, secret, sha256 } from './db.ts';
import { hashPassword } from './oauth.ts';
import { activeKey, createKey, signEnvelope, signFlat } from './signing.ts';
import { removePeer } from './vpn.ts';

const COMMANDS = ['RefreshPolicy', 'InstallApprovedApplication', 'ScheduleUpdate', 'RequestLock', 'RebootDuringWindow', 'CollectApprovedDiagnostics', 'RemoteWipe'];

export function createOrg(db: DatabaseSync, name: string, o: { requireDevice?: boolean } = {}): number {
  const r = db.prepare('INSERT INTO orgs (name, require_device, modules) VALUES (?, ?, ?)').run(name, o.requireDevice ? 1 : 0, JSON.stringify(DEFAULT_MODULES));
  activeKey(db);
  return Number(r.lastInsertRowid);
}

/** Which WorkSuite web apps the org's desktops show (null = all). */
export function setWebApps(db: DatabaseSync, orgId: number, keys: string[] | null) {
  const known = new Set(DEFAULT_WEB_APPS.map((a) => a.id));
  for (const k of keys ?? []) if (!known.has(k)) throw new Error(`unknown web app: ${k}`);
  db.prepare('UPDATE orgs SET web_apps = ? WHERE id = ?').run(keys ? JSON.stringify(keys) : null, orgId);
}

export function addUser(db: DatabaseSync, orgId: number, email: string, name: string, password: string, role: 'user' | 'admin' = 'user'): number {
  if (password.length < 10) throw new Error('password must be at least 10 characters');
  if (!/^[^\s@]+@[^\s@]+$/.test(email.trim())) throw new Error('email is not valid');
  const { salt, hash } = hashPassword(password);
  const r = db.prepare('INSERT INTO users (org_id, email, name, pw_salt, pw_hash, role) VALUES (?, ?, ?, ?, ?, ?)').run(orgId, email.trim().toLowerCase(), name, salt, hash, role);
  return Number(r.lastInsertRowid);
}

export function createEnrollmentToken(db: DatabaseSync, orgId: number, o: { hours?: number; uses?: number } = {}): string {
  const token = secret('wse');
  db.prepare('INSERT INTO enroll_tokens (hash, org_id, expires, uses_left) VALUES (?, ?, ?, ?)').run(sha256(token), orgId, Date.now() + (o.hours ?? 24) * 3_600_000, o.uses ?? 1);
  return token;
}

/** Replace the org's policy body; the version increases and the server signs it on every fetch. */
export function setPolicy(db: DatabaseSync, orgId: number, body: Record<string, unknown>): number {
  const { version: _v, signature: _s, ...rest } = body;
  const cur = db.prepare('SELECT version FROM policies WHERE org_id = ?').get(orgId) as { version: number } | undefined;
  const version = (cur?.version ?? 0) + 1;
  db.prepare('INSERT INTO policies (org_id, version, body) VALUES (?, ?, ?) ON CONFLICT(org_id) DO UPDATE SET version = excluded.version, body = excluded.body')
    .run(orgId, version, JSON.stringify(rest));
  return version;
}

export function issueCommand(db: DatabaseSync, deviceId: string, command: string, args: Record<string, unknown> = {}, ttlHours = 24): string {
  if (!COMMANDS.includes(command)) throw new Error(`unknown command ${command}`);
  const d = db.prepare('SELECT id FROM devices WHERE id = ? AND revoked = 0').get(deviceId);
  if (!d) throw new Error('no such active device');
  const now = Date.now();
  const env = signEnvelope(activeKey(db), {
    id: randomUUID(), command, device_id: deviceId, issued_at: new Date(now).toISOString(), expires_at: new Date(now + ttlHours * 3_600_000).toISOString(), args,
  });
  db.prepare('INSERT INTO commands (id, device_id, envelope, expires, updated) VALUES (?, ?, ?, ?, ?)').run(env.id, deviceId, JSON.stringify(env), now + ttlHours * 3_600_000, now);
  return env.id;
}

export function revokeDevice(db: DatabaseSync, deviceId: string) {
  removePeer(db, deviceId);   // the gateway drops the revoked device's WireGuard peer on its next sync
  return db.prepare('UPDATE devices SET revoked = 1 WHERE id = ?').run(deviceId).changes > 0;
}

/** Sign and publish an OS release manifest for one ring/arch (ReleaseManifest). */
export function publishRelease(db: DatabaseSync, m: Record<string, unknown>) {
  for (const k of ['release_id', 'version', 'min_version', 'ring', 'arch']) if (typeof m[k] !== 'string' || !m[k]) throw new Error(`manifest.${k} required`);
  const signed = signFlat(activeKey(db), { state: 'active', rollout_percent: 100, ...m });
  db.prepare('INSERT INTO releases (ring, arch, manifest) VALUES (?, ?, ?) ON CONFLICT(ring, arch) DO UPDATE SET manifest = excluded.manifest')
    .run(m.ring as string, m.arch as string, JSON.stringify(signed));
  return signed;
}

// ---- Update Center release management (WSOS-UPD-004, WSOS-AUP-013). Every change re-signs the manifest with the
// release key, so devices accept a pause/pull/promotion only because it carries a valid signature. ----

export const RELEASE_PERMISSION = 'desktop.releases.manage';
export { WIPE_PERMISSION } from './approvals.ts';
import { WIPE_PERMISSION } from './approvals.ts';
const RINGS = ['development', 'pilot', 'stable'] as const;
const ARCHES = ['amd64', 'arm64'] as const;
type Ring = typeof RINGS[number];

function ringArg(v: unknown): Ring { if (!RINGS.includes(v as Ring)) throw new Error('ring must be development, pilot or stable'); return v as Ring; }
function archArgs(v: unknown): string[] {
  if (v === undefined || v === null || v === '') return [...ARCHES];
  if (!ARCHES.includes(v as typeof ARCHES[number])) throw new Error('arch must be amd64 or arm64');
  return [v as string];
}
const current = (db: DatabaseSync, ring: string, arch: string) => {
  const row = db.prepare('SELECT manifest FROM releases WHERE ring = ? AND arch = ?').get(ring, arch) as { manifest: string } | undefined;
  return row ? JSON.parse(row.manifest) as Record<string, unknown> : null;
};
const store = (db: DatabaseSync, m: Record<string, unknown>) => {
  const signed = signFlat(activeKey(db), m);
  db.prepare('INSERT INTO releases (ring, arch, manifest) VALUES (?, ?, ?) ON CONFLICT(ring, arch) DO UPDATE SET manifest = excluded.manifest')
    .run(m.ring as string, m.arch as string, JSON.stringify(signed));
  return signed;
};
export function logRelease(db: DatabaseSync, actor: string, action: string, detail: Record<string, unknown>) {
  db.prepare('INSERT INTO release_log (actor, action, detail, at) VALUES (?, ?, ?, ?)').run(actor, action, JSON.stringify(detail), Date.now());
}

/** Pause, resume or pull the current release of a ring (one arch or both). Devices stop within one check cycle. */
export function setReleaseState(db: DatabaseSync, ring: string, arch: string | undefined, state: 'active' | 'paused' | 'pulled', actor = 'cli') {
  const out = archArgs(arch).map((a) => {
    const m = current(db, ringArg(ring), a);
    if (!m) throw new Error(`no release published for ${ring}/${a}`);
    const { signature: _s, ...rest } = m;
    return store(db, { ...rest, state });
  });
  logRelease(db, actor, `release_${state === 'active' ? 'resumed' : state}`, { ring, arches: out.map((m) => m.arch), release_id: out[0].release_id });
  return out;
}

/** Ring promotion: development → pilot → stable, never skipping or going backwards. The APT pool must hold the
 *  packages in the target suite (tools/repo/publish.sh) before devices on that ring can install them. */
export function promoteRelease(db: DatabaseSync, from: string, to: string, arch: string | undefined, o: { rollout_percent?: number } = {}, actor = 'cli') {
  const a = RINGS.indexOf(ringArg(from)), b = RINGS.indexOf(ringArg(to));
  if (b !== a + 1) throw new Error('promote one ring at a time: development → pilot → stable');
  const pct = o.rollout_percent ?? 100;
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) throw new Error('rollout_percent must be 0..100');
  const out = archArgs(arch).map((x) => {
    const m = current(db, from, x);
    if (!m) throw new Error(`no release published for ${from}/${x}`);
    if (m.state !== 'active') throw new Error(`${from}/${x} is ${m.state}; resume it before promoting`);
    const { signature: _s, ...rest } = m;
    return store(db, { ...rest, ring: to, state: 'active', rollout_percent: pct });
  });
  logRelease(db, actor, 'release_promoted', { from, to, arches: out.map((m) => m.arch), release_id: out[0].release_id, rollout_percent: pct });
  return out;
}

/** Emergency release: critical + mandatory, 100 % rollout, published to every ring at once (WSOS-UPD-004). */
export function emergencyRelease(db: DatabaseSync, m: Record<string, unknown>, arch?: string, actor = 'cli') {
  for (const k of ['release_id', 'version', 'min_version']) if (typeof m[k] !== 'string' || !m[k]) throw new Error(`manifest.${k} required`);
  const deadline = typeof m.deadline === 'string' ? m.deadline : new Date(Date.now() + 24 * 3_600_000).toISOString();
  const { signature: _s, ring: _r, arch: _a, ...rest } = m;
  const out = archArgs(arch ?? (typeof m.arch === 'string' ? m.arch : undefined)).flatMap((x) => RINGS.map((ring) =>
    store(db, { ...rest, ring, arch: x, critical: true, mandatory: true, rollout_percent: 100, state: 'active', deadline })));
  logRelease(db, actor, 'release_emergency', { release_id: m.release_id, version: m.version, rings: [...RINGS], arches: [...new Set(out.map((r) => r.arch))] });
  return out;
}

export function grantPermission(db: DatabaseSync, email: string, permission: string, grant = true) {
  if (permission !== RELEASE_PERMISSION && permission !== WIPE_PERMISSION) throw new Error(`unknown permission ${permission}`);
  const u = db.prepare('SELECT id, permissions FROM users WHERE email = ?').get(email.trim().toLowerCase()) as { id: number; permissions: string } | undefined;
  if (!u) throw new Error('no such user');
  const set = new Set(JSON.parse(u.permissions) as string[]);
  if (grant) set.add(permission); else set.delete(permission);
  db.prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify([...set]), u.id);
  return [...set];
}

// ---- licences (WSOS-AUP-012) ----

export interface OrgLicence { edition: string; state: 'active' | 'grace' | 'expired'; entitlements: string[]; grace_until?: string | null }

export function setLicence(db: DatabaseSync, orgId: number, l: OrgLicence) {
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(l.edition ?? '')) throw new Error('edition');
  if (!['active', 'grace', 'expired'].includes(l.state)) throw new Error('state must be active, grace or expired');
  if (!Array.isArray(l.entitlements) || !l.entitlements.every((e) => /^[a-z][a-z0-9_-]{0,39}$/.test(e))) throw new Error('entitlements');
  const body = { edition: l.edition, state: l.state, entitlements: l.entitlements, grace_until: l.grace_until ?? null };
  if (!db.prepare('UPDATE orgs SET licence = ? WHERE id = ?').run(JSON.stringify(body), orgId).changes) throw new Error('no such org');
  return body;
}

/** Short-lived, device-bound and signed with the release key, so it can't be edited, moved or replayed later. */
export function licenceFor(db: DatabaseSync, orgId: number, deviceId: string, now = Date.now()) {
  const row = db.prepare('SELECT licence FROM orgs WHERE id = ?').get(orgId) as { licence: string | null } | undefined;
  const l: OrgLicence = row?.licence ? JSON.parse(row.licence) : { edition: 'none', state: 'expired', entitlements: [] };
  return signFlat(activeKey(db), { device_id: deviceId, edition: l.edition, state: l.state, entitlements: l.entitlements, grace_until: l.grace_until ?? null,
    issued_at: new Date(now).toISOString(), valid_until: new Date(now + 7 * 86_400_000).toISOString() });
}

// ---- offline bundles (WSOS-AUP-010) ----

function tarHeader(name: string, size: number, type: '0' | '5'): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(type === '5' ? '0000755\0' : '0000644\0', 100, 'latin1');
  h.write('0000000\0', 108, 'latin1'); h.write('0000000\0', 116, 'latin1');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'latin1');
  h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 'latin1');
  h.write('        ', 148, 'latin1');
  h.write(type, 156, 'latin1');
  h.write('ustar\0' + '00', 257, 'latin1');
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return h;
}

/** Build a signed .wsupdate: manifest.json (release manifest + bundle.files hashes, signed) and pool/*.deb. */
export function buildBundle(db: DatabaseSync, m: Record<string, unknown>, debs: string[], out: string) {
  for (const k of ['release_id', 'version', 'min_version', 'arch']) if (typeof m[k] !== 'string' || !m[k]) throw new Error(`manifest.${k} required`);
  if (!debs.length) throw new Error('at least one .deb required');
  const files = debs.map((p) => {
    const name = basename(p);
    if (!/^[a-z0-9][a-z0-9+.~_-]{0,200}\.deb$/.test(name)) throw new Error(`bad package file name ${name}`);
    return { path: p, name, size: statSync(p).size, sha256: createHash('sha256').update(readFileSync(p)).digest('hex') };
  });
  const { signature: _s, ...rest } = m;
  const manifest = signFlat(activeKey(db), { ring: 'stable', state: 'active', ...rest, bundle: { files: files.map(({ name, size, sha256 }) => ({ name, size, sha256 })) } });
  const fd = openSync(out, 'w', 0o644);
  try {
    const put = (b: Buffer) => writeSync(fd, b);
    const pad = (n: number) => { if (n % 512) put(Buffer.alloc(512 - (n % 512))); };
    const mj = Buffer.from(JSON.stringify(manifest));
    put(tarHeader('manifest.json', mj.length, '0')); put(mj); pad(mj.length);
    put(tarHeader('pool/', 0, '5'));
    for (const f of files) { const b = readFileSync(f.path); put(tarHeader(`pool/${f.name}`, b.length, '0')); put(b); pad(b.length); }
    put(Buffer.alloc(1024));
  } finally { closeSync(fd); }
  return manifest;
}

export function putCatalogItem(db: DatabaseSync, item: { id: string; source: string; name: string; arches: string[]; [k: string]: unknown }) {
  db.prepare('INSERT INTO catalog (id, item) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET item = excluded.item').run(item.id, JSON.stringify(item));
}

export function putApp(db: DatabaseSync, item: { id: string; name: string; offline_level: string }) {
  db.prepare('INSERT INTO apps (id, item) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET item = excluded.item').run(item.id, JSON.stringify(item));
}

/** Public keys as <key_id>.pem for /usr/share/worksuite/keys/{device-commands,release}. */
export function exportKeys(db: DatabaseSync, dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  const keys = db.prepare('SELECT key_id, public_pem FROM signing_keys').all() as { key_id: string; public_pem: string }[];
  for (const k of keys) writeFileSync(join(dir, `${k.key_id}.pem`), k.public_pem);
  return keys.map((k) => k.key_id);
}

export const rotateKey = (db: DatabaseSync) => createKey(db).key_id;

export function listDevices(db: DatabaseSync) {
  return (db.prepare('SELECT id, org_id, hostname, arch, tpm_backed, revoked, enrolled_at, last_seen FROM devices ORDER BY enrolled_at').all() as Record<string, unknown>[]);
}

// ---- directory settings (WSOS-DIR-002/004/007) ----

const DOMAIN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/;

/** Validates and stores the org's directory settings; unknown keys are refused. */
export function setDirectory(db: DatabaseSync, orgId: number, body: Record<string, unknown>) {
  const out: Record<string, unknown> = { type: 'oneauth' };
  for (const [k, v] of Object.entries(body)) {
    switch (k) {
      case 'type': if (v !== 'oneauth') throw new Error('type must be oneauth'); break;
      case 'offline_login_days': case 'password_max_age_days':
        if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 3650) throw new Error(`${k}: 0 to 3650`); out[k] = v; break;
      case 'domain': if (typeof v !== 'string' || !DOMAIN.test(v)) throw new Error('domain: a DNS name'); out[k] = v; break;
      case 'netbios_domain': if (typeof v !== 'string' || !/^[A-Z0-9][A-Z0-9-]{0,14}$/.test(v)) throw new Error('netbios_domain: 1-15 upper-case letters/digits'); out[k] = v; break;
      case 'upn_suffixes': if (!Array.isArray(v) || v.length > 20 || !v.every((x) => typeof x === 'string' && DOMAIN.test(x))) throw new Error('upn_suffixes: DNS names'); out[k] = v; break;
      // Offline sign-in for accounts with a second factor checks the password only; off unless the org opts in.
      case 'allow_offline_mfa_bypass': if (typeof v !== 'boolean') throw new Error(`${k}: true or false`); out[k] = v; break;
      case 'group_role_map': case 'escrow_public_key': out[k] = v; break;
      default: throw new Error(`unknown directory field ${k}`);
    }
  }
  db.prepare('UPDATE orgs SET directory = ? WHERE id = ?').run(JSON.stringify(out), orgId);
  return out;
}
