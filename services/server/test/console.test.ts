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
import { observedCommand, observedPolicy } from '../src/console.ts';
import { validateCommand, MemoryReplayStore } from '../../device-agent/src/commands.ts';
import { loadKeys } from '../../device-agent/src/main.ts';

let dir: string, server: Server, base: string, db: ReturnType<typeof openDb>;
let orgA: number, orgB: number;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ws-console-'));
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

test('the page is served with a strict CSP and no inline script', async () => {
  const res = await fetch(`${base}/admin`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy')!, /script-src 'self'/);
  const html = await res.text();
  assert.doesNotMatch(html, /<script>(?!<\/script>)/);
  assert.equal((await fetch(`${base}/admin/app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
});

test('sign-in: administrators only, header required, sessions end on sign-out', async () => {
  assert.equal((await call('POST', 'login', { body: { email: 'uma@a.test', password: 'uma-password' } })).status, 401);
  assert.equal((await call('POST', 'login', { body: { email: 'alice@a.test', password: 'wrong' } })).status, 401);
  assert.equal((await call('POST', 'login', { body: { email: 'alice@a.test', password: 'alice-password' }, header: false })).status, 403);
  const c = await login('alice@a.test', 'alice-password');
  assert.equal((await call('GET', 'me', { cookie: c })).body.org_name, 'Org A');
  // CSRF: the cookie alone is not enough.
  assert.equal((await call('GET', 'me', { cookie: c, header: false })).status, 403);
  await call('POST', 'logout', { cookie: c });
  assert.equal((await call('GET', 'me', { cookie: c })).status, 401);
});

test('organizations are isolated', async () => {
  const devA = await enroll(orgA);
  const zed = await login('zed@b.test', 'zed-password');
  assert.deepEqual((await call('GET', 'devices', { cookie: zed })).body.items, []);
  assert.equal((await call('GET', `devices/${devA.device_id}`, { cookie: zed })).status, 404);
  assert.equal((await call('POST', `devices/${devA.device_id}/commands`, { cookie: zed, body: { command: 'RequestLock' } })).status, 404);
  assert.ok(!(await call('GET', 'users', { cookie: zed })).body.items.some((u: { email: string }) => u.email.endsWith('@a.test')));
});

test('requested and observed state are shown separately (WSOS-MDM-005)', async () => {
  const dev = await enroll(orgA);
  const alice = await login('alice@a.test', 'alice-password');
  assert.equal((await call('POST', `devices/${dev.device_id}/commands`, { cookie: alice, body: { command: 'RequestLock' } })).status, 201);
  const d = (await call('GET', `devices/${dev.device_id}`, { cookie: alice })).body;
  const lock = d.commands.find((c: { command: string }) => c.command === 'RequestLock');
  assert.equal(lock.state, 'pending');
  assert.equal(lock.observed, 'not yet received');
  assert.ok(['none', 'not_reported'].includes(d.policy.state));
  assert.equal(d.policy.observed_version, null);

  const future = new Date(Date.now() + 60_000).toISOString(), past = new Date(Date.now() - 1).toISOString();
  assert.equal(observedCommand('pending', past, Date.now()), 'expired — never received');
  assert.equal(observedCommand('received', future, Date.now()), 'received — not yet started');
  assert.equal(observedCommand('completed', past, Date.now()), 'done');
  assert.deepEqual(observedPolicy(5, '4'), { requested_version: 5, observed_version: 4, state: 'pending' });
  assert.deepEqual(observedPolicy(5, 5), { requested_version: 5, observed_version: 5, state: 'applied' });
  assert.deepEqual(observedPolicy(5, undefined), { requested_version: 5, observed_version: null, state: 'not_reported' });
  assert.deepEqual(observedPolicy(null, undefined), { requested_version: null, observed_version: null, state: 'none' });
});

test('routine commands are sent; RemoteWipe needs a second administrator and verifies on the device', async () => {
  const dev = await enroll(orgA);
  const alice = await login('alice@a.test', 'alice-password');
  const bob = await login('bob@a.test', 'bob-password!');
  assert.equal((await call('POST', `devices/${dev.device_id}/commands`, { cookie: alice, body: { command: 'RequestLock' } })).status, 201);
  assert.equal((await call('POST', `devices/${dev.device_id}/commands`, { cookie: alice, body: { command: 'RemoteWipe', args: { scope: 'full_device' } } })).status, 400);
  assert.equal((await call('POST', `devices/${dev.device_id}/commands`, { cookie: alice, body: { command: 'InstallApprovedApplication', args: { catalog_id: 'flatpak:not.there' } } })).status, 400);

  const host = `host-${orgA}`;
  const reqBody = { device_id: dev.device_id, scope: 'full_device', reason: 'Laptop reported stolen' };
  assert.equal((await call('POST', 'wipes', { cookie: alice, body: { ...reqBody, reason: 'x', password: 'alice-password', confirm_name: host } })).status, 400);
  // WSOS-WIPE-001: re-authentication and the typed device name are both required.
  const noPw = await call('POST', 'wipes', { cookie: alice, body: { ...reqBody, confirm_name: host } });
  assert.equal(noPw.status, 401); assert.equal(noPw.body.error.code, 'REAUTH_REQUIRED');
  assert.equal((await call('POST', 'wipes', { cookie: alice, body: { ...reqBody, password: 'bob-password!', confirm_name: host } })).status, 401);   // someone else's password
  const badName = await call('POST', 'wipes', { cookie: alice, body: { ...reqBody, password: 'alice-password', confirm_name: host.toUpperCase() } });
  assert.equal(badName.status, 400);
  assert.equal((await call('GET', 'wipes', { cookie: alice })).body.items.length, 0);   // nothing was created
  const w = await call('POST', 'wipes', { cookie: alice, body: { ...reqBody, password: 'alice-password', confirm_name: host } });
  assert.equal(w.status, 201);
  assert.equal((await call('POST', `wipes/${w.body.id}/approve`, { cookie: alice, body: { password: 'alice-password', confirm_name: host } })).status, 403);   // not by the requester
  assert.equal((await call('POST', `wipes/${w.body.id}/approve`, { cookie: bob, body: { confirm_name: host } })).status, 401);
  assert.equal((await call('POST', `wipes/${w.body.id}/approve`, { cookie: bob, body: { password: 'bob-password!', confirm_name: 'other' } })).status, 400);
  const ok = await call('POST', `wipes/${w.body.id}/approve`, { cookie: bob, body: { password: 'bob-password!', confirm_name: host } });
  assert.equal(ok.status, 200);
  assert.equal((await call('POST', `wipes/${w.body.id}/approve`, { cookie: bob, body: { password: 'bob-password!', confirm_name: host } })).status, 409);

  // The device accepts the envelope: signed, bound to it, with the approval id.
  const keysDir = join(dir, 'keys');
  admin.exportKeys(db, keysDir);
  const env = JSON.parse((db.prepare('SELECT envelope FROM commands WHERE id = ?').get(ok.body.command_id) as { envelope: string }).envelope);
  const v = validateCommand(env, { deviceId: dev.device_id, keys: loadKeys(keysDir), replay: new MemoryReplayStore() });
  assert.equal(v.ok, true);
  assert.deepEqual(env.args, { scope: 'full_device', approval_id: w.body.id });

  const log = (await call('GET', 'log', { cookie: bob })).body.items.map((l: { action: string }) => l.action);
  assert.ok(log.includes('wipe_requested') && log.includes('wipe_approved') && log.includes('reauth_failed'));
});

test('policy: validated, versioned, signed, and active devices are nudged', async () => {
  const alice = await login('alice@a.test', 'alice-password');
  assert.equal((await call('PUT', 'policy', { cookie: alice, body: { policy: { usb_storage: 'sometimes' } } })).status, 400);
  assert.equal((await call('PUT', 'policy', { cookie: alice, body: { policy: { run_this: 'rm -rf /' } } })).status, 400);
  assert.equal((await call('PUT', 'policy', { cookie: alice, body: { policy: { update_mirror: 'http://insecure.example' } } })).status, 400);
  assert.equal((await call('PUT', 'policy', { cookie: alice, body: { policy: { lock_timeout_max_s: 30 } } })).status, 400);
  assert.equal((await call('PUT', 'policy', { cookie: alice, body: { policy: { login_failures_max: 1 } } })).status, 400);
  assert.equal((await call('PUT', 'policy', { cookie: alice, body: { policy: { bluetooth: 'off' } } })).status, 400);
  const r = await call('PUT', 'policy', { cookie: alice, body: { policy: { update_mode: 'notify', usb_storage: 'block', bluetooth: false, maintenance_window: '02:00-04:00', offline_access_days: null, lock_timeout_max_s: 600, login_failures_max: 5, login_lockout_s: 900 } } });
  assert.equal(r.status, 200);
  assert.ok(r.body.devices_notified >= 1);
  const p = await call('GET', 'policy', { cookie: alice });
  assert.deepEqual(p.body.policy, { update_mode: 'notify', usb_storage: 'block', bluetooth: false, maintenance_window: '02:00-04:00', lock_timeout_max_s: 600, login_failures_max: 5, login_lockout_s: 900 });
});

test('disabling a user ends their tokens; admins cannot disable themselves', async () => {
  const alice = await login('alice@a.test', 'alice-password');
  const users = (await call('GET', 'users', { cookie: alice })).body.items as { id: number; email: string }[];
  const me = users.find((u) => u.email === 'alice@a.test')!, bob = users.find((u) => u.email === 'bob@a.test')!;
  assert.equal((await call('POST', `users/${me.id}/disable`, { cookie: alice })).status, 409);
  const bobCookie = await login('bob@a.test', 'bob-password!');
  assert.equal((await call('POST', `users/${bob.id}/disable`, { cookie: alice })).status, 204);
  assert.equal((await call('GET', 'me', { cookie: bobCookie })).status, 401);
  await call('POST', `users/${bob.id}/enable`, { cookie: alice });
  assert.equal((await call('POST', 'users', { cookie: alice, body: { email: 'new@a.test', name: 'New', password: 'short' } })).status, 400);
  assert.equal((await call('POST', 'users', { cookie: alice, body: { email: 'uma@a.test', name: 'Dup', password: 'long enough pw' } })).body.error.message, 'a user with this email already exists');
});

test('enrollment tokens and catalog entries are validated', async () => {
  const alice = await login('alice@a.test', 'alice-password');
  assert.equal((await call('POST', 'enrollment-tokens', { cookie: alice, body: { hours: 0 } })).status, 400);
  const t = await call('POST', 'enrollment-tokens', { cookie: alice, body: { hours: 2, uses: 1 } });
  assert.match(t.body.token, /^wse_/);
  assert.equal((await call('PUT', 'catalog/flatpak:org.gimp.GIMP', { cookie: alice, body: { source: 'apt', name: 'GIMP', arches: ['amd64'] } })).status, 400);
  assert.equal((await call('PUT', 'catalog/appimage:tool', { cookie: alice, body: { source: 'appimage', name: 'Tool', arches: ['amd64'] } })).status, 400);
  assert.equal((await call('PUT', 'catalog/flatpak:org.gimp.GIMP', { cookie: alice, body: { source: 'flatpak', name: 'GIMP', arches: ['amd64', 'arm64'] } })).status, 200);
  assert.equal((await call('GET', 'catalog', { cookie: alice })).body.items.length, 1);
});

async function deviceAck(dev: { credential: string }, commandId: string, state: string) {
  return fetch(`${base}/desktop/v1/devices/commands/${commandId}/ack`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ws-device': dev.credential, 'idempotency-key': randomUUID() }, body: JSON.stringify({ state }),
  });
}

test('WSOS-WIPE-001: requesting and approving a wipe needs desktop.devices.wipe', async () => {
  const dev = await enroll(orgA);
  const host = `host-${orgA}`;
  const carl = await login('carl@a.test', 'carl-password');
  const alice = await login('alice@a.test', 'alice-password');
  const req = { device_id: dev.device_id, scope: 'worksuite_data', reason: 'Employee left', confirm_name: host };
  const denied = await call('POST', 'wipes', { cookie: carl, body: { ...req, password: 'carl-password' } });
  assert.equal(denied.status, 403);
  assert.match(denied.body.error.message, /desktop\.devices\.wipe/);
  const w = await call('POST', 'wipes', { cookie: alice, body: { ...req, password: 'alice-password' } });
  assert.equal(w.status, 201);
  assert.equal(w.body.command_id, undefined);   // corporate device: waits for a second approver
  assert.equal((await call('POST', `wipes/${w.body.id}/approve`, { cookie: carl, body: { password: 'carl-password', confirm_name: host } })).status, 403);
  await call('POST', `wipes/${w.body.id}/cancel`, { cookie: alice });
});

test('WSOS-WIPE-001: policy may waive the second approver for personal devices only', async () => {
  const dev = await enroll(orgA);
  const host = `host-${orgA}`;
  const alice = await login('alice@a.test', 'alice-password');
  const req = { device_id: dev.device_id, scope: 'worksuite_data', reason: 'Lost personal laptop', password: 'alice-password', confirm_name: host };
  assert.equal((await call('PUT', 'policy', { cookie: alice, body: { policy: { wipe_personal_single_approval: true } } })).status, 200);
  const corp = await call('POST', 'wipes', { cookie: alice, body: req });
  assert.equal(corp.body.command_id, undefined);   // waiver does not apply to corporate devices
  await call('POST', `wipes/${corp.body.id}/cancel`, { cookie: alice });
  assert.equal((await call('PUT', `devices/${dev.device_id}/ownership`, { cookie: alice, body: { ownership: 'stolen' } })).status, 400);
  assert.equal((await call('PUT', `devices/${dev.device_id}/ownership`, { cookie: alice, body: { ownership: 'personal' } })).status, 204);
  const pers = await call('POST', 'wipes', { cookie: alice, body: req });
  assert.equal(pers.status, 201);
  assert.equal(pers.body.waived_second_approver, true);
  assert.ok(pers.body.command_id);
  await call('PUT', 'policy', { cookie: alice, body: { policy: {} } });
});

test('WSOS-WIPE-008: results are audited; a wiped device is marked Wiped and must enroll again', async () => {
  const dev = await enroll(orgA);
  const host = `host-${orgA}`;
  const alice = await login('alice@a.test', 'alice-password');
  const bob = await login('bob@a.test', 'bob-password!');
  const w = await call('POST', 'wipes', { cookie: alice, body: { device_id: dev.device_id, scope: 'worksuite_data', reason: 'Device retired', password: 'alice-password', confirm_name: host } });
  const ok = await call('POST', `wipes/${w.body.id}/approve`, { cookie: bob, body: { password: 'bob-password!', confirm_name: host } });
  assert.equal((await deviceAck(dev, ok.body.command_id, 'started')).status, 204);
  assert.equal((await call('GET', `devices/${dev.device_id}`, { cookie: alice })).body.wiped_at, null);
  assert.equal((await deviceAck(dev, ok.body.command_id, 'completed')).status, 204);
  const d = (await call('GET', `devices/${dev.device_id}`, { cookie: alice })).body;
  assert.ok(d.wiped_at); assert.equal(d.revoked, true);
  const listed = (await call('GET', 'wipes', { cookie: alice })).body.items.find((x: { id: string }) => x.id === w.body.id);
  assert.equal(listed.result, 'completed');
  // The old credential no longer works: the device has to enroll again.
  const hb = await fetch(`${base}/desktop/v1/devices/heartbeat`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ws-device': dev.credential }, body: '{}' });
  assert.ok(hb.status === 401 || hb.status === 403);
  const log = (await call('GET', 'log', { cookie: alice })).body.items.map((l: { action: string }) => l.action);
  assert.ok(log.includes('wipe_completed'));
});

test('repeated failed sign-ins are throttled', async () => {
  let last = 0;
  for (let i = 0; i < 11; i++) last = (await call('POST', 'login', { body: { email: 'zed@b.test', password: `nope-${i}` } })).status;
  assert.equal(last, 429);
});

