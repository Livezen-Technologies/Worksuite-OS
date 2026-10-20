// Update Manager (#17) and Software Management (#18) on the device: update history, application updates, the
// bandwidth limit, update checks on connecting, release notes and major upgrades, software permissions and requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Coordinator, RECHECK_ON_CONNECT_MS, type CoordinatorEnv } from '../src/coordinator.ts';
import { HISTORY_MAX, UpdateHistory, type HistoryEntry } from '../src/history.ts';
import { loadCatalog, requestApp, type CatalogEnv } from '../src/catalog.ts';
import { PackageService, type DevicePolicy, type Env, type Job, type RunResult } from '../src/service.ts';
import { canonical, decide, type Manifest } from '../src/updates.ts';

const SOURCES: [string, string][] = [['/etc/apt/sources.list.d/debian.sources', 'Types: deb\nURIs: https://deb.debian.org/debian\nSuites: trixie\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n']];
const USER = 1000;

function world(o: { policy?: DevicePolicy | null; script?: (cmd: string, args: string[]) => Partial<RunResult> | undefined } = {}) {
  const calls: string[] = [];
  let saved: HistoryEntry[] = [];
  const history = new UpdateHistory({ load: () => saved, save: (e) => { saved = e; } });
  let t = 1_000;
  const env: Env = {
    runner: { async run(cmd, args) { calls.push([cmd, ...args].join(' ')); return { code: 0, stdout: '', stderr: '', ...o.script?.(cmd, args) }; } },
    policy: () => o.policy ?? null, sources: () => SOURCES, power: () => ({ ac: true, battery: null }), freeBytes: () => 1e12, audit() {},
    sleep: async () => {}, history, now: () => (t += 1000),
  };
  const svc = new PackageService(env);
  const done = (id: number) => new Promise<Job>((resolve) => { const f = (j: Job) => { if (j.id === id) { svc.off('finished', f); resolve(j); } }; svc.on('finished', f); });
  return { svc, calls, history, saved: () => saved, done };
}

test('update history: OS updates are recorded with version and outcome; queued jobs show as pending', async () => {
  const w = world({ script: (cmd, args) => (cmd === 'test' ? { code: 0 } : cmd === 'apt-get' && args.includes('full-upgrade') && args.includes('-y') && !args.includes('--download-only') && w.calls.filter((c) => c.includes('full-upgrade') && c.includes('-y -q -o Dpkg')).length > 1 ? { code: 100, stderr: 'E: Sub-process /usr/bin/dpkg returned an error code (1)' } : undefined) });
  const a = w.svc.applyUpdate(0, 'os-1.4.0', { version: '1.4.0' });
  const b = w.svc.applyUpdate(0, 'os-1.4.1', { version: '1.4.1' });
  const pend = w.svc.updateHistory();
  assert.deepEqual(pend.pending.map((p) => [p.kind, p.version, p.result]), [['os', '1.4.0', 'pending'], ['os', '1.4.1', 'pending']]);
  await w.done(a); await w.done(b);
  const { pending, entries } = w.svc.updateHistory();
  assert.equal(pending.length, 0);
  assert.deepEqual(entries.map((e) => [e.title, e.version, e.result, e.reboot_required]), [['WorkSuite OS', '1.4.1', 'failed', false], ['WorkSuite OS', '1.4.0', 'success', true]]);
  assert.match(entries[0].error!, /apt-get/);   // kept for administrators' diagnostics
  assert.equal(w.saved().length, 2);              // persisted
  // Installs and repairs are not update history.
  await w.done(w.svc.install(0, 'flatpak', 'flatpak:org.gimp.GIMP'));
  assert.equal(w.svc.updateHistory().entries.length, 2);
});

test('update history store: reloads, drops malformed entries, keeps the newest HISTORY_MAX', () => {
  const e = (i: number): HistoryEntry => ({ id: `e${i}`, kind: 'app', title: `app ${i}`, version: null, result: 'success', error: null, started_at: i, finished_at: i, reboot_required: false });
  let saved: unknown = [e(1), { id: 'bad' }, 'junk'];
  const h = new UpdateHistory({ load: () => saved as HistoryEntry[], save: (x) => { saved = x; } });
  assert.deepEqual(h.list().map((x) => x.id), ['e1']);
  for (let i = 2; i <= HISTORY_MAX + 10; i++) h.add(e(i));
  assert.equal((saved as HistoryEntry[]).length, HISTORY_MAX);
  assert.equal(h.list(1)[0].id, `e${HISTORY_MAX + 10}`);
  assert.doesNotThrow(() => new UpdateHistory({ load: () => { throw new Error('ENOENT'); }, save: () => {} }));
});

