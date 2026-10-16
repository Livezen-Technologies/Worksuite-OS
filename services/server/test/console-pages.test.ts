// Admin console: problem reports, device package audit and the enrollment QR (separate server: sign-in throttling
// state from console.test.ts does not carry over).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as admin from '../src/admin.ts';
import { openDb } from '../src/db.ts';
import { createHandler } from '../src/main.ts';

let dir: string, server: Server, base: string, db: ReturnType<typeof openDb>;
let orgA: number, orgB: number;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ws-console-pages-'));
  db = openDb(join(dir, 'db'));
  orgA = admin.createOrg(db, 'Org A');
  orgB = admin.createOrg(db, 'Org B');
  admin.addUser(db, orgA, 'alice@a.test', 'Alice', 'alice-password', 'admin');
  admin.addUser(db, orgA, 'bob@a.test', 'Bob', 'bob-password!', 'admin');
  admin.addUser(db, orgA, 'uma@a.test', 'Uma', 'uma-password', 'user');
  admin.addUser(db, orgB, 'zed@b.test', 'Zed', 'zed-password', 'admin');
  admin.addUser(db, orgA, 'carl@a.test', 'Carl', 'carl-password', 'admin');   // admin without the wipe permission
  admin.grantPermission(db, 'alice@a.test', admin.WIPE_PERMISSION);
  admin.grantPermission(db, 'bob@a.test', admin.WIPE_PERMISSION);
  server = createServer(createHandler(db, { publicUrl: 'https://ws.test/' }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

async function call(method: string, path: string, o: { cookie?: string; body?: unknown; header?: boolean } = {}) {
  const res = await fetch(`${base}/admin/api/${path}`, {
    method,
    headers: { ...(o.header === false ? {} : { 'x-ws-admin': '1' }), ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.body ? { 'content-type': 'application/json' } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
}
async function login(email: string, password: string) {
  const r = await call('POST', 'login', { body: { email, password } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const c = r.headers.get('set-cookie')!;
  assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Strict/); assert.match(c, /Secure/); assert.match(c, /Path=\/admin/);
  return c.split(';')[0];
}
async function enroll(orgId: number) {
  const res = await fetch(`${base}/desktop/v1/devices/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ enrollment_token: admin.createEnrollmentToken(db, orgId), public_key: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }), arch: 'amd64', hostname: `host-${orgId}` }),
  });
  return (await res.json()) as { device_id: string; credential: string };
}

test('problem reports: admins of the org only, paginated, detail logged', async () => {
  const dev = await enroll(orgA);
  const uma = (db.prepare("SELECT id FROM users WHERE email = 'uma@a.test'").get() as { id: number }).id;
  const zed = (db.prepare("SELECT id FROM users WHERE email = 'zed@b.test'").get() as { id: number }).id;
  const ins = db.prepare('INSERT INTO problem_reports (id, org_id, user_id, device_id, body, at) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 30; i++) ins.run(`rep-a-${String(i).padStart(4, '0')}`, orgA, uma, i % 2 ? dev.device_id : null, JSON.stringify({ description: `Printer fails ${i}`, sections: [{ id: 'system', text: 'WorkSuite OS 1.0' }] }), 1_000 + i);
  ins.run('rep-b-00000001', orgB, zed, null, JSON.stringify({ description: 'other org', sections: [] }), 5_000);
  const c = await login('alice@a.test', 'alice-password');
  const p1 = await call('GET', 'problem-reports', { cookie: c });
  assert.equal(p1.status, 200);
  assert.equal(p1.body.total, 30); assert.equal(p1.body.items.length, 25); assert.equal(p1.body.page, 1);
  assert.equal(p1.body.items[0].id, 'rep-a-0029');   // newest first
  assert.equal(p1.body.items[0].hostname, `host-${orgA}`);
  assert.deepEqual(p1.body.items[0].sections, ['system']);
  assert.equal(p1.body.items[0].body, undefined, 'the list carries no report text');
  const p2 = await call('GET', 'problem-reports?page=2&per_page=10', { cookie: c });
  assert.equal(p2.body.items.length, 10); assert.equal(p2.body.items[0].id, 'rep-a-0019');
  assert.ok(!p1.body.items.some((x: { id: string }) => x.id.startsWith('rep-b')));
  const d = await call('GET', 'problem-reports/rep-a-0003', { cookie: c });
  assert.equal(d.body.description, 'Printer fails 3'); assert.equal(d.body.sections[0].text, 'WorkSuite OS 1.0');
  assert.equal((await call('GET', 'problem-reports/rep-b-00000001', { cookie: c })).status, 404);
  const log = await call('GET', 'log', { cookie: c });
  assert.ok(log.body.items.some((l: { action: string; detail: { id: string } }) => l.action === 'problem_report_viewed' && l.detail.id === 'rep-a-0003'));
  // Not an admin: no session at all.
  assert.equal((await call('POST', 'login', { body: { email: 'uma@a.test', password: 'uma-password' } })).status, 401);
  assert.equal((await call('GET', 'problem-reports')).status, 401);
  assert.equal((await call('GET', 'problem-reports', { cookie: c, header: false })).status, 403);
});

test('device package audit: from os/audit, scoped to the org, filtered and paginated', async () => {
  const dev = await enroll(orgA);
  const other = await enroll(orgB);
  const post = (cred: string, events: unknown[]) => fetch(`${base}/desktop/v1/os/audit`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ws-device': cred, 'idempotency-key': randomUUID() }, body: JSON.stringify({ events }) });
  const ev = (i: number, type: string) => ({ id: `e${i}`, type, at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), data: { packages: ['gimp'], user: 'uma' } });
  assert.equal((await post(dev.credential, Array.from({ length: 12 }, (_, i) => ev(i, i % 3 ? 'package.install' : 'package.remove')))).status, 202);
  assert.equal((await post(other.credential, [ev(1, 'package.install')])).status, 202);
  const c = await login('alice@a.test', 'alice-password');
  const all = await call('GET', `device-audit?per_page=10&device=${dev.device_id}`, { cookie: c });
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.equal(all.body.total, 12); assert.equal(all.body.items.length, 10);
  assert.equal(all.body.items[0].id, 'e11'); assert.deepEqual(all.body.items[0].data.packages, ['gimp']);
  assert.ok(all.body.types.includes('package.remove'));
  const rm = await call('GET', `device-audit?type=package.remove&device=${dev.device_id}`, { cookie: c });
  assert.equal(rm.body.total, 4);
  assert.ok(rm.body.items.every((x: { type: string }) => x.type === 'package.remove'));
  const cz = await login('zed@b.test', 'zed-password');
  const b = await call('GET', 'device-audit', { cookie: cz });
  assert.ok(b.body.items.every((x: { device_id: string }) => x.device_id !== dev.device_id));
  assert.equal((await call('GET', 'device-audit?type=../x', { cookie: c })).status, 400);
});

test('enrollment tokens come with a link and a QR code; the token is in the fragment', async () => {
  const c = await login('alice@a.test', 'alice-password');
  const r = await call('POST', 'enrollment-tokens', { cookie: c, body: { hours: 2, uses: 1 } });
  assert.equal(r.status, 201);
  assert.equal(r.body.server, 'https://ws.test/');
  assert.equal(r.body.link, `https://ws.test/enroll#token=${encodeURIComponent(r.body.token)}`);
  assert.ok(Array.isArray(r.body.qr) && r.body.qr.length >= 21);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const log = await call('GET', 'log', { cookie: c });
  assert.ok(!JSON.stringify(log.body).includes(r.body.token), 'the token is never logged');
});
