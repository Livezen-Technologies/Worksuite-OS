// Employee monitoring follow-up (#39) on the server: live state, device power events, website domains, the searchable
// and audited activity log, attendance with CSV export, and the signed HR webhook.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
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
import { purgeActivity, validateActivityReport, validateLive } from '../src/monitoring.ts';
import { attendanceCsv, runHrWebhooks, signWebhook, validateWebhookUrl } from '../src/attendance.ts';

let dir: string, server: Server, base: string, db: ReturnType<typeof openDb>;
let orgA: number, orgB: number, ana: string, ben: string, zoe: string;
const NOW = Date.now();
const today = new Date(NOW).toISOString().slice(0, 10);
const yesterday = new Date(NOW - 86_400_000).toISOString().slice(0, 10);
const hooks: { url: string; headers: Record<string, string>; body: string }[] = [];
let hookStatus = 200;
const webhookFetch = async (url: string, init: { headers: Record<string, string>; body: string }) => { hooks.push({ url, headers: init.headers, body: init.body }); return { status: hookStatus }; };

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ws-mon39-'));
  db = openDb(join(dir, 'db'));
  orgA = admin.createOrg(db, 'Org A');
  orgB = admin.createOrg(db, 'Org B');
  admin.addUser(db, orgA, 'alice@a.test', 'Alice', 'alice-password', 'admin');
  ana = issueTokens(db, admin.addUser(db, orgA, 'ana@a.test', 'Ana', 'password-123'), 'worksuite-os').access_token;
  ben = issueTokens(db, admin.addUser(db, orgA, 'ben@a.test', '=Ben', 'password-123'), 'worksuite-os').access_token;
  zoe = issueTokens(db, admin.addUser(db, orgB, 'zoe@b.test', 'Zoe', 'password-123'), 'worksuite-os').access_token;
  server = createServer(createHandler(db, { publicUrl: 'https://ws.test/', webhookFetch: webhookFetch as never }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

async function req(method: string, path: string, o: { cookie?: string; body?: unknown; token?: string; device?: string } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(path.startsWith('/admin/') ? { 'x-ws-admin': '1' } : {}), ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.device ? { 'x-ws-device': o.device } : {}),
    },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : undefined; } catch { /* csv */ }
  return { status: res.status, body, headers: res.headers };
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
  day: today, active_s: 3600, idle_s: 600, locked_s: 0, first_active: NOW - 7200_000, last_active: NOW - 60_000,
  apps: [{ app_id: 'org.worksuite.Office', name: 'WorkSuite Office', active_s: 3000, switches: 3 }],
  events: [{ at: NOW - 7200_000, type: 'login' }, { at: NOW - 3600_000, type: 'lock' }], ...over,
});
const hb = { os_version: '1', shell_version: '1', kernel_version: '6', policy_version: '1' };
const auditActions = async (cookie: string) => (await req('GET', '/admin/api/log', { cookie })).body.items.map((l: { action: string }) => l.action) as string[];

test('policy and schemas: website tracking is a boolean; domains only, never URLs or titles; live is closed', () => {
  assert.deepEqual(validatePolicy({ activity_web_domains: true }), { activity_web_domains: true });
  assert.throws(() => validatePolicy({ activity_web_domains: 'yes' }));
  assert.equal(validateActivityReport(report({ domains: [{ domain: 'mail.worksuite.lk', active_s: 60 }, { domain: 'xn--fsqu00a.xn--3lr804guic', active_s: 5 }] }), NOW).domains!.length, 2);
  for (const d of ['https://mail.worksuite.lk/', 'mail.worksuite.lk/inbox', 'mail.worksuite.lk:443', 'Mail.Worksuite.LK', '10.0.0.1', 'user@host.lk', 'Inbox - Mail', 'localhost', 'a.lk?q=1'])
    assert.throws(() => validateActivityReport(report({ domains: [{ domain: d, active_s: 1 }] }), NOW), /domain name only/, d);
  assert.throws(() => validateActivityReport(report({ domains: [{ domain: 'a.lk', active_s: 1, title: 'x' }] }), NOW), /not collected/);
  assert.deepEqual(validateLive({ state: 'idle', app_id: 'firefox' }), { state: 'idle', app_id: 'firefox' });
  for (const bad of [{ state: 'busy' }, { state: 'active', app_id: 'a b' }, { state: 'active', title: 'x' }, { state: 'active', url: 'https://x' }]) assert.throws(() => validateLive(bad));
  assert.equal(validateWebhookUrl('https://hr.test/h'), 'https://hr.test/h');
  for (const u of ['http://hr.test/h', 'https://u:p@hr.test/', 'ftp://x', 'nope']) assert.throws(() => validateWebhookUrl(u));
});