test('application updates: listed from Flatpak, updated in the queue and recorded; policy can reserve updates', async () => {
  const w = world({ script: (cmd, args) => (cmd === 'flatpak' && args[0] === 'remote-ls'
    ? { stdout: 'org.gimp.GIMP\tGIMP\t2.10.40\t120.5 MB\nnot an app\t\t\t\norg.mozilla.firefox\tFirefox\t131.0\t80 MB\n' } : undefined) });
  assert.deepEqual(await w.svc.appUpdates(), [
    { id: 'flatpak:org.gimp.GIMP', name: 'GIMP', version: '2.10.40', download_size: '120.5 MB' },
    { id: 'flatpak:org.mozilla.firefox', name: 'Firefox', version: '131.0', download_size: '80 MB' },
  ]);
  const j = await w.done(w.svc.updateApps(USER, ['flatpak:org.gimp.GIMP']));
  assert.equal(j.state, 'success');
  assert.ok(w.calls.includes('flatpak update --system --noninteractive -y org.gimp.GIMP'));
  assert.deepEqual(w.svc.updateHistory().entries.map((e) => [e.kind, e.title, e.result]), [['app', 'org.gimp.GIMP', 'success']]);
  assert.throws(() => w.svc.updateApps(USER, ['flatpak:--help']), /catalog|InvalidArgs|name/i);

  const managed = world({ policy: { software_update: false } });
  assert.throws(() => managed.svc.updateApps(USER, []), (e: Error & { code?: string }) => e.code === 'NotAuthorized');
  assert.equal((await managed.done(managed.svc.updateApps(0, []))).state, 'success');   // the organization (root) still can
});

test('software permissions: block, any, and uninstall restrictions apply to people, not to the organization', async () => {
  const blocked = world({ policy: { software_install: 'block', app_allowlist: ['flatpak:org.gimp.GIMP'] } });
  assert.throws(() => blocked.svc.install(USER, 'flatpak', 'flatpak:org.gimp.GIMP'), (e: Error & { code?: string }) => e.code === 'NotAuthorized');
  assert.equal((await blocked.done(blocked.svc.install(0, 'flatpak', 'flatpak:org.gimp.GIMP'))).state, 'success');

  const approved = world({ policy: { software_install: 'approved', app_allowlist: ['flatpak:org.gimp.GIMP'] } });
  assert.throws(() => approved.svc.install(USER, 'flatpak', 'flatpak:org.inkscape.Inkscape'), (e: Error & { code?: string }) => e.code === 'NotInCatalog');
  const any = world({ policy: { software_install: 'any', app_allowlist: ['flatpak:org.gimp.GIMP'] } });
  assert.equal((await any.done(any.svc.install(USER, 'flatpak', 'flatpak:org.inkscape.Inkscape'))).state, 'success');
  assert.equal((await any.done(any.svc.install(USER, 'apt', 'apt:inkscape'))).state, 'success');   // apt re-checks in the lock as the same person
  // 'any' never widens what root installs for the organization: commands are checked against the allowlist.
  assert.throws(() => any.svc.install(0, 'flatpak', 'flatpak:org.inkscape.Inkscape'), (e: Error & { code?: string }) => e.code === 'NotInCatalog');

  const noRemove = world({ policy: { software_uninstall: false } });
  assert.throws(() => noRemove.svc.remove(USER, 'flatpak', 'flatpak:org.gimp.GIMP'), (e: Error & { code?: string }) => e.code === 'NotAuthorized');
  assert.equal((await noRemove.done(noRemove.svc.remove(0, 'flatpak', 'flatpak:org.gimp.GIMP'))).state, 'success');
  // The critical set stays protected for everyone.
  assert.throws(() => noRemove.svc.remove(0, 'apt', 'apt:systemd'), (e: Error & { code?: string }) => e.code === 'Protected');
});

