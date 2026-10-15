// Catalog, local .deb, Flatpak permissions/prune, offline bundles, resumable downloads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCatalog, type CatalogEnv } from '../src/catalog.ts';
import { PackageService, type Env, type Job, type RunResult } from '../src/service.ts';
import { makeBundle, releaseKey, sha256, tmp } from './helpers.ts';

const GOOD_SOURCES: [string, string][] = [['/etc/apt/sources.list.d/debian.sources', 'Types: deb\nURIs: https://deb.debian.org/debian\nSuites: trixie\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n']];
type Script = (cmd: string, args: string[]) => Partial<RunResult> | undefined;
const uid = process.getuid?.() ?? 0;

function world(script: Script = () => undefined, over: Partial<Env> = {}) {
  const calls: string[] = [];
  const audit: [string, Record<string, unknown>][] = [];
  const env: Env = {
    runner: { async run(cmd, args) { calls.push([cmd, ...args].join(' ')); return { code: 0, stdout: '', stderr: '', ...script(cmd, args) }; } },
    policy: () => null, sources: () => GOOD_SOURCES, power: () => ({ ac: true, battery: 90 }), freeBytes: () => 50e9,
    audit: (e, f) => { audit.push([e, f]); }, spool: tmp('ws-spool-'), sleep: async () => {}, ...over,
  };
  const svc = new PackageService(env);
  const done = (id: number) => new Promise<Job>((resolve) => {
    const check = (j: Job) => { if (j.id === id) { svc.off('finished', check); resolve(j); } };
    svc.on('finished', check);
  });
  return { svc, calls, audit, done, env };
}

// ---------------- catalog ----------------

function catalogEnv(pages: Record<string, unknown[]>, over: Partial<CatalogEnv> = {}) {
  const urls: string[] = [];
  const env: CatalogEnv = {
    server: () => ({ host: 'ws.example.com', token: 'dev-token' }),
    async fetchJson(url, headers) {
      urls.push(url);
      assert.equal(headers['x-ws-device'], 'dev-token');
      const u = new URL(url);
      const arch = u.searchParams.get('arch')!;
      const items = pages[arch] ?? [];
      const cursor = u.searchParams.get('cursor');
      // two items per page to exercise paging
      const start = cursor ? Number(cursor) : 0;
      return { items: items.slice(start, start + 2), next_cursor: start + 2 < items.length ? String(start + 2) : null };
    },
    arch: 'arm64', policy: () => null, now: () => 1,
    runner: { async run(cmd) { return cmd === 'dpkg-query' ? { code: 0, stdout: 'inkscape\tii \nfirefox-esr:arm64\tii \ngimp\trc \n', stderr: '' } : { code: 0, stdout: 'org.gimp.GIMP\n', stderr: '' }; } },
    ...over,
  };
  return { env, urls };
}

const ITEMS = {
  arm64: [
    { id: 'apt:inkscape', source: 'apt', name: 'Inkscape', arches: ['amd64', 'arm64'] },
    { id: 'flatpak:org.gimp.GIMP', source: 'flatpak', name: 'GIMP', arches: ['amd64', 'arm64'] },
    { id: 'apt:nmap', source: 'apt', name: 'Nmap', arches: ['amd64', 'arm64'], blocked: true },
    { id: 'appimage:pinta', source: 'appimage', name: 'Pinta', arches: ['arm64'], sha256: 'a'.repeat(64) },
    { id: 'apt:../evil', source: 'apt', name: 'bad', arches: ['arm64'] },
  ],
  amd64: [
    { id: 'apt:inkscape', source: 'apt', name: 'Inkscape', arches: ['amd64', 'arm64'] },
    { id: 'flatpak:com.example.X86Only', source: 'flatpak', name: 'X86 Only', arches: ['amd64'] },
  ],
};

