import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, type Host } from '../src/agent.ts';
import { ApiError, type DeviceApi } from '../src/api.ts';
import { canonical, signingBytes, type CommandEnvelope } from '../src/commands.ts';
import { ENFORCED_PATHS, faillockConf, offlineAccessExpired, policyEnforcement, type Enforcement } from '../src/enforce.ts';
import { splitCatalogId, windowStart } from '../src/host.ts';
import { StateFile, type Policy } from '../src/state.ts';

const server = generateKeyPairSync('ed25519');
const attacker = generateKeyPairSync('ed25519');
const DAY = 86_400_000;
let NOW = Date.parse('2026-10-15T10:00:00Z');

function signedPolicy(p: Omit<Policy, 'signature'>, key = server.privateKey): Policy {
  return { ...p, signature: `k1:${sign(null, Buffer.from(canonical(p)), key).toString('base64')}` } as Policy;
}

function command(command: string, args: Record<string, unknown> = {}, over: Partial<CommandEnvelope> = {}, key = server.privateKey): CommandEnvelope {
  const e = { id: randomUUID(), command, device_id: 'dev-1', issued_at: new Date(NOW - 1000).toISOString(), expires_at: new Date(NOW + DAY).toISOString(), args, ...over } as CommandEnvelope;
  e.signature = { alg: 'ed25519', key_id: 'k1', value: sign(null, signingBytes(e), key).toString('base64') };
  return e;
}

