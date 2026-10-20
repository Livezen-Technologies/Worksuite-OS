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

test('signalling relay: only for a consented, active session; device offers, admin answers; stops at end', async () => {
  const dev = await enroll(orgA);
  const other = await enroll(orgA);
  const tess = await login('tess@a.test', 'tess-password');
  const zed = await login('zed@b.test', 'zed-password');
  const id = (await call('POST', 'remote-support/sessions', { cookie: tess, body: { device_id: dev.device_id, mode: 'view', reason: 'screen flickers' } })).body.session_id;
  const dsig = (method: string, body?: unknown, cred = dev.credential, q = '') => fetch(`${base}/desktop/v1/os/remote-support/sessions/${id}/signal${q}`, { method, headers: { 'x-ws-device': cred, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });

  // Before consent nothing is relayed.
  assert.equal((await dsig('POST', { type: 'offer', sdp: 'v=0' })).status, 409);
  assert.equal((await call('GET', `remote-support/sessions/${id}/signal`, { cookie: tess })).status, 409);
  assert.equal(await device(dev.credential).report(id, { state: 'active', granted_mode: 'view', consent: 'user' }), 204);

  assert.equal((await dsig('POST', { type: 'answer', sdp: 'x' })).status, 400, 'device may not answer');
  assert.equal((await dsig('POST', { type: 'offer', sdp: 'v=0 offer' })).status, 204);
  assert.equal((await dsig('POST', { type: 'offer', sdp: 'x' }, other.credential)).status, 404, 'another device cannot inject');
  assert.equal((await call('GET', `remote-support/sessions/${id}/signal`, { cookie: zed })).status, 404, 'another org cannot read');
  const got = (await call('GET', `remote-support/sessions/${id}/signal`, { cookie: tess })).body;
  assert.equal(got.granted_mode, 'view');
  assert.deepEqual(got.messages.map((m: any) => [m.type, m.sdp]), [['offer', 'v=0 offer']]);
  assert.equal((await call('POST', `remote-support/sessions/${id}/signal`, { cookie: tess, body: { type: 'offer', sdp: 'x' } })).status, 400);
  assert.equal((await call('POST', `remote-support/sessions/${id}/signal`, { cookie: tess, body: { type: 'answer', sdp: 'v=0 answer' } })).status, 204);
  assert.equal((await call('POST', `remote-support/sessions/${id}/signal`, { cookie: tess, body: { type: 'ice', candidate: { candidate: 'candidate:1', sdpMid: '0' } } })).status, 204);
  const toDev = await (await dsig('GET')).json() as any;
  assert.deepEqual(toDev.messages.map((m: any) => m.type), ['answer', 'ice']);
  const after = toDev.messages.at(-1).id;
  assert.deepEqual((await (await dsig('GET', undefined, dev.credential, `?after=${after}`)).json() as any).messages, []);
  const log = (await call('GET', 'log', { cookie: tess })).body.items.map((i: any) => i.action);
  assert.ok(log.includes('remote_support_stream_offered') && log.includes('remote_support_stream_answered'));

  await call('POST', `remote-support/sessions/${id}/terminate`, { cookie: tess });
  assert.equal((await dsig('GET')).status, 409, 'relay stops at the end');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM remote_signals WHERE session_id = ?').get(id) as { n: number }).n, 0, 'signals dropped');
});

// ---- issue #37 ----
import { iceServers, purgeRecordings } from '../src/remoteSupport.ts';
import { createHmac } from 'node:crypto';

async function activeSession(cookie: string, mode: 'view' | 'control' = 'view', extra: Record<string, unknown> = {}) {
  const dev = await enroll(orgA);
  const r = await call('POST', 'remote-support/sessions', { cookie, body: { device_id: dev.device_id, mode, reason: 'help with files', ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(await device(dev.credential).report(r.body.session_id, { state: 'active', granted_mode: 'view', consent: 'user' }), 204);
  return { dev, id: r.body.session_id as string };
}

test('ICE servers: STUN, coturn REST credentials (short-lived, per session), static extras', () => {
  const now = Date.parse('2026-10-20T10:00:00Z');
  const env = { WORKSUITE_STUN_URLS: 'stun:turn.example.com:3478, bogus', WORKSUITE_TURN_URLS: 'turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349', WORKSUITE_TURN_SECRET: 's3cret', WORKSUITE_TURN_TTL: '600',
    WORKSUITE_ICE_SERVERS: '[{"urls":"stun:extra.example.com"},{"nope":1}]' };
  const l = iceServers('sess-1', now, env);
  assert.deepEqual(l[0], { urls: ['stun:turn.example.com:3478'] });
  const user = `${now / 1000 + 600}:sess-1`;
  assert.deepEqual(l[1], { urls: ['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:5349'], username: user, credential: createHmac('sha1', 's3cret').update(user).digest('base64') });
  assert.deepEqual(l[2], { urls: 'stun:extra.example.com' });
  assert.equal(l.length, 3);
  assert.equal(iceServers('x', now, { WORKSUITE_TURN_URLS: 'turn:t' }).length, 0, 'no TURN without the shared secret');
  assert.equal(Number(iceServers('x', now, { ...env, WORKSUITE_TURN_TTL: '99999999' })[1].username!.split(':')[0]), now / 1000 + 86400, 'TTL capped at a day');
});

test('ICE servers endpoint for both peers, only for an active session', async () => {
  const tess = await login('tess@a.test', 'tess-password');
  const { dev, id } = await activeSession(tess);
  process.env.WORKSUITE_TURN_URLS = 'turn:t.example:3478'; process.env.WORKSUITE_TURN_SECRET = 'k';
  try {
    const a = await call('GET', `remote-support/sessions/${id}/ice-servers`, { cookie: tess });
    assert.equal(a.body.ice_servers[0].urls[0], 'turn:t.example:3478');
    assert.match(a.body.ice_servers[0].username, new RegExp(`^\\d+:${id}$`));
    const d = await fetch(`${base}/desktop/v1/os/remote-support/sessions/${id}/ice-servers`, { headers: { 'x-ws-device': dev.credential } });
    assert.equal(d.status, 200);
  } finally { delete process.env.WORKSUITE_TURN_URLS; delete process.env.WORKSUITE_TURN_SECRET; }
  await call('POST', `remote-support/sessions/${id}/terminate`, { cookie: tess });
  assert.equal((await call('GET', `remote-support/sessions/${id}/ice-servers`, { cookie: tess })).status, 409);
});

test('step-up: view → control needs TOTP, sends a signed RemoteSupportElevate, grant changes only on the device report', async () => {
  const tess = await login('tess@a.test', 'tess-password');
  const { dev, id } = await activeSession(tess);
  await device(dev.credential).poll();
  assert.equal((await call('POST', `remote-support/sessions/${id}/elevate`, { cookie: tess, body: {} })).status, 401);
  assert.equal((await call('POST', `remote-support/sessions/${id}/elevate`, { cookie: tess, body: { otp: '123456' } })).status, 401);
  const zed = await login('zed@b.test', 'zed-password');
  assert.equal((await call('POST', `remote-support/sessions/${id}/elevate`, { cookie: zed, body: { otp: '123456' } })).status, 404);
  const ok = await call('POST', `remote-support/sessions/${id}/elevate`, { cookie: tess, body: { otp: totp(totpSecret, Date.now() + 30_000) } });
  assert.equal(ok.status, 202, JSON.stringify(ok.body));
  assert.equal((await call('POST', `remote-support/sessions/${id}/elevate`, { cookie: tess, body: { otp: totp(totpSecret, Date.now() + 30_000) } })).status, 409, 'already asking');
  let h = (await call('GET', 'remote-support/sessions', { cookie: tess })).body.items.find((s: any) => s.id === id);
  assert.equal(h.granted_mode, 'view', 'still view until the user answers');
  assert.equal(h.elevation, 'requested');
  const cmds = (await device(dev.credential).poll()).commands;
  assert.deepEqual(cmds.map((c) => c.command), ['RemoteSupportRequest', 'RemoteSupportElevate'], 'delivered on the fast poll');
  admin.exportKeys(db, join(dir, 'keys2'));
  assert.ok(validateCommand(cmds[1], { deviceId: dev.device_id, keys: loadKeys(join(dir, 'keys2')), replay: new MemoryReplayStore() }).ok);
  assert.equal(await device(dev.credential).report(id, { state: 'active', granted_mode: 'control', consent: 'user', elevation: 'granted' }), 204);
  h = (await call('GET', 'remote-support/sessions', { cookie: tess })).body.items.find((s: any) => s.id === id);
  assert.equal(h.granted_mode, 'control');
  assert.equal(h.elevation, 'granted');
  assert.equal((await call('POST', `remote-support/sessions/${id}/elevate`, { cookie: tess, body: {} })).status, 409);
  const log = (await call('GET', 'log', { cookie: tess })).body.items.map((i: any) => i.action);
  assert.ok(log.includes('remote_support_elevation_requested') && log.includes('remote_support_elevation_granted'));
  await call('POST', `remote-support/sessions/${id}/terminate`, { cookie: tess });
});

test('chat and file-transfer audit: metadata only, validated, both sides, active sessions only', async () => {
  const tess = await login('tess@a.test', 'tess-password');
  const { dev, id } = await activeSession(tess);
  const ev = (body: unknown, cred = dev.credential) => fetch(`${base}/desktop/v1/os/remote-support/sessions/${id}/events`, { method: 'POST', headers: { 'x-ws-device': cred, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await ev({ kind: 'chat', direction: 'to_admin', length: 12 })).status, 204);
  assert.equal((await ev({ kind: 'chat', direction: 'to_admin', length: 12, text: 'secret' })).status, 204, 'extra fields are dropped, not stored');
  assert.equal((await ev({ kind: 'chat', direction: 'sideways', length: 1 })).status, 400);
  const sha = 'a'.repeat(64);
  assert.equal((await ev({ kind: 'file', direction: 'to_device', action: 'accepted', name: 'driver.zip', size: 2048 })).status, 204);
  assert.equal((await ev({ kind: 'file', direction: 'to_device', action: 'completed', name: 'driver.zip', size: 2048, sha256: sha })).status, 204);
  assert.equal((await ev({ kind: 'file', direction: 'to_device', action: 'deleted', name: 'x', size: 1 })).status, 400);
  assert.equal((await call('POST', `remote-support/sessions/${id}/events`, { cookie: tess, body: { kind: 'file', direction: 'to_admin', action: 'completed', name: 'log.txt', size: 10 } })).status, 204);
  const other = await enroll(orgA);
  assert.equal((await ev({ kind: 'chat', direction: 'to_admin', length: 1 }, other.credential)).status, 404);
  const items = (await call('GET', `remote-support/sessions/${id}/events`, { cookie: tess })).body.items;
  assert.deepEqual(items.map((e: any) => [e.side, e.kind, e.action ?? e.length]), [['device', 'chat', 12], ['device', 'chat', 12], ['device', 'file', 'accepted'], ['device', 'file', 'completed'], ['admin', 'file', 'completed']]);
  assert.ok(!JSON.stringify(items).includes('secret'), 'chat text is never stored');
  assert.equal(items[3].sha256, sha);
  const log = (await call('GET', 'log', { cookie: tess })).body.items.map((i: any) => i.action);
  assert.ok(log.includes('remote_support_chat') && log.includes('remote_support_file_completed'));
  await call('POST', `remote-support/sessions/${id}/terminate`, { cookie: tess });
  assert.equal((await ev({ kind: 'chat', direction: 'to_admin', length: 1 })).status, 409);
});

test('recording: only when the policy allows it and the request asked; in-order chunks; audited download; retention', async () => {
  const tess = await login('tess@a.test', 'tess-password');
  admin.setPolicy(db, orgA, {});
  const dev0 = await enroll(orgA);
  assert.equal((await call('POST', 'remote-support/sessions', { cookie: tess, body: { device_id: dev0.device_id, mode: 'view', reason: 'record me', record: true } })).status, 409, 'policy must allow recording');
  assert.throws(() => validatePolicy({ remote_support: { recording_retention_days: 0 } }));
  admin.setPolicy(db, orgA, { remote_support: { recording: true, recording_retention_days: 7 } });
  const { dev, id } = await activeSession(tess, 'view', { record: true });
  const c = (await device(dev.credential).poll()).commands[0];
  assert.equal(c.args.record, true, 'the device is told, so the user sees it in the consent dialog');
  const up = (seq: number, data: Buffer, ct = 'video/webm') => fetch(`${base}/admin/api/remote-support/sessions/${id}/recording?seq=${seq}`, { method: 'POST', headers: { 'x-ws-admin': '1', cookie: tess, 'content-type': ct }, body: new Uint8Array(data) });
  assert.equal((await up(0, Buffer.from('abc'), 'text/plain')).status, 400);
  assert.equal((await up(1, Buffer.from('late'))).status, 409, 'out of order');
  assert.equal((await up(0, Buffer.from('WEBM'))).status, 200);
  assert.equal((await up(0, Buffer.from('WEBM'))).status, 200, 'a retried chunk is accepted once');
  assert.equal((await up(1, Buffer.from('-two'))).status, 200);
  const dl = await fetch(`${base}/admin/api/remote-support/sessions/${id}/recording`, { headers: { 'x-ws-admin': '1', cookie: tess } });
  assert.equal(dl.headers.get('content-type'), 'video/webm');
  assert.equal(Buffer.from(await dl.arrayBuffer()).toString(), 'WEBM-two');
  const zed = await login('zed@b.test', 'zed-password');
  assert.equal((await fetch(`${base}/admin/api/remote-support/sessions/${id}/recording`, { headers: { 'x-ws-admin': '1', cookie: zed } })).status, 404);
  let log = (await call('GET', 'log', { cookie: tess })).body.items.map((i: any) => i.action);
  assert.ok(log.includes('remote_support_recording_started') && log.includes('remote_support_recording_downloaded'));

  // A session without recording can't upload.
  const plain = await activeSession(tess);
  assert.equal((await fetch(`${base}/admin/api/remote-support/sessions/${plain.id}/recording?seq=0`, { method: 'POST', headers: { 'x-ws-admin': '1', cookie: tess, 'content-type': 'video/webm' }, body: 'x' })).status, 409);

  await call('POST', `remote-support/sessions/${id}/terminate`, { cookie: tess });
  purgeRecordings(db, Date.now() + 6 * 86_400_000);
  assert.equal((await fetch(`${base}/admin/api/remote-support/sessions/${id}/recording`, { headers: { 'x-ws-admin': '1', cookie: tess } })).status, 200, 'kept within retention');
  purgeRecordings(db, Date.now() + 8 * 86_400_000);
  assert.equal((await fetch(`${base}/admin/api/remote-support/sessions/${id}/recording`, { headers: { 'x-ws-admin': '1', cookie: tess } })).status, 404, 'deleted after retention');
  log = (await call('GET', 'log', { cookie: tess })).body.items.map((i: any) => i.action);
  assert.ok(log.includes('remote_support_recording_expired'));
  admin.setPolicy(db, orgA, {});
});
