// worksuite-package-service: root daemon owning lk.worksuite.PackageService1 on the system bus.
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import dbus from 'dbus-next';
import { busAuthority, loadIntrospection, NAME, serve } from './dbus.ts';
import { PackageService, type DevicePolicy, type Env, type RunResult } from './service.ts';

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

async function main() {
  const svc = new PackageService(linuxEnv);
  await svc.detectInterrupted();          // WSOS-APT-006: surfaced as State=interrupted for the shell
  const bus = dbus.systemBus();
  serve(bus, svc, busAuthority(bus), loadIntrospection(XML));
  await bus.requestName(NAME, dbus.NameFlag.DO_NOT_QUEUE);
  linuxEnv.audit('started', { state: svc.state() });
}

if (import.meta.main) main().catch((e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(1); });