test('catalog: server items with paging, installed state, policy and arch flags; invalid ids dropped', async () => {
  const { env, urls } = catalogEnv(ITEMS, { policy: () => ({ app_allowlist: ['flatpak:org.gimp.GIMP', 'apt:nmap'], appimages: 'block' }) });
  const r = await loadCatalog(env);
  assert.equal(r.state, 'ok');
  assert.ok(urls.every((u) => u.startsWith('https://ws.example.com/desktop/v1/os/catalog?')));
  assert.ok(urls.some((u) => u.includes('cursor=2')), 'follows next_cursor');
  const by = Object.fromEntries(r.items.map((i) => [i.id, i]));
  assert.equal(by['apt:../evil'], undefined);
  assert.equal(by['apt:inkscape'].installed, true);
  assert.equal(by['apt:inkscape'].blocked_reason, 'Not on your organization’s approved list');
  assert.equal(by['flatpak:org.gimp.GIMP'].installed, true);
  assert.equal(by['flatpak:org.gimp.GIMP'].blocked_reason, null);
  assert.equal(by['apt:nmap'].blocked_reason, 'Blocked by your organization');
  assert.equal(by['appimage:pinta'].blocked_reason, 'Your organization does not allow AppImages');
  assert.equal(by['flatpak:com.example.X86Only'].available, false);
  assert.equal(by['flatpak:com.example.X86Only'].blocked_reason, 'Not available for ARM64');
});

test('catalog: unmanaged, unreachable and refused are explicit empty states', async () => {
  assert.equal((await loadCatalog(catalogEnv(ITEMS, { server: () => null }).env)).state, 'not_enrolled');
  const down = await loadCatalog(catalogEnv(ITEMS, { fetchJson: async () => { throw new Error('fetch failed'); } }).env);
  assert.equal(down.state, 'unreachable'); assert.deepEqual(down.items, []);
  const refused = await loadCatalog(catalogEnv(ITEMS, { fetchJson: async () => { throw new Error('HTTP 401'); } }).env);
  assert.equal(refused.state, 'error'); assert.deepEqual(refused.items, []);
});

// ---------------- local .deb (WSOS-APT-005) ----------------

const FIELDS = 'Package: hello\nVersion: 2.10-3\nArchitecture: amd64\nMaintainer: Example Org <pkg@example.org>\nDescription: says hello\n';
const debScript = (over: Script = () => undefined): Script => (cmd, args) => {
  const o = over(cmd, args); if (o) return o;
  if (cmd === 'dpkg-deb') return { stdout: FIELDS };
  if (cmd === 'dpkg' && args[0] === '--print-architecture') return { stdout: 'amd64\n' };
  if (cmd === 'apt-get' && args[0] === '-s') return { stdout: 'Inst libhello (1.0 Debian:13/stable [amd64])\nInst hello (2.10-3 local [amd64])\n' };
  if (cmd === 'apt-get' && args[0] === '--assume-no') return { code: 1, stdout: 'After this operation, 1,024 kB of additional disk space will be used.\n' };
};
function debFile(content = 'debian-binary...') {
  const d = tmp(); const f = join(d, 'hello_2.10-3_amd64.deb'); writeFileSync(f, content); return f;
}

test('local .deb: staged copy, publisher shown unverified, apt validates; install needs the preview token', async () => {
  const w = world(debScript());
  const file = debFile();
  const p = await w.svc.previewLocalDeb(uid, file);
  assert.equal(p.package, 'hello');
  assert.equal(p.publisher, 'Example Org <pkg@example.org>');
  assert.equal(p.publisher_verified, false);
  assert.equal(p.token, sha256('debian-binary...'));
  assert.deepEqual(p.plan.install.map((c) => c.name), ['libhello', 'hello']);
  assert.equal(p.disk_bytes, 1_024_000);
  const staged = join(w.env.spool!, 'debs', `${p.token}.deb`);
  assert.ok(w.calls.includes(`apt-get -s -q install -- ${staged}`), 'apt works on the root-owned copy, not the user file');
  assert.throws(() => w.svc.installLocalDeb(uid, 'not-a-token'), { code: 'InvalidArgs' });
  const job = await w.done(w.svc.installLocalDeb(uid, p.token));
  assert.equal(job.state, 'success', job.error);
  assert.ok(w.calls.includes(`apt-get -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold install -- ${staged}`));
  assert.ok(w.audit.some(([e, f]) => e === 'installed_local_deb' && f.sha256 === p.token && f.publisher === p.publisher));
  assert.ok(!existsSync(staged), 'staged copy removed after install');
  const again = await w.done(w.svc.installLocalDeb(uid, p.token));
  assert.equal(again.state, 'failed', 'a token is good for one install');
});

