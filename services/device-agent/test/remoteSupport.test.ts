import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, unattendedRemoteSupport, type Host } from '../src/agent.ts';
import type { DeviceApi } from '../src/api.ts';
import { canonical, signingBytes, validateCommand, MemoryReplayStore, type CommandEnvelope } from '../src/commands.ts';
import { serveSocket } from '../src/control.ts';
import { consentDispatch, parseRequest, parseSeatSessions, RemoteSupport, type RsDeps, type RsReport, type RsRequest, type RsSession } from '../src/remoteSupport.ts';
import { StateFile, type Policy } from '../src/state.ts';

let NOW = Date.parse('2026-10-20T09:00:00Z');
const HOUR = 3_600_000;

function rig(o: { seat?: { uid: number; user: string } | null; unattended?: boolean } = {}) {
  const reports: [string, RsReport][] = [];
  const audit: string[] = [];
  const pub: { session: RsSession | null; consent: { uid: number; nonce: string } | null } = { session: null, consent: null };
  let stopped = 0;
  const deps: RsDeps = {
    now: () => NOW,
    seatUser: async () => (o.seat === undefined ? { uid: 1000, user: 'uma' } : o.seat),
    unattendedPolicy: () => o.unattended ?? false,
    publish: (s, c) => { pub.session = s; pub.consent = c; },
    report: async (id, r) => { reports.push([id, r]); },
    audit: (e) => audit.push(e),
    stopStreams: async () => { stopped++; },
  };
  return { rs: new RemoteSupport(deps), reports, audit, pub, stopped: () => stopped };
}

const req = (over: Partial<RsRequest> = {}): RsRequest => ({
  session_id: randomUUID(), mode: 'control', reason: 'Printer driver fails', admin_name: 'Alice Admin', org_name: 'Org A',
  unattended_eligible: false, record: false, expires_at: NOW + HOUR, ...over,
});

test('attended: nothing starts until the seat user consents; nonce only for that user', async () => {
  const r = rig();
  const q = req();
  assert.equal(await r.rs.request(q), 'pending');
  assert.equal(r.pub.session?.state, 'pending');
  assert.equal(r.pub.session?.granted_mode, null);
  assert.equal(r.pub.consent?.uid, 1000);
  assert.ok(!JSON.stringify(r.pub.session).includes(r.pub.consent!.nonce), 'nonce never in the world-readable file');
  assert.deepEqual(r.reports, [], 'server hears nothing before a decision');
  await assert.rejects(r.rs.decide('guess', 'control'), /BAD_NONCE/);
  assert.equal(r.rs.snapshot()?.state, 'pending');
  const s = await r.rs.decide(r.pub.consent!.nonce, 'control');
  assert.equal(s.state, 'active'); assert.equal(s.granted_mode, 'control'); assert.equal(s.consent, 'user');
  assert.equal(r.pub.consent, null, 'nonce removed once used');
  assert.deepEqual(r.reports.at(-1)?.[1], { state: 'active', granted_mode: 'control', consent: 'user', end_reason: null });
  assert.ok(r.audit.includes('remote_support_started'));
});

test('grant never exceeds the request; screen sharing only, then deny', async () => {
  const r = rig();
  await r.rs.request(req({ mode: 'view' }));
  await assert.rejects(r.rs.decide(r.pub.consent!.nonce, 'control'), /BAD_DECISION/);
  await r.rs.decide(r.pub.consent!.nonce, 'view');
  assert.equal(r.rs.snapshot()?.granted_mode, 'view');

  const d = rig();
  const q = req();
  await d.rs.request(q);
  const s = await d.rs.decide(d.pub.consent!.nonce, 'deny');
  assert.equal(s.state, 'ended'); assert.equal(s.end_reason, 'denied');
  assert.deepEqual(d.reports, [[q.session_id, { state: 'ended', granted_mode: null, consent: null, end_reason: 'denied' }]]);
  assert.equal(d.stopped(), 0, 'nothing was streaming');
});

test('user can drop control and end at any time; streams are stopped', async () => {
  const r = rig();
  await r.rs.request(req());
  await r.rs.decide(r.pub.consent!.nonce, 'control');
  assert.equal((await r.rs.revokeControl())?.granted_mode, 'view');
  assert.equal(r.reports.at(-1)?.[1].granted_mode, 'view');
  const s = await r.rs.end('user_ended');
  assert.equal(s?.state, 'ended'); assert.equal(s?.end_reason, 'user_ended');
  assert.equal(r.stopped(), 1);
  assert.equal(r.pub.session, null, 'indicator cleared');
});