function world(opts: { encrypted?: boolean | 'error'; policy?: Policy } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ws-agent-'));
  const log: string[] = [];
  const acks: { id: string; state: string; reason?: string }[] = [];
  const s = {
    queue: [] as unknown[], policy: opts.policy ?? signedPolicy({ version: 'p1', app_allowlist: ['flatpak:org.gimp.GIMP'], maintenance_window: '02:00-04:00' }),
    enforced: [] as Enforcement[], offlineNotice: undefined as string | null | undefined, failEnforce: false,
    down: false, revoked: false, failAck: null as null | string, published: { credential: undefined as string | null | undefined, policy: undefined as Policy | null | undefined },
  };
  const api: DeviceApi = {
    async register(url, token) { log.push(`register ${url} ${token}`); return { device_id: 'dev-1', credential: 'cred-1', org_name: 'Livezen Technologies' }; },
    async heartbeat() {
      if (s.down) throw new ApiError(0, 'NETWORK');
      if (s.revoked) throw new ApiError(403, 'DEVICE_REVOKED');
      const commands = s.queue; s.queue = []; return { commands };
    },
    async policy() { if (s.down) throw new ApiError(0, 'NETWORK'); return s.policy; },
    async ack(id, state, reason) {
      if (s.failAck === state) throw new ApiError(0, 'NETWORK');
      log.push(`ack ${state}${reason ? ' ' + reason : ''}`); acks.push({ id, state, reason });
    },
    async inventory() {},
    async diagnostics() { log.push('diagnostics uploaded'); },
    async vpn() { throw new ApiError(404, 'NOT_FOUND'); },
    async vpnPeer() { throw new ApiError(404, 'NOT_FOUND'); },
  };
  const host: Host = {
    async generateDeviceKey() { return { publicKeyPem: 'PEM', tpmBacked: false }; },
    async facts() { return { arch: 'amd64', hostname: 'h', os_version: '1.0', shell_version: '1.0', kernel_version: '6.12', update_status: 'idle' }; },
    async inventory() { return {}; },
    publishCredential(c) { s.published.credential = c; },
    publishPolicy(p) { s.published.policy = p; },
    publishStatus() {},
    async lockAllSessions() { log.push('lock'); },
    async applyEnforcement(e) { if (s.failEnforce) throw new Error('udevadm: failed'); s.enforced.push(e); },
    setOfflineAccessBlock(n) { s.offlineNotice = n; log.push(n ? 'offline block' : 'offline unblock'); },
    async installApproved(id) { log.push(`install ${id}`); },
    async scheduleUpdate() { log.push('update'); },
    async scheduleReboot(w) { log.push(`reboot ${w}`); },
    async collectDiagnostics(p) { return { profile: p, sha256: 'x', content: '{}' }; },
    async isFullyEncrypted() { if (opts.encrypted === 'error') throw new Error('lsblk: overlay: not a block device'); return opts.encrypted ?? false; },
    async wipeWorkSuiteData() { log.push('wipe data'); },
    async cryptoErase() { log.push('crypto erase'); },
    audit() {},
    async wgPublicKey() { return 'unused'; },
    forgetWgKey() {},
    async applyVpn() {},
    async vpnConnections() { return []; },
    async removeConnection() {},
  };
  const path = join(dir, 'state.json');
  const make = () => new Agent({ state: new StateFile(path), api, host, keys: (id) => (id === 'k1' ? server.publicKey : undefined), now: () => NOW });
  return { agent: make(), restart: make, s, log, acks, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function enrolled(o?: Parameters<typeof world>[0]) {
  const w = world(o);
  await w.agent.enroll('https://work.livezentech.com', 'tok-123');
  w.log.length = 0; w.acks.length = 0;
  return w;
}

test('enroll: https only, credential published, verified policy applied, token not stored', async () => {
  const w = world();
  await assert.rejects(w.agent.enroll('http://work.livezentech.com', 't'), /INSECURE_URL/);
  assert.equal(await w.agent.enroll('https://work.livezentech.com', 'tok-123'), 'dev-1');
  assert.equal(w.s.published.credential, 'cred-1');
  assert.equal(w.s.published.policy?.version, 'p1');
  const st = w.agent.status();
  assert.equal(st.managed, true);
  assert.equal(st.org_name, 'Livezen Technologies');
  assert.ok(!JSON.stringify(w.restart().status()).includes('tok-123'));
  await assert.rejects(w.agent.enroll('https://x', 't'), /ALREADY_ENROLLED/);
  w.cleanup();
});

test('policy: tampered or wrongly signed policy is rejected and the previous one kept', async () => {
  const w = await enrolled();
  w.s.policy = { ...signedPolicy({ version: 'p2', usb_storage: 'block' }), usb_storage: 'allow' };
  await assert.rejects(w.agent.refreshPolicy(), /POLICY_SIGNATURE/);
  w.s.policy = signedPolicy({ version: 'p3' }, attacker.privateKey);
  await assert.rejects(w.agent.refreshPolicy(), /POLICY_SIGNATURE/);
  assert.equal(w.agent.status().policies?.version, 'p1');
  w.cleanup();
});

test('command: received → run → completed; replay after restart is not run again', async () => {
  const w = await enrolled();
  const c = command('RequestLock');
  w.s.queue = [c];
  await w.agent.checkIn();
  assert.deepEqual(w.log, ['ack received', 'lock', 'ack completed']);
  w.log.length = 0;
  w.s.queue = [c];
  await w.restart().checkIn();
  assert.deepEqual(w.log, [], 'replayed command ignored, even after a restart');
  w.cleanup();
});

test('check-in still runs commands when encryption cannot be determined (overlay root on the live ISO)', async () => {
  const w = await enrolled({ encrypted: 'error' });
  w.s.queue = [command('RequestLock')];
  await w.agent.checkIn();
  assert.deepEqual(w.log, ['ack received', 'lock', 'ack completed']);
  w.cleanup();
});

test('forged, misbound or unknown commands are rejected and never run', async () => {
  const w = await enrolled();
  w.s.queue = [command('RequestLock', {}, {}, attacker.privateKey), command('RequestLock', {}, { device_id: 'dev-2' }), command('RunShell', { cmd: 'id' })];
  await w.agent.checkIn();
  assert.deepEqual(w.log, ['ack rejected BAD_SIGNATURE', 'ack rejected WRONG_DEVICE', 'ack rejected UNKNOWN_COMMAND']);
  w.cleanup();
});

test('install only what the signed allowlist contains; reboot uses the maintenance window', async () => {
  const w = await enrolled();
  w.s.queue = [command('InstallApprovedApplication', { catalog_id: 'apt:nmap' }), command('InstallApprovedApplication', { catalog_id: 'flatpak:org.gimp.GIMP' }), command('RebootDuringWindow')];
  await w.agent.checkIn();
  assert.deepEqual(w.log, ['ack received', 'ack failed NOT_IN_ALLOWLIST', 'ack received', 'install flatpak:org.gimp.GIMP', 'ack completed', 'ack received', 'reboot 02:00-04:00', 'ack completed']);
  w.cleanup();
});

test('WorkSuite data wipe: "started" reaches the server before anything is destroyed', async () => {
  const w = await enrolled();
  w.s.queue = [command('RemoteWipe', { scope: 'worksuite_data', approval_id: 'ap-1' })];
  await w.agent.checkIn();
  assert.deepEqual(w.log, ['ack received', 'ack started', 'wipe data', 'ack completed']);
  assert.equal(w.s.published.credential, null);
  assert.equal(w.agent.status().managed, false);
  assert.equal(w.agent.status().wiped, true);
  w.cleanup();
});

test('full wipe: refused on unencrypted devices; on LUKS devices erases keys with no "completed"', async () => {
  const plain = await enrolled({ encrypted: false });
  plain.s.queue = [command('RemoteWipe', { scope: 'full_device', approval_id: 'ap-1' })];
  await plain.agent.checkIn();
  assert.deepEqual(plain.log, ['ack received', 'ack rejected NOT_ENCRYPTED']);
  plain.cleanup();

  const luks = await enrolled({ encrypted: true });
  luks.s.queue = [command('RemoteWipe', { scope: 'full_device', approval_id: 'ap-1' })];
  await luks.agent.checkIn();
  assert.deepEqual(luks.log, ['ack received', 'ack started', 'wipe data', 'crypto erase']);
  luks.cleanup();
});

test('wipe whose "started" ack cannot be sent destroys nothing and runs on redelivery', async () => {
  const w = await enrolled();
  const c = command('RemoteWipe', { scope: 'worksuite_data', approval_id: 'ap-1' });
  w.s.failAck = 'started';
  w.s.queue = [c];
  await w.agent.checkIn();
  assert.ok(!w.log.includes('wipe data'));
  w.s.failAck = null; w.log.length = 0;
  w.s.queue = [c];
  await w.agent.checkIn();
  assert.deepEqual(w.log, ['ack received', 'ack started', 'wipe data', 'ack completed']);
  w.cleanup();
});

test('acks that fail are queued and delivered on the next check-in', async () => {
  const w = await enrolled();
  w.s.failAck = 'completed';
  w.s.queue = [command('ScheduleUpdate')];
  await w.agent.checkIn();
  assert.deepEqual(w.log, ['ack received', 'update']);
  w.s.failAck = null;
  await w.agent.checkIn();
  assert.deepEqual(w.log, ['ack received', 'update', 'ack completed']);
  w.cleanup();
});

test('DEVICE_REVOKED unenrolls locally and withdraws the credential', async () => {
  const w = await enrolled();
  w.s.revoked = true;
  await w.agent.checkIn();
  assert.equal(w.agent.status().managed, false);
  assert.equal(w.s.published.credential, null);
  assert.equal(w.s.published.policy, null);
  w.cleanup();
});

test('offline kill timer wipes WorkSuite data after N days without check-in, once', async () => {
  const w = await enrolled({ policy: signedPolicy({ version: 'p1', offline_wipe_days: 3 }) });
  w.s.down = true;
  NOW += 2 * DAY; await w.agent.checkIn();
  assert.deepEqual(w.log, []);
  NOW += 2 * DAY; await w.agent.checkIn(); await w.agent.checkIn();
  assert.deepEqual(w.log, ['wipe data']);
  w.cleanup();
});

test('host helpers validate maintenance windows and catalog ids', () => {
  assert.equal(windowStart('02:00-04:00'), '02:00');
  assert.equal(windowStart('2am'), null);
  assert.equal(windowStart('02:00-04:00; reboot'), null);
  assert.deepEqual(splitCatalogId('flatpak:org.gimp.GIMP'), ['flatpak', 'org.gimp.GIMP']);
  assert.throws(() => splitCatalogId('apt:foo;rm -rf /'), /BAD_CATALOG_ID/);
  assert.throws(() => splitCatalogId('deb:foo'), /BAD_CATALOG_ID/);
});

test('policy enforcement: USB storage, Bluetooth, lock timeout and faillock map to machine settings (WSOS-MDM-002)', () => {
  const none = policyEnforcement(null);
  assert.equal(none.usb_storage, 'allow'); assert.equal(none.bluetooth, 'allow');
  assert.equal(none.files[ENFORCED_PATHS.lockPolicy], null);
  assert.equal(none.files[ENFORCED_PATHS.usbModprobe], null);
  assert.equal(none.files[ENFORCED_PATHS.usbUdev], null);
  assert.equal(none.files[ENFORCED_PATHS.faillock], faillockConf(5, 600));

  const strict = policyEnforcement({ version: 'p', signature: 'x', usb_storage: 'block', bluetooth: false, lock_timeout_max_s: 600, login_failures_max: 3, login_lockout_s: 0 });
  assert.equal(strict.bluetooth, 'block');
  assert.match(strict.files[ENFORCED_PATHS.lockPolicy]!, /^LOCK_TIMEOUT_MAX_S=600$/m);
  assert.match(strict.files[ENFORCED_PATHS.usbModprobe]!, /^install usb_storage \/bin\/false$/m);
  assert.match(strict.files[ENFORCED_PATHS.usbModprobe]!, /^install uas \/bin\/false$/m);
  assert.match(strict.files[ENFORCED_PATHS.usbUdev]!, /UDISKS_IGNORE}="1"/);
  assert.match(strict.files[ENFORCED_PATHS.faillock]!, /^deny = 3$/m);
  assert.match(strict.files[ENFORCED_PATHS.faillock]!, /^unlock_time = 0$/m);

  const ro = policyEnforcement({ version: 'p', signature: 'x', usb_storage: 'read_only', bluetooth: true });
  assert.equal(ro.bluetooth, 'allow');
  assert.equal(ro.files[ENFORCED_PATHS.usbModprobe], null);
  assert.match(ro.files[ENFORCED_PATHS.usbUdev]!, /ENV\{ID_BUS\}=="usb".*RUN\+="\/usr\/sbin\/blockdev --setro \$devnode"/);
  // Only integers ever reach the lock file that worksuite-idle reads.
  assert.equal(policyEnforcement({ version: 'p', signature: 'x', lock_timeout_max_s: '60; rm -rf /' as unknown as number }).files[ENFORCED_PATHS.lockPolicy], null);
});

test('a verified policy is enforced; a rejected one changes nothing; unenrolling lifts every restriction', async () => {
  const w = await enrolled({ policy: signedPolicy({ version: 'p1', usb_storage: 'block', bluetooth: false, lock_timeout_max_s: 300 }) });
  assert.equal(w.s.enforced.at(-1)!.usb_storage, 'block');
  assert.equal(w.s.enforced.at(-1)!.bluetooth, 'block');
  const n = w.s.enforced.length;
  w.s.policy = { ...signedPolicy({ version: 'p2', usb_storage: 'allow' }), signature: 'k1:AAAA' };
  await assert.rejects(w.agent.refreshPolicy(), /POLICY_SIGNATURE/);
  assert.equal(w.s.enforced.length, n);
  w.s.policy = signedPolicy({ version: 'p2', usb_storage: 'read_only' });
  await w.agent.refreshPolicy();
  assert.equal(w.s.enforced.at(-1)!.usb_storage, 'read_only');
  assert.equal(w.s.enforced.at(-1)!.bluetooth, 'allow');
  assert.equal(w.s.enforced.at(-1)!.files[ENFORCED_PATHS.lockPolicy], null);
  w.s.revoked = true;
  await w.agent.checkIn();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(w.s.enforced.at(-1), policyEnforcement(null));
  w.cleanup();
});

test('a failure applying the policy is audited and does not reject the verified policy', async () => {
  const w = world({ policy: signedPolicy({ version: 'p1', usb_storage: 'block' }) });
  w.s.failEnforce = true;
  await w.agent.enroll('https://work.livezentech.com', 'tok-123');
  assert.equal(w.agent.status().policies?.usb_storage, 'block');
  w.cleanup();
});

test('offline access period: sign-in refused and sessions locked after N days offline, restored on check-in (WSOS-AUTH-003)', async () => {
  assert.equal(offlineAccessExpired({ version: 'p', signature: 'x' }, NOW - 400 * DAY, NOW), false);
  const w = await enrolled({ policy: signedPolicy({ version: 'p1', offline_access_days: 7 }) });
  w.s.down = true;
  NOW += 6 * DAY; await w.agent.checkIn();
  assert.deepEqual(w.log, []);
  NOW += 1 * DAY; await w.agent.checkIn(); await w.agent.checkIn();
  assert.deepEqual(w.log, ['offline block', 'lock']);
  assert.match(w.s.offlineNotice!, /Livezen Technologies for 7 days/);
  assert.equal(w.agent.status().offline_access_expired, true);
  // Survives an agent restart, then clears at the first successful check-in.
  const again = w.restart();
  assert.equal(again.status().offline_access_expired, true);
  w.s.down = false; w.log.length = 0;
  await again.checkIn();
  assert.deepEqual((w.log as string[]).filter((l) => l.startsWith('offline')), ['offline unblock']);
  assert.equal(again.status().offline_access_expired, false);
  w.cleanup();
});