test('live heartbeat, power events, domains, log search, attendance, CSV and webhook (audited, org-isolated)', async () => {
  const dev = await enroll(orgA, 'laptop-a');
  const dev2 = await enroll(orgA, 'desk-a');
  const devB = await enroll(orgB, 'laptop-b');
  const live = (body: unknown, token = ana, device: string | null = dev.credential) => req('POST', '/desktop/v1/activity/live', { token, device: device ?? undefined, body });

  // Off by default: nothing accepted, power events dropped.
  assert.equal((await live({ state: 'active', app_id: 'firefox' })).status, 403);
  assert.equal((await req('POST', '/desktop/v1/devices/heartbeat', { device: dev.credential, body: { ...hb, power_events: [{ at: NOW - 1000, type: 'startup' }] } })).status, 200);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM activity_log').get() as { n: number }).n, 0);
  assert.ok(!JSON.stringify(db.prepare('SELECT heartbeat FROM devices WHERE id = ?').get(dev.device_id)).includes('power_events'));

  admin.setPolicy(db, orgA, { activity_monitoring: true, activity_retention_days: 30 });
  assert.equal((await live({ state: 'active', app_id: 'org.worksuite.Office' })).status, 204);
  assert.equal((await live({ state: 'active' }, ana, null)).status, 403);   // device required
  assert.equal((await live({ state: 'active', window_title: 'Payroll.xlsx' })).status, 400);
  assert.equal((await live({ state: 'locked', app_id: null }, ben, dev2.credential)).status, 204);
  db.prepare('UPDATE activity_live SET at = ? WHERE user_id = (SELECT id FROM users WHERE email = ?)').run(NOW - 10 * 60_000, 'ben@a.test');

  // Power events: stored once (heartbeat retries are deduplicated), invalid ones refused.
  const pe = [{ at: NOW - 9000_000, type: 'startup' }, { at: NOW - 100, type: 'shutdown' }];
  assert.equal((await req('POST', '/desktop/v1/devices/heartbeat', { device: dev.credential, body: { ...hb, power_events: pe } })).status, 200);
  assert.equal((await req('POST', '/desktop/v1/devices/heartbeat', { device: dev.credential, body: { ...hb, power_events: pe } })).status, 200);
  assert.equal((await req('POST', '/desktop/v1/devices/heartbeat', { device: dev.credential, body: { ...hb, power_events: [{ at: NOW, type: 'reboot' }] } })).status, 400);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE type IN ('startup','shutdown')").get() as { n: number }).n, 2);

  // Website domains: refused while the policy has them off, stored when on.
  const post = (body: unknown, token = ana, device = dev.credential) => req('POST', '/desktop/v1/activity', { token, device, body });
  const withWeb = report({ domains: [{ domain: 'mail.worksuite.lk', active_s: 900 }] });
  assert.equal((await post({ reports: [withWeb] })).status, 403);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM activity_reports').get() as { n: number }).n, 0);
  admin.setPolicy(db, orgA, { activity_monitoring: true, activity_retention_days: 30, activity_web_domains: true });
  assert.equal((await post({ reports: [withWeb] })).status, 202);
  assert.equal((await post({ reports: [report({ day: yesterday, first_active: NOW - 86_400_000, last_active: NOW - 80_000_000, apps: [], events: [] })] })).status, 202);
  assert.equal((await post({ reports: [report({ active_s: 1800, first_active: NOW - 9000_000, last_active: NOW - 30_000 })] }, ana, dev2.credential)).status, 202);
  assert.equal((await post({ reports: [report({ active_s: 600 })] }, ben, dev2.credential)).status, 202);

  // The employee sees their live state and their devices' power events.
  const own = (await req('GET', '/desktop/v1/activity', { token: ana })).body;
  assert.equal(own.live[0].state, 'active'); assert.equal(own.device_events.length, 2);
  assert.equal(own.items.find((x: { day: string; device_id: string }) => x.day === today && x.device_id === dev.device_id).domains[0].domain, 'mail.worksuite.lk');

  const alice = await login('alice@a.test', 'alice-password');
  // Live: Ana active in Office; Ben's heartbeat is stale → offline.
  const lv = await req('GET', '/admin/api/monitoring/live', { cookie: alice });
  assert.equal(lv.status, 200);
  const anaLive = lv.body.items.find((x: { name: string }) => x.name === 'Ana');
  assert.equal(anaLive.status, 'active'); assert.equal(anaLive.app_name, 'WorkSuite Office'); assert.equal(anaLive.device, 'laptop-a');
  assert.equal(lv.body.items.find((x: { name: string }) => x.name === '=Ben').status, 'offline');

  // Log: filters and pagination.
  const lg = (q: string) => req('GET', '/admin/api/monitoring/log?' + q, { cookie: alice });
  const all = await lg('');
  assert.equal(all.status, 200); assert.ok(all.body.total >= 8);
  assert.ok((await lg('type=startup')).body.items.every((x: { type: string; device: string }) => x.type === 'startup' && x.device === 'laptop-a'));
  assert.equal((await lg('type=web')).body.items[0].domain, 'mail.worksuite.lk');
  assert.equal((await lg('app=Office&type=app')).body.total, 3);
  const anaId = (db.prepare("SELECT id FROM users WHERE email = 'ana@a.test'").get() as { id: number }).id;
  assert.ok((await lg(`user=${anaId}`)).body.items.every((x: { user_id: number }) => x.user_id === anaId));
  assert.equal((await lg(`device=${dev2.device_id}&user=${anaId}&type=app`)).body.total, 1);
  assert.equal((await lg(`from=${today}&to=${today}&type=app`)).body.total, 3);
  const p1 = await lg('per_page=10&page=1'), p2 = await lg('per_page=10&page=2');
  assert.equal(p1.body.items.length, Math.min(10, all.body.total)); assert.equal(p1.body.pages, Math.ceil(all.body.total / 10));
  assert.equal(p2.body.items.length, all.body.total - 10);
  assert.equal((await lg('type=keystrokes')).status, 400);
  assert.equal((await lg('from=yesterday')).status, 400);

  // Attendance: earliest first and latest last activity over both devices, summed active time.
  const at = await req('GET', `/admin/api/monitoring/attendance?from=${yesterday}&to=${today}`, { cookie: alice });
  assert.equal(at.status, 200);
  const anaToday = at.body.items.find((x: { name: string; day: string }) => x.name === 'Ana' && x.day === today);
  assert.equal(anaToday.active_s, 5400); assert.equal(anaToday.first_active, NOW - 9000_000); assert.equal(anaToday.last_active, NOW - 30_000); assert.equal(anaToday.devices, 2);
  const csv = await req('GET', `/admin/api/monitoring/attendance?from=${yesterday}&to=${today}&format=csv`, { cookie: alice });
  assert.match(csv.headers.get('content-type')!, /text\/csv/);
  assert.equal(String(csv.body).split('\r\n')[0], 'date,employee,email,first_active,last_active,active_seconds,active_hours,devices');
  assert.match(String(csv.body), /,'=Ben,/);   // formula injection neutralised
  assert.match(attendanceCsv([{ day: today, user_id: 1, name: 'A, "B"', email: 'a@b', first_active: null, last_active: null, active_s: 0, devices: 1 }]), /"A, ""B"""/);

  // HR webhook: https only, secret shown once, signed delivery with attendance figures only.
  assert.equal((await req('PUT', '/admin/api/monitoring/hr-webhook', { cookie: alice, body: { url: 'http://hr.test/in' } })).status, 400);
  const wh = await req('PUT', '/admin/api/monitoring/hr-webhook', { cookie: alice, body: { url: 'https://hr.test/in' } });
  assert.equal(wh.status, 200); assert.match(wh.body.secret, /^whsec_/);
  assert.equal((await req('PUT', '/admin/api/monitoring/hr-webhook', { cookie: alice, body: { url: 'https://hr.test/in2' } })).body.secret, undefined);
  const sent = await req('POST', '/admin/api/monitoring/hr-webhook/send', { cookie: alice, body: { day: today } });
  assert.equal(sent.status, 200); assert.equal(sent.body.ok, true); assert.equal(sent.body.employees, 2);
  const h = hooks.at(-1)!;
  assert.equal(h.url, 'https://hr.test/in2');
  const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(h.headers['x-worksuite-signature'])!;
  assert.equal(v1, createHmac('sha256', wh.body.secret).update(`${t}.${h.body}`).digest('hex'));
  assert.equal(signWebhook(wh.body.secret, h.body, Number(t)), h.headers['x-worksuite-signature']);
  const payload = JSON.parse(h.body);
  assert.deepEqual(Object.keys(payload.employees[0]).sort(), ['active_seconds', 'email', 'first_active', 'last_active', 'name']);
  assert.ok(!h.body.includes('Office') && !h.body.includes('mail.worksuite.lk'));

  // Scheduled run: yesterday once; a failure is retried next time.
  hooks.length = 0; db.prepare('UPDATE hr_webhooks SET last_day = NULL').run();
  hookStatus = 500; await runHrWebhooks(db, webhookFetch as never, NOW);
  assert.equal(hooks.length, 1); assert.equal((db.prepare('SELECT last_day FROM hr_webhooks').get() as { last_day: string | null }).last_day, null);
  hookStatus = 200; await runHrWebhooks(db, webhookFetch as never, NOW);
  assert.equal(JSON.parse(hooks.at(-1)!.body).day, yesterday);
  await runHrWebhooks(db, webhookFetch as never, NOW);
  assert.equal(hooks.length, 2);   // already delivered

  // Every view is audited; another organization sees nothing.
  const acts = await auditActions(alice);
  for (const a of ['monitoring_live_viewed', 'monitoring_log_viewed', 'attendance_viewed', 'attendance_exported', 'hr_webhook_changed', 'hr_webhook_sent']) assert.ok(acts.includes(a), a);
  admin.addUser(db, orgB, 'zed@b.test', 'Zed', 'zed-password', 'admin');
  const zed = await login('zed@b.test', 'zed-password');
  assert.equal((await req('GET', '/admin/api/monitoring/live', { cookie: zed })).body.items.length, 0);
  assert.equal((await req('GET', '/admin/api/monitoring/log', { cookie: zed })).body.total, 0);
  assert.equal((await live({ state: 'active' }, zoe, devB.credential)).status, 403);   // org B: monitoring off

  // Website tracking off → its rows go; monitoring off → everything goes and the webhook stops sending.
  admin.setPolicy(db, orgA, { activity_monitoring: true, activity_retention_days: 30 });
  purgeActivity(db);
  assert.equal((await lg('type=web')).body.total, 0);
  assert.equal((await post({ reports: [withWeb] })).status, 403);
  admin.setPolicy(db, orgA, { activity_monitoring: false });
  purgeActivity(db);
  for (const t of ['activity_log', 'activity_live', 'activity_reports']) assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, 0, t);
  assert.equal((await req('POST', '/admin/api/monitoring/hr-webhook/send', { cookie: alice, body: { day: today } })).status, 403);
});
