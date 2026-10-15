import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSources, parseCatalogId, parseDiskChange, parseSimulation, parseUpgradable } from '../src/apt.ts';
import { flatpakPermissions, PackageService, type Env, type Job, type RunResult } from '../src/service.ts';

const GOOD_SOURCES: [string, string][] = [
  ['/etc/apt/sources.list.d/debian.sources', 'Types: deb\nURIs: https://deb.debian.org/debian\nSuites: trixie trixie-updates\nComponents: main non-free-firmware\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n'],
  ['/etc/apt/sources.list.d/worksuite.list', 'deb [signed-by=/usr/share/keyrings/worksuite-archive-keyring.gpg] https://download.worksuitecloud.com/os/apt trixie-pilot main\n'],
];

type Script = (cmd: string, args: string[]) => Partial<RunResult> | undefined;

function world(script: Script = () => undefined, over: Partial<Env> = {}) {
  const calls: string[] = [];
  const audit: string[] = [];
  const env: Env = {
    runner: { async run(cmd, args) { calls.push([cmd, ...args].join(' ')); return { code: 0, stdout: '', stderr: '', ...script(cmd, args) }; } },
    policy: () => null,
    sources: () => GOOD_SOURCES,
    power: () => ({ ac: true, battery: 90 }),
    freeBytes: () => 50e9,
    audit: (e) => { audit.push(e); },
    ...over,
  };
  const svc = new PackageService(env);
  const done = (id: number) => new Promise<Job>((resolve) => {
    const check = (j: Job) => { if (j.id === id) { svc.off('finished', check); resolve(j); } };
    svc.on('finished', check);
  });
  return { svc, calls, audit, done };
}

const SIM_INSTALL = 'Inst libgimp (2.10.38-1 Debian:13/stable [amd64])\nInst gimp (2.10.38-1 Debian:13/stable [amd64])\nConf gimp (2.10.38-1)\n';

test('parsers: simulation, disk change, upgradable list, flatpak permissions', () => {
  assert.deepEqual(parseSimulation('Inst a [1.0] (1.1 Debian [amd64])\nInst b (2.0 Debian [amd64])\nRemv c [3.0]\n'),
    { install: [{ name: 'b', version: '2.0' }], upgrade: [{ name: 'a', version: '1.1' }], remove: [{ name: 'c', version: '3.0' }] });
  assert.equal(parseDiskChange('After this operation, 12.3 MB of additional disk space will be used.'), 12_300_000);
  assert.equal(parseDiskChange('After this operation, 4,096 kB disk space will be freed.'), -4_096_000);
  assert.deepEqual(parseUpgradable('Listing...\nfirefox-esr/trixie-security 128.3 amd64 [upgradable from: 128.2]\n'), [{ name: 'firefox-esr', version: '128.3' }]);
  assert.deepEqual(flatpakPermissions('[Application]\nname=x\n\n[Context]\nshared=network;ipc;\nfilesystems=home;\n'), ['shared=network;ipc;', 'filesystems=home;']);
});

test('sources: trixie + WorkSuite with Signed-By pass; testing, unstable, unknown hosts and unsigned fail', () => {
  assert.deepEqual(GOOD_SOURCES.flatMap(([f, t]) => checkSources(t, f)), []);
  const bad = checkSources('deb https://deb.debian.org/debian testing main\ndeb [signed-by=/k.gpg] http://ppa.example.com/x trixie main\ndeb [signed-by=/k.gpg] https://deb.debian.org/debian sid main\n', 'x.list');
  assert.ok(bad.some((i) => /testing.*not allowed/.test(i)));
  assert.ok(bad.some((i) => /sid.*not allowed/.test(i)));
  assert.ok(bad.some((i) => /ppa.example.com/.test(i)));
  assert.ok(bad.some((i) => /missing Signed-By/.test(i)));
  assert.deepEqual(checkSources('Types: deb\nURIs: https://deb.debian.org/debian\nSuites: unstable\nComponents: main\nEnabled: no\n', 'off.sources'), [], 'disabled stanzas ignored');
});

test('catalog ids: only plain package names or flatpak app ids, never options or paths', () => {
  assert.equal(parseCatalogId('apt', 'apt:gimp'), 'gimp');
  assert.equal(parseCatalogId('flatpak', 'flatpak:org.gimp.GIMP'), 'org.gimp.GIMP');
  for (const bad of ['-oDebug=1', '../x', 'gimp; rm -rf /', '/tmp/x.deb', 'http://x/y.deb']) assert.throws(() => parseCatalogId('apt', bad));
  assert.throws(() => parseCatalogId('flatpak', 'gimp'));
});

test('preview shows the plan and disk space, through fixed apt-get arguments', async () => {
  const w = world((cmd, args) => {
    if (args[0] === '-s') return { stdout: SIM_INSTALL };
    if (args[0] === '--assume-no') return { code: 1, stdout: 'After this operation, 118 MB of additional disk space will be used.\nAbort.' };
  });
  const p = await w.svc.preview('apt', 'apt:gimp', 'install');
  assert.deepEqual(p.plan.install.map((c) => c.name), ['libgimp', 'gimp']);
  assert.equal(p.disk_bytes, 118_000_000);
  assert.deepEqual(w.calls, ['apt-get -s -q install -- gimp', 'apt-get --assume-no -q install -- gimp']);
});

