import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, MIGRATIONS } from '../src/db.ts';
import { LocalStore } from '../src/store.ts';
import { SyncEngine } from '../src/engine.ts';
import { backoffDelay, BACKOFF_CAP_MS } from '../src/backoff.ts';
import { conflictCopyName, resolveConflict, type DataType } from '../src/policy.ts';
import { FakeServer } from './fake-server.ts';

const types: Record<string, DataType> = { prefs: 'preference', docs: 'document', chat: 'message', payroll: 'authoritative', invalid: 'document' };
const typeOf = (m: string) => types[m] ?? 'document';
const A = 'acct1';

function setup(server = new FakeServer(), path = ':memory:', tokens = server.tokens()) {
  const db = openDb(path);
  const store = new LocalStore(db, typeOf);
  store.addAccount({ id: A, serverUrl: 'https://ws.example', orgId: 'o', userId: 'u', mode: 'enterprise' });
  let clock = 1_000;
  const engine = new SyncEngine({ db, transport: server.transport(), tokens, typeOf, now: () => clock, rand: () => 0.5 });
  return { db, store, engine, server, tokens, tick: (ms: number) => { clock += ms; } };
}

test('schema: all tables exist and migrations are recorded once', () => {
  const db = openDb();
  const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((r) => r.name);
  for (const t of ['accounts', 'objects', 'outbox', 'sync_cursors', 'conflicts', 'file_cache', 'schema_migrations']) assert.ok(names.includes(t), t);
  const v = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
  assert.equal(v.n, MIGRATIONS.length);
});

