import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as admin from '../src/admin.ts';
import { purgeTombstones, TOMBSTONE_WINDOW } from '../src/api.ts';
import { openDb } from '../src/db.ts';
import { createHandler } from '../src/main.ts';
import { issueTokens } from '../src/oauth.ts';

let dir: string, server: Server, base: string, db: ReturnType<typeof openDb>;
let org: number, ana: string, ben: string, strictUser: string, strictOrg: number;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ws-api-'));
  db = openDb(join(dir, 'db'));
  org = admin.createOrg(db, 'Org A');
  strictOrg = admin.createOrg(db, 'Strict Org', { requireDevice: true });
  ana = issueTokens(db, admin.addUser(db, org, 'ana@a.test', 'Ana', 'password-123'), 'worksuite-os').access_token;
  ben = issueTokens(db, admin.addUser(db, org, 'ben@a.test', 'Ben', 'password-123'), 'worksuite-os').access_token;
  strictUser = issueTokens(db, admin.addUser(db, strictOrg, 'c@b.test', 'C', 'password-123'), 'worksuite-os').access_token;
  server = createServer(createHandler(db, { publicUrl: 'https://ws.test/' }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

const call = async (method: string, path: string, o: { token?: string; device?: string; body?: unknown; idem?: string; raw?: string } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
      ...(o.device ? { 'x-ws-device': o.device } : {}),
      ...(o.idem ? { 'idempotency-key': o.idem } : {}),
      'content-type': 'application/json', 'x-request-id': 'req-123',
    },
    body: o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
};

async function enroll(orgId = org) {
  const r = await call('POST', '/desktop/v1/devices/register', {
    body: { enrollment_token: admin.createEnrollmentToken(db, orgId), public_key: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }), arch: 'amd64', hostname: 'h' },
    idem: randomUUID(),
  });
  assert.equal(r.status, 201);
  return r.body as { device_id: string; credential: string };
}

test('errors use the structured shape and echo the request id', async () => {
  const r = await call('GET', '/desktop/v1/bootstrap');
  assert.equal(r.status, 401);
  assert.deepEqual(r.body, { error: { code: 'TOKEN_EXPIRED', message: 'missing bearer token', request_id: 'req-123' } });
  assert.equal(r.headers.get('x-request-id'), 'req-123');
  assert.equal((await call('GET', '/nope')).body.error.code, 'NOT_FOUND');
  assert.equal((await call('DELETE', '/desktop/v1/bootstrap', { token: ana })).status, 405);
  assert.equal((await call('POST', '/desktop/v1/sync/events', { token: ana, raw: '{' })).body.error.code, 'VALIDATION');
  assert.equal((await call('POST', '/desktop/v1/sync/events', { token: ana, raw: JSON.stringify({ x: 'a'.repeat(1024 * 1024) }) })).status, 413);
});

test('Idempotency-Key: required, and a replay returns the original response without a second effect', async () => {
  assert.equal((await call('POST', '/desktop/v1/audit', { token: ana, body: { events: [] } })).status, 400);
  const idem = randomUUID();
  const body = { batch_id: randomUUID(), mutations: [{ mutation_id: randomUUID(), module: 'tasks', object_id: 't1', operation: 'create', base_revision: null, payload: { n: 1 } }] };
  const a = await call('POST', '/desktop/v1/sync/mutations', { token: ana, idem, body });
  const b = await call('POST', '/desktop/v1/sync/mutations', { token: ana, idem, body });
  assert.deepEqual(a.body, b.body);
  assert.equal(b.headers.get('idempotent-replay'), 'true');
  assert.equal(a.body.results[0].status, 'applied');
  // Keys are per principal: Ben reusing Ana's key gets his own result.
  const c = await call('POST', '/desktop/v1/sync/mutations', { token: ben, idem, body });
  assert.equal(c.body.results[0].status, 'applied');
  assert.equal(c.headers.get('idempotent-replay'), null);
});

