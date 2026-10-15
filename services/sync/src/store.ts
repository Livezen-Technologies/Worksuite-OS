// Local writes: object update + outbox enqueue in ONE transaction (SRS §8.2).
import { randomUUID } from 'node:crypto';
import { tx, type Db } from './db.ts';
import { appliesLocally, type DataType } from './policy.ts';

export interface LocalWrite {
  accountId: string;
  module: string;
  objectId: string;
  operation: 'create' | 'update' | 'delete';
  data?: unknown;
}

export class LocalStore {
  constructor(readonly db: Db, readonly typeOf: (module: string) => DataType, private now = () => Date.now()) {}

  addAccount(a: { id: string; serverUrl: string; orgId: string; userId: string; mode: 'personal' | 'enterprise' }) {
    this.db.prepare('INSERT OR REPLACE INTO accounts(id, server_url, org_id, user_id, mode) VALUES (?,?,?,?,?)')
      .run(a.id, a.serverUrl, a.orgId, a.userId, a.mode);
  }

  write(w: LocalWrite): string {
    const mutationId = randomUUID();
    tx(this.db, () => {
      const obj = this.get(w.accountId, w.module, w.objectId);
      // A later edit on an object with an in-flight mutation keeps the same base: our own chain.
      const base = obj?.server_revision ?? null;
      if (appliesLocally(this.typeOf(w.module))) {
        const deleted = w.operation === 'delete' ? 1 : 0;
        this.db.prepare(`INSERT INTO objects(account_id, module, object_id, data, server_revision, deleted, updated_at)
          VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(account_id, module, object_id) DO UPDATE SET data=excluded.data, deleted=excluded.deleted, updated_at=excluded.updated_at`)
          .run(w.accountId, w.module, w.objectId, deleted ? null : JSON.stringify(w.data ?? null), base, deleted, this.now());
      }
      const seq = (this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS s FROM outbox').get() as { s: number }).s;
      this.db.prepare(`INSERT INTO outbox(mutation_id, account_id, module, object_id, operation, base_revision, payload, created_at, seq)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(mutationId, w.accountId, w.module, w.objectId, w.operation, base,
          w.operation === 'delete' ? null : JSON.stringify(w.data ?? null), this.now(), seq);
    });
    return mutationId;
  }

  get(accountId: string, module: string, objectId: string) {
    return this.db.prepare('SELECT * FROM objects WHERE account_id=? AND module=? AND object_id=?')
      .get(accountId, module, objectId) as
      | { data: string | null; server_revision: number | null; deleted: number; updated_at: number }
      | undefined;
  }

  read<T = unknown>(accountId: string, module: string, objectId: string): T | undefined {
    const o = this.get(accountId, module, objectId);
    return o && !o.deleted && o.data != null ? (JSON.parse(o.data) as T) : undefined;
  }

  pending(accountId: string) {
    return this.db.prepare(`SELECT * FROM outbox WHERE account_id=? AND state='pending' ORDER BY seq`).all(accountId) as any[];
  }

  /** WSOS-SYN-004: per-record errors for the UI. */
  failed(accountId: string) {
    return this.db.prepare(`SELECT mutation_id, module, object_id, last_error FROM outbox WHERE account_id=? AND state='failed' ORDER BY seq`)
      .all(accountId) as { mutation_id: string; module: string; object_id: string; last_error: string }[];
  }

  conflicts(accountId: string) {
    return this.db.prepare('SELECT * FROM conflicts WHERE account_id=? ORDER BY id').all(accountId) as any[];
  }
}
