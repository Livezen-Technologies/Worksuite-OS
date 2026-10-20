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
import { enrollTotp, totp } from '../src/identity.ts';
import { createHandler } from '../src/main.ts';
import { REMOTE_SUPPORT_PERMISSION, sweep } from '../src/remoteSupport.ts';
import { validatePolicy } from '../src/policy.ts';
import { validateCommand, MemoryReplayStore } from '../../device-agent/src/commands.ts';
import { parseRequest } from '../../device-agent/src/remoteSupport.ts';
import { loadKeys } from '../../device-agent/src/main.ts';

let dir: string, server: Server, base: string, db: ReturnType<typeof openDb>;
let orgA: number, orgB: number, totpSecret: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ws-rs-'));
  db = openDb(join(dir, 'db'));
  orgA = admin.createOrg(db, 'Org A');
  orgB = admin.createOrg(db, 'Org B');
  admin.addUser(db, orgA, 'tess@a.test', 'Tess Tech', 'tess-password', 'admin');
  admin.addUser(db, orgA, 'carl@a.test', 'Carl', 'carl-password', 'admin');     // no remote support permission
  admin.addUser(db, orgB, 'zed@b.test', 'Zed', 'zed-password', 'admin');
  admin.grantPermission(db, 'tess@a.test', REMOTE_SUPPORT_PERMISSION);
  admin.grantPermission(db, 'zed@b.test', REMOTE_SUPPORT_PERMISSION);
  totpSecret = enrollTotp(db, 'tess@a.test').match(/secret=([A-Z2-7]+)/)?.[1] ?? '';
  server = createServer(createHandler(db, { publicUrl: 'https://ws.test/' }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

async function call(method: string, path: string, o: { cookie?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}/admin/api/${path}`, { method, headers: { 'x-ws-admin': '1', ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.body ? { 'content-type': 'application/json' } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}
async function login(email: string, password: string) {
  const res = await fetch(`${base}/admin/api/login`, { method: 'POST', headers: { 'x-ws-admin': '1', 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return res.headers.get('set-cookie')!.split(';')[0];
}
async function enroll(orgId: number, hostname = `host-${randomUUID().slice(0, 6)}`) {
  const res = await fetch(`${base}/desktop/v1/devices/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ enrollment_token: admin.createEnrollmentToken(db, orgId), public_key: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }), arch: 'amd64', hostname }),
  });
  return (await res.json()) as { device_id: string; credential: string };
}
const device = (cred: string) => ({
  poll: async () => (await (await fetch(`${base}/desktop/v1/os/remote-support/commands`, { headers: { 'x-ws-device': cred } })).json()) as { commands: any[] },
  report: async (id: string, body: unknown) => (await fetch(`${base}/desktop/v1/os/remote-support/sessions/${id}/state`, { method: 'POST', headers: { 'x-ws-device': cred, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify(body) })).status,
});

test('policy: remote_support is validated', () => {
  assert.deepEqual(validatePolicy({ remote_support: { enabled: true, unattended: false, max_session_minutes: 30 } }).remote_support, { enabled: true, unattended: false, max_session_minutes: 30 });
  for (const bad of [{ unattended: 'yes' }, { max_session_minutes: 1000 }, { exec: true }, []]) assert.throws(() => validatePolicy({ remote_support: bad }));
});

test('request → device consent → active; the device verifies the signed request; history and audit', async () => {
  const dev = await enroll(orgA, 'reception-pc');
  const tess = await login('tess@a.test', 'tess-password');
  const r = await call('POST', 'remote-support/sessions', { cookie: tess, body: { device_id: dev.device_id, mode: 'view', reason: 'Outlook crashes on start' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.unattended, false);
  const id = r.body.session_id;

  let dash = (await call('GET', 'remote-support', { cookie: tess })).body;
  assert.equal(dash.cards.pending_requests, 1);
  assert.equal(dash.devices.find((d: any) => d.id === dev.device_id).status, 'busy');
  assert.equal(dash.history[0].state, 'requested');
  assert.equal(dash.history[0].administrator, 'Tess Tech');

  // Busy: a second request for the same device is refused.
  assert.equal((await call('POST', 'remote-support/sessions', { cookie: tess, body: { device_id: dev.device_id, mode: 'view', reason: 'again' } })).status, 409);

  const { commands } = await device(dev.credential).poll();
  assert.equal(commands.length, 1);
  // The device agent's own validator accepts it with the server's exported public keys.
  admin.exportKeys(db, join(dir, 'keys'));
  const v = validateCommand(commands[0], { deviceId: dev.device_id, keys: loadKeys(join(dir, 'keys')), replay: new MemoryReplayStore() });
  assert.ok(v.ok, JSON.stringify(v));
  const req = parseRequest(commands[0].args, Date.parse(commands[0].expires_at))!;
  assert.equal(req.session_id, id); assert.equal(req.admin_name, 'Tess Tech'); assert.equal(req.org_name, 'Org A'); assert.equal(req.unattended_eligible, false);

  // The device may not report more than was requested.
  assert.equal(await device(dev.credential).report(id, { state: 'active', granted_mode: 'control', consent: 'user' }), 400);
  assert.equal(await device(dev.credential).report(id, { state: 'active', granted_mode: 'view', consent: 'user' }), 204);
  dash = (await call('GET', 'remote-support', { cookie: tess })).body;
  assert.equal(dash.cards.active_sessions, 1);
  assert.equal(dash.history[0].consent, 'user');
  assert.equal(await device(dev.credential).report(id, { state: 'ended', end_reason: 'user_ended' }), 204);
  dash = (await call('GET', 'remote-support', { cookie: tess })).body;
  assert.equal(dash.history[0].end_reason, 'user_ended');
  assert.equal(dash.cards.completed_sessions, 1);
  const log = (await call('GET', 'log', { cookie: tess })).body.items.map((i: any) => i.action);
  for (const a of ['remote_support_requested', 'remote_support_view', 'remote_support_ended']) assert.ok(log.includes(a), a);
});

test('permission, MFA for control, organization isolation', async () => {
  const dev = await enroll(orgA);
  const carl = await login('carl@a.test', 'carl-password');
  assert.equal((await call('GET', 'remote-support', { cookie: carl })).status, 403);
  assert.equal((await call('POST', 'remote-support/sessions', { cookie: carl, body: { device_id: dev.device_id, mode: 'view', reason: 'x y z' } })).status, 403);
  const zed = await login('zed@b.test', 'zed-password');
  assert.equal((await call('POST', 'remote-support/sessions', { cookie: zed, body: { device_id: dev.device_id, mode: 'view', reason: 'peek' } })).status, 404);
  assert.ok(!(await call('GET', 'remote-support', { cookie: zed })).body.devices.some((d: any) => d.id === dev.device_id));

  const tess = await login('tess@a.test', 'tess-password');
  assert.equal((await call('POST', 'remote-support/sessions', { cookie: tess, body: { device_id: dev.device_id, mode: 'control', reason: 'fix VPN' } })).status, 401);
  assert.equal((await call('POST', 'remote-support/sessions', { cookie: tess, body: { device_id: dev.device_id, mode: 'control', reason: 'fix VPN', otp: '000000' } })).status, 401);
  const ok = await call('POST', 'remote-support/sessions', { cookie: tess, body: { device_id: dev.device_id, mode: 'control', reason: 'fix VPN', otp: totp(totpSecret, Date.now()) } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  // Another org's device cannot report on this session.
  const devB = await enroll(orgB);
  assert.equal(await device(devB.credential).report(ok.body.session_id, { state: 'active', granted_mode: 'view', consent: 'user' }), 404);

  // Terminate: ended now, and a signed RemoteSupportEnd goes to the device.
  assert.equal((await call('POST', `remote-support/sessions/${ok.body.session_id}/terminate`, { cookie: tess })).body.state, 'ended');
  assert.equal((await call('POST', `remote-support/sessions/${ok.body.session_id}/terminate`, { cookie: zed })).status, 404);
  const cmds = (await device(dev.credential).poll()).commands.map((c) => c.command);
  assert.deepEqual(cmds, ['RemoteSupportRequest', 'RemoteSupportEnd']);
});

test('unattended only with policy AND a corporate device; disabled policy refuses; unanswered requests expire', async () => {
  const dev = await enroll(orgA);
  const tess = await login('tess@a.test', 'tess-password');
  admin.setPolicy(db, orgA, { remote_support: { unattended: true, max_session_minutes: 15 } });
  const r = await call('POST', 'remote-support/sessions', { cookie: tess, body: { device_id: dev.device_id, mode: 'view', reason: 'overnight patching' } });
  assert.equal(r.body.unattended, true);
  const c = (await device(dev.credential).poll()).commands[0];
  assert.equal(c.args.unattended, true);
  assert.ok(Date.parse(c.expires_at) - Date.parse(c.issued_at) <= 15 * 60_000 + 1000, 'token lifetime follows the policy');
  await call('POST', `remote-support/sessions/${r.body.session_id}/terminate`, { cookie: tess });

  db.prepare("UPDATE devices SET ownership = 'personal' WHERE id = ?").run(dev.device_id);
  const p = await call('POST', 'remote-support/sessions', { cookie: tess, body: { device_id: dev.device_id, mode: 'view', reason: 'personal laptop' } });
  assert.equal(p.body.unattended, false, 'never unattended on a personal device');
  sweep(db, Date.now() + 4 * 60_000);
  const h = (await call('GET', 'remote-support/sessions', { cookie: tess })).body.items.find((s: any) => s.id === p.body.session_id);
  assert.equal(h.end_reason, 'consent_timeout');

  admin.setPolicy(db, orgA, { remote_support: { enabled: false } });
  assert.equal((await call('POST', 'remote-support/sessions', { cookie: tess, body: { device_id: dev.device_id, mode: 'view', reason: 'blocked' } })).status, 409);
  admin.setPolicy(db, orgA, {});
});
