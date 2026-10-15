// Administrative operations (CLI today; an admin console later). Each takes the database and plain values.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_MODULES, DEFAULT_WEB_APPS, secret, sha256 } from './db.ts';
import { hashPassword } from './oauth.ts';
import { activeKey, createKey, signEnvelope, signFlat } from './signing.ts';

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