test('bandwidth limit from policy is passed to apt downloads', async () => {
  const w = world({ policy: { update_bandwidth_kbps: 512 } });
  await w.done(w.svc.applyUpdate(0, ''));
  const dl = w.calls.find((c) => c.includes('--download-only'))!;
  assert.match(dl, /Acquire::http::Dl-Limit=512/);
  assert.match(dl, /Acquire::https::Dl-Limit=512/);
  const free = world();
  await free.done(free.svc.applyUpdate(0, ''));
  assert.doesNotMatch(free.calls.find((c) => c.includes('--download-only'))!, /Dl-Limit/);
});

// ---- coordinator: checks on connecting, notes, major upgrades ----

const keys = generateKeyPairSync('ed25519');
const signed = (m: Record<string, unknown>) => ({ ...m, signature: `r1:${sign(null, Buffer.from(canonical(m)), keys.privateKey).toString('base64')}` });
const base = { release_id: 'os-1.0.2', version: '1.0.2', min_version: '1.0.0', ring: 'stable', arch: 'amd64', rollout_percent: 100, state: 'active' };

function coord(o: { manifest?: Record<string, unknown>; offline?: boolean; idle?: boolean; policy?: ReturnType<CoordinatorEnv['policy']> } = {}) {
  let now = new Date(2026, 9, 15, 14).getTime();
  const gets: string[] = [];
  let offline = o.offline ?? false;
  const svc = new PackageService({ runner: { async run() { return { code: 0, stdout: '', stderr: '' }; } }, policy: () => null, sources: () => [], power: () => ({ ac: true, battery: null }), freeBytes: () => 1e12, audit() {} });
  const env: CoordinatorEnv = {
    fetchJson: async (url) => { gets.push(url); if (offline) throw new Error('fetch failed'); return signed({ ...base, ...o.manifest }); },
    keys: (id) => (id === 'r1' ? keys.publicKey : undefined), policy: () => o.policy ?? null, arch: 'amd64',
    installedVersion: () => '1.0.1', deviceKey: () => 'm', idle: async () => o.idle ?? false, metered: async () => false,
    setSuite() {}, load: () => ({ deferrals: {} }), save() {}, report: async () => {}, reboot: async () => {}, now: () => now, audit() {},
  };
  return { c: new Coordinator(env, svc), gets, advance: (ms: number) => { now += ms; }, online: () => { offline = false; } };
}

test('connecting to the internet checks for updates once, again only when stale or after an offline failure', async () => {
  const w = coord({ offline: true });
  assert.equal(await w.c.connectivityChanged(), true);            // never checked yet
  assert.equal(w.c.status.state, 'failed');
  w.online();
  assert.equal(await w.c.connectivityChanged(), true);            // the last check failed offline
  assert.equal(w.c.status.state, 'waiting');                      // not idle: waits
  assert.equal(await w.c.connectivityChanged(), false);           // fresh: no repeated check
  assert.equal(w.gets.length, 2);
  w.advance(RECHECK_ON_CONNECT_MS);
  assert.equal(await w.c.connectivityChanged(), true);
  assert.equal(w.gets.length, 3);
});

test('release notes, sizes and the upgrade flag reach the status; major upgrades wait outside the window', async () => {
  const w = coord({ idle: true, manifest: { upgrade: true, notes: 'New Start menu.\nFaster sign-in.', notes_url: 'https://download.worksuitecloud.com/notes/1.0.2', download_bytes: 734_003_200, installed_bytes: 2_000_000_000 } });
  const d = await w.c.check();
  assert.deepEqual(d, { action: 'wait', reason: 'major_upgrade' });   // idle is not enough for a major upgrade
  assert.equal(w.c.status.notes, 'New Start menu.\nFaster sign-in.');
  assert.equal(w.c.status.notes_url, 'https://download.worksuitecloud.com/notes/1.0.2');
  assert.equal(w.c.status.download_bytes, 734_003_200);
  assert.equal(w.c.status.upgrade, true);
  const bad = coord({ manifest: { notes_url: 'javascript:alert(1)' } });
  await bad.c.check();
  assert.equal(bad.c.status.notes_url, null);

  const m = { ...base, upgrade: true, signature: 'x' } as unknown as Manifest;
  const at = (h: number) => decide({ manifest: m, installed: '1.0.1', managed: true, mode: 'automatic', window: '02:00-04:00', deviceKey: 'k', now: new Date(2026, 9, 15, h), idle: true, metered: false, deferrals: 0 });
  assert.deepEqual(at(3), { action: 'install', reason: 'automatic' });
  assert.deepEqual(at(14), { action: 'wait', reason: 'major_upgrade' });
});

