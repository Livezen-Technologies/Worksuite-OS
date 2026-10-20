import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canDefer, canonical, compareVersions, decide, inWindow, rolloutBucket, verifyManifest, type DecideInput, type Manifest } from '../src/updates.ts';

const keys = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const signed = (m: Omit<Manifest, 'signature'>, key = keys.privateKey): Manifest =>
  ({ ...m, signature: `r1:${sign(null, Buffer.from(canonical(m)), key).toString('base64')}` }) as Manifest;
const base: Omit<Manifest, 'signature'> = { release_id: 'os-1.0.2', version: '1.0.2', min_version: '1.0.0', ring: 'stable', arch: 'amd64', rollout_percent: 100, state: 'active' };
const at = (h: number, m = 0) => new Date(2026, 9, 15, h, m);
const input = (over: Partial<DecideInput> = {}, man: Partial<Manifest> = {}): DecideInput => ({
  manifest: { ...signed(base), ...man }, installed: '1.0.1', managed: true, mode: 'automatic', window: '02:00-04:00',
  deviceKey: 'dev-1', now: at(3), idle: false, metered: false, deferrals: 0, ...over,
});

test('versions compare numerically; ~ sorts before release', () => {
  assert.ok(compareVersions('1.0.10', '1.0.9') > 0);
  assert.ok(compareVersions('1.0.0~dev1', '1.0.0') < 0);
  assert.ok(compareVersions('1.1.0-2', '1.1.0-1') > 0);
  assert.equal(compareVersions('1.0.2', '1.0.2'), 0);
});

test('manifest signatures: valid key passes; tampered, foreign-key and unsigned fail (WSOS-AUP-002)', () => {
  const k = (id: string) => (id === 'r1' ? keys.publicKey : undefined);
  const m = signed(base);
  assert.equal(verifyManifest(m, k), true);
  assert.equal(verifyManifest({ ...m, rollout_percent: 100, state: 'pulled' }, k), false);
  assert.equal(verifyManifest(signed(base, other.privateKey), k), false);
  assert.equal(verifyManifest({ ...base }, k), false);
});

test('automatic: installs in the maintenance window, waits outside it', () => {
  assert.deepEqual(decide(input()), { action: 'install', reason: 'automatic' });
  assert.deepEqual(decide(input({ now: at(14) })), { action: 'wait', reason: 'outside_window' });
  assert.deepEqual(decide(input({ window: undefined, idle: true })), { action: 'install', reason: 'automatic' });
  assert.deepEqual(decide(input({ window: undefined, idle: false })), { action: 'wait', reason: 'not_idle' });
});

test('notify waits for the user; manual is honoured only on personal devices (WSOS-AUP-004)', () => {
  assert.deepEqual(decide(input({ mode: 'notify' })), { action: 'wait', reason: 'waiting_for_user' });
  assert.deepEqual(decide(input({ mode: 'manual', managed: false })), { action: 'none', reason: 'manual_mode' });
  assert.deepEqual(decide(input({ mode: 'manual', managed: true })), { action: 'wait', reason: 'waiting_for_user' });
});

test('security releases install in automatic and notify, not manual (WSOS-AUP-005)', () => {
  assert.deepEqual(decide(input({ mode: 'notify' }, { security: true })), { action: 'install', reason: 'security' });
  assert.deepEqual(decide(input({ mode: 'manual', managed: false }, { security: true })), { action: 'none', reason: 'manual_mode' });
});

test('downgrades need a signed rollback directive for the installed version (WSOS-AUP-003)', () => {
  assert.deepEqual(decide(input({ installed: '1.0.3' })), { action: 'refuse', reason: 'downgrade' });
  assert.deepEqual(decide(input({ installed: '1.0.3' }, { rollback_directive: { from_version: '1.0.3', reason: 'regression' } })), { action: 'install', reason: 'automatic' });
  assert.deepEqual(decide(input({ installed: '1.0.2' })), { action: 'none', reason: 'up_to_date' });
});

test('staged rollout uses a stable bucket; paused and pulled stop installing (WSOS-AUP-006)', () => {
  assert.equal(rolloutBucket('dev-1', 'os-1.0.2'), rolloutBucket('dev-1', 'os-1.0.2'));
  const devices = Array.from({ length: 1000 }, (_, n) => `dev-${n}`);
  const inTen = devices.filter((d) => decide(input({ deviceKey: d }, { rollout_percent: 10 })).action === 'install').length;
  assert.ok(inTen > 60 && inTen < 140, `~10% got it (${inTen})`);
  const inThirty = devices.filter((d) => decide(input({ deviceKey: d }, { rollout_percent: 30 })).action === 'install');
  assert.ok(devices.filter((d) => decide(input({ deviceKey: d }, { rollout_percent: 10 })).action === 'install').every((d) => inThirty.includes(d)), 'widening keeps earlier devices');
  assert.deepEqual(decide(input({}, { state: 'paused' })), { action: 'none', reason: 'paused' });
  assert.deepEqual(decide(input({}, { state: 'pulled' })), { action: 'none', reason: 'pulled' });
});

test('mandatory: 3 deferrals and a deadline, then a 15-minute warning (WSOS-AUP-007)', () => {
  const m = { mandatory: true, deadline: new Date(2026, 9, 16, 9).toISOString() };
  assert.deepEqual(decide(input({ mode: 'notify', deferrals: 2 }, m)), { action: 'wait', reason: 'waiting_for_user' });
  assert.deepEqual(decide(input({ mode: 'notify', deferrals: 3 }, m)), { action: 'warn_restart', minutes: 15 });
  assert.deepEqual(decide(input({ mode: 'notify', now: new Date(2026, 9, 16, 10) }, m)), { action: 'warn_restart', minutes: 15 });
  const man = { ...signed(base), ...m };
  assert.equal(canDefer(man, '1.0.1', 2, at(10)), true);
  assert.equal(canDefer(man, '1.0.1', 3, at(10)), false);
  assert.equal(canDefer({ ...signed(base) }, '1.0.1', 9, at(10)), true, 'optional releases can always wait');
  assert.equal(canDefer({ ...signed(base) }, '0.9.0', 3, at(10)), false, 'below min_version counts as mandatory');
});

test('metered connections wait unless critical (WSOS-AUP-008)', () => {
  assert.deepEqual(decide(input({ metered: true })), { action: 'wait', reason: 'metered' });
  assert.deepEqual(decide(input({ metered: true }, { critical: true })), { action: 'install', reason: 'automatic' });
});

test('maintenance windows can wrap midnight', () => {
  assert.equal(inWindow('22:00-02:00', at(23)), true);
  assert.equal(inWindow('22:00-02:00', at(1)), true);
  assert.equal(inWindow('22:00-02:00', at(12)), false);
  assert.equal(inWindow(undefined, at(12)), true);
});

test('policy security_auto_patch (#38): immediate ignores the window, off follows the update mode', () => {
  const outside = { now: at(12), idle: false };
  assert.deepEqual(decide(input({ mode: 'notify', ...outside }, { security: true })), { action: 'wait', reason: 'outside_window' });
  assert.deepEqual(decide(input({ mode: 'notify', ...outside, securityPatch: 'immediate' }, { security: true })), { action: 'install', reason: 'security' });
  assert.deepEqual(decide(input({ mode: 'notify', securityPatch: 'off' }, { security: true })), { action: 'wait', reason: 'waiting_for_user' });
  // Still never on a metered link unless critical.
  assert.deepEqual(decide(input({ mode: 'automatic', metered: true, securityPatch: 'immediate' }, { security: true })), { action: 'wait', reason: 'metered' });
});
