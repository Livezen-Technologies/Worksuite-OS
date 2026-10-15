// worksuite-package-service: root daemon owning lk.worksuite.PackageService1 on the system bus.
import { execFile, execFileSync } from 'node:child_process';
import { createPublicKey, randomUUID, type KeyObject } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import dbus from 'dbus-next';
import { busAuthority, loadIntrospection, NAME, serve } from './dbus.ts';
import { PackageService, type DevicePolicy, type Env, type RunResult } from './service.ts';
import { Coordinator, type CoordinatorEnv } from './coordinator.ts';
import { loadCatalog } from './catalog.ts';

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
    setSuite(suite) {
      if (!existsSync(WORKSUITE_SOURCES)) return;
      const text = readFileSync(WORKSUITE_SOURCES, 'utf8');
      const next = text.replace(/^Suites:.*$/m, `Suites: ${suite}`);
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
  serve(bus, svc, busAuthority(bus), loadIntrospection(XML), coordinator, {
    catalog: () => loadCatalog({ server: enrollment, fetchJson: getJson, arch: ARCH, policy: linuxEnv.policy, runner: linuxEnv.runner, now: Date.now }),
  });
  coordinator.start();
  await bus.requestName(NAME, dbus.NameFlag.DO_NOT_QUEUE);
  linuxEnv.audit('started', { state: svc.state() });
}

if (import.meta.main) main().catch((e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(1); });
