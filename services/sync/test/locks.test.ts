// WSOS-DRV-003: the Drive file lock taken while a document is open in WorkSuite Office.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { FileLocks, type LockCall } from '../src/locks.ts';
import { NetworkError } from '../src/transport.ts';
import { serveControl } from '../src/control.ts';

function setup(answer: (method: string, id: string, token: string) => { status: number; body: unknown } | Error) {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO file_cache (account_id, file_id, path, state) VALUES ('a', 'f-42', 'Reports/Q3.docx', 'synced')`).run();
  const calls: string[] = [];
  const call: LockCall = async (m, id, t) => { calls.push(`${m} ${id} ${t}`); const r = answer(m, id, t); if (r instanceof Error) throw r; return r; };
  let tok = 't1';
  const locks = new FileLocks({ db, call, tokens: { current: async () => tok, refresh: async () => (tok = 't2') }, refreshMs: 20 });
  return { db, locks, calls };
}

test('locks a synced document by path, refreshes it, and releases it', async () => {
  const { locks, calls } = setup((m) => (m === 'POST' ? { status: 200, body: { lock_id: 'L1', expires_at: 'x' } } : { status: 204, body: null }));
  assert.deepEqual(await locks.lock('Reports/Q3.docx'), { ok: true, lock_id: 'L1' });
  assert.deepEqual(await locks.lock('Reports/Q3.docx'), { ok: true, lock_id: 'L1' });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(calls.filter((c) => c.startsWith('POST')).length >= 2, 'refreshed before the server TTL');
  assert.equal(await locks.unlock('Reports/Q3.docx'), true);
  assert.equal(calls.at(-1), 'DELETE f-42 t1');
  const n = calls.length;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, n, 'no refresh after release');
  assert.equal(await locks.unlock('Reports/Q3.docx'), false);
});

test('reports a lock held by someone else, unknown files, offline and token refresh', async () => {
  assert.deepEqual(await setup(() => ({ status: 409, body: { error: { code: 'LOCKED' } } })).locks.lock('Reports/Q3.docx'), { ok: false, error: 'locked' });
  assert.deepEqual(await setup(() => ({ status: 200, body: {} })).locks.lock('Other.docx'), { ok: false, error: 'not_synced' });
  assert.deepEqual(await setup(() => new NetworkError('down')).locks.lock('Reports/Q3.docx'), { ok: false, error: 'offline' });
  const s = setup((_m, _id, t) => (t === 't1' ? { status: 401, body: {} } : { status: 200, body: { lock_id: 'L2' } }));
  assert.deepEqual(await s.locks.lock('Reports/Q3.docx'), { ok: true, lock_id: 'L2' });
  assert.deepEqual(s.calls, ['POST f-42 t1', 'POST f-42 t2']);
  await s.locks.releaseAll();
});

test('control socket: LockFile/UnlockFile validate the path', async () => {
  const { locks } = setup(() => ({ status: 200, body: { lock_id: 'L3' } }));
  const sock = join(mkdtempSync(join(tmpdir(), 'locks-')), 'sync.sock');
  const fakeSvc = {} as never;
  const srv = serveControl(sock, fakeSvc, '.', locks);
  await new Promise((r) => srv.once('listening', r));
  const ask = (req: unknown) => new Promise<any>((resolve) => {
    const c = createConnection(sock); let buf = '';
    c.on('data', (d) => { buf += d; if (buf.includes('\n')) { c.end(); resolve(JSON.parse(buf)); } });
    c.write(JSON.stringify(req) + '\n');
  });
  assert.deepEqual(await ask({ id: 1, method: 'LockFile', params: { path: '../etc/passwd' } }), { id: 1, error: 'invalid_argument' });
  assert.deepEqual(await ask({ id: 2, method: 'LockFile', params: { path: 'Reports/Q3.docx' } }), { id: 2, result: { ok: true, lock_id: 'L3' } });
  assert.deepEqual(await ask({ id: 3, method: 'UnlockFile', params: { path: 'Reports/Q3.docx' } }), { id: 3, result: true });
  srv.close();
});
