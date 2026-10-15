import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Coordinator, manifestUrl, type CoordinatorEnv } from '../src/coordinator.ts';
import { PackageService } from '../src/service.ts';
import { canonical, type Manifest } from '../src/updates.ts';

const keys = generateKeyPairSync('ed25519');
const signed = (m: Record<string, unknown>, key = keys.privateKey) => ({ ...m, signature: `r1:${sign(null, Buffer.from(canonical(m)), key).toString('base64')}` });
const base = { release_id: 'os-1.0.2', version: '1.0.2', min_version: '1.0.0', ring: 'stable', arch: 'amd64', rollout_percent: 100, state: 'active' };

function world(opts: { manifest?: unknown; policy?: ReturnType<CoordinatorEnv['policy']>; idle?: boolean; installed?: string; reboot?: boolean; aptFails?: boolean } = {}) {
  const log: string[] = [];
  const reports: Record<string, unknown>[] = [];
  let store = { deferrals: {} as Record<string, number> };
  let installed = opts.installed ?? '1.0.1';
  const svc = new PackageService({
    runner: { async run(cmd, args) {
      if (cmd === 'test') return { code: opts.reboot ? 0 : 1, stdout: '', stderr: '' };
      if (cmd === 'apt-get' && args.includes('full-upgrade') && args.includes('-y') && !args.includes('--download-only')) {
        log.push('apply'); if (opts.aptFails) return { code: 100, stdout: '', stderr: 'E: Sub-process /usr/bin/dpkg returned an error code (1)' };
        installed = '1.0.2';
      }
      return { code: 0, stdout: '', stderr: '' };
    } },
    policy: () => null, sources: () => [], power: () => ({ ac: true, battery: null }), freeBytes: () => 1e12, audit() {},
  });
  const env: CoordinatorEnv = {
    fetchJson: async (url) => { log.push(`GET ${url}`); return opts.manifest ?? signed(base); },
    keys: (id) => (id === 'r1' ? keys.publicKey : undefined),
    policy: () => opts.policy ?? null,
    arch: 'amd64',
    installedVersion: () => installed,
    deviceKey: () => 'machine-1',
    idle: async () => opts.idle ?? true,
    metered: async () => false,
    setSuite: (s) => log.push(`suite ${s}`),
    load: () => store,
    save: (s) => { store = s; },
    report: async (r) => { reports.push(r); },
    reboot: async () => { log.push('reboot'); },
    now: () => new Date(2026, 9, 15, 3).getTime(),
    audit() {},
  };
  return { c: new Coordinator(env, svc), log, reports };
}

test('manifest URL is https, per ring and arch', () => {
  assert.equal(manifestUrl('https://download.worksuitecloud.com', 'pilot', 'arm64'), 'https://download.worksuitecloud.com/os/manifests/pilot/arm64.json');
  assert.throws(() => manifestUrl('http://mirror.example', 'stable', 'amd64'));
});

test('a verified update installs at idle, reports success, and ends up to date', async () => {
  const w = world();
  const d = await w.c.check();
  assert.deepEqual(d, { action: 'install', reason: 'automatic' });
  assert.ok(w.log.includes('suite trixie-stable'));
  assert.ok(w.log.includes('apply'));
  assert.equal(w.c.status.state, 'up_to_date');
  assert.equal(w.c.status.installed, '1.0.2');
  assert.deepEqual(w.reports.map((r) => [r.release_id, r.result, r.health_check, r.ring, r.arch]), [['os-1.0.2', 'success', 'pass', 'stable', 'amd64']]);
});

test('reboot-needing updates end in ready_to_restart', async () => {
  const w = world({ reboot: true });
  await w.c.check();
  assert.equal(w.c.status.state, 'ready_to_restart');
  assert.ok(!w.log.includes('reboot'), 'never reboots on its own outside a deadline');
});

test('a tampered manifest is refused and reported (WSOS-AUP-002)', async () => {
  const w = world({ manifest: { ...signed(base), version: '9.9.9' } });
  assert.equal(await w.c.check(), null);
  assert.equal(w.c.status.state, 'failed');
  assert.deepEqual(w.reports.map((r) => r.result), ['refused_signature']);
  assert.ok(!w.log.includes('apply'));
});

test('a manifest for another ring is refused', async () => {
  const w = world({ manifest: signed({ ...base, ring: 'development' }) });
  await w.c.check();
  assert.equal(w.c.status.state, 'failed');
});

test('ring and mirror come from policy (WSOS-UPD-002, AUP-009)', async () => {
  const w = world({ policy: { update_ring: 'pilot', update_mirror: 'https://mirror.livezen.example', update_mode: 'notify' }, manifest: signed({ ...base, ring: 'pilot' }) });
  const d = await w.c.check();
  assert.ok(w.log.includes('suite trixie-pilot'));
  assert.ok(w.log.includes('GET https://mirror.livezen.example/os/manifests/pilot/amd64.json'));
  assert.deepEqual(d, { action: 'wait', reason: 'waiting_for_user' });
  assert.equal(w.c.status.state, 'waiting');
  await w.c.installNow();
  assert.equal(w.c.status.state, 'up_to_date');
});

test('deferrals: unlimited for optional releases, three for mandatory ones', async () => {
  const w = world({ policy: { update_mode: 'notify' }, manifest: signed({ ...base, mandatory: true, deadline: new Date(2026, 9, 20).toISOString() }) });
  await w.c.check();
  assert.equal(w.c.status.deferrals_left, 3);
  assert.equal(w.c.defer(), true); assert.equal(w.c.defer(), true); assert.equal(w.c.defer(), true);
  assert.equal(w.c.defer(), false);
  const d = await w.c.check();
  assert.deepEqual(d, { action: 'warn_restart', minutes: 15 });
  assert.equal(w.c.status.state, 'restart_pending');
  assert.ok(w.c.status.restart_at);
  w.c.stop();
});

test('a failed apply is reported with the error', async () => {
  const w = world({ aptFails: true });
  await w.c.check();
  assert.equal(w.c.status.state, 'failed');
  assert.equal(w.reports[0].result, 'failed');
  assert.match(String(w.reports[0].error), /dpkg returned an error/);
});

test('refuses downgrades and reports them (WSOS-AUP-003)', async () => {
  const w = world({ installed: '1.1.0' });
  await w.c.check();
  assert.equal(w.c.status.state, 'failed');
  assert.deepEqual(w.reports.map((r) => r.result), ['refused_downgrade']);
});
