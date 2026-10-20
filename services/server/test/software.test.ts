// Software Management: assignments, required-app deployment, installation requests, remote uninstall, inventory.
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
import { validatePolicy } from '../src/policy.ts';
import { validateAssignment } from '../src/software.ts';
import { validateCommand, MemoryReplayStore } from '../../device-agent/src/commands.ts';
import { loadKeys } from '../../device-agent/src/main.ts';

let dir: string, server: Server, base: string, db: ReturnType<typeof openDb>, org: number, other: number;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ws-software-'));
  db = openDb(join(dir, 'db'));
  org = admin.createOrg(db, 'Org A');
  other = admin.createOrg(db, 'Org B');
  admin.addUser(db, org, 'alice@a.test', 'Alice', 'alice-password', 'admin');
  admin.addUser(db, org, 'uma@a.test', 'Uma', 'uma-password', 'user');
  admin.addUser(db, other, 'zed@b.test', 'Zed', 'zed-password', 'admin');
  server = createServer(createHandler(db, { publicUrl: 'https://ws.test/' }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

async function adminCall(method: string, path: string, cookie: string, body?: unknown) {
  const res = await fetch(`${base}/admin/api/${path}`, { method, headers: { 'x-ws-admin': '1', cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}
async function deviceCall(method: string, path: string, credential: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'x-ws-device': credential, 'idempotency-key': randomUUID(), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}
async function login(email: string, password: string) {
  const res = await fetch(`${base}/admin/api/login`, { method: 'POST', headers: { 'x-ws-admin': '1', 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return res.headers.get('set-cookie')!.split(';')[0];
}
async function enroll(orgId: number, hostname: string, arch = 'amd64') {
  const res = await fetch(`${base}/desktop/v1/devices/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ enrollment_token: admin.createEnrollmentToken(db, orgId), public_key: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }), arch, hostname }),
  });
  return (await res.json()) as { device_id: string; credential: string };
}
const commandsFor = async (cred: string) => (await deviceCall('POST', '/desktop/v1/devices/heartbeat', cred, { os_version: '1', shell_version: '1', kernel_version: '1', policy_version: '1' })).body.commands as { id: string; command: string; args: { catalog_id: string } }[];
const keys = () => { const k = join(dir, 'keys'); admin.exportKeys(db, k); return loadKeys(k); };
const allowlist = () => JSON.parse((db.prepare('SELECT body FROM policies WHERE org_id = ?').get(org) as { body: string }).body).app_allowlist as string[];

test('policy accepts the software permission fields and refuses bad values', () => {
  assert.deepEqual(validatePolicy({ software_install: 'request', software_uninstall: false, software_update: true, update_bandwidth_kbps: 2048 }),
    { software_install: 'request', software_uninstall: false, software_update: true, update_bandwidth_kbps: 2048 });
  assert.throws(() => validatePolicy({ software_install: 'everything' }));
  assert.throws(() => validatePolicy({ update_bandwidth_kbps: -1 }));
  assert.equal(validateAssignment({ devices: [], users: [] }), undefined);
  assert.deepEqual(validateAssignment({ users: [' Uma@A.test '], departments: ['Finance'] }), { users: ['uma@a.test'], departments: ['Finance'] });
  assert.throws(() => validateAssignment({ users: ['not an email'] }));
});

test('assigned apps are listed only where assigned; required apps deploy and are allowlisted', async () => {
  const alice = await login('alice@a.test', 'alice-password');
  const fin = await enroll(org, 'fin-1'), ops = await enroll(org, 'ops-1'), arm = await enroll(org, 'arm-1', 'arm64');
  assert.equal((await adminCall('PUT', `devices/${fin.device_id}/department`, alice, { department: 'Finance' })).status, 200);
  assert.equal((await adminCall('PUT', `devices/${fin.device_id}/department`, alice, { department: '<script>' })).status, 400);

  // Not required, for Finance only: listed on fin-1, not on ops-1; the assignment itself is never sent to devices.
  assert.equal((await adminCall('PUT', 'catalog/flatpak:org.gnucash.GnuCash', alice, { source: 'flatpak', name: 'GnuCash', arches: ['amd64'], assign: { departments: ['Finance'] } })).status, 200);
  const finCat = (await deviceCall('GET', '/desktop/v1/os/catalog?arch=amd64', fin.credential)).body.items;
  assert.deepEqual(finCat.map((i: { id: string }) => i.id), ['flatpak:org.gnucash.GnuCash']);
  assert.equal(finCat[0].assign, undefined);
  assert.equal((await deviceCall('GET', '/desktop/v1/os/catalog?arch=amd64', ops.credential)).body.items.length, 0);

  // Required for everyone (amd64 only): fin-1 and ops-1 get an install command, arm-1 does not; the id is allowlisted.
  const put = await adminCall('PUT', 'catalog/flatpak:org.mozilla.firefox', alice, { source: 'flatpak', name: 'Firefox', arches: ['amd64'], required: true });
  assert.equal(put.body.deployed, 2);
  assert.ok(allowlist().includes('flatpak:org.mozilla.firefox'));
  const cmds = await commandsFor(fin.credential);
  const install = cmds.find((c) => c.command === 'InstallApprovedApplication')!;
  assert.equal(install.args.catalog_id, 'flatpak:org.mozilla.firefox');
  assert.equal((await commandsFor(arm.credential)).length, 0);
  // The device accepts the signed command.
  const v = validateCommand(install, { deviceId: fin.device_id, keys: keys(), replay: new MemoryReplayStore() });
  assert.ok(v.ok, JSON.stringify(v));

  // No duplicate while the first is open; an inventory that shows it installed needs nothing more.
  await deviceCall('POST', `/desktop/v1/devices/commands/${install.id}/ack`, fin.credential, { state: 'completed' });
  await deviceCall('POST', '/desktop/v1/os/inventory', fin.credential, { collected_at: new Date().toISOString(), hardware: {}, software: [], flatpaks: [{ name: 'org.mozilla.firefox', version: '130' }], packages: [] });
  assert.equal((await commandsFor(fin.credential)).filter((c) => c.command === 'InstallApprovedApplication').length, 0);
  const inv = (await adminCall('GET', 'software/inventory', alice)).body;
  const ff = inv.apps.find((a: { id: string }) => a.id === 'flatpak:org.mozilla.firefox');
  assert.deepEqual(ff.installed_on, [fin.device_id]);
  assert.equal(ff.assigned_devices, 2);
  const sw = (await adminCall('GET', `devices/${fin.device_id}/software`, alice)).body;
  assert.equal(sw.items[0].catalog_name, 'Firefox');
});

test('user assignments follow the user to devices they sign in on', async () => {
  const alice = await login('alice@a.test', 'alice-password');
  const dev = await enroll(org, 'shared-1');
  await adminCall('PUT', 'catalog/apt:inkscape', alice, { source: 'apt', name: 'Inkscape', arches: ['amd64'], required: true, assign: { users: ['uma@a.test'] } });
  assert.ok(!(await commandsFor(dev.credential)).some((c) => c.args?.catalog_id === 'apt:inkscape'));
  assert.equal((await deviceCall('POST', '/desktop/v1/os/directory/authenticate', dev.credential, { username: 'uma@a.test', password: 'uma-password' })).status, 200);
  assert.ok((await commandsFor(dev.credential)).some((c) => c.command === 'InstallApprovedApplication' && c.args.catalog_id === 'apt:inkscape'));
  assert.ok((await deviceCall('GET', '/desktop/v1/os/catalog?arch=amd64', dev.credential)).body.items.some((i: { id: string }) => i.id === 'apt:inkscape'));
});

test('installation requests: device asks, administrator approves (install sent) or rejects', async () => {
  const alice = await login('alice@a.test', 'alice-password');
  const zed = await login('zed@b.test', 'zed-password');
  const dev = await enroll(org, 'req-1');
  await adminCall('PUT', 'catalog/flatpak:org.gimp.GIMP', alice, { source: 'flatpak', name: 'GIMP', arches: ['amd64'] });
  await adminCall('PUT', 'catalog/flatpak:com.bad.App', alice, { source: 'flatpak', name: 'Bad', arches: ['amd64'], blocked: true });
  assert.equal((await deviceCall('POST', '/desktop/v1/os/software-requests', dev.credential, { catalog_id: 'flatpak:not.there', username: 'uma' })).status, 400);
  assert.equal((await deviceCall('POST', '/desktop/v1/os/software-requests', dev.credential, { catalog_id: 'flatpak:com.bad.App', username: 'uma' })).status, 400);
  const r1 = await deviceCall('POST', '/desktop/v1/os/software-requests', dev.credential, { catalog_id: 'flatpak:org.gimp.GIMP', username: 'uma', reason: 'Photo edits for marketing' });
  assert.equal(r1.status, 201);
  // Asking again while pending returns the same request.
  assert.equal((await deviceCall('POST', '/desktop/v1/os/software-requests', dev.credential, { catalog_id: 'flatpak:org.gimp.GIMP', username: 'uma' })).body.id, r1.body.id);
  const r2 = (await deviceCall('POST', '/desktop/v1/os/software-requests', dev.credential, { catalog_id: 'flatpak:org.gnucash.GnuCash', username: 'uma' })).body;

  // Another organization's admin can't see or decide it.
  assert.equal((await adminCall('GET', 'software/requests', zed)).body.items.length, 0);
  assert.equal((await adminCall('POST', `software/requests/${r1.body.id}/approve`, zed)).status, 404);

  const pending = (await adminCall('GET', 'software/requests?state=pending', alice)).body.items;
  assert.ok(pending.some((x: { id: string; reason: string }) => x.id === r1.body.id && x.reason === 'Photo edits for marketing'));
  const ok = await adminCall('POST', `software/requests/${r1.body.id}/approve`, alice, {});
  assert.equal(ok.body.state, 'approved');
  assert.ok(ok.body.command_id);
  assert.ok(allowlist().includes('flatpak:org.gimp.GIMP'));
  assert.ok((await commandsFor(dev.credential)).some((c) => c.id === ok.body.command_id && c.args.catalog_id === 'flatpak:org.gimp.GIMP'));
  assert.equal((await adminCall('POST', `software/requests/${r1.body.id}/reject`, alice, {})).status, 400);   // already decided

  const no = await adminCall('POST', `software/requests/${r2.id}/reject`, alice, { note: 'Use the web version' });
  assert.equal(no.body.state, 'rejected');
  const mine = (await deviceCall('GET', '/desktop/v1/os/software-requests', dev.credential)).body.items;
  assert.deepEqual(mine.map((x: { state: string }) => x.state).sort(), ['approved', 'rejected']);
  assert.equal(mine.find((x: { state: string }) => x.state === 'rejected').note, 'Use the web version');
});

test('remote uninstall and bulk deployment; history shows status', async () => {
  const alice = await login('alice@a.test', 'alice-password');
  const a = await enroll(org, 'bulk-1'), b = await enroll(org, 'bulk-2');
  await adminCall('PUT', 'catalog/flatpak:org.videolan.VLC', alice, { source: 'flatpak', name: 'VLC', arches: ['amd64'] });
  const dep = await adminCall('POST', 'software/deploy', alice, { catalog_id: 'flatpak:org.videolan.VLC', action: 'install', devices: [a.device_id, b.device_id, randomUUID()] });
  assert.equal(dep.status, 201);
  assert.equal(dep.body.results.filter((x: { command_id?: string }) => x.command_id).length, 2);
  assert.equal(dep.body.results[2].error, 'not_found');
  // Same again while open: nothing new.
  assert.equal((await adminCall('POST', 'software/deploy', alice, { catalog_id: 'flatpak:org.videolan.VLC', action: 'install', devices: [a.device_id] })).body.results[0].error, 'already_pending');

  const rm = await adminCall('POST', `devices/${b.device_id}/commands`, alice, { command: 'RemoveApplication', args: { catalog_id: 'flatpak:org.videolan.VLC' } });
  assert.equal(rm.status, 201);
  const cmd = (await commandsFor(b.credential)).find((c) => c.command === 'RemoveApplication')!;
  assert.ok(validateCommand(cmd, { deviceId: b.device_id, keys: keys(), replay: new MemoryReplayStore() }).ok);
  await deviceCall('POST', `/desktop/v1/devices/commands/${cmd.id}/ack`, b.credential, { state: 'failed', reason: 'Protected' });
  const hist = (await adminCall('GET', 'software/deployments', alice)).body.items;
  const row = hist.find((x: { id: string }) => x.id === cmd.id);
  assert.equal(row.action, 'uninstall'); assert.equal(row.state, 'failed'); assert.equal(row.reason, 'Protected'); assert.equal(row.hostname, 'bulk-2');
  assert.equal((await adminCall('POST', 'software/deploy', alice, { catalog_id: 'flatpak:org.videolan.VLC', action: 'remove', devices: [a.device_id] })).status, 400);
});
