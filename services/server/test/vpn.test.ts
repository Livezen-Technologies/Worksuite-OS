// Managed WireGuard VPN: desktop/v1/os/vpn, desktop/v1/os/vpn/peer and the admin console's /admin/api/vpn.
// WireGuard keys are generated here for each run; no key material is committed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as admin from '../src/admin.ts';
import { openDb } from '../src/db.ts';
import { createHandler } from '../src/main.ts';
import { activeKey, canonical } from '../src/signing.ts';
import { validateVpnSettings } from '../src/vpn.ts';

let dir: string, server: Server, base: string, db: ReturnType<typeof openDb>;
let org: number, other: number;

const wgPublic = () => Buffer.from(generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64');
const GATEWAY = wgPublic();
const SETTINGS = { endpoint: 'vpn.a.test:51820', server_public_key: GATEWAY, address_pool: '10.70.0.0/29', allowed_ips: ['0.0.0.0/0'], dns: ['10.70.0.1'], always_on: true, kill_switch: true };

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ws-vpn-'));
  db = openDb(join(dir, 'db'));
  org = admin.createOrg(db, 'Org A');
  other = admin.createOrg(db, 'Org B');
  admin.addUser(db, org, 'alice@a.test', 'Alice', 'alice-password', 'admin');
  server = createServer(createHandler(db, { publicUrl: 'https://ws.test/' }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

async function call(method: string, path: string, o: { device?: string; body?: unknown; idem?: boolean; cookie?: string } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(o.device ? { 'x-ws-device': o.device } : {}), ...(o.idem ? { 'idempotency-key': randomUUID() } : {}),
      ...(o.cookie ? { cookie: o.cookie, 'x-ws-admin': '1' } : {}), 'content-type': 'application/json',
    },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}
async function enroll(orgId = org, wg?: string) {
  const r = await call('POST', '/desktop/v1/devices/register', { idem: true, body: {
    enrollment_token: admin.createEnrollmentToken(db, orgId), arch: 'amd64', hostname: `h-${randomUUID().slice(0, 4)}`,
    public_key: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }), ...(wg ? { wg_public_key: wg } : {}),
  } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body as { device_id: string; credential: string };
}
const verified = (p: Record<string, unknown>) => {
  const [kid, sig] = String(p.signature).split(':');
  const k = activeKey(db);
  assert.equal(kid, k.key_id);
  const { signature: _s, ...rest } = p;
  return verify(null, Buffer.from(canonical(rest)), createPublicKey(k.public_pem), Buffer.from(sig, 'base64'));
};

test('settings validation: keys, CIDRs, endpoint, and no kill switch on a split tunnel', () => {
  assert.deepEqual(validateVpnSettings(SETTINGS), SETTINGS);
  assert.throws(() => validateVpnSettings({ ...SETTINGS, server_public_key: 'abc' }), /server_public_key/);
  assert.throws(() => validateVpnSettings({ ...SETTINGS, endpoint: 'vpn.a.test' }), /endpoint/);
  assert.throws(() => validateVpnSettings({ ...SETTINGS, endpoint: 'vpn.a.test:70000' }), /endpoint/);
  assert.throws(() => validateVpnSettings({ ...SETTINGS, address_pool: '10.70.0.0/31' }), /address_pool/);
  assert.throws(() => validateVpnSettings({ ...SETTINGS, allowed_ips: ['10.0.0.0/33'] }), /allowed_ips/);
  assert.throws(() => validateVpnSettings({ ...SETTINGS, allowed_ips: ['10.0.0.0/8'] }), /kill_switch/);
  assert.throws(() => validateVpnSettings({ ...SETTINGS, private_key: 'x' }), /unknown VPN field/);
  assert.ok(validateVpnSettings({ ...SETTINGS, kill_switch: false, allowed_ips: ['10.0.0.0/8', 'fd00::/8'] }));
});

test('no org VPN: a signed "disabled" config', async () => {
  const d = await enroll(other);
  const r = await call('GET', '/desktop/v1/os/vpn', { device: d.credential });
  assert.equal(r.status, 200);
  assert.equal(r.body.enabled, false);
  assert.equal(r.body.device_id, d.device_id);
  assert.ok(verified(r.body));
  assert.equal((await call('GET', '/desktop/v1/os/vpn')).status, 403);
});

test('device registers only its public key and gets a signed per-device config with its own address', async () => {
  const c = await login();
  assert.equal((await call('PUT', '/admin/api/vpn', { cookie: c, body: { vpn: SETTINGS } })).status, 200);
  const k1 = wgPublic();
  const a = await enroll(org, k1);                 // key sent at enrolment
  const r = await call('GET', '/desktop/v1/os/vpn', { device: a.credential });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(verified(r.body));
  assert.equal(r.body.enabled, true);
  assert.equal(r.body.device_public_key, k1);
  assert.deepEqual(r.body.interface.address, ['10.70.0.2/32']);   // .1 is the gateway
  assert.deepEqual(r.body.peer, { public_key: GATEWAY, endpoint: 'vpn.a.test:51820', allowed_ips: ['0.0.0.0/0'], persistent_keepalive: 25 });
  assert.equal(r.body.always_on, true); assert.equal(r.body.kill_switch, true);
  assert.ok(!JSON.stringify(r.body).includes('private'));

  // A device without a key is told to register one; then PUT returns its config.
  const b = await enroll();
  assert.equal((await call('GET', '/desktop/v1/os/vpn', { device: b.credential })).body.error.code, 'VPN_PEER_KEY_REQUIRED');
  assert.equal((await call('PUT', '/desktop/v1/os/vpn/peer', { device: b.credential, idem: true, body: { public_key: 'not-a-key' } })).status, 400);
  assert.equal((await call('PUT', '/desktop/v1/os/vpn/peer', { device: b.credential, idem: true, body: { public_key: wgPublic(), private_key: 'x' } })).status, 400);
  assert.equal((await call('PUT', '/desktop/v1/os/vpn/peer', { device: b.credential, idem: true, body: { public_key: k1 } })).body.error.code, 'VPN_KEY_IN_USE');
  const k2 = wgPublic();
  const p = await call('PUT', '/desktop/v1/os/vpn/peer', { device: b.credential, idem: true, body: { public_key: k2 } });
  assert.equal(p.status, 200);
  assert.deepEqual(p.body.interface.address, ['10.70.0.3/32']);
  assert.ok(verified(p.body));

  // The gateway's peer list has both public keys, nothing else secret.
  const g = await call('GET', '/admin/api/vpn', { cookie: c });
  assert.deepEqual(g.body.peers.map((x: { public_key: string; address: string }) => [x.public_key, x.address]), [[k1, '10.70.0.2'], [k2, '10.70.0.3']]);

  // Rotation: the admin forgets the key; the device must register a new one (and keeps its address slot freed).
  assert.equal((await call('POST', `/admin/api/vpn/peers/${b.device_id}/rotate`, { cookie: c })).status, 204);
  assert.equal((await call('GET', '/desktop/v1/os/vpn', { device: b.credential })).body.error.code, 'VPN_PEER_KEY_REQUIRED');
  const k3 = wgPublic();
  assert.equal((await call('PUT', '/desktop/v1/os/vpn/peer', { device: b.credential, idem: true, body: { public_key: k3 } })).body.device_public_key, k3);

  // Revocation removes the peer from the gateway's list and the device can no longer fetch a config.
  admin.revokeDevice(db, a.device_id);
  assert.equal((await call('GET', '/desktop/v1/os/vpn', { device: a.credential })).body.error.code, 'DEVICE_REVOKED');
  assert.deepEqual((await call('GET', '/admin/api/vpn', { cookie: c })).body.peers.map((x: { public_key: string }) => x.public_key), [k3]);

  // A /29 has 5 device addresses (.2-.6); the pool runs out cleanly.
  for (let i = 0; i < 4; i++) await enroll(org, wgPublic()).then((d) => call('GET', '/desktop/v1/os/vpn', { device: d.credential }));
  const last = await enroll(org, wgPublic());
  assert.equal((await call('GET', '/desktop/v1/os/vpn', { device: last.credential })).body.error.code, 'VPN_POOL_EXHAUSTED');

  // Removing the org VPN: devices get a signed "disabled" config.
  assert.equal((await call('PUT', '/admin/api/vpn', { cookie: c, body: { vpn: null } })).status, 200);
  assert.equal((await call('GET', '/desktop/v1/os/vpn', { device: b.credential })).body.enabled, false);
});

test('wipe started removes the device peer; policy accepts vpn_required and user_vpn', async () => {
  const c = await login();
  await call('PUT', '/admin/api/vpn', { cookie: c, body: { vpn: { ...SETTINGS, address_pool: '10.80.0.0/24' } } });
  const d = await enroll(org, wgPublic());
  assert.equal((await call('GET', '/desktop/v1/os/vpn', { device: d.credential })).status, 200);
  const id = admin.issueCommand(db, d.device_id, 'RemoteWipe', { scope: 'worksuite_data', approval_id: randomUUID() });
  assert.equal((await call('POST', `/desktop/v1/devices/commands/${id}/ack`, { device: d.credential, idem: true, body: { state: 'started' } })).status, 204);
  assert.equal((await call('GET', '/desktop/v1/os/vpn', { device: d.credential })).body.error.code, 'VPN_PEER_KEY_REQUIRED');

  assert.equal((await call('PUT', '/admin/api/policy', { cookie: c, body: { policy: { vpn_required: true, user_vpn: 'block' } } })).status, 200);
  assert.equal((await call('PUT', '/admin/api/policy', { cookie: c, body: { policy: { user_vpn: 'maybe' } } })).status, 400);
  const pol = await call('GET', '/desktop/v1/policies', { device: d.credential });
  assert.equal(pol.body.vpn_required, true); assert.equal(pol.body.user_vpn, 'block');
});

async function login() {
  const res = await fetch(`${base}/admin/api/login`, { method: 'POST', headers: { 'x-ws-admin': '1', 'content-type': 'application/json' }, body: JSON.stringify({ email: 'alice@a.test', password: 'alice-password' }) });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie')!.split(';')[0];
}