test('local .deb: a changed staged copy, policy, arch, critical packages and unmet dependencies are refused', async () => {
  const w = world(debScript());
  const p = await w.svc.previewLocalDeb(uid, debFile());
  writeFileSync(join(w.env.spool!, 'debs', `${p.token}.deb`), 'swapped');
  assert.equal((await w.done(w.svc.installLocalDeb(uid, p.token))).state, 'failed');
  assert.ok(!w.calls.some((c) => c.startsWith('apt-get -y')));

  await assert.rejects(world(debScript(), { policy: () => ({ allow_local_debs: false }) }).svc.previewLocalDeb(uid, debFile()), { code: 'NotInCatalog' });
  await assert.rejects(world(debScript(), { policy: () => ({ app_allowlist: ['apt:gimp'] }) }).svc.previewLocalDeb(uid, debFile()), { code: 'NotInCatalog' });
  await world(debScript(), { policy: () => ({ app_allowlist: ['apt:hello'] }) }).svc.previewLocalDeb(uid, debFile());
  await assert.rejects(world(debScript((c, a) => (c === 'dpkg' && a[0] === '--print-architecture' ? { stdout: 'arm64\n' } : undefined))).svc.previewLocalDeb(uid, debFile()), { code: 'ArchMismatch' });
  await assert.rejects(world(debScript((c) => (c === 'dpkg-deb' ? { stdout: FIELDS.replace('hello', 'worksuite-desktop') } : undefined))).svc.previewLocalDeb(uid, debFile()), { code: 'Protected' });
  await assert.rejects(world(debScript((c, a) => (c === 'apt-get' && a[0] === '-s' ? { code: 100, stderr: 'E: Unmet dependencies. hello : Depends: libfoo\n' } : undefined))).svc.previewLocalDeb(uid, debFile()), /Unmet dependencies/);
  await assert.rejects(world(debScript((c, a) => (c === 'apt-get' && a[0] === '-s' ? { stdout: 'Remv greetd [1]\nInst hello (1 local [amd64])\n' } : undefined))).svc.previewLocalDeb(uid, debFile()), { code: 'Protected' });
});

test('local .deb: only regular files the caller owns, never links or other paths', async () => {
  const w = world(debScript());
  const f = debFile();
  const link = join(tmp(), 'link.deb'); symlinkSync(f, link);
  await assert.rejects(w.svc.previewLocalDeb(uid, link), { code: 'InvalidArgs' });
  await assert.rejects(w.svc.previewLocalDeb(uid, 'relative.deb'), { code: 'InvalidArgs' });
  await assert.rejects(w.svc.previewLocalDeb(uid, '/etc/shadow'), { code: 'InvalidArgs' });
  await assert.rejects(w.svc.previewLocalDeb(uid + 1, f), { code: 'NotAuthorized' });
  assert.ok(!w.calls.length, 'nothing ran');
});

// ---------------- Flatpak (WSOS-FLP-003/004) ----------------

test('flatpak: permissions review, system override reset and pruning only through flatpak --unused', async () => {
  const w = world((cmd, args) => {
    if (args[0] === 'info') return { stdout: '[Context]\nshared=network;ipc;\nfilesystems=home;\n\n[Session Bus Policy]\norg.freedesktop.Notifications=talk\n' };
    if (args[0] === 'override') return { stdout: '[Context]\nfilesystems=!home;\n' };
    if (args[0] === 'uninstall') return { stdout: '\n        ID                               Branch    Op\n 1.     org.gnome.Platform               46        r\n 2.     org.gnome.Platform.Locale        46        r\n\nUninstall complete.\n' };
  });
  const p = await w.svc.appPermissions('flatpak:org.gimp.GIMP');
  assert.deepEqual(p.permissions, ['shared=network;ipc;', 'filesystems=home;']);
  assert.deepEqual(p.broad, ['shared=network;ipc;', 'filesystems=home;']);
  assert.deepEqual(p.overrides, ['filesystems=!home;']);
  assert.throws(() => w.svc.resetAppPermissions(1000, 'flatpak:--all'), { code: 'InvalidArgs' });
  assert.equal((await w.done(w.svc.resetAppPermissions(1000, 'flatpak:org.gimp.GIMP'))).state, 'success');
  assert.ok(w.calls.includes('flatpak override --system --reset org.gimp.GIMP'));
  assert.equal((await w.done(w.svc.pruneRuntimes(1000))).state, 'success');
  assert.ok(w.calls.includes('flatpak uninstall --system --unused --noninteractive -y'));
  assert.ok(!w.calls.some((c) => /flatpak uninstall .*org\.gnome\.Platform/.test(c)), 'never names runtimes itself');
  assert.deepEqual(w.audit.find(([e]) => e === 'flatpak_runtimes_pruned')![1].removed, ['org.gnome.Platform//46', 'org.gnome.Platform.Locale//46']);
});

