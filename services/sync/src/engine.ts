// Push / pull loops (SRS §8.3).
import { randomUUID } from 'node:crypto';
import { tx, type Db } from './db.ts';
import { backoffDelay } from './backoff.ts';
import { resolveConflict, type DataType } from './policy.ts';
import { NetworkError, type Change, type MutationIn, type MutationResult, type SyncTransport, type TokenProvider, type TransportResponse } from './transport.ts';

export interface EngineOptions {
  db: Db;
  transport: SyncTransport;
  tokens: TokenProvider;
  typeOf: (module: string) => DataType;
  now?: () => number;
  rand?: () => number;
  batchSize?: number;
  pageSize?: number;
  /** Bound on pages fetched in one pull, including a full resync (WSOS-SYN-006). */
  maxPages?: number;
}

export type PushOutcome =
  | { kind: 'idle' }
  | { kind: 'done'; acked: number; rejected: number; conflicts: number }
  | { kind: 'retry'; at: number; error: string }
  | { kind: 'auth_required' }      // refresh failed; outbox kept (WSOS-SYN-005)
  | { kind: 'device_revoked' };    // WSOS-IDN-006

type OutboxRow = {
  mutation_id: string; account_id: string; module: string; object_id: string;
  operation: 'create' | 'update' | 'delete'; base_revision: number | null; payload: string | null; attempts: number;
};

const TRANSIENT = new Set([409, 429, 500, 502, 503, 504]);

export class SyncEngine {
  private o: Required<Omit<EngineOptions, 'db' | 'transport' | 'tokens' | 'typeOf'>> & EngineOptions;
  revoked = false;

  constructor(opts: EngineOptions) {
    this.o = { now: Date.now, rand: Math.random, batchSize: 100, pageSize: 500, maxPages: 1000, ...opts };
  }

  private get db() { return this.o.db; }

  /** 401 → exactly one refresh, then one retry. Returns null if refresh fails. */
  private async authed<T>(call: (token: string) => Promise<TransportResponse<T>>): Promise<TransportResponse<T> | null> {
    let res = await call(await this.o.tokens.current());
    if (res.status !== 401) return res;
    let fresh: string;
    try { fresh = await this.o.tokens.refresh(); } catch { return null; }
    return call(fresh);
  }

  async pushOnce(accountId: string): Promise<PushOutcome> {
    if (this.revoked) return { kind: 'device_revoked' };
    const rows = this.db.prepare(`SELECT * FROM outbox WHERE account_id=? AND state='pending' AND next_attempt_at<=?
      ORDER BY seq LIMIT ?`).all(accountId, this.o.now(), this.o.batchSize) as OutboxRow[];
    if (!rows.length) return { kind: 'idle' };

    const mutations: MutationIn[] = rows.map((r) => ({
      mutation_id: r.mutation_id, module: r.module, object_id: r.object_id, operation: r.operation,
      base_revision: r.base_revision, payload: r.payload == null ? null : JSON.parse(r.payload),
      ...(this.o.typeOf(r.module) === 'preference' ? { force: true } : {}),
    }));

    let res: TransportResponse<{ results: MutationResult[] }> | null;
    try {
      res = await this.authed((t) => this.o.transport.postMutations({ batch_id: randomUUID(), mutations }, t));
    } catch (e) {
      if (e instanceof NetworkError) return this.backoff(rows, `network: ${e.message}`);
      throw e;
    }
    if (res === null) return { kind: 'auth_required' };
    if (res.status === 401) return this.backoff(rows, 'unauthorized after refresh');
    if (res.status === 403 && res.body.error.code === 'DEVICE_REVOKED') { this.revoked = true; return { kind: 'device_revoked' }; }
    if (res.status !== 200) {
      if (TRANSIENT.has(res.status)) return this.backoff(rows, `${res.status} ${res.body.error.code}`);
      // Whole-batch 403/413/422: surface against every record, do not retry blindly.
      tx(this.db, () => { for (const r of rows) this.fail(r.mutation_id, res.body.error); });
      return { kind: 'done', acked: 0, rejected: rows.length, conflicts: 0 };
    }

    const byId = new Map(rows.map((r) => [r.mutation_id, r]));
    let acked = 0, rejected = 0, conflicts = 0;
    // WSOS-SYN-002: ack handling is one local transaction.
    tx(this.db, () => {
      for (const result of res.body.results) {
        const row = byId.get(result.mutation_id);
        if (!row) continue; // not ours / already handled
        byId.delete(result.mutation_id);
        const k = this.applyResult(row, result);
        if (k === 'ack') acked++; else if (k === 'rejected') rejected++; else conflicts++;
      }
    });
    // Mutations missing from the response stay pending and are retried with backoff.
    const missing = [...byId.values()];
    if (missing.length) this.backoff(missing, 'no result returned');
    return { kind: 'done', acked, rejected, conflicts };
  }

