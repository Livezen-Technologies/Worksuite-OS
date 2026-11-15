// Tenant isolation regressions found in end-to-end QA: file locks, the software catalog and malformed inventory
// reports must never let one organization (or one bad device report) affect another organization.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as admin from '../src/admin.ts';
import { openDb } from '../src/db.ts';
import { createHandler } from '../src/main.ts';

let dir: string, server: Server, base: string, db: ReturnType<typeof openDb>;
let org1: number, org2: number;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ws-tenant-'));
  db = openDb(join(dir, 'server.db'));
  org1 = admin.createOrg(db, 'Org One');
  org2 = admin.createOrg(db, 'Org Two');
  admin.addUser(db, org1, 'ann@one.test', 'Ann', 'ann-password-1234');
  admin.addUser(db, org1, 'adm@one.test', 'Admin One', 'admin-password-1234', 'admin');
  admin.addUser(db, org2, 'cat@two.test', 'Cat', 'cat-password-1234');
  admin.addUser(db, org2, 'adm@two.test', 'Admin Two', 'admin-password-1234', 'admin');
  server = createServer(createHandler(db, { publicUrl: 'http://ws.test/' }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

async function bearer(email: string, password: string) {
  const verifier = randomBytes(32).toString('base64url');
  const form = new URLSearchParams({ client_id: 'worksuite-os', redirect_uri: 'http://127.0.0.1:1/cb', response_type: 'code', code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), email, password });
  const a = await fetch(`${base}/oauth/authorize`, { method: 'POST', body: form, redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const code = new URL(a.headers.get('location')!).searchParams.get('code')!;
  const t = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'worksuite-os', redirect_uri: 'http://127.0.0.1:1/cb', code, code_verifier: verifier }) });
  return { authorization: `Bearer ${(await t.json()).access_token}` };
}