test('unanswered requests time out; sessions end at the token expiry', async () => {
  const r = rig();
  await r.rs.request(req());
  NOW += 119_000; await r.rs.tick(); assert.equal(r.rs.snapshot()?.state, 'pending');
  NOW += 2_000; await r.rs.tick(); assert.equal(r.rs.snapshot()?.end_reason, 'consent_timeout');

  const e = rig();
  await e.rs.request(req({ expires_at: NOW + 10 * 60_000 }));
  await e.rs.decide(e.pub.consent!.nonce, 'view');
  NOW += 10 * 60_000; await e.rs.tick();
  assert.equal(e.rs.snapshot()?.end_reason, 'expired');
  assert.equal(e.stopped(), 1);
});

test('no signed-in seat user: attended request ends no_user; a second request while busy is refused', async () => {
  const n = rig({ seat: null });
  assert.equal(await n.rs.request(req()), 'ended');
  assert.equal(n.rs.snapshot()?.end_reason, 'no_user');

  const b = rig();
  await b.rs.request(req());
  const other = req();
  assert.equal(await b.rs.request(other), 'ended');
  assert.deepEqual(b.reports.at(-1), [other.session_id, { state: 'ended', granted_mode: null, consent: null, end_reason: 'busy' }]);
  assert.equal(b.rs.snapshot()?.state, 'pending', 'first request untouched');
});

test('unattended only with server eligibility AND the device policy; still visible and user-endable', async () => {
  const onlyServer = rig({ unattended: false });
  assert.equal(await onlyServer.rs.request(req({ unattended_eligible: true })), 'pending');
  const onlyPolicy = rig({ unattended: true });
  assert.equal(await onlyPolicy.rs.request(req({ unattended_eligible: false })), 'pending');
  const both = rig({ unattended: true, seat: null });
  assert.equal(await both.rs.request(req({ unattended_eligible: true })), 'active');
  assert.equal(both.rs.snapshot()?.consent, 'unattended_policy');
  assert.equal(both.pub.session?.state, 'active', 'indicator published');
  assert.equal((await both.rs.end('user_ended'))?.state, 'ended');
  assert.equal(unattendedRemoteSupport({ version: '1', signature: 'x', remote_support: { unattended: true } } as Policy), true);
  assert.equal(unattendedRemoteSupport({ version: '1', signature: 'x', remote_support: { enabled: false, unattended: true } } as Policy), false);
  assert.equal(unattendedRemoteSupport(undefined), false);
});

test('request args are validated and cleaned', () => {
  const ok = { session_id: randomUUID(), mode: 'view', reason: 'x\u0007y', admin_name: 'A' };
  assert.equal(parseRequest(ok, 1)?.reason, 'x y');
  for (const bad of [{ ...ok, mode: 'root' }, { ...ok, session_id: '../x' }, { ...ok, admin_name: '' }, { ...ok, reason: 5 }]) assert.equal(parseRequest(bad, 1), null);
});

