import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { LocalStore } from '../src/store.ts';
import { SyncEngine } from '../src/engine.ts';
import { SyncService } from '../src/service.ts';
import { serveControl } from '../src/control.ts';
import { checkIntegrity } from '../src/main.ts';
import { FakeServer } from './fake-server.ts';

const A = 'acct1';

function setup(server = new FakeServer(), tokens = server.tokens()) {
  const db = openDb();
  const store = new LocalStore(db, () => 'document');
  store.addAccount({ id: A, serverUrl: 'https://ws.example', orgId: 'o', userId: 'u', mode: 'enterprise' });
  const engine = new SyncEngine({ db, transport: server.transport(), tokens, typeOf: () => 'document', rand: () => 0 });
  const svc = new SyncService({ db, engine, store, streams: ['docs'], intervalMs: 3_600_000 });
  return { db, store, engine, svc, server };
}

test('a cycle pushes the outbox and pulls streams', async () => {
  const { store, svc, server } = setup();
  store.write({ accountId: A, module: 'docs', objectId: 'd1', operation: 'create', data: { t: 1 } });
  await svc.syncNow();
  assert.equal(server.effects, 1);
  assert.deepEqual({ ...svc.status(), last_sync: null }, { state: 'idle', last_sync: null, last_error: null, pending: 0, failed: 0, conflicts: 0 });
  assert.ok(svc.lastSync);
  await svc.stop();
});

test('server unavailable: changes stay pending and state is offline', async () => {
  const { store, svc, server } = setup();
  server.failNext = 1;
  store.write({ accountId: A, module: 'docs', objectId: 'd1', operation: 'create', data: { t: 1 } });
  await svc.syncNow();
  assert.equal(svc.state, 'offline');
  assert.equal(svc.status().pending, 1);
  assert.equal(server.effects, 0);
  await svc.stop();
});

test('failed refresh: auth_required, outbox kept, no polling', async () => {
  const server = new FakeServer();
  const { store, svc } = setup(server, server.tokens('stale', () => false));
  store.write({ accountId: A, module: 'docs', objectId: 'd1', operation: 'create', data: { t: 1 } });
  await svc.syncNow();
  assert.equal(svc.state, 'auth_required');
  assert.equal(svc.status().pending, 1);
  await svc.stop();
});

test('concurrent SyncNow calls coalesce into one follow-up cycle', async () => {
  const { store, svc, server } = setup();
  store.write({ accountId: A, module: 'docs', objectId: 'd1', operation: 'create', data: { t: 1 } });
  const first = svc.syncNow();
  store.write({ accountId: A, module: 'docs', objectId: 'd2', operation: 'create', data: { t: 2 } });
  void svc.syncNow(); void svc.syncNow();
  await first;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(server.effects, 2);
  await svc.stop();
});

test('control socket answers Status and rejects bad arguments', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-sync-'));
  const { svc } = setup();
  const path = join(dir, 'sync.sock');
  const srv = serveControl(path, svc);
  await new Promise((r) => srv.once('listening', r));
  const call = (line: string) => new Promise<any>((resolve) => {
    const s = createConnection(path);
    let buf = '';
    s.on('data', (c) => { buf += c; if (buf.includes('\n')) { s.end(); resolve(JSON.parse(buf)); } });
    s.write(line + '\n');
  });
  assert.equal((await call('{"id":1,"method":"Status"}')).result.state, 'idle');
  assert.equal((await call('{"method":"RetryFailed","params":{"mutation_id":"x; rm -rf /"}}')).error, 'invalid_argument');
  assert.equal((await call('not json')).error, 'bad_request');
  srv.close();
  await svc.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('corrupt database: outbox exported, file set aside', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-sync-'));
  const path = join(dir, 'sync.db');
  writeFileSync(path, 'this is not a sqlite database');
  const exported = checkIntegrity(path, dir);
  assert.ok(exported && existsSync(exported));
  assert.deepEqual(JSON.parse(readFileSync(exported, 'utf8')), []);
  assert.ok(!existsSync(path));
  assert.ok(readdirSync(dir).some((f) => f.startsWith('sync.db.corrupt-')));

  const healthy = join(dir, 'ok.db');
  openDb(healthy).close();
  assert.equal(checkIntegrity(healthy, dir), null);
  rmSync(dir, { recursive: true, force: true });
});

test('sign-out with unsent changes: count, export to a private file, then forget the account', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-sync-'));
  const { store, svc, server, db } = setup();
  server.failNext = 5;
  store.write({ accountId: A, module: 'docs', objectId: 'd1', operation: 'create', data: { t: 'draft' } });
  await svc.syncNow();
  assert.equal(svc.unsent(A), 1);

  const path = svc.exportUnsent(A, dir);
  const out = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(out.account_id, A);
  assert.deepEqual(out.changes[0].payload, { t: 'draft' });
  assert.equal(statSync(path).mode & 0o777, 0o600);

  svc.forgetAccount(A);
  for (const t of ['outbox', 'objects', 'accounts']) assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, 0, t);
  assert.equal(server.effects, 0, 'discarded changes never reach the server');
  await svc.stop();
  rmSync(dir, { recursive: true, force: true });
});
