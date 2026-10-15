// worksuite-sync entry point: the user-level service that owns local WorkSuite state (SRS §8.2).
// Paths follow XDG (SRS §11.6); logs are one JSON object per line for journald.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import { LocalStore } from './store.ts';
import { SyncEngine } from './engine.ts';
import { SyncService } from './service.ts';
import { brokerTokens, serveControl } from './control.ts';
import { fetchTransport } from './transport.ts';
import type { DataType } from './policy.ts';
import { checkStorage, readCrypttab } from './storage.ts';

export interface SyncConfig {
  account: { id: string; server_url: string; org_id: string; user_id: string; mode: 'personal' | 'enterprise' };
  /** Where the device agent publishes the device credential (WSOS-IDN-005). Read on every call so re-enrollment applies. */
  device_credential_path?: string;
  streams: string[];
  modules: Record<string, DataType>;
  interval_ms?: number;
}

const env = process.env;
const home = homedir();
const stateDir = join(env.XDG_STATE_HOME || join(home, '.local/state'), 'worksuite');
const configPath = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'worksuite/sync.json');
const runtimeDir = join(env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`, 'worksuite');
const dbPath = join(stateDir, 'sync.db');

const DEVICE_CREDENTIAL_PATH = '/run/worksuite-device-agent/device-token';

/** The device credential, or null on an unenrolled Personal device. Enterprise servers answer 403 without it. */
export function deviceCredential(path: string): () => string | null {
  return () => {
    try { return readFileSync(path, 'utf8').trim() || null; } catch { return null; }
  };
}

const log = (event: string, fields: Record<string, unknown> = {}) =>
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), service: 'worksuite-sync', event, ...fields }) + '\n');

/**
 * SRS §9.2: on local database corruption, export the outbox first, set the database aside, and start
 * fresh so the next sync rebuilds from the server. Returns the export path when recovery happened.
 */
export function checkIntegrity(path: string, exportDir: string): string | null {
  if (!existsSync(path)) return null;
  let ok = false;
  let outbox: unknown[] = [];
  try {
    const db = new DatabaseSync(path);
    try {
      ok = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check === 'ok';
      if (!ok) outbox = db.prepare(`SELECT * FROM outbox WHERE state IN ('pending','failed')`).all();
    } finally { db.close(); }
  } catch { ok = false; }
  if (ok) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const exported = join(exportDir, `outbox-export-${stamp}.json`);
  writeFileSync(exported, JSON.stringify(outbox, null, 2), { mode: 0o600 });
  for (const ext of ['', '-wal', '-shm']) if (existsSync(path + ext)) renameSync(path + ext, `${path}${ext}.corrupt-${stamp}`);
  return exported;
}

async function main() {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (!existsSync(configPath)) {
    // Not signed in yet: nothing to sync. systemd restarts us after first-run writes the config.
    log('not_configured', { config: configPath });
    process.exit(0);
  }
  const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as SyncConfig;

  // WSOS-SYN-010: with LUKS enabled, refuse to keep WorkSuite data outside the encrypted volume.
  const storage = checkStorage(stateDir, readCrypttab());
  if (!storage.ok) {
    log('storage_unencrypted', { dir: stateDir });
    process.exit(0);
  }

  const exported = checkIntegrity(dbPath, stateDir);
  if (exported) log('database_rebuilt', { outbox_export: exported });

  const db = openDb(dbPath);
  const typeOf = (m: string): DataType => cfg.modules[m] ?? 'document';
  const store = new LocalStore(db, typeOf);
  const a = cfg.account;
  // Insert only when missing: REPLACE would delete the row and trip foreign keys from cached objects.
  if (!db.prepare('SELECT 1 FROM accounts WHERE id=?').get(a.id))
    store.addAccount({ id: a.id, serverUrl: a.server_url, orgId: a.org_id, userId: a.user_id, mode: a.mode });

  const engine = new SyncEngine({
    db, typeOf,
    transport: fetchTransport(a.server_url, deviceCredential(cfg.device_credential_path ?? DEVICE_CREDENTIAL_PATH)),
    tokens: brokerTokens(join(runtimeDir, 'credentials.sock'), a.id),
  });
  const svc = new SyncService({ db, engine, store, streams: cfg.streams, intervalMs: cfg.interval_ms, log });
  const docs = join(home, 'Documents');
  const control = serveControl(join(runtimeDir, 'sync.sock'), svc, existsSync(docs) ? docs : home);

  const shutdown = async (signal: string) => {
    log('stopping', { signal });
    control.close();
    await svc.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  log('started', { db: dbPath, streams: cfg.streams });
  svc.start();
}

if (import.meta.main) main().catch((e) => { log('fatal', { error: String(e?.stack ?? e) }); process.exit(1); });