test('adding a Flatpak remote needs policy permission for that exact name and URL (WSOS-FLP-001)', async () => {
  const url = 'https://flatpak.example.lk/corp.flatpakrepo';
  const unmanaged = world();
  assert.throws(() => unmanaged.svc.addRemote(1000, 'corp', url), (e: { code?: string }) => e.code === 'NotAuthorized');
  const policy = { approved_remotes: ['flathub', 'corp'], flatpak_remotes: { corp: url } };
  const w = world(undefined, { policy: () => policy });
  assert.throws(() => w.svc.addRemote(1000, 'corp', 'https://evil.example/corp.flatpakrepo'), (e: { code?: string }) => e.code === 'NotAuthorized');
  assert.throws(() => w.svc.addRemote(1000, 'other', url), (e: { code?: string }) => e.code === 'NotAuthorized');
  assert.throws(() => w.svc.addRemote(1000, 'corp', 'http://flatpak.example.lk/corp.flatpakrepo'), (e: { code?: string }) => e.code === 'InvalidArgs');
  assert.throws(() => w.svc.addRemote(1000, '--no-gpg-verify', url), (e: { code?: string }) => e.code === 'InvalidArgs');
  assert.deepEqual(w.calls, []);
  assert.equal(w.audit.filter(([e]) => e === 'flatpak_remote_refused').length, 2);
  assert.equal((await w.done(w.svc.addRemote(1000, 'corp', url))).state, 'success');
  assert.deepEqual(w.calls, [`flatpak remote-add --system --if-not-exists --from corp ${url}`]);
  assert.ok(w.audit.some(([e]) => e === 'flatpak_remote_added'));
});

// ---------------- offline bundles (WSOS-AUP-010) ----------------

function bundleWorld(installed = '1.0.0', key = releaseKey(), script: Script = () => undefined) {
  const root = tmp('ws-media-');
  const w = world(script, { release: { keys: key.keys, arch: 'amd64', installed: () => installed }, bundleRoots: [root + '/'] });
  return { ...w, root, key };
}

test('bundle: signed manifest and package hashes verified; installs offline with apt from the extracted copy', async () => {
  const b = bundleWorld();
  const file = makeBundle(b.root, { sign: b.key.signFlat });
  const info = b.svc.inspectBundle(file);
  assert.deepEqual(info, { release_id: 'rel-1.1.0', version: '1.1.0', packages: 2, bytes: 14, critical: false, verified: true });
  const job = await b.done(b.svc.installBundle(1000, file));
  assert.equal(job.state, 'success', job.error);
  const dir = join(b.env.spool!, 'bundle');
  const debs = [join(dir, 'worksuite-desktop_1.1.0_amd64.deb'), join(dir, 'worksuite-shell_1.1.0_amd64.deb')].join(' ');
  assert.ok(b.calls.includes(`apt-get -y -q --no-download -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold install -- ${debs}`), b.calls.join('\n'));
  assert.ok(b.audit.some(([e]) => e === 'bundle_installed'));
  assert.ok(!existsSync(dir), 'extracted packages cleaned up');
});