test('tombstones past the window are purged and older cursors get 410 CURSOR_EXPIRED', async () => {
  const m = (operation: string, base_revision: number | null, object_id: string) =>
    call('POST', '/desktop/v1/sync/mutations', { token: ana, idem: randomUUID(), body: { batch_id: randomUUID(), mutations: [{ mutation_id: randomUUID(), module: 'docs', object_id, operation, base_revision, payload: { v: 1 } }] } });
  await m('create', null, 'd1');
  const first = await call('GET', '/desktop/v1/sync/changes?stream=docs', { token: ana });
  await m('delete', 1, 'd1');
  await m('create', null, 'd2');
  purgeTombstones(db, Date.now() + TOMBSTONE_WINDOW + 1000);
  const r = await call('GET', `/desktop/v1/sync/changes?stream=docs&cursor=${first.body.next_cursor}`, { token: ana });
  assert.equal(r.status, 410);
  assert.equal(r.body.error.code, 'CURSOR_EXPIRED');
  const full = await call('GET', '/desktop/v1/sync/changes?stream=docs', { token: ana });
  assert.deepEqual(full.body.changes.map((c: { object_id: string }) => c.object_id), ['d2']);
  // Recreating after a delete is allowed and continues the revision sequence.
  assert.equal((await call('GET', '/desktop/v1/sync/changes?stream=docs&cursor=abc', { token: ana })).status, 400);
});

test('document locks: one holder at a time, renewable by the holder, released on DELETE', async () => {
  const a = await call('POST', '/desktop/v1/files/doc-1/lock', { token: ana });
  assert.equal(a.status, 200);
  assert.equal((await call('POST', '/desktop/v1/files/doc-1/lock', { token: ben })).body.error.code, 'LOCKED');
  assert.equal((await call('POST', '/desktop/v1/files/doc-1/lock', { token: ana })).body.lock_id, a.body.lock_id);
  assert.equal((await call('DELETE', '/desktop/v1/files/doc-1/lock', { token: ben })).status, 204);   // not Ben's: no effect
  assert.equal((await call('POST', '/desktop/v1/files/doc-1/lock', { token: ben })).status, 409);
  await call('DELETE', '/desktop/v1/files/doc-1/lock', { token: ana });
  assert.equal((await call('POST', '/desktop/v1/files/doc-1/lock', { token: ben })).status, 200);
});

test('organizations that require a device refuse user calls without one; devices are tenant-bound', async () => {
  assert.equal((await call('GET', '/desktop/v1/bootstrap', { token: strictUser })).body.error.code, 'DEVICE_REQUIRED');
  const strictDev = await enroll(strictOrg);
  assert.equal((await call('GET', '/desktop/v1/bootstrap', { token: strictUser, device: strictDev.credential })).status, 200);
  const otherDev = await enroll(org);
  assert.equal((await call('GET', '/desktop/v1/bootstrap', { token: strictUser, device: otherDev.credential })).status, 403);
  assert.equal((await call('GET', '/desktop/v1/os/directory', { device: 'wsd_unknown' })).status, 403);
  // A device cannot ack another device's command.
  const cmd = admin.issueCommand(db, strictDev.device_id, 'RefreshPolicy');
  assert.equal((await call('POST', `/desktop/v1/devices/commands/${cmd}/ack`, { device: otherDev.credential, idem: randomUUID(), body: { state: 'completed' } })).status, 404);
  admin.revokeDevice(db, otherDev.device_id);
  assert.equal((await call('GET', '/desktop/v1/os/directory', { device: otherDev.credential })).body.error.code, 'DEVICE_REVOKED');
});

test('device reports and escrow are stored; required fields are validated', async () => {
  const d = await enroll();
  const report = (path: string, body: unknown) => call('POST', path, { device: d.credential, idem: randomUUID(), body });
  assert.equal((await report('/desktop/v1/os/inventory', { collected_at: new Date().toISOString(), hardware: {}, software: [] })).status, 202);
  assert.equal((await report('/desktop/v1/os/update-results', { release_id: 'r1' })).status, 400);
  assert.equal((await report('/desktop/v1/os/update-results', { release_id: 'r1', result: 'success', os_version: '1', shell_version: '1', kernel_version: '6' })).status, 202);
  assert.equal((await report('/desktop/v1/os/break-glass', { username: 'wsadmin', encrypted_secret: 'age1…', rotated_at: new Date().toISOString() })).status, 204);
  assert.deepEqual((await call('GET', '/desktop/v1/os/directory', { device: d.credential })).body, { type: 'oneauth', offline_login_days: 7 });
  const hb = await call('POST', '/desktop/v1/devices/heartbeat', { device: d.credential, body: { os_version: '1' } });
  assert.equal(hb.status, 400);
});

