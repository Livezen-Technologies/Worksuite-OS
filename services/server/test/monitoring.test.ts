// Security Center (#20) and Employee monitoring (#22) on the server: policy fields, incident-response commands,
// closed activity-report schema, retention, transparency and organization isolation.
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
import { issueTokens } from '../src/oauth.ts';
import { validatePolicy } from '../src/policy.ts';
import { purgeActivity, validateActivityReport } from '../src/monitoring.ts';
import { validateCommand, MemoryReplayStore } from '../../device-agent/src/commands.ts';
import { loadKeys } from '../../device-agent/src/main.ts';

let dir: string, server: Server, base: string, db: ReturnType<typeof openDb>;
let orgA: number, orgB: number, ana: string, zoe: string;
const NOW = Date.now();
const today = new Date(NOW).toISOString().slice(0, 10);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ws-mon-'));
  db = openDb(join(dir, 'db'));
  orgA = admin.createOrg(db, 'Org A');
  orgB = admin.createOrg(db, 'Org B');
  admin.addUser(db, orgA, 'alice@a.test', 'Alice', 'alice-password', 'admin');
  ana = issueTokens(db, admin.addUser(db, orgA, 'ana@a.test', 'Ana', 'password-123'), 'worksuite-os').access_token;
  zoe = issueTokens(db, admin.addUser(db, orgB, 'zoe@b.test', 'Zoe', 'password-123'), 'worksuite-os').access_token;
  admin.addUser(db, orgB, 'zed@b.test', 'Zed', 'zed-password', 'admin');
  server = createServer(createHandler(db, { publicUrl: 'https://ws.test/' }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

async function req(method: string, path: string, o: { cookie?: string; body?: unknown; token?: string; device?: string } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(path.startsWith('/admin/') ? { 'x-ws-admin': '1' } : {}), ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.body ? { 'content-type': 'application/json' } : {}),
      ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.device ? { 'x-ws-device': o.device } : {}),
    },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}
