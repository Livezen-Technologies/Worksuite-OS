// WSOS-AUP-012 edition entitlement gating, and WSOS-AUP-008 interrupted downloads in the coordinator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator, type CoordinatorEnv } from '../src/coordinator.ts';
import { PackageService } from '../src/service.ts';
import { decide, verifyLicence, type DecideInput, type Licence, type Manifest } from '../src/updates.ts';
import { releaseKey } from './helpers.ts';

const key = releaseKey('r1');
const now = new Date(2026, 9, 15, 3);
const licence = (over: Partial<Licence> = {}) => key.signFlat({ device_id: 'dev-1', edition: 'business', state: 'active', entitlements: ['business'],
  issued_at: '2026-10-15T00:00:00Z', valid_until: '2026-10-22T00:00:00Z', ...over }) as unknown as Licence;
const manifest = (over: Partial<Manifest> = {}) => key.signFlat({ release_id: 'os-1.1.0', version: '1.1.0', min_version: '1.0.0', ring: 'stable', arch: 'amd64', rollout_percent: 100, state: 'active', ...over }) as unknown as Manifest;
const input = (m: Manifest, l: Licence | null): DecideInput => ({ manifest: m, installed: '1.0.1', managed: true, mode: 'automatic', deviceKey: 'k', now, idle: true, metered: false, deferrals: 0, licence: l });

test('licence: signature, device binding, state and freshness are all required', () => {
  assert.equal(verifyLicence(licence(), key.keys, 'dev-1', now), true);
  assert.equal(verifyLicence(licence(), key.keys, 'dev-2', now), false, 'another device');
  assert.equal(verifyLicence({ ...licence(), state: 'active', entitlements: ['business', 'enterprise'] }, key.keys, 'dev-1', now), false, 'edited');
  assert.equal(verifyLicence(licence({ valid_until: '2026-10-01T00:00:00Z' }), key.keys, 'dev-1', now), false, 'stale licence cannot be replayed');
  assert.equal(verifyLicence(releaseKey('r1').signFlat(licence() as unknown as Record<string, unknown>), key.keys, 'dev-1', now), false, 'foreign key');
});

test('feature releases need the entitlement; security releases continue during grace; ungated releases ignore licences', () => {
  const feature = manifest({ entitlement: 'business' });
  assert.equal(decide(input(feature, licence())).action, 'install');
  assert.deepEqual(decide(input(feature, null)), { action: 'none', reason: 'not_entitled' });
  assert.deepEqual(decide(input(feature, licence({ entitlements: ['personal'] }))), { action: 'none', reason: 'not_entitled' });
  assert.deepEqual(decide(input(feature, licence({ state: 'grace' }))), { action: 'none', reason: 'not_entitled' }, 'features stop in grace');
  const security = manifest({ entitlement: 'business', security: true });
  assert.deepEqual(decide(input(security, licence({ state: 'grace' }))), { action: 'install', reason: 'security' }, 'security continues in grace');
  assert.deepEqual(decide(input(security, licence({ state: 'expired' }))), { action: 'none', reason: 'not_entitled' });
  assert.equal(decide(input(manifest(), null)).action, 'install', 'releases without an entitlement are for everyone');
});

function world(opts: { licence?: unknown; download?: 'fail' | 'ok' }) {
  const audits: string[] = [];
  const svc = new PackageService({
    runner: { async run(cmd, args) {
      if (cmd === 'test') return { code: 1, stdout: '', stderr: '' };
      if (cmd === 'apt-get' && args.includes('--download-only') && opts.download === 'fail') return { code: 100, stdout: '', stderr: 'E: Failed to fetch https://x/a.deb Connection timed out' };
      return { code: 0, stdout: '', stderr: '' };
    } },
    policy: () => null, sources: () => [], power: () => ({ ac: true, battery: null }), freeBytes: () => 1e12, audit() {}, sleep: async () => {},
  });
  const reports: Record<string, unknown>[] = [];
  let store = { deferrals: {} as Record<string, number> };
  const env: CoordinatorEnv = {
    fetchJson: async () => manifest({ entitlement: 'business' }), keys: key.keys, policy: () => ({ update_mode: 'automatic' }), arch: 'amd64',
    installedVersion: () => '1.0.1', deviceKey: () => 'k', idle: async () => true, metered: async () => false, setSuite() {},
    load: () => store, save: (s) => { store = s; }, report: async (r) => { reports.push(r); }, reboot: async () => {}, now: () => now.getTime(),
    licence: async () => opts.licence ?? null, deviceId: () => 'dev-1', audit: (e) => { audits.push(e); },
  };
  return { c: new Coordinator(env, svc), reports, audits };
}

test('coordinator: a forged licence counts as none; nothing is installed or removed', async () => {
  const w = world({ licence: { ...licence(), entitlements: ['business'], state: 'active', edition: 'enterprise' } });
  assert.deepEqual(await w.c.check(), { action: 'none', reason: 'not_entitled' });
  assert.equal(w.c.status.state, 'available');
  assert.equal(w.c.status.reason, 'not_entitled');
  assert.ok(w.audits.includes('licence_rejected'));
});

test('coordinator: an interrupted download waits to resume instead of failing; nothing is reported as failed', async () => {
  const w = world({ licence: licence(), download: 'fail' });
  await w.c.check();
  assert.equal(w.c.status.state, 'waiting');
  assert.equal(w.c.status.reason, 'download_interrupted');
  assert.equal(w.reports.length, 0);
  const ok = world({ licence: licence(), download: 'ok' });
  await ok.c.check();
  assert.equal(ok.c.status.state, 'up_to_date');
});