test('consent socket: 0666 and only the documented methods', async () => {
  const r = rig();
  const dir = mkdtempSync(join(tmpdir(), 'ws-rs-'));
  const path = join(dir, 'rs.sock');
  const srv = serveSocket(path, (l) => consentDispatch(r.rs, l), 0o666);
  await new Promise((res) => setTimeout(res, 50));
  const call = (line: string) => new Promise<any>((res) => {
    const c = createConnection(path); let buf = '';
    c.on('connect', () => c.write(line + '\n')); c.on('data', (d) => { buf += d; }); c.on('end', () => res(JSON.parse(buf)));
  });
  try {
    assert.equal((await call('{"method":"Exec"}')).error, 'unknown_method');
    assert.equal((await call('nope')).error, 'bad_request');
    await r.rs.request(req());
    assert.equal((await call('{"method":"Decide","params":{"nonce":"x","decision":"control"}}')).error, 'BAD_NONCE');
    assert.equal((await call(JSON.stringify({ method: 'Decide', params: { nonce: r.pub.consent!.nonce, decision: 'view' } }))).result.state, 'active');
    assert.equal((await call('{"method":"End"}')).result.end_reason, 'user_ended');
  } finally { srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('loginctl parsing: active seat0 graphical user only', () => {
  const list = JSON.stringify([{ session: '3', uid: 0, user: 'root', seat: 'seat0' }, { session: 'c1', uid: 117, user: 'greeter', seat: 'seat0' }, { session: '7', uid: 1000, user: 'uma', seat: 'seat0' }, { session: '9', uid: 1001, user: 'ssh', seat: null }]);
  const props: Record<string, Record<string, string>> = {
    '3': { Active: 'yes', State: 'active', Type: 'tty', Class: 'user' },
    'c1': { Active: 'yes', State: 'active', Type: 'wayland', Class: 'greeter' },
    '7': { Active: 'yes', State: 'active', Type: 'wayland', Class: 'user' },
  };
  assert.deepEqual(parseSeatSessions(list, (id) => props[id] ?? {}), { uid: 1000, user: 'uma' });
  props['7'].Active = 'no';
  assert.equal(parseSeatSessions(list, (id) => props[id] ?? {}), null);
  assert.equal(parseSeatSessions('garbage', () => ({})), null);
});

// ---- through the agent: signed command → consent → acks ----
const server = generateKeyPairSync('ed25519');
function command(name: string, args: Record<string, unknown>, ttl = HOUR): CommandEnvelope {
  const e = { id: randomUUID(), command: name, device_id: 'dev-1', issued_at: new Date(NOW - 1000).toISOString(), expires_at: new Date(NOW + ttl).toISOString(), args } as CommandEnvelope;
  e.signature = { alg: 'ed25519', key_id: 'k1', value: sign(null, signingBytes(e), server.privateKey).toString('base64') };
  return e;
}

test('signed RemoteSupportRequest: TTL capped at 4 h; agent hands it to consent and End ends it', async () => {
  const deps = { deviceId: 'dev-1', keys: () => server.publicKey, replay: new MemoryReplayStore(), now: () => NOW };
  const args = { session_id: randomUUID(), mode: 'control', reason: 'VPN', admin_name: 'Alice', org_name: 'Org A' };
  assert.equal((validateCommand(command('RemoteSupportRequest', args, 5 * HOUR), deps) as any).reason, 'TTL_TOO_LONG');
  assert.equal((validateCommand(command('RemoteSupportRequest', { ...args, mode: 'admin' }), deps) as any).reason, 'BAD_ARGS');

  const dir = mkdtempSync(join(tmpdir(), 'ws-rsa-'));
  const r = rig();
  const queue: unknown[] = [];
  const acks: string[] = [];
  const pol = { version: 'p1' } as Omit<Policy, 'signature'>;
  const policy = { ...pol, signature: `k1:${sign(null, Buffer.from(canonical(pol)), server.privateKey).toString('base64')}` } as Policy;
  const api = {
    async register() { return { device_id: 'dev-1', credential: 'c' }; }, async heartbeat() { return { commands: [] }; }, async policy() { return policy; },
    async ack(_id: string, st: string, reason?: string) { acks.push(st + (reason ? ' ' + reason : '')); }, async inventory() {}, async diagnostics() {}, async audit() {},
    async vpn() { throw new Error('x'); }, async vpnPeer() { throw new Error('x'); },
    async remoteSupportCommands() { const commands = queue.splice(0); return { commands }; }, async remoteSupportState() {},
  } as unknown as DeviceApi;
  const noop = async () => {};
  const host = new Proxy({}, { get: (_t, k) => (k === 'facts' ? async () => ({ arch: 'amd64', hostname: 'h', os_version: '1', shell_version: '1', kernel_version: '6', update_status: 'idle' }) : k === 'isFullyEncrypted' ? async () => false : k === 'wgPublicKey' ? async () => 'k' : k === 'generateDeviceKey' ? async () => ({ publicKeyPem: 'P', tpmBacked: false }) : k === 'vpnConnections' ? async () => [] : String(k).startsWith('publish') || k === 'audit' || k === 'forgetWgKey' || k === 'setOfflineAccessBlock' ? () => {} : noop) }) as Host;
  const agent = new Agent({ state: new StateFile(join(dir, 's.json')), api, host, keys: (id) => (id === 'k1' ? server.publicKey : undefined), now: () => NOW, remoteSupport: r.rs });
  try {
    await agent.enroll('https://ws.example', 'tok');
    queue.push(command('RemoteSupportRequest', args));
    await agent.pollRemoteSupport();
    assert.deepEqual(acks, ['received', 'completed']);
    assert.equal(r.rs.snapshot()?.state, 'pending');
    assert.equal((agent.status() as any).remote_support.state, 'pending');
    queue.push(command('RemoteSupportEnd', { session_id: args.session_id }));
    await agent.pollRemoteSupport();
    assert.equal(r.rs.snapshot()?.end_reason, 'admin_ended');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- issue #37: step-up, clipboard opt-in, recording disclosure ----
async function activeView(r: ReturnType<typeof rig>, over: Partial<RsRequest> = {}) {
  const q = req({ mode: 'view', ...over });
  await r.rs.request(q);
  await r.rs.decide(r.pub.consent!.nonce, 'view');
  return q;
}

test('step-up: view → control needs a fresh answer from the seat user, with a new nonce', async () => {
  const r = rig();
  const q = await activeView(r);
  const first = r.reports.length;
  await r.rs.elevate(randomUUID());
  assert.equal(r.rs.snapshot()?.elevation, null, 'another session id is ignored');
  await r.rs.elevate(q.session_id);
  const s = r.rs.snapshot()!;
  assert.equal(s.elevation, 'pending');
  assert.equal(s.granted_mode, 'view', 'nothing changes before the user answers');
  const nonce = r.pub.consent!.nonce;
  assert.equal(r.pub.consent?.uid, 1000);
  await assert.rejects(r.rs.decideElevation('guess', true), /BAD_NONCE/);
  await assert.rejects(r.rs.decide(nonce, 'control'), /NO_PENDING_REQUEST/, 'the first-consent path cannot be reused');
  const after = await r.rs.decideElevation(nonce, true);
  assert.equal(after.granted_mode, 'control');
  assert.equal(after.elevation, null);
  assert.equal(r.pub.consent, null, 'nonce removed once answered');
  assert.deepEqual(r.reports.slice(first).map(([, x]) => [x.granted_mode, x.elevation]), [['control', 'granted']]);
  assert.ok(r.audit.includes('remote_support_elevation_requested') && r.audit.includes('remote_support_elevation_granted'));
  await assert.rejects(r.rs.decideElevation(nonce, true), /NO_PENDING_REQUEST/, 'one answer per request');
});

test('step-up: denied, timed out, or nobody at the seat keeps view only', async () => {
  const r = rig();
  const q = await activeView(r);
  await r.rs.elevate(q.session_id);
  await r.rs.decideElevation(r.pub.consent!.nonce, false);
  assert.equal(r.rs.snapshot()?.granted_mode, 'view');
  assert.equal(r.reports.at(-1)![1].elevation, 'denied');
  await r.rs.elevate(q.session_id);
  NOW += 121_000;
  await r.rs.tick();
  assert.equal(r.rs.snapshot()?.elevation, null);
  assert.equal(r.rs.snapshot()?.granted_mode, 'view');
  assert.equal(r.reports.at(-1)![1].elevation, 'denied');

  const u = rig({ unattended: true });
  const uq = req({ mode: 'view', unattended_eligible: true });
  await u.rs.request(uq);
  assert.equal(u.rs.snapshot()?.consent, 'unattended_policy');
  const v = rig({ seat: null, unattended: true });
  await v.rs.request({ ...uq, session_id: randomUUID() });
  await v.rs.elevate(v.rs.snapshot()!.session_id);
  assert.equal(v.rs.snapshot()?.granted_mode, 'view', 'unattended policy never covers a step-up');
  assert.equal(v.reports.at(-1)![1].elevation, 'denied');
});

test('clipboard sync: off by default, the seat user turns it on and off; recording flag is published', async () => {
  const r = rig();
  const q = await activeView(r, { record: true });
  assert.equal(r.pub.session?.clipboard, false);
  assert.equal(r.pub.session?.record, true, 'the dialog and indicator can say the session may be recorded');
  const res = await consentDispatch(r.rs, JSON.stringify({ method: 'SetClipboard', params: { enabled: true } }));
  assert.equal((res.result as RsSession).clipboard, true);
  assert.equal(r.reports.at(-1)![1].clipboard, true);
  assert.deepEqual(await consentDispatch(r.rs, JSON.stringify({ method: 'SetClipboard', params: { enabled: 'yes' } })), { error: 'BAD_ARGUMENT' });
  await r.rs.end('user_ended', q.session_id);
  assert.equal(r.rs.snapshot()?.clipboard, false, 'ending the session turns it off');
  assert.deepEqual(await consentDispatch(r.rs, JSON.stringify({ method: 'SetClipboard', params: { enabled: true } })), { error: 'NO_ACTIVE_SESSION' });
  assert.ok(r.audit.includes('remote_support_clipboard_on'));
  assert.equal(parseRequest({ session_id: randomUUID(), mode: 'view', reason: 'x y z', admin_name: 'A', record: true }, 1)?.record, true);
  assert.equal(parseRequest({ session_id: randomUUID(), mode: 'view', reason: 'x y z', admin_name: 'A', record: 'yes' }, 1)?.record, false);
});
