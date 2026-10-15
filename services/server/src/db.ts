// SQLite schema and small helpers. Secrets (tokens, credentials, enrollment tokens) are stored only as SHA-256 hashes.
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orgs (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL,
  require_device INTEGER NOT NULL DEFAULT 0,
  modules TEXT NOT NULL,            -- JSON [{key, offline?, data_type?}]
  directory TEXT NOT NULL DEFAULT '{"type":"oneauth","offline_login_days":7}',
  web_apps TEXT                     -- JSON [key] of enabled WorkSuite web apps; NULL = all of DEFAULT_WEB_APPS
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id),
  email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, pw_salt BLOB NOT NULL, pw_hash BLOB NOT NULL, disabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS oauth_codes (
  hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL, expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  hash TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id INTEGER NOT NULL, client_id TEXT NOT NULL,
  family TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tokens_family ON tokens(family);
CREATE TABLE IF NOT EXISTS enroll_tokens (
  hash TEXT PRIMARY KEY, org_id INTEGER NOT NULL, expires INTEGER NOT NULL, uses_left INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, org_id INTEGER NOT NULL, cred_hash TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL,
  tpm_backed INTEGER NOT NULL, arch TEXT NOT NULL, hostname TEXT NOT NULL, enrolled_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0, last_seen INTEGER, heartbeat TEXT
);
CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, envelope TEXT NOT NULL, expires INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', reason TEXT, updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS policies (org_id INTEGER PRIMARY KEY, version INTEGER NOT NULL, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS records (
  user_id INTEGER NOT NULL, module TEXT NOT NULL, object_id TEXT NOT NULL, revision INTEGER NOT NULL,
  deleted INTEGER NOT NULL, data TEXT, seq INTEGER NOT NULL, updated INTEGER NOT NULL,
  PRIMARY KEY (user_id, module, object_id)
);
CREATE INDEX IF NOT EXISTS records_stream ON records(user_id, module, seq);
CREATE TABLE IF NOT EXISTS stream_horizon (user_id INTEGER NOT NULL, module TEXT NOT NULL, min_seq INTEGER NOT NULL, PRIMARY KEY (user_id, module));
CREATE TABLE IF NOT EXISTS mutations (user_id INTEGER NOT NULL, mutation_id TEXT NOT NULL, revision INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (user_id, mutation_id));
CREATE TABLE IF NOT EXISTS idempotency (
  principal TEXT NOT NULL, key TEXT NOT NULL, status INTEGER NOT NULL, body TEXT, at INTEGER NOT NULL, PRIMARY KEY (principal, key)
);
CREATE TABLE IF NOT EXISTS locks (file_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, lock_id TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit (id TEXT NOT NULL, principal TEXT NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL, data TEXT, PRIMARY KEY (principal, id));
CREATE TABLE IF NOT EXISTS inventory (device_id TEXT PRIMARY KEY, body TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS update_results (id INTEGER PRIMARY KEY, device_id TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS diagnostics (id INTEGER PRIMARY KEY, device_id TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS break_glass (device_id TEXT PRIMARY KEY, body TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS releases (ring TEXT NOT NULL, arch TEXT NOT NULL, manifest TEXT NOT NULL, PRIMARY KEY (ring, arch));
CREATE TABLE IF NOT EXISTS catalog (id TEXT PRIMARY KEY, item TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS apps (id TEXT PRIMARY KEY, item TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admin_sessions (hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS wipe_requests (
  id TEXT PRIMARY KEY, org_id INTEGER NOT NULL, device_id TEXT NOT NULL, scope TEXT NOT NULL, reason TEXT NOT NULL,
  requested_by INTEGER NOT NULL, requested_at INTEGER NOT NULL, approved_by INTEGER, approved_at INTEGER, command_id TEXT, cancelled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS admin_log (id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, user_id INTEGER NOT NULL, action TEXT NOT NULL, detail TEXT, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS signing_keys (key_id TEXT PRIMARY KEY, private_pem TEXT NOT NULL, public_pem TEXT NOT NULL, created INTEGER NOT NULL);
`;

export const DEFAULT_MODULES = [
  { key: 'docs', offline: 'full_offline', data_type: 'document' },
  { key: 'notes', offline: 'full_offline', data_type: 'document' },
  { key: 'tasks', offline: 'full_offline', data_type: 'document' },
  { key: 'preferences', offline: 'full_offline', data_type: 'preference' },
  { key: 'chat', offline: 'cached_read', data_type: 'message' },
  { key: 'billing', offline: 'online_only', data_type: 'authoritative' },
];

/** WorkSuite web apps the desktop can open in an app window; each is served at <web base>/<id>/. */
export const DEFAULT_WEB_APPS: { id: string; name: string }[] = [
  { id: 'mail', name: 'Mail' }, { id: 'calendar', name: 'Calendar' }, { id: 'chat', name: 'Chat' },
  { id: 'drive', name: 'Drive' }, { id: 'tasks', name: 'Tasks' }, { id: 'projects', name: 'Projects' },
  { id: 'crm', name: 'CRM' }, { id: 'meet', name: 'Meet' },
  { id: 'pdf-studio', name: 'PDF Studio' },
];

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  // Additive migrations for databases created by earlier versions.
  const cols = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('role')) db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  // Fine-grained admin permissions, e.g. desktop.releases.manage (WSOS-AUP-013).
  if (!cols.includes('permissions')) db.exec("ALTER TABLE users ADD COLUMN permissions TEXT NOT NULL DEFAULT '[]'");
  // CoreLicenseService state per organization (WSOS-AUP-012): {edition, state, entitlements, grace_until}.
  const orgCols = (db.prepare('PRAGMA table_info(orgs)').all() as { name: string }[]).map((c) => c.name);
  if (!orgCols.includes('licence')) db.exec('ALTER TABLE orgs ADD COLUMN licence TEXT');
  if (!orgCols.includes('web_apps')) db.exec('ALTER TABLE orgs ADD COLUMN web_apps TEXT');
  db.exec('CREATE TABLE IF NOT EXISTS release_log (id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, at INTEGER NOT NULL)');
  return db;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const secret = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`;

/** Monotonic change sequence shared by all streams (cursor values). */
export function nextSeq(db: DatabaseSync): number {
  const row = db.prepare("INSERT INTO meta (k, v) VALUES ('seq', '1') ON CONFLICT(k) DO UPDATE SET v = CAST(v AS INTEGER) + 1 RETURNING v").get() as { v: string };
  return Number(row.v);
}

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