test('local write is atomic: object + outbox together, or neither', () => {
  const { db, store } = setup();
  store.write({ accountId: A, module: 'docs', objectId: 'd1', operation: 'create', data: { t: 1 } });
  assert.deepEqual(store.read(A, 'docs', 'd1'), { t: 1 });
  assert.equal(store.pending(A).length, 1);
  // Unknown account violates FK on outbox → object write must roll back too.
  assert.throws(() => store.write({ accountId: 'nope', module: 'docs', objectId: 'd2', operation: 'create', data: {} }));
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM objects WHERE object_id='d2'`).get()!.n, 0);
});

test('§13.1 duplicate mutation → one business effect', async () => {
  const { store, engine, server } = setup();
  store.write({ accountId: A, module: 'docs', objectId: 'd1', operation: 'create', data: { t: 1 } });
  const batch = store.pending(A);
  await engine.pushOnce(A);
  // Replay the exact same mutation (e.g. proxy retry).
  const r = server.apply({ mutation_id: batch[0].mutation_id, module: 'docs', object_id: 'd1', operation: 'create', base_revision: null, payload: { t: 1 } });
  assert.equal(r.status, 'duplicate');
  assert.equal(server.effects, 1);
});

test('§13.1 crash after server commit, before client ack → no duplicate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wsync-'));
  try {
    const server = new FakeServer();
    const s1 = setup(server, join(dir, 'state.db'));
    s1.store.write({ accountId: A, module: 'docs', objectId: 'd1', operation: 'create', data: { t: 1 } });
    server.dropResponseOnce = true;
    const out = await s1.engine.pushOnce(A);
    assert.equal(out.kind, 'retry');
    assert.equal(server.effects, 1);
    s1.db.close(); // "crash": process gone, outbox row still on disk

    const s2 = setup(server, join(dir, 'state.db'));
    assert.equal(s2.store.pending(A).length, 1);
    s2.tick(10 * 60_000);
    const out2 = await s2.engine.pushOnce(A);
    assert.deepEqual(out2, { kind: 'done', acked: 1, rejected: 0, conflicts: 0 });
    assert.equal(server.effects, 1, 'server applied once');
    assert.equal(s2.store.pending(A).length, 0);
    assert.equal(s2.store.get(A, 'docs', 'd1')!.server_revision, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('§13.1 two offline edits of one document → conflict kept, no silent loss', async () => {
  const server = new FakeServer();
  const a = setup(server), b = setup(server);
  a.store.write({ accountId: A, module: 'docs', objectId: 'd1', operation: 'create', data: { v: 'base' } });
  await a.engine.pushOnce(A);
  await b.engine.pull(A, 'docs');
  // Both go offline and edit from revision 1.
  a.store.write({ accountId: A, module: 'docs', objectId: 'd1', operation: 'update', data: { v: 'from A' } });
  b.store.write({ accountId: A, module: 'docs', objectId: 'd1', operation: 'update', data: { v: 'from B' } });
  assert.equal((await a.engine.pushOnce(A) as any).acked, 1);
  assert.equal((await b.engine.pushOnce(A) as any).conflicts, 1);
  const [c] = b.store.conflicts(A);
  assert.deepEqual(JSON.parse(c.local_version), { v: 'from B' });
  assert.deepEqual(JSON.parse(c.server_version), { v: 'from A' });
  assert.equal(c.reason, 'revision_mismatch');
  assert.deepEqual(b.store.read(A, 'docs', 'd1'), { v: 'from A' });
  assert.equal(b.store.pending(A).length, 0);
});

test('§13.1 expired token → one refresh, pending changes kept on refresh failure', async () => {
  const server = new FakeServer();
  let refreshWorks = false;
  const tokens = server.tokens('stale', () => refreshWorks);
  const { store, engine } = setup(server, ':memory:', tokens);
  store.write({ accountId: A, module: 'docs', objectId: 'd1', operation: 'create', data: { t: 1 } });
  assert.deepEqual(await engine.pushOnce(A), { kind: 'auth_required' });
  assert.equal(tokens.refreshes, 1, 'exactly one refresh per 401');
  assert.equal(store.pending(A).length, 1, 'never discarded');
  refreshWorks = true;
  assert.equal((await engine.pushOnce(A) as any).acked, 1);
  assert.equal(tokens.refreshes, 2);
  assert.equal(server.effects, 1);
});

test('validation error surfaced per record and not retried', async () => {
  const { store, engine, server } = setup();
  store.write({ accountId: A, module: 'invalid', objectId: 'x', operation: 'create', data: {} });
  store.write({ accountId: A, module: 'docs', objectId: 'ok', operation: 'create', data: {} });
  assert.deepEqual(await engine.pushOnce(A), { kind: 'done', acked: 1, rejected: 1, conflicts: 0 });
  const [f] = store.failed(A);
  assert.equal(f.object_id, 'x');
  assert.equal(JSON.parse(f.last_error).field, 'title');
  assert.deepEqual(await engine.pushOnce(A), { kind: 'idle' });
  assert.equal(server.effects, 1);
});

test('transient failure backs off with jitter and keeps the mutation', async () => {
  const { store, engine, server, tick } = setup();
  server.failNext = 1;
  store.write({ accountId: A, module: 'docs', objectId: 'd1', operation: 'create', data: {} });
  const r = await engine.pushOnce(A);
  assert.equal(r.kind, 'retry');
  assert.deepEqual(await engine.pushOnce(A), { kind: 'idle' }, 'not before next_attempt_at');
  tick(1_000);
  assert.equal((await engine.pushOnce(A) as any).acked, 1);
});

test('backoff: 1 s start, doubling, 5 min cap, jitter within [d/2, d]', () => {
  assert.equal(backoffDelay(1, 1), 1_000);
  assert.equal(backoffDelay(1, 0), 500);
  assert.equal(backoffDelay(4, 1), 8_000);
  assert.equal(backoffDelay(50, 1), BACKOFF_CAP_MS);
  assert.ok(backoffDelay(50, 0.999) <= BACKOFF_CAP_MS);
});

test('expired cursor → bounded full resync of the stream, stale objects swept', async () => {
  const server = new FakeServer();
  const w = setup(server), r = setup(server);
  w.store.write({ accountId: A, module: 'docs', objectId: 'keep', operation: 'create', data: { k: 1 } });
  w.store.write({ accountId: A, module: 'docs', objectId: 'gone', operation: 'create', data: { g: 1 } });
  await w.engine.pushOnce(A);
  await r.engine.pull(A, 'docs');
  assert.deepEqual(r.store.read(A, 'docs', 'gone'), { g: 1 });
  server.objects.delete('docs/gone'); // purged past tombstone window
  server.oldestCursor = 99;
  const out = await r.engine.pull(A, 'docs');
  assert.equal((out as any).resynced, true);
  assert.equal(r.store.get(A, 'docs', 'gone'), undefined);
  assert.deepEqual(r.store.read(A, 'docs', 'keep'), { k: 1 });
});

test('ack and cursor advance are transactional; pull does not clobber pending local edits', async () => {
  const server = new FakeServer();
  const w = setup(server), r = setup(server);
  w.store.write({ accountId: A, module: 'docs', objectId: 'd', operation: 'create', data: { v: 1 } });
  await w.engine.pushOnce(A);
  await r.engine.pull(A, 'docs');
  r.store.write({ accountId: A, module: 'docs', objectId: 'd', operation: 'update', data: { v: 'local' } });
  w.store.write({ accountId: A, module: 'docs', objectId: 'd', operation: 'update', data: { v: 'remote' } });
  await w.engine.pushOnce(A);
  await r.engine.pull(A, 'docs');
  assert.deepEqual(r.store.read(A, 'docs', 'd'), { v: 'local' });
  const cur = r.db.prepare('SELECT cursor FROM sync_cursors WHERE stream=?').get('docs') as any;
  assert.equal(cur.cursor, '2');
});

test('conflict policy per data type', async () => {
  assert.deepEqual(resolveConflict('preference', 'update', false), { kind: 'force' });
  assert.deepEqual(resolveConflict('message', 'create', false), { kind: 'accept_server' });
  assert.deepEqual(resolveConflict('authoritative', 'update', false), { kind: 'accept_server' });
  assert.deepEqual(resolveConflict('document', 'update', true), { kind: 'keep_both', reason: 'delete_vs_edit' });
  assert.deepEqual(resolveConflict('document', 'delete', false), { kind: 'keep_both', reason: 'delete_vs_edit' });

  // Preferences: last write wins even from a stale base.
  const server = new FakeServer();
  const a = setup(server), b = setup(server);
  a.store.write({ accountId: A, module: 'prefs', objectId: 'theme', operation: 'create', data: 'dark' });
  b.store.write({ accountId: A, module: 'prefs', objectId: 'theme', operation: 'create', data: 'light' });
  await a.engine.pushOnce(A); await b.engine.pushOnce(A);
  assert.equal(server.objects.get('prefs/theme')!.data, 'light');

  // Authoritative: offline action is a request; not applied locally.
  a.store.write({ accountId: A, module: 'payroll', objectId: 'p1', operation: 'update', data: { approve: true } });
  assert.equal(a.store.read(A, 'payroll', 'p1'), undefined);
  assert.equal(a.store.pending(A).length, 1);
});

test('Drive conflict copy name', () => {
  const d = new Date('2026-10-15T09:30:00Z');
  assert.equal(conflictCopyName('Budget.xlsx', 'lap-01', d), 'Budget (conflict lap-01 2026-10-15).xlsx');
  assert.equal(conflictCopyName('README', 'a/b', d), 'README (conflict a-b 2026-10-15)');
  assert.equal(conflictCopyName('.bashrc', 'pc', d), '.bashrc (conflict pc 2026-10-15)');
});
