// worksuite-package-service: root daemon owning lk.worksuite.PackageService1 on the system bus.
import { execFile, execFileSync } from 'node:child_process';
import { createPublicKey, randomUUID, type KeyObject } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import dbus from 'dbus-next';
import { busAuthority, loadIntrospection, NAME, serve } from './dbus.ts';
import { PackageService, type DevicePolicy, type Env, type RunResult } from './service.ts';
import { Coordinator, LOCAL_CONFIG, updateHost, type CoordinatorEnv } from './coordinator.ts';
import { loadCatalog } from './catalog.ts';
import { gunzipSync } from 'node:zlib';
import { DriverManager, firmwarePresent, parseModulesAlias, scanSysfs, type DriverEnv } from './driverscan.ts';

const POLICY = '/run/worksuite-device-agent/policy.json';
const AUDIT_LOG = '/var/log/worksuite/package-service-audit.log';
const XML = '/usr/share/dbus-1/interfaces/lk.worksuite.PackageService1.xml';

/** Fixed executables, argument vectors, no shell; non-interactive and C locale so output parses (WSOS-SEC-007). */
function run(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      timeout: 2 * 60 * 60_000, maxBuffer: 64 * 1024 * 1024,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C.UTF-8', DEBIAN_FRONTEND: 'noninteractive', APT_LISTCHANGES_FRONTEND: 'none' },
    }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 127) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

const readOr = (p: string) => { try { return readFileSync(p, 'utf8').trim(); } catch { return ''; } };

export const linuxEnv: Env = {
  runner: { run },
  policy: () => { try { return JSON.parse(readFileSync(POLICY, 'utf8')) as DevicePolicy; } catch { return null; } },
  sources: () => {
    const files: [string, string][] = [];
    if (existsSync('/etc/apt/sources.list')) files.push(['/etc/apt/sources.list', readOr('/etc/apt/sources.list')]);
    const d = '/etc/apt/sources.list.d';
    if (existsSync(d)) for (const f of readdirSync(d)) if (/\.(list|sources)$/.test(f)) files.push([join(d, f), readOr(join(d, f))]);
    return files;
  },
  // The Update Center the coordinator uses (policy update_mirror > /etc/worksuite/updates.json > default) is an approved
  // APT source too, so pointing worksuite.sources at it doesn't lock APT.
  updateHosts: () => {
    let local: { update_host?: string } = {};
    try { local = JSON.parse(readFileSync('/etc/worksuite/updates.json', 'utf8')); } catch { /* defaults */ }
    const p = linuxEnv.policy() as { update_mirror?: string } | null;
    return [new URL(updateHost(p?.update_mirror, local.update_host)).host];
  },
  power: () => {
    const base = '/sys/class/power_supply';
    const supplies = existsSync(base) ? readdirSync(base).map((n) => ({ type: readOr(join(base, n, 'type')), dir: join(base, n) })) : [];
    const mains = supplies.filter((x) => x.type === 'Mains');
    const bat = supplies.find((x) => x.type === 'Battery');
    const battery = bat ? Number(readOr(join(bat.dir, 'capacity'))) || 0 : null;
    // Desktops have no battery: treat as on AC.
    const ac = mains.some((m) => readOr(join(m.dir, 'online')) === '1') || battery === null;
    return { ac, battery };
  },
  freeBytes: () => { const s = statfsSync('/'); return s.bavail * s.bsize; },
  audit: (event, fields) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), service: 'worksuite-package-service', event, ...fields });
    process.stdout.write(line + '\n');
    try { appendFileSync(AUDIT_LOG, line + '\n', { mode: 0o600 }); } catch { /* journald has it */ }
  },
};

const RELEASE_KEYS = '/usr/share/worksuite/keys/release';        // worksuite-archive-keyring
const STATE = '/var/lib/worksuite-package-service/updates.json';
const AGENT_STATUS = '/run/worksuite-device-agent/status.json';
const DEVICE_TOKEN = '/run/worksuite-device-agent/device-token';
const WORKSUITE_SOURCES = '/etc/apt/sources.list.d/worksuite.sources';

function loadKeys(dir: string): (id: string) => KeyObject | undefined {
  const m = new Map<string, KeyObject>();
  if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.endsWith('.pem')) m.set(f.slice(0, -4), createPublicKey(readFileSync(join(dir, f))));
  return (id) => m.get(id);
}
const busctlGet = (args: string[]) => new Promise<string>((resolve) => execFile('busctl', ['--system', 'get-property', ...args], { timeout: 5000 }, (_e, out) => resolve(String(out ?? '').trim())));
const pkgVersion = (name: string) => { try { return execFileSync('dpkg-query', ['-W', '-f=${Version}', name], { encoding: 'utf8' }).trim() || 'unknown'; } catch { return 'unknown'; } };

const UPDATE_STATUS_DIR = '/run/worksuite-package-service';