  private applyResult(row: OutboxRow, r: MutationResult): 'ack' | 'rejected' | 'conflict' {
    const key = [row.account_id, row.module, row.object_id] as const;
    const del = this.db.prepare('DELETE FROM outbox WHERE mutation_id=?');
    if (r.status === 'applied' || r.status === 'duplicate') {
      del.run(row.mutation_id);
      this.db.prepare('UPDATE objects SET server_revision=? WHERE account_id=? AND module=? AND object_id=?').run(r.revision, ...key);
      // Our own queued follow-up edits now build on the acked revision.
      this.db.prepare(`UPDATE outbox SET base_revision=? WHERE account_id=? AND module=? AND object_id=?`).run(r.revision, ...key);
      return 'ack';
    }
    if (r.status === 'rejected') { this.fail(row.mutation_id, r.error); return 'rejected'; }

    const c = r as Extract<MutationResult, { status: 'conflict' }>;
    const action = resolveConflict(this.o.typeOf(row.module), row.operation, !!c.server_deleted);
    if (action.kind === 'force') {
      // LWW type got a conflict anyway (server lacked force support): rebase and resend.
      this.db.prepare('UPDATE outbox SET base_revision=? WHERE mutation_id=?').run(r.revision, row.mutation_id);
      return 'conflict';
    }
    if (action.kind === 'keep_both') {
      this.db.prepare(`INSERT INTO conflicts(account_id, module, object_id, mutation_id, local_version, server_version, server_revision, reason, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(...key, row.mutation_id, row.payload, JSON.stringify(c.server_version ?? null), r.revision, action.reason, this.o.now());
    }
    del.run(row.mutation_id);
    // Drop any later local edits to the same object into the conflict record too — never silently.
    const later = this.db.prepare('SELECT mutation_id, payload FROM outbox WHERE account_id=? AND module=? AND object_id=?').all(...key) as any[];
    for (const l of later) {
      this.db.prepare(`INSERT INTO conflicts(account_id, module, object_id, mutation_id, local_version, server_version, server_revision, reason, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(...key, l.mutation_id, l.payload, JSON.stringify(c.server_version ?? null), r.revision, 'superseded_by_conflict', this.o.now());
      del.run(l.mutation_id);
    }
    this.db.prepare(`INSERT INTO objects(account_id, module, object_id, data, server_revision, deleted, updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(account_id, module, object_id) DO UPDATE SET data=excluded.data, server_revision=excluded.server_revision, deleted=excluded.deleted, updated_at=excluded.updated_at`)
      .run(...key, c.server_deleted ? null : JSON.stringify(c.server_version ?? null), r.revision, c.server_deleted ? 1 : 0, this.o.now());
    return 'conflict';
  }

  private fail(mutationId: string, error: unknown) {
    this.db.prepare(`UPDATE outbox SET state='failed', last_error=? WHERE mutation_id=?`).run(JSON.stringify(error), mutationId);
  }

  private backoff(rows: OutboxRow[], error: string): PushOutcome {
    let at = Infinity;
    const st = this.db.prepare('UPDATE outbox SET attempts=?, next_attempt_at=?, last_error=? WHERE mutation_id=?');
    for (const r of rows) {
      const attempts = r.attempts + 1;
      const next = this.o.now() + backoffDelay(attempts, this.o.rand());
      st.run(attempts, next, error, r.mutation_id);
      at = Math.min(at, next);
    }
    return { kind: 'retry', at, error };
  }

  /** User action on a failed record: retry it now (e.g. after fixing a field). */
  retryFailed(mutationId: string) {
    this.db.prepare(`UPDATE outbox SET state='pending', attempts=0, next_attempt_at=0 WHERE mutation_id=?`).run(mutationId);
  }

  /**
   * Pull one stream. Each page applies changes + advances the cursor in one transaction.
   * 410 CURSOR_EXPIRED → bounded full resync of that stream (WSOS-SYN-006).
   */
  async pull(accountId: string, stream: string): Promise<{ applied: number; resynced: boolean } | { kind: 'auth_required' | 'device_revoked' }> {
    if (this.revoked) return { kind: 'device_revoked' };
    const cur = this.db.prepare('SELECT cursor FROM sync_cursors WHERE account_id=? AND stream=?').get(accountId, stream) as { cursor: string | null } | undefined;
    let cursor = cur?.cursor ?? null;
    let resynced = false, applied = 0;
    const seen = new Set<string>();

    for (let page = 0; page < this.o.maxPages; page++) {
      const res = await this.authed((t) => this.o.transport.getChanges({ stream, cursor, limit: this.o.pageSize }, t));
      if (res === null) return { kind: 'auth_required' };
      if (res.status === 410 && !resynced) { resynced = true; cursor = null; page = -1; continue; }
      if (res.status === 403 && res.body.error.code === 'DEVICE_REVOKED') { this.revoked = true; return { kind: 'device_revoked' }; }
      if (res.status !== 200) throw new Error(`changes ${stream}: ${res.status} ${res.body.error.code}`);
      const body = res.body;
      tx(this.db, () => {
        for (const c of body.changes) { if (this.applyChange(accountId, c)) applied++; if (resynced) seen.add(`${c.module}\0${c.object_id}`); }
        this.db.prepare(`INSERT INTO sync_cursors(account_id, stream, cursor, updated_at) VALUES (?,?,?,?)
          ON CONFLICT(account_id, stream) DO UPDATE SET cursor=excluded.cursor, updated_at=excluded.updated_at`)
          .run(accountId, stream, body.next_cursor, this.o.now());
        if (resynced && !body.has_more) this.sweep(accountId, stream, seen);
      });
      cursor = body.next_cursor;
      if (!body.has_more) return { applied, resynced };
    }
    return { applied, resynced };
  }

  /** Server change → local. Objects with pending local mutations are left alone; push resolves them. */
  private applyChange(accountId: string, c: Change): boolean {
    const pending = this.db.prepare(`SELECT 1 FROM outbox WHERE account_id=? AND module=? AND object_id=? AND state='pending' LIMIT 1`)
      .get(accountId, c.module, c.object_id);
    if (pending) return false;
    const r = this.db.prepare(`INSERT INTO objects(account_id, module, object_id, data, server_revision, deleted, updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(account_id, module, object_id) DO UPDATE SET data=excluded.data, server_revision=excluded.server_revision, deleted=excluded.deleted, updated_at=excluded.updated_at
      WHERE objects.server_revision IS NULL OR objects.server_revision < excluded.server_revision`)
      .run(accountId, c.module, c.object_id, c.deleted ? null : JSON.stringify(c.data), c.revision, c.deleted ? 1 : 0, this.o.now());
    return Number(r.changes) > 0;
  }

  /** After a full resync, drop synced objects of this stream the server no longer has. Stream name = module. */
  private sweep(accountId: string, stream: string, seen: Set<string>) {
    const rows = this.db.prepare(`SELECT module, object_id FROM objects o WHERE account_id=? AND module=? AND server_revision IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM outbox x WHERE x.account_id=o.account_id AND x.module=o.module AND x.object_id=o.object_id)`)
      .all(accountId, stream) as { module: string; object_id: string }[];
    const del = this.db.prepare('DELETE FROM objects WHERE account_id=? AND module=? AND object_id=?');
    for (const r of rows) if (!seen.has(`${r.module}\0${r.object_id}`)) del.run(accountId, r.module, r.object_id);
  }
}