test('bundle: foreign key, edited package, extra member, wrong arch, downgrade and outside paths are refused', async () => {
  const b = bundleWorld();
  const foreign = releaseKey('ws-other');
  assert.throws(() => b.svc.inspectBundle(makeBundle(b.root, { sign: foreign.signFlat })), { code: 'SignatureInvalid' });
  const edited = bundleWorld();
  assert.throws(() => edited.svc.inspectBundle(makeBundle(edited.root, { sign: edited.key.signFlat, tamper: (r) => writeFileSync(join(r, 'pool/worksuite-shell_1.1.0_amd64.deb'), 'deb TWO') })), { code: 'SignatureInvalid' });
  const extra = bundleWorld();
  assert.throws(() => extra.svc.inspectBundle(makeBundle(extra.root, { sign: extra.key.signFlat, tamper: (r) => writeFileSync(join(r, 'pool/evil_1_amd64.deb'), 'x') })), { code: 'SignatureInvalid' });
  const altered = bundleWorld();
  assert.throws(() => altered.svc.inspectBundle(makeBundle(altered.root, { sign: altered.key.signFlat, tamper: (r) => {
    const m = JSON.parse(readFileSync(join(r, 'manifest.json'), 'utf8')); m.critical = true; writeFileSync(join(r, 'manifest.json'), JSON.stringify(m));
  } })), { code: 'SignatureInvalid' });
  const arm = bundleWorld();
  assert.throws(() => arm.svc.inspectBundle(makeBundle(arm.root, { sign: arm.key.signFlat, arch: 'arm64' })), { code: 'ArchMismatch' });
  const newer = bundleWorld('1.2.0');
  assert.throws(() => newer.svc.inspectBundle(makeBundle(newer.root, { sign: newer.key.signFlat })), /downgrade/);
  const rollback = bundleWorld('1.2.0');
  rollback.svc.inspectBundle(makeBundle(rollback.root, { sign: rollback.key.signFlat, manifest: { rollback_directive: { from_version: '1.2.0', reason: 'regression' } } }));
  const out = bundleWorld();
  const elsewhere = makeBundle(tmp('ws-elsewhere-'), { sign: out.key.signFlat });
  assert.throws(() => out.svc.inspectBundle(elsewhere), /removable media/);
  assert.throws(() => out.svc.installBundle(1000, '/etc/passwd'), { code: 'InvalidArgs' });
});

test('bundle: the copy is re-verified at install time, so a stick swapped after inspection is refused', async () => {
  const b = bundleWorld();
  const file = makeBundle(b.root, { sign: b.key.signFlat });
  b.svc.inspectBundle(file);
  makeBundle(b.root, { sign: b.key.signFlat, tamper: (r) => writeFileSync(join(r, 'pool/worksuite-shell_1.1.0_amd64.deb'), 'deb TWO') });
  const job = await b.done(b.svc.installBundle(1000, file));
  assert.equal(job.state, 'failed');
  assert.ok(!b.calls.some((c) => c.startsWith('apt-get -y')));
  assert.ok(b.audit.some(([e]) => e === 'bundle_rejected'));
});

// ---------------- resumable downloads (WSOS-AUP-008) ----------------

test('update download retries and keeps partial files; never cleans the apt cache', async () => {
  let n = 0;
  const w = world((cmd, args) => {
    if (cmd === 'apt-get' && args.includes('--download-only')) return ++n < 3 ? { code: 100, stderr: 'E: Failed to fetch http://x/a.deb  Connection reset by peer\n' } : undefined;
  });
  const job = await w.done(w.svc.applyUpdate(0, ''));
  assert.equal(job.state, 'success', job.error);
  assert.equal(n, 3);
  assert.ok(w.calls.filter((c) => c === 'apt-get -y -q -o Acquire::Retries=3 --download-only full-upgrade').length === 3);
  assert.ok(!w.calls.some((c) => /apt-get (clean|autoclean)/.test(c)));
  assert.equal(w.audit.filter(([e]) => e === 'download_interrupted').length, 2);

  const down = world((cmd, args) => (cmd === 'apt-get' && args.includes('--download-only') ? { code: 100, stderr: 'E: Failed to fetch\n' } : undefined));
  const failed = await down.done(down.svc.applyUpdate(0, ''));
  assert.match(failed.error!, /^download interrupted/);
  assert.ok(!down.calls.some((c) => c.includes('full-upgrade') && c.startsWith('apt-get -y -q -o Dpkg')), 'nothing applied without a complete download');
});