// ---- Software Management: requests from the App Center ----

function catalogEnv(policy: DevicePolicy | null, requests: unknown[] = []) {
  const posts: { url: string; body: unknown }[] = [];
  const env: CatalogEnv = {
    server: () => ({ host: 'ws.example.com', token: 'dev-token' }),
    async fetchJson(url) {
      const u = new URL(url);
      if (u.pathname === '/desktop/v1/os/software-requests') return { items: requests };
      return u.searchParams.get('arch') === 'amd64'
        ? { items: [{ id: 'flatpak:org.gimp.GIMP', source: 'flatpak', name: 'GIMP', arches: ['amd64'] }, { id: 'apt:inkscape', source: 'apt', name: 'Inkscape', arches: ['amd64'] }], next_cursor: null }
        : { items: [], next_cursor: null };
    },
    async postJson(url, _h, body) { posts.push({ url, body }); return { id: 'r1', state: 'pending', ...(body as object) }; },
    arch: 'amd64', policy: () => policy, now: () => 1,
    runner: { async run() { return { code: 0, stdout: '', stderr: '' }; } },
  };
  return { env, posts };
}

test('catalog: request mode marks unapproved apps requestable and shows this user\'s requests', async () => {
  const { env } = catalogEnv({ software_install: 'request', app_allowlist: ['flatpak:org.gimp.GIMP'] }, [
    { id: 'q1', catalog_id: 'apt:inkscape', username: 'uma', state: 'rejected', note: 'Use the web app', at: 5 },
    { id: 'q0', catalog_id: 'apt:inkscape', username: 'uma', state: 'pending', note: null, at: 2 },
    { id: 'q2', catalog_id: 'apt:inkscape', username: 'someone', state: 'approved', note: null, at: 9 },
  ]);
  const r = await loadCatalog(env, 'uma');
  assert.equal(r.state, 'ok');
  const by = Object.fromEntries(r.items.map((i) => [i.id, i]));
  assert.equal(by['flatpak:org.gimp.GIMP'].requestable, false);
  assert.equal(by['apt:inkscape'].requestable, true);
  assert.deepEqual(by['apt:inkscape'].request, { id: 'q1', state: 'rejected', note: 'Use the web app', at: 5 });

  const blockedAll = await loadCatalog(catalogEnv({ software_install: 'block' }).env);
  assert.ok(blockedAll.items.every((i) => i.blocked_reason === 'Your organization installs apps for you' && !i.requestable));
  const anyMode = await loadCatalog(catalogEnv({ software_install: 'any', app_allowlist: ['flatpak:org.gimp.GIMP'] }).env);
  assert.ok(anyMode.items.every((i) => i.blocked_reason === null));
});

test('requestApp posts with the device credential, only in request mode, with a cleaned reason', async () => {
  const { env, posts } = catalogEnv({ software_install: 'request' });
  const r = await requestApp(env, 'uma', 'apt:inkscape', ' For\u0007 diagrams ');
  assert.equal(r.state, 'pending');
  assert.deepEqual(posts, [{ url: 'https://ws.example.com/desktop/v1/os/software-requests', body: { catalog_id: 'apt:inkscape', username: 'uma', reason: 'For  diagrams' } }]);
  await assert.rejects(requestApp(env, 'uma', 'apt:../x', ''), (e: Error & { code?: string }) => e.code === 'InvalidArgs');
  await assert.rejects(requestApp(catalogEnv({ software_install: 'approved' }).env, 'uma', 'apt:inkscape', ''), (e: Error & { code?: string }) => e.code === 'NotAuthorized');
  await assert.rejects(requestApp({ ...env, server: () => null }, 'uma', 'apt:inkscape', ''), (e: Error & { code?: string }) => e.code === 'PreconditionFailed');
});