async function login(email: string, password: string) {
  const res = await fetch(`${base}/admin/api/login`, { method: 'POST', headers: { 'x-ws-admin': '1', 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return res.headers.get('set-cookie')!.split(';')[0];
}
async function enroll(orgId: number, hostname: string) {
  const res = await fetch(`${base}/desktop/v1/devices/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ enrollment_token: admin.createEnrollmentToken(db, orgId), public_key: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }), arch: 'amd64', hostname }),
  });
  return (await res.json()) as { device_id: string; credential: string };
}
const report = (over: Record<string, unknown> = {}) => ({
  day: today, active_s: 3600, idle_s: 600, locked_s: 1200, first_active: NOW - 7200_000, last_active: NOW,
  apps: [{ app_id: 'org.worksuite.Office', name: 'WorkSuite Office', active_s: 3000, switches: 12 }, { app_id: 'firefox', name: 'Firefox', active_s: 600, switches: 4 }],
  events: [{ at: NOW - 7200_000, type: 'login' }, { at: NOW - 3600_000, type: 'lock' }], ...over,
});

test('policy: security and monitoring fields are validated', () => {
  assert.deepEqual(validatePolicy({ firewall_outbound_block: ['203.0.113.0/24', '2001:db8::/32'], antivirus: true, av_scan_schedule: 'daily', av_exclusions: ['/home/dev/vm'], activity_monitoring: true, activity_retention_days: 30 }),
    { firewall_outbound_block: ['203.0.113.0/24', '2001:db8::/32'], antivirus: true, av_scan_schedule: 'daily', av_exclusions: ['/home/dev/vm'], activity_monitoring: true, activity_retention_days: 30 });
  for (const bad of [{ firewall_outbound_block: ['example.com'] }, { av_exclusions: ['/'] }, { av_exclusions: ['relative'] }, { av_scan_schedule: 'hourly' }, { activity_retention_days: 0 }, { av_cpu_quota_percent: 5 }])
    assert.throws(() => validatePolicy(bad), JSON.stringify(bad));
});

test('activity report schema is closed: no titles, URLs, keystrokes or screenshots', () => {
  assert.equal(validateActivityReport(report(), NOW).apps.length, 2);
  for (const extra of [{ window_titles: ['x'] }, { screenshots: [] }, { keystrokes: 1 }, { urls: [] }])
    assert.throws(() => validateActivityReport(report(extra), NOW), /not collected/);
  assert.throws(() => validateActivityReport(report({ apps: [{ app_id: 'firefox', name: 'F', active_s: 1, title: 'Inbox' }] }), NOW), /not collected/);
  assert.throws(() => validateActivityReport(report({ events: [{ at: NOW, type: 'keypress' }] }), NOW));
  assert.throws(() => validateActivityReport(report({ day: '2020-01-01' }), NOW));
});

test('reports: refused while monitoring is off, stored when on, visible to the employee, org-isolated, purged by retention', async () => {
  const dev = await enroll(orgA, 'laptop-a');
  const devB = await enroll(orgB, 'laptop-b');
  const post = (body: unknown, token = ana, device: string | null = dev.credential) => req('POST', '/desktop/v1/activity', { token, device: device ?? undefined, body });
  assert.equal((await post({ reports: [report()] })).status, 403);   // policy off
  admin.setPolicy(db, orgA, { activity_monitoring: true, activity_retention_days: 30 });
  assert.equal((await post({ reports: [report()] }, ana, null)).status, 403);   // device required
  assert.equal((await post({ reports: [report()] }, ana, devB.credential)).status, 403);   // other org's device
  const ok = await post({ reports: [report()] });
  assert.equal(ok.status, 202); assert.deepEqual(ok.body.stored, [today]);
  assert.equal((await post({ reports: [report({ active_s: 4000 })] })).status, 202);   // same day replaces

  const own = await req('GET', '/desktop/v1/activity', { token: ana });
  assert.equal(own.body.items.length, 1); assert.equal(own.body.items[0].active_s, 4000);
  assert.equal((await req('GET', '/desktop/v1/activity', { token: zoe })).body.items.length, 0);

  const alice = await login('alice@a.test', 'alice-password');
  const m = await req('GET', '/admin/api/monitoring?days=7', { cookie: alice });
  assert.equal(m.status, 200); assert.equal(m.body.enabled, true); assert.equal(m.body.retention_days, 30);
  assert.equal(m.body.employees.length, 1);
  assert.equal(m.body.employees[0].name, 'Ana'); assert.equal(m.body.employees[0].top_apps[0].app_id, 'org.worksuite.Office');
  assert.deepEqual(m.body.employees[0].devices, ['laptop-a']);
  const zed = await login('zed@b.test', 'zed-password');
  assert.equal((await req('GET', '/admin/api/monitoring', { cookie: zed })).body.employees.length, 0);
  const log = (await req('GET', '/admin/api/log', { cookie: alice })).body.items.map((l: { action: string }) => l.action);
  assert.ok(log.includes('monitoring_viewed'));

  db.prepare("UPDATE activity_reports SET day = '2000-01-01'").run();
  purgeActivity(db);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM activity_reports').get() as { n: number }).n, 0);
  assert.equal((await post({ reports: [report()] })).status, 202);
  admin.setPolicy(db, orgA, { activity_monitoring: false });
  purgeActivity(db);   // monitoring turned off → everything held is deleted
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM activity_reports').get() as { n: number }).n, 0);
});

test('Security Center: heartbeat summaries, scan and release are routine, isolation needs the password and device name', async () => {
  const dev = await enroll(orgA, 'sec-host');
  const hb = await req('POST', '/desktop/v1/devices/heartbeat', { device: dev.credential, body: { os_version: '1', shell_version: '1', kernel_version: '6', policy_version: '1', security: { overall: 'at_risk', threats: { active: 2, quarantined: 1 }, firewall: { active: true }, isolation: null } } });
  assert.equal(hb.status, 200);
  const alice = await login('alice@a.test', 'alice-password');
  const s = await req('GET', '/admin/api/security', { cookie: alice });
  assert.equal(s.status, 200);
  assert.equal(s.body.totals.at_risk, 1); assert.equal(s.body.totals.active_threats, 2);
  assert.equal(s.body.devices.find((d: { hostname: string }) => d.hostname === 'sec-host').security.overall, 'at_risk');

  const cmd = (body: unknown) => req('POST', `/admin/api/devices/${dev.device_id}/commands`, { cookie: alice, body });
  assert.equal((await cmd({ command: 'StartMalwareScan', args: { kind: 'full' } })).status, 201);
  assert.equal((await cmd({ command: 'StartMalwareScan', args: { kind: 'everything' } })).status, 400);
  assert.equal((await cmd({ command: 'IsolateEndpoint', args: { hours: 4 } })).status, 401);
  assert.equal((await cmd({ command: 'IsolateEndpoint', args: { hours: 4 }, password: 'alice-password', confirm_name: 'wrong' })).status, 400);
  assert.equal((await cmd({ command: 'IsolateEndpoint', args: { hours: 400 }, password: 'alice-password', confirm_name: 'sec-host' })).status, 400);
  const iso = await cmd({ command: 'IsolateEndpoint', args: { hours: 4 }, password: 'alice-password', confirm_name: 'sec-host' });
  assert.equal(iso.status, 201);
  assert.equal((await cmd({ command: 'ReleaseIsolation' })).status, 201);

  // The device agent accepts the signed envelope.
  const keysDir = join(dir, 'keys');
  admin.exportKeys(db, keysDir);
  const env = JSON.parse((db.prepare('SELECT envelope FROM commands WHERE id = ?').get(iso.body.command_id) as { envelope: string }).envelope);
  const v = validateCommand(env, { deviceId: dev.device_id, keys: loadKeys(keysDir), replay: new MemoryReplayStore() });
  assert.equal(v.ok, true); assert.deepEqual(env.args, { hours: 4 });
});
