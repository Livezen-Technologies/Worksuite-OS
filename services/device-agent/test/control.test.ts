import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controlDispatch, serveControl, type ControlHandlers } from '../src/control.ts';

const handlers = (log: string[] = []): ControlHandlers => ({
  enroll: async (u, t) => { log.push(`enroll ${u} ${t.length}`); return 'dev-1'; },
  refresh: async () => { log.push('refresh'); return { enrolled: true }; },
  status: () => ({ enrolled: false }),
});

test('WSOS-SEC-007: control requests are validated before any handler runs', async () => {
  const log: string[] = [];
  const h = handlers(log);
  for (const l of ['null', '[]', '7', '{"method":5}', 'nope']) assert.equal((await controlDispatch(h, l)).error, 'bad_request', l);
  for (const p of ['null', '"x"', '{"server_url":"http://evil","enrollment_token":"t"}', '{"server_url":"https://ok","enrollment_token":""}',
    '{"server_url":"https://ok","enrollment_token":{"a":1}}', '{"server_url":"https://a b","enrollment_token":"t"}']) {
    assert.equal((await controlDispatch(h, `{"method":"Enroll","params":${p}}`)).error, 'invalid_argument', p);
  }
  assert.deepEqual(log, []);
  assert.equal((await controlDispatch(h, '{"method":"Wipe"}')).error, 'unknown_method');
  assert.deepEqual(await controlDispatch(h, '{"method":"Enroll","params":{"server_url":"https://ws.example","enrollment_token":"tok"}}'), { result: 'dev-1' });
  assert.deepEqual(log, ['enroll https://ws.example 3']);
  const failing = { ...h, refresh: async () => { throw new Error('NETWORK'); } };
  assert.deepEqual(await controlDispatch(failing, '{"method":"Refresh"}'), { error: 'NETWORK' });
});

test('WSOS-SEC-007: the socket is 0600 in a 0700 directory and survives hostile clients', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'ws-da-')), 'run');
  const path = join(dir, 'control.sock');
  const srv = serveControl(path, handlers());
  await new Promise((r) => srv.once('listening', r));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const call = (line: string) => new Promise<any>((resolve) => {
    const s = createConnection(path); let buf = '';
    s.on('data', (c) => { buf += c; }); s.on('end', () => resolve(JSON.parse(buf))); s.write(line + '\n');
  });
  assert.equal((await call('null')).error, 'bad_request');
  await new Promise<void>((resolve) => { const s = createConnection(path); s.on('close', () => resolve()); s.on('error', () => {}); s.write('x'.repeat(20000)); });
  assert.deepEqual(await call('{"method":"Status"}'), { result: { enrolled: false } });
  srv.close();
  rmSync(dir, { recursive: true, force: true });
});