async function consoleSession(email: string) {
  const res = await fetch(`${base}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ws-admin': '1' }, body: JSON.stringify({ email, password: 'admin-password-1234' }) });
  return { 'x-ws-admin': '1', cookie: res.headers.get('set-cookie')!.split(';')[0] };
}

async function enroll(orgId: number) {
  const token = admin.createEnrollmentToken(db, orgId, {});
  const pem = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const r = await call('POST', '/desktop/v1/devices/register', { public_key: pem, arch: 'amd64', hostname: `pc-${orgId}` }, { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() });
  assert.equal(r.status, 201);
  return { device_id: r.json.device_id as string, headers: { 'x-ws-device': r.json.credential as string } };
}

test('a file lock in one organization does not block the same file id in another', async () => {
  const ann = await bearer('ann@one.test', 'ann-password-1234');
  const cat = await bearer('cat@two.test', 'cat-password-1234');
  assert.equal((await call('POST', '/desktop/v1/files/report-q3/lock', undefined, ann)).status, 200);
  assert.equal((await call('POST', '/desktop/v1/files/report-q3/lock', undefined, cat)).status, 200, 'org 2 must not see org 1 locks');
  // Releasing in org 2 leaves org 1's lock in place.
  assert.equal((await call('DELETE', '/desktop/v1/files/report-q3/lock', undefined, cat)).status, 204);
  const bob = await bearer('ann@one.test', 'ann-password-1234');
  assert.equal((await call('POST', '/desktop/v1/files/report-q3/lock', undefined, bob)).status, 200, 'same user re-locks');
});

test("one organization's admin cannot change, delete or push another organization's catalog", async () => {
  const a1 = await consoleSession('adm@one.test');
  const a2 = await consoleSession('adm@two.test');
  const dev1 = await enroll(org1);
  assert.equal((await call('PUT', '/admin/api/catalog/apt:one-tool', { source: 'apt', name: 'One Tool', arches: ['amd64'] }, a1)).status, 200);
  // Overwrite and delete from org 2 are refused; org 1's item is unchanged.
  assert.equal((await call('PUT', '/admin/api/catalog/apt:one-tool', { source: 'apt', name: 'Hijacked', arches: ['amd64'], blocked: true }, a2)).status, 409);
  assert.equal((await call('DELETE', '/admin/api/catalog/apt:one-tool', undefined, a2)).status, 404);
  const mine = await call('GET', '/admin/api/catalog', undefined, a1);
  assert.equal(mine.json.items.find((i: { id: string }) => i.id === 'apt:one-tool').name, 'One Tool');
  // Org 2 does not even see it.
  assert.ok(!(await call('GET', '/admin/api/catalog', undefined, a2)).json.items.some((i: { id: string }) => i.id === 'apt:one-tool'));
  // A required item from org 2 never reaches org 1's devices or allowlist.
  assert.equal((await call('PUT', '/admin/api/catalog/apt:two-only', { source: 'apt', name: 'Two only', arches: ['amd64'], required: true }, a2)).status, 200);
  assert.equal((await call('POST', '/desktop/v1/os/inventory', { collected_at: new Date().toISOString(), hardware: {}, software: [] }, { ...dev1.headers, 'idempotency-key': randomUUID() })).status, 202);
  const hb = await call('POST', '/desktop/v1/devices/heartbeat', { os_version: '1', shell_version: '1', kernel_version: '1', policy_version: '1' }, dev1.headers);
  assert.ok(!JSON.stringify(hb.json).includes('apt:two-only'), 'org 2 required app was queued on an org 1 device');
  assert.ok(!JSON.stringify((await call('GET', '/desktop/v1/policies', undefined, dev1.headers)).json).includes('apt:two-only'));
  const cat1 = await call('GET', '/desktop/v1/os/catalog?arch=amd64', undefined, dev1.headers);
  assert.ok(!JSON.stringify(cat1.json).includes('apt:two-only'));
  // Platform items (operator CLI) are visible to everyone and read-only in the console.
  admin.putCatalogItem(db, { id: 'apt:platform-app', source: 'apt', name: 'Platform', arches: ['amd64'] });
  assert.ok((await call('GET', '/admin/api/catalog', undefined, a2)).json.items.some((i: { id: string; platform: boolean }) => i.id === 'apt:platform-app' && i.platform));
  assert.equal((await call('PUT', '/admin/api/catalog/apt:platform-app', { source: 'apt', name: 'x', arches: ['amd64'], blocked: true }, a2)).status, 409);
});

test('a malformed inventory report is refused before it is stored and cannot break sign-in', async () => {
  const a1 = await consoleSession('adm@one.test');
  const dev = await enroll(org1);
  assert.equal((await call('PUT', '/admin/api/catalog/apt:must-have', { source: 'apt', name: 'Must have', arches: ['amd64'], required: true }, a1)).status, 200);
  for (const bad of [{ software: {} }, { software: 'x' }, { packages: 5 }, { hardware: [] }]) {
    const r = await call('POST', '/desktop/v1/os/inventory', { collected_at: 'x', hardware: {}, software: [], ...bad }, { ...dev.headers, 'idempotency-key': randomUUID() });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  // A row stored by an older server with a bad shape is tolerated by reconcile and directory sign-in.
  db.prepare('INSERT INTO inventory (device_id, body, at) VALUES (?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET body = excluded.body').run(dev.device_id, JSON.stringify({ software: {}, packages: 'x' }), Date.now());
  const auth = await call('POST', '/desktop/v1/os/directory/authenticate', { username: 'ann@one.test', password: 'ann-password-1234' }, dev.headers);
  assert.notEqual(auth.status, 500);
  assert.equal((await call('PUT', '/admin/api/catalog/apt:must-have-2', { source: 'apt', name: 'Must have 2', arches: ['amd64'], required: true }, a1)).status, 200);
});

test('HR webhook refuses local, private and link-local destinations', async () => {
  const { validateWebhookUrl, internalAddress } = await import('../src/attendance.ts');
  for (const u of ['https://127.0.0.1/', 'https://localhost:8443/x', 'https://169.254.169.254/latest/meta-data/', 'https://10.1.2.3/', 'https://192.168.1.10/', 'https://172.20.0.1/', 'https://[::1]/', 'https://[fd00::1]/', 'https://[::ffff:127.0.0.1]/'])
    assert.throws(() => validateWebhookUrl(u), /public HR system/, u);
  assert.equal(validateWebhookUrl('https://hr.example.com/hook'), 'https://hr.example.com/hook');
  assert.equal(validateWebhookUrl('https://8.8.8.8/hook'), 'https://8.8.8.8/hook');
  assert.ok(internalAddress('100.64.0.1') && !internalAddress('172.32.0.1') && !internalAddress('2606:4700::1111'));
});

test('a problem report whose id another user already took is refused, not silently dropped', async () => {
  const ann = await bearer('ann@one.test', 'ann-password-1234');
  const cat = await bearer('cat@two.test', 'cat-password-1234');
  const report = { id: 'squat-1234-abcd', description: 'x', sections: [] }
  assert.equal((await call('POST', '/desktop/v1/problem-reports', report, { ...cat, 'idempotency-key': randomUUID() })).status, 202);
  assert.equal((await call('POST', '/desktop/v1/problem-reports', report, { ...cat, 'idempotency-key': randomUUID() })).status, 202, 'own resend is fine');
  assert.equal((await call('POST', '/desktop/v1/problem-reports', report, { ...ann, 'idempotency-key': randomUUID() })).status, 409);
});
