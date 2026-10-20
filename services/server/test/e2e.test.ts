// End to end against the real client code: credentials broker OIDC calls, sync transport, device agent and the
// package service's manifest verification. Clients insist on https, so their fetch is pointed at the local http port.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as admin from '../src/admin.ts';
import { openDb } from '../src/db.ts';
import { createHandler } from '../src/main.ts';
import { authorizationUrl, discover, tokenRequest, userinfo } from '../../credentials/src/oidc.ts';
import { buildSyncConfig, fetchBootstrap } from '../../credentials/src/syncconfig.ts';
import { fetchTransport } from '../../sync/src/transport.ts';
import { Agent, type Host } from '../../device-agent/src/agent.ts';
import { httpApi } from '../../device-agent/src/api.ts';
import { loadKeys } from '../../device-agent/src/main.ts';
import { StateFile } from '../../device-agent/src/state.ts';
import { wgKeyPair, type VpnPlan } from '../../device-agent/src/vpn.ts';
import { setVpnSettings } from '../src/vpn.ts';
import { verifyManifest } from '../../package-service/src/updates.ts';

const PUBLIC = 'https://ws.test/';
let dir: string, server: Server, port: number, db: ReturnType<typeof openDb>, orgId: number;

/** https://ws.test/... → http://127.0.0.1:<port>/... */
const toLocal: typeof fetch = (input, init) => {
  const u = new URL(input instanceof Request ? input.url : String(input));
  if (u.host === 'ws.test') { u.protocol = 'http:'; u.host = `127.0.0.1:${port}`; }
  return fetch(u, init);
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ws-server-'));
  db = openDb(join(dir, 'server.db'));
  orgId = admin.createOrg(db, 'Livezen Technologies');
  admin.addUser(db, orgId, 'Ana@Example.com', 'Ana Perera', 'correct horse battery');
  server = createServer(createHandler(db, { publicUrl: PUBLIC }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

/** Browser half of the sign-in: load the login page, post the form, read the loopback redirect. */
async function signIn(email = 'ana@example.com', password = 'correct horse battery') {
  const ep = await discover(PUBLIC, { fetch: toLocal });
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const redirectUri = 'http://127.0.0.1:49152/callback';
  const state = randomUUID();
  const authz = new URL(authorizationUrl(ep, { clientId: 'worksuite-os', redirectUri, challenge, state }));
  const page = await toLocal(authz);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Sign in to WorkSuite/);
  const form = new URLSearchParams({ ...Object.fromEntries(authz.searchParams), email, password });
  const res = await toLocal(new URL('/oauth/authorize', PUBLIC), { method: 'POST', body: form, redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  if (res.status !== 302) return { ep, status: res.status };
  const loc = new URL(res.headers.get('location')!);
  assert.equal(loc.origin + loc.pathname, redirectUri);
  assert.equal(loc.searchParams.get('state'), state);
  const tokens = await tokenRequest(ep, { grant_type: 'authorization_code', code: loc.searchParams.get('code')!, redirect_uri: redirectUri, client_id: 'worksuite-os', code_verifier: verifier }, { fetch: toLocal });
  return { ep, status: 302, tokens, code: loc.searchParams.get('code')!, verifier, redirectUri };
}

test('OneAuth: discovery, PKCE sign-in, userinfo, refresh rotation and reuse detection, revocation', async () => {
  const s = await signIn();
  assert.ok(s.tokens);
  assert.equal(s.ep.issuer, 'https://ws.test/oauth');
  assert.equal(s.tokens.expires_in, 900);
  const me = await userinfo(s.ep, s.tokens.access_token, { fetch: toLocal });
  assert.deepEqual([me.name, me.email], ['Ana Perera', 'ana@example.com']);

  // The code is single-use.
  await assert.rejects(tokenRequest(s.ep, { grant_type: 'authorization_code', code: s.code!, redirect_uri: s.redirectUri!, client_id: 'worksuite-os', code_verifier: s.verifier! }, { fetch: toLocal }), /invalid_grant/);

  const r1 = await tokenRequest(s.ep, { grant_type: 'refresh_token', refresh_token: s.tokens.refresh_token!, client_id: 'worksuite-os' }, { fetch: toLocal });
  assert.notEqual(r1.refresh_token, s.tokens.refresh_token);
  // Replaying the rotated token revokes the family, including the newest refresh token.
  await assert.rejects(tokenRequest(s.ep, { grant_type: 'refresh_token', refresh_token: s.tokens.refresh_token!, client_id: 'worksuite-os' }, { fetch: toLocal }), /invalid_grant/);
  await assert.rejects(tokenRequest(s.ep, { grant_type: 'refresh_token', refresh_token: r1.refresh_token!, client_id: 'worksuite-os' }, { fetch: toLocal }), /invalid_grant/);

  const s2 = await signIn();
  await toLocal(new URL(s2.ep.revocation_endpoint!), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: s2.tokens!.refresh_token!, client_id: 'worksuite-os' }) });
  await assert.rejects(userinfo(s2.ep, s2.tokens!.access_token, { fetch: toLocal }), /userinfo_failed/);
});

test('OneAuth: wrong password, non-loopback redirect and missing PKCE are refused', async () => {
  assert.equal((await signIn('ana@example.com', 'wrong password!')).status, 401);
  const bad = async (q: Record<string, string>) => (await toLocal(new URL(`/oauth/authorize?${new URLSearchParams({
    response_type: 'code', client_id: 'worksuite-os', redirect_uri: 'http://127.0.0.1:5000/cb', code_challenge_method: 'S256', code_challenge: 'a'.repeat(43), ...q })}`, PUBLIC))).status;
  assert.equal(await bad({ redirect_uri: 'https://evil.example/cb' }), 400);
  assert.equal(await bad({ client_id: 'other' }), 400);
  assert.equal(await bad({ code_challenge_method: 'plain' }), 400);
});

test('bootstrap feeds the sync config; mutations are idempotent, conflicts are reported, changes page by cursor', async () => {
  const { tokens } = await signIn();
  const at = tokens!.access_token;
  const boot = await fetchBootstrap('https://ws.test/', at, null, { fetch: toLocal });
  const cfg = buildSyncConfig({ id: 'ws.test:1', server_url: PUBLIC, issuer: 'https://ws.test/oauth', sub: '1' }, PUBLIC, 'personal', boot);
  assert.deepEqual(cfg.streams, ['docs', 'notes', 'tasks', 'preferences', 'chat']);   // billing is online_only
  assert.equal(cfg.modules.preferences, 'preference');

  const t = fetchTransport(PUBLIC, () => null, toLocal);
  const id = randomUUID();
  const batch = { batch_id: randomUUID(), mutations: [
    { mutation_id: id, module: 'notes', object_id: 'n1', operation: 'create' as const, base_revision: null, payload: { title: 'Hello' } },
    { mutation_id: randomUUID(), module: 'Bad Module', object_id: 'x', operation: 'create' as const, base_revision: null, payload: {} },
  ] };
  const r1 = await t.postMutations(batch, at);
  assert.equal(r1.status, 200);
  if (r1.status !== 200) return;
  assert.deepEqual(r1.body.results.map((r) => r.status), ['applied', 'rejected']);

  // Same mutation in a new batch: duplicate, original revision, no second effect.
  const r2 = await t.postMutations({ batch_id: randomUUID(), mutations: [batch.mutations[0]] }, at);
  assert.deepEqual(r2.status === 200 && r2.body.results[0], { mutation_id: id, status: 'duplicate', revision: 1 });

  const upd = (base: number | null, title: string, force = false) => t.postMutations({ batch_id: randomUUID(), mutations: [
    { mutation_id: randomUUID(), module: 'notes', object_id: 'n1', operation: 'update', base_revision: base, payload: { title }, force }] }, at);
  const ok = await upd(1, 'Hello again');
  assert.equal(ok.status === 200 && ok.body.results[0].status, 'applied');
  const stale = await upd(1, 'stale edit');
  assert.deepEqual(stale.status === 200 && stale.body.results[0], { mutation_id: (stale as any).body.results[0].mutation_id, status: 'conflict', revision: 2, server_version: { title: 'Hello again' } });
  const forced = await upd(1, 'forced', true);
  assert.equal(forced.status === 200 && forced.body.results[0].status, 'applied');

  await t.postMutations({ batch_id: randomUUID(), mutations: [
    { mutation_id: randomUUID(), module: 'notes', object_id: 'n2', operation: 'create', base_revision: null, payload: { title: 'Two' } },
    { mutation_id: randomUUID(), module: 'notes', object_id: 'n1', operation: 'delete', base_revision: 3, payload: null },
  ] }, at);

  const p1 = await t.getChanges({ stream: 'notes', cursor: null, limit: 1 }, at);
  assert.equal(p1.status, 200);
  if (p1.status !== 200) return;
  assert.equal(p1.body.has_more, true);
  const p2 = await t.getChanges({ stream: 'notes', cursor: p1.body.next_cursor, limit: 100 }, at);
  assert.equal(p2.status, 200);
  if (p2.status !== 200) return;
  const all = [...p1.body.changes, ...p2.body.changes];
  assert.deepEqual(all.map((c) => [c.object_id, c.revision, c.deleted]), [['n2', 1, false], ['n1', 4, true]]);
  assert.equal(p2.body.has_more, false);
  // Other users' streams are invisible: a second user starts empty.
  admin.addUser(db, orgId, 'ben@example.com', 'Ben', 'another long password');
  const ben = await signIn('ben@example.com', 'another long password');
  const empty = await t.getChanges({ stream: 'notes', cursor: null, limit: 100 }, ben.tokens!.access_token);
  assert.deepEqual(empty.status === 200 && empty.body.changes, []);
  const anon = await t.getChanges({ stream: 'notes', cursor: null, limit: 100 }, 'wsa_nope');
  assert.equal(anon.status, 401);
});

test('device agent: enrollment, signed policy, signed commands with acks, revocation', async () => {
  const keysDir = join(dir, 'keys');
  admin.exportKeys(db, keysDir);
  const token = admin.createEnrollmentToken(db, orgId);
  admin.setPolicy(db, orgId, { update_ring: 'pilot', update_mode: 'notify', app_allowlist: ['flatpak:org.gimp.GIMP'] });

  // Managed WireGuard VPN for the org; the device's keypair is generated here and only the public key is sent.
  setVpnSettings(db, orgId, { endpoint: 'vpn.livezentech.test:51820', server_public_key: wgKeyPair().publicKey, address_pool: '10.90.0.0/24', allowed_ips: ['10.0.0.0/8'], dns: ['10.90.0.1'], always_on: true });
  let wg = wgKeyPair();
  const vpnApplied: (VpnPlan | null)[] = [];
  const log: string[] = [];
  const host: Host = {
    async generateDeviceKey() { return { publicKeyPem: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString(), tpmBacked: false }; },
    async facts() { return { arch: 'amd64', hostname: 'ws-test', os_version: '1.0.0', shell_version: '1.0.0', kernel_version: '6.12', update_status: 'idle' }; },
    async inventory() { return {}; },
    publishCredential() {}, publishPolicy() {}, publishStatus() {},
    async lockAllSessions() { log.push('lock'); },
    async installApproved(id) { log.push(`install ${id}`); },
    async removeApplication(id) { log.push(`remove ${id}`); },
    async scheduleUpdate() {}, async scheduleReboot() {},
    async collectDiagnostics(p) { return { profile: p, sha256: '', content: '' }; },
    async isFullyEncrypted() { return true; },
    async wipeWorkSuiteData() {}, async cryptoErase() {},
    async applyEnforcement(e) { log.push(`enforce usb=${e.usb_storage}`); }, setOfflineAccessBlock() {},
    audit(e) { log.push(`audit ${e}`); },
    async wgPublicKey(rotate) { if (rotate) wg = wgKeyPair(); return wg.publicKey; },
    forgetWgKey() { log.push('wg key forgotten'); },
    async applyVpn(plan) { vpnApplied.push(plan); },
    async vpnConnections() { return []; }, async removeConnection() {},
  };
  const state = new StateFile(join(dir, 'agent-state.json'));
  const agent = new Agent({ state, host, api: httpApi(() => state.state, toLocal), keys: loadKeys(keysDir) });

  const deviceId = await agent.enroll(PUBLIC, token);
  assert.equal(state.state.org_name, 'Livezen Technologies');
  assert.equal(state.state.policy?.update_ring, 'pilot');
  assert.equal(state.state.policy?.version, '1');
  const plan = vpnApplied.at(-1)!;
  assert.equal(plan.config.device_public_key, wg.publicKey);
  assert.deepEqual(plan.config.interface!.address, ['10.90.0.2/32']);
  assert.equal(plan.autoconnect, true);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM vpn_peers').all()).includes(wg.privateKey));
  // The enrollment token is single-use.
  await assert.rejects(httpApi(() => ({}), toLocal).register(PUBLIC, token, { public_key: (await host.generateDeviceKey()).publicKeyPem, tpm_backed: false, arch: 'amd64', hostname: 'x' }), /TOKEN_EXPIRED/);

  admin.issueCommand(db, deviceId, 'InstallApprovedApplication', { catalog_id: 'flatpak:org.gimp.GIMP' });
  const lockId = admin.issueCommand(db, deviceId, 'RequestLock');
  await agent.checkIn();
  assert.ok(log.includes('install flatpak:org.gimp.GIMP'));
  assert.ok(log.includes('lock'));
  const st = db.prepare('SELECT state FROM commands WHERE id = ?').get(lockId) as { state: string };
  assert.equal(st.state, 'completed');
  // Completed commands are not re-sent.
  log.length = 0;
  await agent.checkIn();
  assert.ok(!log.includes('lock'));
  const hb = db.prepare('SELECT heartbeat FROM devices WHERE id = ?').get(deviceId) as { heartbeat: string };
  assert.equal(JSON.parse(hb.heartbeat).policy_version, '1');

  // A user signing in on this device sends its credential; bootstrap accepts it.
  const { tokens } = await signIn();
  await fetchBootstrap(PUBLIC, tokens!.access_token, state.state.credential!, { fetch: toLocal });

  admin.revokeDevice(db, deviceId);
  await agent.checkIn();
  assert.equal(state.state.enrolled, false);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(vpnApplied.at(-1), null);              // managed connection removed on revocation
  assert.ok(log.includes('wg key forgotten'));
});

test('release manifests verify with the package service; catalog filters by arch', async () => {
  const keysDir = join(dir, 'release-keys');
  admin.publishRelease(db, { release_id: 'r-1.1.0', version: '1.1.0', min_version: '1.0.0', ring: 'stable', arch: 'amd64', security: true });
  admin.exportKeys(db, keysDir);
  const m = await (await toLocal(new URL('/os/manifests/stable/amd64.json', PUBLIC))).json();
  assert.equal(verifyManifest(m, loadKeys(keysDir)), true);
  assert.equal(verifyManifest({ ...m, version: '9.9.9' }, loadKeys(keysDir)), false);
  assert.equal((await toLocal(new URL('/os/manifests/stable/arm64.json', PUBLIC))).status, 404);
  const same = await (await toLocal(new URL('/desktop/v1/releases/manifest?platform=os&ring=stable&arch=amd64', PUBLIC))).json();
  assert.deepEqual(same, m);

  admin.putCatalogItem(db, { id: 'flatpak:org.gimp.GIMP', source: 'flatpak', name: 'GIMP', arches: ['amd64', 'arm64'] });
  admin.putCatalogItem(db, { id: 'apt:x86-only', source: 'apt', name: 'x86 only', arches: ['amd64'] });
  const token = admin.createEnrollmentToken(db, orgId);
  const reg = await httpApi(() => ({}), toLocal).register(PUBLIC, token, { public_key: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString(), tpm_backed: false, arch: 'arm64', hostname: 'pi' });
  const cat = await (await toLocal(new URL('/desktop/v1/os/catalog?arch=arm64', PUBLIC), { headers: { 'x-ws-device': reg.credential } })).json();
  assert.deepEqual(cat.items.map((i: { id: string }) => i.id), ['flatpak:org.gimp.GIMP']);
});
