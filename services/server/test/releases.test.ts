// Update Center release management (WSOS-UPD-004, WSOS-AUP-013), licences (WSOS-AUP-012) and offline bundles
// (WSOS-AUP-010), checked against the package service's own verification code.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as admin from '../src/admin.ts';
import { openDb } from '../src/db.ts';
import { createHandler } from '../src/main.ts';
import { verifyLicence, verifyManifest } from '../../package-service/src/updates.ts';
import { inspectBundle } from '../../package-service/src/bundle.ts';

let dir: string, server: Server, base: string, db: ReturnType<typeof openDb>, org: number;
let keys: (id: string) => KeyObject | undefined;
const M = { release_id: 'os-1.1.0', version: '1.1.0', min_version: '1.0.0' };

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ws-releases-'));
  db = openDb(join(dir, 'db'));
  org = admin.createOrg(db, 'Org A');
  admin.addUser(db, org, 'rm@a.test', 'Release Manager', 'rm-password!', 'admin');
  admin.addUser(db, org, 'plain@a.test', 'Plain Admin', 'plain-password', 'admin');
  const pems = db.prepare('SELECT key_id, public_pem FROM signing_keys').all() as { key_id: string; public_pem: string }[];
  keys = (id) => { const k = pems.find((p) => p.key_id === id); return k ? createPublicKey(k.public_pem) : undefined; };
  server = createServer(createHandler(db, { publicUrl: 'https://ws.test/' }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

const manifest = async (ring: string, arch = 'amd64') => (await fetch(`${base}/os/manifests/${ring}/${arch}.json`)).json() as Promise<Record<string, unknown>>;

test('pause, resume, pull and promote re-sign the manifest; devices verify it', async () => {
  for (const arch of ['amd64', 'arm64']) admin.publishRelease(db, { ...M, ring: 'pilot', arch, rollout_percent: 20 });
  admin.setReleaseState(db, 'pilot', undefined, 'paused');
  for (const arch of ['amd64', 'arm64']) {
    const m = await manifest('pilot', arch);
    assert.equal(m.state, 'paused'); assert.ok(verifyManifest(m, keys));
  }
  assert.throws(() => admin.promoteRelease(db, 'pilot', 'stable', 'amd64'), /resume it/);
  admin.setReleaseState(db, 'pilot', 'amd64', 'active');
  assert.equal((await manifest('pilot', 'arm64')).state, 'paused', 'arch filter respected');
  assert.throws(() => admin.promoteRelease(db, 'development', 'stable', 'amd64'), /one ring at a time/);
  assert.throws(() => admin.promoteRelease(db, 'stable', 'pilot', 'amd64'), /one ring at a time/);
  admin.promoteRelease(db, 'pilot', 'stable', 'amd64', { rollout_percent: 10 });
  const s = await manifest('stable');
  assert.deepEqual([s.ring, s.release_id, s.state, s.rollout_percent], ['stable', 'os-1.1.0', 'active', 10]);
  assert.ok(verifyManifest(s, keys));
  admin.setReleaseState(db, 'stable', 'amd64', 'pulled');
  assert.equal((await manifest('stable')).state, 'pulled');
  assert.throws(() => admin.setReleaseState(db, 'development', 'amd64', 'paused'), /no release/);
  const log = db.prepare('SELECT action FROM release_log ORDER BY id').all() as { action: string }[];
  assert.deepEqual(log.map((l) => l.action), ['release_paused', 'release_resumed', 'release_promoted', 'release_pulled']);
});

test('emergency release goes to every ring as critical + mandatory at 100 %', async () => {
  admin.emergencyRelease(db, { release_id: 'os-1.1.1', version: '1.1.1', min_version: '1.1.1', security: true }, 'amd64');
  for (const ring of ['development', 'pilot', 'stable']) {
    const m = await manifest(ring);
    assert.deepEqual([m.release_id, m.critical, m.mandatory, m.rollout_percent, m.state, m.ring], ['os-1.1.1', true, true, 100, 'active', ring]);
    assert.ok(typeof m.deadline === 'string' && verifyManifest(m, keys));
  }
  assert.throws(() => admin.emergencyRelease(db, { version: '1' }), /release_id/);
});

async function call(method: string, path: string, cookie: string, body?: unknown) {
  const r = await fetch(`${base}/admin/api/${path}`, { method, headers: { 'x-ws-admin': '1', cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) as Record<string, unknown> };
}
async function login(email: string, password: string) {
  const r = await fetch(`${base}/admin/api/login`, { method: 'POST', headers: { 'x-ws-admin': '1', 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return r.headers.get('set-cookie')!.split(';')[0];
}

test('admin API: release actions need desktop.releases.manage and are logged', async () => {
  admin.publishRelease(db, { ...M, ring: 'development', arch: 'arm64' });
  const plain = await login('plain@a.test', 'plain-password');
  assert.equal((await call('POST', 'releases/development/pause', plain, { arch: 'arm64' })).status, 403);
  assert.throws(() => admin.grantPermission(db, 'plain@a.test', 'everything'), /unknown permission/);
  admin.grantPermission(db, 'rm@a.test', admin.RELEASE_PERMISSION);
  const rm = await login('rm@a.test', 'rm-password!');
  const paused = await call('POST', 'releases/development/pause', rm, { arch: 'arm64' });
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  assert.equal((await manifest('development', 'arm64')).state, 'paused');
  assert.equal((await call('POST', 'releases/development/explode', rm, {})).status, 400);
  assert.equal((await call('POST', 'releases/development/resume', rm, { arch: 'arm64' })).status, 200);
  const promoted = await call('POST', 'releases/promote', rm, { from: 'development', to: 'pilot', arch: 'arm64', rollout_percent: 5 });
  assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
  assert.equal((await manifest('pilot', 'arm64')).rollout_percent, 5);
  const pub = await call('POST', 'releases/publish', rm, { manifest: { release_id: 'os-1.2.0', version: '1.2.0', min_version: '1.0.0', ring: 'development', arch: 'arm64' } });
  assert.equal(pub.status, 200);
  assert.equal((pub.body.items as Record<string, unknown>[])[0].signature, undefined, 'signatures are not echoed');
  const em = await call('POST', 'releases/emergency', rm, { manifest: { release_id: 'os-1.2.1', version: '1.2.1', min_version: '1.2.1' }, arch: 'arm64' });
  assert.equal((em.body.items as unknown[]).length, 3);
  const actions = (await call('GET', 'log', rm)).body.items as { action: string }[];
  assert.ok(['release_state', 'release_promoted', 'release_published', 'release_emergency'].every((a) => actions.some((x) => x.action === a)));
  admin.grantPermission(db, 'rm@a.test', admin.RELEASE_PERMISSION, false);
  assert.equal((await call('POST', 'releases/development/pause', rm, {})).status, 403, 'revocation takes effect immediately');
});

test('licence endpoint: device-only, signed, bound to the device and short-lived', async () => {
  const reg = await fetch(`${base}/desktop/v1/devices/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ enrollment_token: admin.createEnrollmentToken(db, org), public_key: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }), arch: 'amd64', hostname: 'h' }),
  });
  const dev = await reg.json() as { device_id: string; credential: string };
  assert.equal((await fetch(`${base}/desktop/v1/os/licence`)).status, 403);
  const none = await (await fetch(`${base}/desktop/v1/os/licence`, { headers: { 'x-ws-device': dev.credential } })).json() as Record<string, unknown>;
  assert.equal(none.state, 'expired', 'no licence on record → nothing gated is offered');
  admin.setLicence(db, org, { edition: 'business', state: 'grace', entitlements: ['business'], grace_until: '2026-11-01T00:00:00Z' });
  assert.throws(() => admin.setLicence(db, org, { edition: 'business', state: 'bogus' as 'active', entitlements: [] }));
  const l = await (await fetch(`${base}/desktop/v1/os/licence`, { headers: { 'x-ws-device': dev.credential } })).json() as Record<string, unknown>;
  assert.equal(l.state, 'grace');
  assert.ok(verifyLicence(l, keys, dev.device_id, new Date()));
  assert.ok(!verifyLicence(l, keys, 'other-device', new Date()));
  assert.ok(!verifyLicence(l, keys, dev.device_id, new Date(Date.now() + 8 * 86_400_000)), 'expires after 7 days');
});

test('bundle-build output verifies with the package service, and the CLI drives release commands', () => {
  const d = join(dir, 'bundle'); mkdirSync(d);
  writeFileSync(join(d, 'worksuite-desktop_1.1.0_amd64.deb'), 'pkg one');
  writeFileSync(join(d, 'worksuite-shell_1.1.0_amd64.deb'), 'package two');
  writeFileSync(join(d, 'm.json'), JSON.stringify({ ...M, arch: 'amd64' }));
  const cli = (...a: string[]) => execFileSync(process.execPath, ['--no-warnings', join(import.meta.dirname, '../src/main.ts'), ...a, '--db', join(dir, 'db')], { encoding: 'utf8' });
  cli('bundle-build', join(d, 'm.json'), join(d, 'out.wsupdate'), join(d, 'worksuite-desktop_1.1.0_amd64.deb'), join(d, 'worksuite-shell_1.1.0_amd64.deb'));
  const { manifest: bm, entries } = inspectBundle(join(d, 'out.wsupdate'), { keys, arch: 'amd64', installed: '1.0.5' });
  assert.equal(bm.version, '1.1.0');
  assert.deepEqual(entries.map((e) => e.name), ['pool/worksuite-desktop_1.1.0_amd64.deb', 'pool/worksuite-shell_1.1.0_amd64.deb']);
  // System tar reads it too (plain ustar).
  assert.match(execFileSync('tar', ['-tf', join(d, 'out.wsupdate')], { encoding: 'utf8' }), /pool\/worksuite-shell_1\.1\.0_amd64\.deb/);
  assert.throws(() => inspectBundle(join(d, 'out.wsupdate'), { keys: () => undefined, arch: 'amd64', installed: '1.0.5' }), { code: 'SignatureInvalid' });

  cli('release-pause', '--ring', 'stable', '--arch', 'amd64');
  assert.equal(JSON.parse((db.prepare("SELECT manifest FROM releases WHERE ring = 'stable' AND arch = 'amd64'").get() as { manifest: string }).manifest).state, 'paused');
  cli('grant', '--email', 'plain@a.test', '--permission', 'desktop.releases.manage');
  assert.match((db.prepare("SELECT permissions FROM users WHERE email = 'plain@a.test'").get() as { permissions: string }).permissions, /desktop\.releases\.manage/);
});