test('install runs in the queue, re-checks the plan, and audits', async () => {
  const w = world((_c, args) => (args[0] === '-s' ? { stdout: SIM_INSTALL } : undefined));
  const id = w.svc.install(1000, 'apt', 'apt:gimp');
  const job = await w.done(id);
  assert.equal(job.state, 'success');
  assert.ok(w.calls.includes('apt-get -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold install -- gimp'));
  assert.ok(w.audit.includes('installed'));
});

test('jobs never overlap (one package lock, WSOS-APT-004)', async () => {
  let running = 0, max = 0;
  const w = world();
  w.svc['env'].runner = { async run() { running++; max = Math.max(max, running); await new Promise((r) => setTimeout(r, 5)); running--; return { code: 0, stdout: '', stderr: '' }; } };
  const ids = [w.svc.install(1000, 'flatpak', 'flatpak:org.gimp.GIMP'), w.svc.repair(0), w.svc.install(1000, 'flatpak', 'flatpak:org.inkscape.Inkscape')];
  await w.done(ids[2]);
  assert.equal(max, 1);
});

test('critical packages: direct removal and side-effect removal are refused (WSOS-APT-003)', async () => {
  const w = world((_c, args) => (args[0] === '-s' ? { stdout: 'Remv libfoo [1]\nRemv greetd [0.10]\n' } : undefined));
  assert.throws(() => w.svc.remove(1000, 'apt', 'apt:worksuite-shell'), /part of the system/);
  assert.throws(() => w.svc.remove(1000, 'apt', 'apt:linux-image-6.12.0-1-amd64'), /part of the system/);
  const job = await w.done(w.svc.remove(1000, 'apt', 'apt:libfoo'));
  assert.equal(job.state, 'failed');
  assert.match(job.error!, /would remove greetd/);
  assert.ok(!w.calls.some((c) => c.startsWith('apt-get -y -q remove')));
});

test('managed devices install only allowlisted apps from approved remotes (WSOS-APP-003, FLP-001)', async () => {
  const w = world(undefined, { policy: () => ({ app_allowlist: ['flatpak:org.gimp.GIMP'], approved_remotes: ['corp-flathub'] }) });
  assert.throws(() => w.svc.install(1000, 'apt', 'apt:nmap'), /not approved/);
  await w.done(w.svc.install(1000, 'flatpak', 'flatpak:org.gimp.GIMP'));
  assert.ok(w.calls.includes('flatpak install --system --noninteractive -y corp-flathub org.gimp.GIMP'));
});

test('a testing/unstable source blocks APT operations', async () => {
  const w = world(undefined, { sources: () => [['/etc/apt/sources.list', 'deb [signed-by=/k] https://deb.debian.org/debian unstable main\n']] });
  await assert.rejects(w.svc.preview('apt', 'apt:gimp', 'install'), /unstable/);
});

test('updates need power, refresh signed metadata, and report reboot need (WSOS-UPD-001)', async () => {
  const low = world(undefined, { power: () => ({ ac: false, battery: 25 }) });
  const j1 = await low.done(low.svc.applyUpdate(0, ''));
  assert.equal(j1.state, 'failed'); assert.match(j1.error!, /40%/);
  assert.deepEqual(low.calls, []);

  const ok = world((cmd, args) => {
    if (cmd === 'test') return { code: 0 };
    if (args[0] === '--assume-no') return { code: 1, stdout: 'After this operation, 200 MB of additional disk space will be used.' };
  });
  const j2 = await ok.done(ok.svc.applyUpdate(0, ''));
  assert.equal(j2.state, 'success');
  assert.equal(ok.calls[0], 'apt-get update -q');
  assert.ok(ok.svc.rebootRequired);

  const bad = world((_c, args) => (args[0] === 'update' ? { code: 100, stderr: 'W: GPG error: https://download.worksuitecloud.com trixie-pilot InRelease: NO_PUBKEY 1234\n' } : undefined));
  const j3 = await bad.done(bad.svc.applyUpdate(0, ''));
  assert.equal(j3.state, 'failed'); assert.match(j3.error!, /NO_PUBKEY/);
});

test('interrupted dpkg: everything but Repair is refused until repaired (WSOS-APT-006)', async () => {
  let interrupted = true;
  const w = world((cmd, args) => {
    if (cmd === 'dpkg' && args[0] === '--audit') return { stdout: interrupted ? 'The following packages are only half configured\n gimp\n' : '' };
    if (cmd === 'dpkg' && args[0] === '--configure') { interrupted = false; return {}; }
  });
  assert.equal(await w.svc.detectInterrupted(), true);
  assert.equal(w.svc.state(), 'interrupted');
  assert.throws(() => w.svc.install(1000, 'flatpak', 'flatpak:org.gimp.GIMP'), /repair packages first/);
  const job = await w.done(w.svc.repair(1000));
  assert.equal(job.state, 'success');
  assert.ok(w.calls.includes('dpkg --configure -a'));
  assert.equal(w.svc.state(), 'idle');
});

test('only the job owner (or root) can cancel, and only while queued', async () => {
  const w = world();
  w.svc['env'].runner = { async run() { await new Promise((r) => setTimeout(r, 10)); return { code: 0, stdout: '', stderr: '' }; } };
  const first = w.svc.repair(1000);
  const second = w.svc.install(1001, 'flatpak', 'flatpak:org.gimp.GIMP');
  assert.throws(() => w.svc.cancel(1000, second), /NotAuthorized/);
  w.svc.cancel(1001, second);
  assert.equal(w.svc.job(second)?.state, 'cancelled');
  await w.done(first);
  assert.throws(() => w.svc.cancel(1000, first), /Busy|already/);
});