/** Point worksuite.sources (deb822) at `repo` (an https …/os/apt URL) and `suite`; keeps Signed-By. */
export function rewriteSources(text: string, suite: string, repo?: string): string {
  let next = text.replace(/^Suites:.*$/m, `Suites: ${suite}`);
  if (repo && /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9._/-]*$/.test(repo)) next = next.replace(/^URIs:.*$/m, `URIs: ${repo}`);
  return next;
}

export function coordinatorEnv(): CoordinatorEnv {
  return {
    async fetchJson(url) {
      const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    keys: loadKeys(RELEASE_KEYS),
    policy: () => linuxEnv.policy() as ReturnType<CoordinatorEnv['policy']>,
    arch: process.arch === 'arm64' ? 'arm64' : 'amd64',
    installedVersion: () => pkgVersion('worksuite-desktop'),
    deviceKey: () => readOr('/etc/machine-id') || 'unknown',
    // logind's IdleHint: true when every session is idle or locked.
    idle: async () => (await busctlGet(['org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager', 'IdleHint'])) === 'b true',
    // NetworkManager Metered: 1 = yes, 3 = guess-yes.
    metered: async () => /^u [13]$/.test(await busctlGet(['org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager', 'org.freedesktop.NetworkManager', 'Metered'])),
    config: () => { try { return JSON.parse(readFileSync(LOCAL_CONFIG, 'utf8')); } catch { return null; } },
    setSuite(suite, repo) {
      if (!existsSync(WORKSUITE_SOURCES)) return;
      const text = readFileSync(WORKSUITE_SOURCES, 'utf8');
      const next = rewriteSources(text, suite, repo);
      if (next !== text) { writeFileSync(WORKSUITE_SOURCES + '.tmp', next, { mode: 0o644 }); renameSync(WORKSUITE_SOURCES + '.tmp', WORKSUITE_SOURCES); }
    },
    // WSOS-UPD-001: the WorkSuite system units must still be active after an update.
    async healthCheck() {
      const units = ['worksuite-package-service.service', 'worksuite-device-agent.service', 'greetd.service'];
      const failed: string[] = [];
      for (const u of units) {
        const r = await linuxEnv.runner.run('systemctl', ['is-failed', '--quiet', u]);
        if (r.code === 0) failed.push(`unit_failed:${u}`);
      }
      return failed;
    },
    load: () => { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return { deferrals: {} }; } },
    save: (s) => { mkdirSync('/var/lib/worksuite-package-service', { recursive: true }); writeFileSync(STATE + '.tmp', JSON.stringify(s), { mode: 0o600 }); renameSync(STATE + '.tmp', STATE); },
    // WSOS-UPD-005: only managed devices report (they have a server and a device credential).
    async report(r) {
      let server = ''; try { server = JSON.parse(readFileSync(AGENT_STATUS, 'utf8')).server ?? ''; } catch { /* unmanaged */ }
      const token = readOr(DEVICE_TOKEN);
      if (!server || !token) return;
      const body = { ...r, os_version: pkgVersion('worksuite-desktop'), shell_version: pkgVersion('worksuite-shell'), kernel_version: release() };
      const res = await fetch(new URL('/desktop/v1/os/update-results', `https://${server}`), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { 'content-type': 'application/json', 'x-ws-device': token, 'idempotency-key': randomUUID(), 'x-request-id': randomUUID() },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    reboot: () => new Promise((resolve) => execFile('systemctl', ['reboot'], () => resolve())),
    now: () => Date.now(),
    // WSOS-AUP-012: signed licence for this device (managed devices only).
    async licence() {
      const e = enrollment();
      return e ? getJson(new URL('/desktop/v1/os/licence', `https://${e.host}`).toString(), { 'x-ws-device': e.token }) : null;
    },
    deviceId: () => enrollment()?.deviceId ?? null,
    audit: linuxEnv.audit,
  };
}

const ARCH = process.arch === 'arm64' ? 'arm64' : 'amd64';

/** Enrolled server and device credential from the device agent; null when unmanaged. */
function enrollment(): { host: string; token: string; deviceId: string | null } | null {
  let st: { server?: string; device_id?: string } = {};
  try { st = JSON.parse(readFileSync(AGENT_STATUS, 'utf8')); } catch { return null; }
  const token = readOr(DEVICE_TOKEN);
  return st.server && token ? { host: st.server, token, deviceId: st.device_id ?? null } : null;
}

async function getJson(url: string, headers: Record<string, string> = {}) {
  const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { ...headers, 'x-request-id': randomUUID() } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const DRIVERS_STATE = '/var/lib/worksuite-package-service/drivers.json';
const SECURE_BOOT_VAR = '/sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-e0c98e08a90c';

export function driverEnv(svc: PackageService): DriverEnv {
  let aliases: ReturnType<typeof parseModulesAlias> | null = null;
  const installed = (p: string) => { try { return execFileSync('dpkg-query', ['-W', '-f=${db:Status-Abbrev}', p], { encoding: 'utf8' }).startsWith('ii'); } catch { return false; } };
  return {
    run: linuxEnv.runner.run,
    devices: () => {
      aliases ??= parseModulesAlias(readOr(`/lib/modules/${release()}/modules.alias`));
      return scanSysfs('/', aliases);
    },
    kernelLog: async () => (await run('journalctl', ['-k', '-b', '-o', 'cat', '--no-pager', '-q'])).stdout,
    firmwarePresent: (f) => firmwarePresent(f),
    // apt-file-like lookup: Debian's non-free-firmware Contents index (signed archive host; small, ~30 kB).
    async contents() {
      const base = 'https://deb.debian.org/debian/dists/trixie/non-free-firmware/';
      const parts = await Promise.all(['Contents-all.gz', `Contents-${ARCH}.gz`].map(async (f) => {
        const r = await fetch(base + f, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8');
      }));
      return parts.join('\n');
    },
    installed,
    // The published policy carries the kiosk block for the devices it names; this device's id is in the agent's status.
    policy: () => {
      const p = linuxEnv.policy() as (ReturnType<DriverEnv['policy']> & { kiosk?: { enabled?: boolean; devices?: unknown } }) | null;
      if (!p) return null;
      const id = enrollment()?.deviceId;
      const kiosk = p.kiosk?.enabled === true && Array.isArray(p.kiosk.devices) && !!id && p.kiosk.devices.includes(id);
      return { ...p, kiosk: { enabled: kiosk } };
    },
    metered: async () => /^u [13]$/.test(await busctlGet(['org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager', 'org.freedesktop.NetworkManager', 'Metered'])),
    secureBoot: () => { try { const b = readFileSync(SECURE_BOOT_VAR); return b[b.length - 1] === 1; } catch { return false; } },
    arch: ARCH,
    now: Date.now,
    load: () => { try { return JSON.parse(readFileSync(DRIVERS_STATE, 'utf8')); } catch { return {}; } },
    save: (st) => { mkdirSync('/var/lib/worksuite-package-service', { recursive: true }); writeFileSync(DRIVERS_STATE + '.tmp', JSON.stringify(st), { mode: 0o600 }); renameSync(DRIVERS_STATE + '.tmp', DRIVERS_STATE); },
    audit: linuxEnv.audit,
    writeFile: (p, text) => writeFileSync(p, text, { mode: 0o600 }),
    enqueue: (caller, body) => svc.driverJob(caller, body),
  };
}

async function main() {
  const releaseKeys = loadKeys(RELEASE_KEYS);
  const svc = new PackageService({ ...linuxEnv, release: { keys: releaseKeys, arch: ARCH, installed: () => pkgVersion('worksuite-desktop') } });
  await svc.detectInterrupted();          // WSOS-APT-006: surfaced as State=interrupted for the shell
  const bus = dbus.systemBus();
  const coordinator = new Coordinator(coordinatorEnv(), svc);
  // WSOS-MDM-001: the device agent reports the coordinator's state in its heartbeat and inventory.
  coordinator.on('status', (st) => {
    try {
      mkdirSync(UPDATE_STATUS_DIR, { recursive: true, mode: 0o755 });
      writeFileSync(UPDATE_STATUS_DIR + '/update-status.json.tmp', JSON.stringify(st), { mode: 0o644 });
      renameSync(UPDATE_STATUS_DIR + '/update-status.json.tmp', UPDATE_STATUS_DIR + '/update-status.json');
    } catch { /* status is informational */ }
  });
  const drivers = new DriverManager(driverEnv(svc));
  serve(bus, svc, busAuthority(bus), loadIntrospection(XML), coordinator, {
    drivers,
    catalog: () => loadCatalog({ server: enrollment, fetchJson: getJson, arch: ARCH, policy: linuxEnv.policy, runner: linuxEnv.runner, now: Date.now }),
  });
  coordinator.start();
  await bus.requestName(NAME, dbus.NameFlag.DO_NOT_QUEUE);
  linuxEnv.audit('started', { state: svc.state() });
  // GPU rollback (nvidia → nouveau) when the first boot after installing it didn't bring up the greeter; then the
  // daily driver check (the timer starts this service 2 min after boot; NetworkManager's dispatcher on connectivity).
  setTimeout(() => {
    void (async () => {
      const greeter = await run('systemctl', ['is-active', '--quiet', 'greetd.service']);
      await drivers.gpuBootCheck(greeter.code === 0, existsSync('/sys/module/nvidia'));
      await drivers.check('timer');
    })().catch((e) => linuxEnv.audit('drivers_check_failed', { error: String(e) }));
  }, 60_000).unref();
}

if (import.meta.main) main().catch((e) => { process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), service: 'worksuite-package-service', level: 'error', event: 'fatal', error: String(e?.stack ?? e) }) + '\n'); process.exit(1); });
