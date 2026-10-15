// Local SQLite store (SRS §8.2). node:sqlite ships with Node 22.
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

/** Ordered, append-only migrations. Never edit a shipped entry; add a new one. */
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  server_url TEXT NOT NULL,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('personal','enterprise'))
);
CREATE TABLE objects (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  module TEXT NOT NULL,
  object_id TEXT NOT NULL,
  data TEXT,                      -- JSON; NULL = tombstone
  server_revision INTEGER,        -- last authoritative revision (NULL = never synced)
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, module, object_id)
);
CREATE TABLE outbox (
  mutation_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  module TEXT NOT NULL,
  object_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create','update','delete')),
  base_revision INTEGER,
  payload TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  seq INTEGER NOT NULL
);
CREATE INDEX outbox_ready ON outbox(account_id, state, next_attempt_at, seq);
CREATE TABLE sync_cursors (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  stream TEXT NOT NULL,
  cursor TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, stream)
);
CREATE TABLE conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  module TEXT NOT NULL,
  object_id TEXT NOT NULL,
  mutation_id TEXT,
  local_version TEXT,
  server_version TEXT,
  server_revision INTEGER,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE file_cache (
  account_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT,
  server_revision INTEGER,
  state TEXT NOT NULL CHECK (state IN ('synced','syncing','pending','conflict','online-only','error')),
  PRIMARY KEY (account_id, file_id)
);`,
  },
];

export function openDb(path = ':memory:'): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;');
  migrate(db);
  return db;
}

export function migrate(db: Db): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  let current = row.v ?? 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    tx(db, () => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(m.version, Date.now());
    });
    current = m.version;
  }
  return current;
}

/** Run fn in one IMMEDIATE transaction; rolls back on throw. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
