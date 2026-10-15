// Long-running sync loop around SyncEngine: push until idle, pull each stream, sleep until the next due time.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tx, type Db } from './db.ts';
import type { SyncEngine } from './engine.ts';
import { LocalStore } from './store.ts';

export interface ServiceOptions {
  db: Db;
  engine: SyncEngine;
  store: LocalStore;
  streams: string[];
  /** Pull cadence when nothing is pending. */
  intervalMs?: number;
  now?: () => number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export type ServiceState = 'idle' | 'syncing' | 'auth_required' | 'device_revoked' | 'offline' | 'stopped';

export class SyncService {
  state: ServiceState = 'idle';
  lastSync: number | null = null;
  lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private readonly o: Required<Omit<ServiceOptions, 'log'>> & Pick<ServiceOptions, 'log'>;

  constructor(opts: ServiceOptions) {
    this.o = { intervalMs: 60_000, now: Date.now, ...opts };
  }

  start() { this.syncNow(); }

  /** Run a cycle now; if one is in flight, run another right after it. */
  syncNow(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) { this.again = true; return this.running; }
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.running = this.cycle().finally(() => {
      this.running = null;
      if (this.again) { this.again = false; void this.syncNow(); }
    });
    return this.running;
  }

  /** Let an in-flight cycle finish, then close the database (WSOS-SES-003). */
  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running?.catch(() => {});
    this.state = 'stopped';
    this.o.db.close();
  }

  status() {
    const accounts = this.accounts();
    const count = (fn: (a: string) => unknown[]) => accounts.reduce((n, a) => n + fn(a).length, 0);
    return {
      state: this.state,
      last_sync: this.lastSync,
      last_error: this.lastError,
      pending: count((a) => this.o.store.pending(a)),
      failed: count((a) => this.o.store.failed(a)),
      conflicts: count((a) => this.o.store.conflicts(a)),
    };
  }

  listFailed() { return this.accounts().flatMap((a) => this.o.store.failed(a)); }

  /** Unsent = pending or failed outbox rows (WSOS-SYN-008). */
  unsent(accountId: string): number {
    return (this.o.db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE account_id=?`).get(accountId) as { n: number }).n;
  }

  /** Sign-out choice "export": write unsent changes to a 0600 JSON file the user keeps. Returns its path. */
  exportUnsent(accountId: string, dir: string): string {
    const rows = this.o.db.prepare(`SELECT mutation_id, module, object_id, operation, base_revision, payload, state, last_error, created_at
      FROM outbox WHERE account_id=? ORDER BY seq`).all(accountId) as { payload: string | null }[];
    const stamp = new Date(this.o.now()).toISOString().replace(/[:.]/g, '-');
    const path = join(dir, `WorkSuite unsent changes ${stamp}.json`);
    const changes = rows.map((r) => ({ ...r, payload: r.payload == null ? null : JSON.parse(r.payload) }));
    writeFileSync(path, JSON.stringify({ account_id: accountId, exported_at: new Date(this.o.now()).toISOString(), changes }, null, 2), { mode: 0o600, flag: 'wx' });
    return path;
  }

  /**
   * Sign-out cleanup ("export" after writing the file, or "discard" after the user confirmed): drop this account's
   * local WorkSuite state in one transaction so nothing half-synced survives. The next sign-in rebuilds from the server.
   */
  forgetAccount(accountId: string) {
    tx(this.o.db, () => {
      for (const t of ['outbox', 'conflicts', 'objects', 'sync_cursors', 'file_cache']) this.o.db.prepare(`DELETE FROM ${t} WHERE account_id=?`).run(accountId);
      this.o.db.prepare('DELETE FROM accounts WHERE id=?').run(accountId);
    });
  }

  retryFailed(mutationId: string) { this.o.engine.retryFailed(mutationId); return this.syncNow(); }

  private accounts(): string[] {
    return (this.o.db.prepare('SELECT id FROM accounts ORDER BY id').all() as { id: string }[]).map((r) => r.id);
  }

  private async cycle() {
    this.state = 'syncing';
    let next = this.o.now() + this.o.intervalMs;
    let outcome: ServiceState = 'idle';
    try {
      for (const account of this.accounts()) {
        // Push until the due part of the outbox is empty or the server asks us to wait.
        for (;;) {
          const r = await this.o.engine.pushOnce(account);
          if (r.kind === 'done') continue;
          if (r.kind === 'retry') { next = Math.min(next, r.at); outcome = 'offline'; this.lastError = r.error; }
          if (r.kind === 'auth_required' || r.kind === 'device_revoked') outcome = r.kind;
          break;
        }
        if (outcome === 'auth_required' || outcome === 'device_revoked') break;
        if (outcome === 'offline') continue;
        for (const stream of this.o.streams) {
          const p = await this.o.engine.pull(account, stream);
          if ('kind' in p) { outcome = p.kind; break; }
          if (p.resynced) this.o.log?.('stream_resynced', { account, stream });
        }
      }
      if (outcome === 'idle') { this.lastSync = this.o.now(); this.lastError = null; }
    } catch (e) {
      // Network errors on pull and unexpected server errors: keep data, retry on the next tick.
      outcome = 'offline';
      this.lastError = e instanceof Error ? e.message : String(e);
    }
    this.state = outcome;
    this.o.log?.('sync_cycle', { state: outcome, error: this.lastError });
    // Revoked devices and expired sign-ins wait for an explicit SyncNow (after sign-in) instead of polling.
    if (!this.stopped && outcome !== 'device_revoked' && outcome !== 'auth_required') {
      this.timer = setTimeout(() => void this.syncNow(), Math.max(0, next - this.o.now()));
      this.timer.unref?.();
    }
  }
}