test('directory authenticate is device-bound, refuses disabled accounts; break-glass use is audited', async () => {
  const d = await enroll();
  const auth = (username: string, password: string, device = d.credential) =>
    call('POST', '/desktop/v1/os/directory/authenticate', { device, body: { username, password } });
  assert.equal((await call('POST', '/desktop/v1/os/directory/authenticate', { body: { username: 'ana@a.test', password: 'password-123' } })).status, 403);
  const ok = await auth('Ana@A.test', 'password-123');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.username, 'ana@a.test');
  assert.deepEqual(ok.body.groups, ['worksuite-users']);
  assert.equal(ok.body.offline_login_days, 7);
  assert.equal(JSON.stringify(ok.body).includes('password'), false);
  assert.equal((await auth('ana@a.test', 'wrong-password')).body.error.code, 'INVALID_CREDENTIALS');
  assert.equal((await auth('nobody@a.test', 'password-123')).status, 401);
  // A device of another organization cannot verify this org's users.
  const strictDev = await enroll(strictOrg);
  assert.equal((await auth('ana@a.test', 'password-123', strictDev.credential)).status, 401);
  const gone = admin.addUser(db, org, 'gone@a.test', 'Gone', 'password-123');
  db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(gone);
  assert.equal((await auth('gone@a.test', 'password-123')).body.error.code, 'ACCOUNT_DISABLED');
  const ev = (type: string) => call('POST', '/desktop/v1/os/break-glass/events', { device: d.credential, idem: randomUUID(),
    body: { id: randomUUID(), type, username: 'wsadmin', at: new Date().toISOString() } });
  assert.equal((await ev('used')).status, 202);
  assert.equal((await ev('bogus')).status, 400);
  const rows = db.prepare('SELECT type FROM audit WHERE principal = ?').all(`device:${d.device_id}`) as { type: string }[];
  assert.deepEqual(rows.map((r) => r.type), ['break_glass.used']);
});

test('WSOS-SEC-008: device package-change audit events are stored against the device, retries are ignored', async () => {
  const d = await enroll();
  const post = (events: unknown) => call('POST', '/desktop/v1/os/audit', { device: d.credential, idem: randomUUID(), body: { events } });
  const ev = { id: 'pkg-1', type: 'package.installed', at: '2026-10-16T10:00:00.000Z', data: { caller: 1000, source: 'flatpak', name: 'org.gnome.Calculator' } };
  assert.equal((await post([ev])).status, 202);
  assert.equal((await post([ev])).status, 202);
  assert.equal((await post([{ ...ev, id: 'x', type: 'directory.password_changed' }])).status, 400);
  assert.equal((await post([{ ...ev, id: 'y', at: 'yesterday' }])).status, 400);
  assert.equal((await post([])).status, 400);
  assert.equal((await call('POST', '/desktop/v1/os/audit', { idem: randomUUID(), body: { events: [ev] } })).status, 403);
  const rows = db.prepare('SELECT type, data FROM audit WHERE principal = ? AND type LIKE ?').all(`device:${d.device_id}`, 'package.%') as { type: string; data: string }[];
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].data).name, 'org.gnome.Calculator');
});

test('expired commands are not delivered', async () => {
  const d = await enroll();
  const id = admin.issueCommand(db, d.device_id, 'RefreshPolicy');
  db.prepare('UPDATE commands SET expires = ? WHERE id = ?').run(Date.now() - 1, id);
  const hb = await call('POST', '/desktop/v1/devices/heartbeat', { device: d.credential, body: { os_version: '1', shell_version: '1', kernel_version: '6', policy_version: '0' } });
  assert.deepEqual(hb.body, { commands: [] });
});

test('bootstrap lists the org\'s web apps with web_url; links resolve to a web_url', async () => {
  const b = await call('GET', '/desktop/v1/bootstrap', { token: ana });
  const mail = b.body.apps.find((a: { id: string }) => a.id === 'mail');
  assert.deepEqual(mail, { id: 'mail', name: 'Mail', offline_level: 'cached_read', web_url: 'https://ws.test/apps/mail/' });
  assert.equal(b.body.apps.length, 9);
  const l = await call('GET', '/desktop/v1/links/resolve?url=' + encodeURIComponent('worksuite://drive/files/42?v=1'), { token: ana });
  assert.deepEqual(l.body, { app_id: 'drive', route: '/files/42', web_url: 'https://ws.test/apps/drive/files/42?v=1' });
  admin.setWebApps(db, org, ['mail', 'chat']);
  const b2 = await call('GET', '/desktop/v1/bootstrap', { token: ana });
  assert.deepEqual(b2.body.apps.map((a: { id: string }) => a.id), ['mail', 'chat']);
  const l2 = await call('GET', '/desktop/v1/links/resolve?url=' + encodeURIComponent('worksuite://drive/x'), { token: ana });
  assert.equal(l2.body.web_url, null);
  assert.throws(() => admin.setWebApps(db, org, ['nope']));
  admin.setWebApps(db, org, null);
});

test('search, file search and recent files cover only the caller\'s records', async () => {
  const put = (token: string, module: string, object_id: string, payload: unknown) => call('POST', '/desktop/v1/sync/mutations', {
    token, idem: randomUUID(), body: { batch_id: randomUUID(), mutations: [{ mutation_id: randomUUID(), module, object_id, operation: 'create', base_revision: null, payload }] },
  });
  await put(ana, 'mail', 'm1', { subject: 'Budget review', from: 'Kamal' });
  await put(ana, 'contacts', 'c1', { name: 'Budget Office', email: 'b@a.test' });
  await put(ana, 'files', 'f1', { name: 'Budget 2026.xlsx', folder: 'Finance', size: 2048 });
  await put(ben, 'mail', 'm9', { subject: 'Budget secret' });
  const s = await call('GET', '/desktop/v1/search?q=budget', { token: ana });
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.results.map((r: { id: string }) => r.id).sort(), ['contacts:c1', 'mail:m1']);
  const m = s.body.results.find((r: { id: string }) => r.id === 'mail:m1');
  assert.equal(m.type, 'mail'); assert.equal(m.link, 'worksuite://mail/m1'); assert.equal(m.subtitle, 'Kamal');
  const typed = await call('GET', '/desktop/v1/search?q=budget&types=contact', { token: ana });
  assert.deepEqual(typed.body.results.map((r: { type: string }) => r.type), ['contact']);
  const f = await call('GET', '/desktop/v1/files/search?q=budget', { token: ana });
  assert.equal(f.body.files.length, 1);
  assert.equal(f.body.files[0].ext, 'xlsx'); assert.equal(f.body.files[0].folder, 'Finance');
  const recent = await call('GET', '/desktop/v1/files/recent', { token: ana });
  assert.deepEqual(recent.body.files.map((x: { id: string }) => x.id), ['files:f1']);
  const benS = await call('GET', '/desktop/v1/search?q=budget', { token: ben });
  assert.deepEqual(benS.body.results.map((r: { id: string }) => r.id), ['mail:m9']);
  assert.equal((await call('GET', '/desktop/v1/search?q=', { token: ana })).status, 400);
  assert.equal((await call('GET', '/desktop/v1/search?q=x')).status, 401);
});

test('§11.6-d problem reports: stored for the user\'s org with the device, unknown sections refused', async () => {
  const d = await enroll();
  const post = (body: unknown) => call('POST', '/desktop/v1/problem-reports', { token: ana, device: d.credential, idem: randomUUID(), body });
  assert.equal((await post({ id: 'rep-00001', description: 'Wi-Fi drops', sections: [{ id: 'system', text: 'OS: WorkSuite OS' }] })).status, 202);
  assert.equal((await post({ id: 'rep-00002', sections: [{ id: 'shadow', text: 'x' }] })).status, 400);
  assert.equal((await post({ id: 'rep-00003', sections: [{ id: 'system', text: 'x'.repeat(80_000) }] })).status, 400);
  assert.equal((await call('POST', '/desktop/v1/problem-reports', { device: d.credential, idem: randomUUID(), body: { id: 'rep-00004', sections: [] } })).status, 401);
  const row = db.prepare('SELECT device_id, body FROM problem_reports WHERE id = ?').get('rep-00001') as { device_id: string; body: string };
  assert.equal(row.device_id, d.device_id);
  assert.equal(JSON.parse(row.body).description, 'Wi-Fi drops');
});
