// Real Debian/Linux effects for the agent. Every external program runs with fixed argument arrays (WSOS-ARC-002,
// WSOS-LCH-001); package changes go through lk.worksuite.PackageService1, never apt directly.
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, hostname, release, totalmem } from 'node:os';
import { join } from 'node:path';
import type { Host } from './agent.ts';
import type { Policy } from './state.ts';

export interface HostPaths { stateDir: string; runtimeDir: string; auditLog: string }

export const DEFAULT_PATHS: HostPaths = {
  stateDir: '/var/lib/worksuite-device-agent',
  runtimeDir: '/run/worksuite-device-agent',
  auditLog: '/var/log/worksuite/device-agent-audit.log',
};

function run(cmd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => (err ? reject(new Error(`${cmd}: ${err.message.split('\n')[0]}`)) : resolve(stdout)));
  });
}

const readOr = (p: string, d = '') => { try { return readFileSync(p, 'utf8').trim(); } catch { return d; } };

function writePublic(path: string, data: string) {
  writeFileSync(path + '.tmp', data, { mode: 0o644 });
  renameSync(path + '.tmp', path);
}

/** Per-user WorkSuite data removed by a WorkSuite data wipe (WSOS-WIPE-002). Relative to each home directory. */
export const WORKSUITE_USER_PATHS = [
  '.config/worksuite', '.local/state/worksuite', '.local/share/worksuite', '.cache/worksuite', 'WorkSuite Drive',
];

/** Maintenance window "HH:MM-HH:MM" → start time for shutdown(8), validated. */
export function windowStart(window: string | undefined): string | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(window ?? '');
  return m ? `${m[1]}:${m[2]}` : null;
}

const SOURCES = new Set(['apt', 'flatpak', 'worksuite']);
/** Catalog ids are "<source>:<id>" (same form as policy app_allowlist). */
export function splitCatalogId(id: string): [string, string] {
  const i = id.indexOf(':');
  const source = id.slice(0, i), name = id.slice(i + 1);
  if (i < 1 || !SOURCES.has(source) || !/^[A-Za-z0-9._+-]{1,200}$/.test(name)) throw new Error('BAD_CATALOG_ID');
  return [source, name];
}

/** Diagnostic profiles an admin may request. Logs only from WorkSuite units; no user files, no secrets. */
const PROFILES: Record<string, () => Promise<Record<string, string>>> = {
  basic: async () => ({
    'os-release': readOr('/etc/os-release'),
    kernel: release(),
    'failed-units': await run('systemctl', ['--failed', '--no-legend', '--plain']).catch(() => ''),
  }),
  session: async () => ({
    ...(await PROFILES.basic()),
    journal: await run('journalctl', ['--since', '-24h', '--no-pager', '-o', 'short-iso', '-u', 'worksuite-*', '-n', '5000']).catch(() => ''),
  }),
};

export function linuxHost(paths: HostPaths = DEFAULT_PATHS): Host {
  mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o755 });
  const audit = (event: string, fields: Record<string, unknown> = {}) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), service: 'worksuite-device-agent', event, ...fields });
    process.stdout.write(line + '\n');
    try { appendFileSync(paths.auditLog, line + '\n', { mode: 0o600 }); } catch { /* journald still has it */ }
  };

  const homes = async (): Promise<{ user: string; home: string }[]> => {
    const out = await run('getent', ['passwd']);
    return out.split('\n').map((l) => l.split(':')).filter((f) => f.length >= 7 && Number(f[2]) >= 1000 && Number(f[2]) < 60000 && f[5].startsWith('/home/'))
      .map((f) => ({ user: f[0], home: f[5] }));
  };

  const luksDevices = async (): Promise<string[]> => {
    const j = JSON.parse(await run('lsblk', ['-J', '-p', '-o', 'PATH,FSTYPE'])) as { blockdevices: { path: string; fstype: string | null; children?: unknown[] }[] };
    const all: string[] = [];
    const walk = (ns: { path: string; fstype: string | null; children?: unknown[] }[]) => {
      for (const n of ns) { if (n.fstype === 'crypto_LUKS') all.push(n.path); if (n.children) walk(n.children as typeof ns); }
    };
    walk(j.blockdevices);
    return all;
  };

  return {
    async generateDeviceKey() {
      // TPM-backed keys (tpm2-tss) are a qualification item (SRS §13.5); until then the key lives in the 0700 state dir.
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      writeFileSync(join(paths.stateDir, 'device-key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      return { publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), tpmBacked: false };
    },

    async facts() {
      const osr = Object.fromEntries(readOr('/etc/os-release').split('\n').map((l) => l.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k, v.replace(/^"|"$/g, '')]));
      return {
        arch: process.arch === 'arm64' ? 'arm64' : 'amd64',
        hostname: hostname(),
        os_version: readOr('/etc/worksuite-release', osr.PRETTY_NAME ?? 'unknown'),
        shell_version: await run('dpkg-query', ['-W', '-f=${Version}', 'worksuite-shell']).catch(() => 'unknown'),
        kernel_version: release(),
        update_status: readOr('/var/lib/worksuite-update/status', 'unknown'),
      };
    },

    async inventory() {
      const pkgs = await run('dpkg-query', ['-W', '-f=${Package}\t${Version}\t${Architecture}\n']).catch(() => '');
      const flatpaks = await run('flatpak', ['list', '--app', '--columns=application,version,origin']).catch(() => '');
      return {
        hardware: {
          vendor: readOr('/sys/class/dmi/id/sys_vendor'), model: readOr('/sys/class/dmi/id/product_name'),
          cpu: cpus()[0]?.model ?? '', cores: cpus().length, memory_bytes: totalmem(),
          tpm: existsSync('/dev/tpmrm0'), encrypted: (await luksDevices().catch(() => [])).length > 0,
        },
        packages: pkgs.split('\n').filter(Boolean).map((l) => { const [name, version, arch] = l.split('\t'); return { source: 'apt', name, version, arch }; }),
        flatpaks: flatpaks.split('\n').filter(Boolean).map((l) => { const [name, version, origin] = l.split('\t'); return { source: 'flatpak', name, version, origin }; }),
      };
    },

    publishCredential(credential) {
      const p = join(paths.runtimeDir, 'device-token');
      if (credential) writePublic(p, credential + '\n'); else rmSync(p, { force: true });
    },
    publishPolicy(policy: Policy | null) {
      const p = join(paths.runtimeDir, 'policy.json');
      if (policy) writePublic(p, JSON.stringify(policy, null, 2)); else rmSync(p, { force: true });
    },
    publishStatus(status) { writePublic(join(paths.runtimeDir, 'status.json'), JSON.stringify(status, null, 2)); },

    async lockAllSessions() { await run('loginctl', ['lock-sessions']); },

    async installApproved(catalogId) {
      const [source, name] = splitCatalogId(catalogId);
      await run('busctl', ['call', '--system', 'lk.worksuite.PackageService1', '/lk/worksuite/PackageService1', 'lk.worksuite.PackageService1', 'Install', 'ss', source, name], 600_000);
    },

    async scheduleUpdate() {
      // Empty release id = newest release allowed by this device's ring; the package service applies window/power rules.
      await run('busctl', ['call', '--system', 'lk.worksuite.PackageService1', '/lk/worksuite/PackageService1', 'lk.worksuite.PackageService1', 'ApplyUpdate', 'sa{sv}', '', '0']);
    },

    async scheduleReboot(window) {
      const at = windowStart(window);
      if (!at) throw new Error('NO_MAINTENANCE_WINDOW');
      await run('shutdown', ['-r', at, 'WorkSuite: restart scheduled by your organization']);
    },

    async collectDiagnostics(profile) {
      const make = PROFILES[profile];
      if (!make) throw new Error('UNKNOWN_PROFILE');
      const content = JSON.stringify(await make());
      return { profile, sha256: createHash('sha256').update(content).digest('hex'), content };
    },

    async isFullyEncrypted() {
      const src = (await run('findmnt', ['-n', '-o', 'SOURCE', '/'])).trim();
      const j = JSON.parse(await run('lsblk', ['-J', '-s', '-p', '-o', 'PATH,FSTYPE', src])) as { blockdevices: { fstype: string | null; children?: unknown[] }[] };
      const any = (ns: { fstype: string | null; children?: unknown[] }[]): boolean => ns.some((n) => n.fstype === 'crypto_LUKS' || (n.children ? any(n.children as typeof ns) : false));
      return any(j.blockdevices);
    },

    async wipeWorkSuiteData() {
      const users = await homes();
      // Sign everyone out first so no process rewrites what is being removed.
      for (const u of users) await run('loginctl', ['terminate-user', u.user]).catch(() => {});
      for (const u of users) {
        for (const rel of WORKSUITE_USER_PATHS) rmSync(join(u.home, rel), { recursive: true, force: true });
        // Keyring entries (refresh tokens) are inside the user's encrypted keyring and can't be edited while locked;
        // the server revokes this device's sessions on wipe, so the stored refresh tokens stop working.
      }
      rmSync(join(paths.runtimeDir, 'device-token'), { force: true });
      audit('worksuite_data_wiped', { users: users.length });
    },

    async cryptoErase() {
      const devs = await luksDevices();
      if (!devs.length) throw new Error('NOT_ENCRYPTED');
      for (const d of devs) await run('cryptsetup', ['erase', '--batch-mode', d]);   // all key slots incl. TPM-bound tokens
      for (const f of readdirSync(paths.stateDir)) if (f.startsWith('luks-header')) rmSync(join(paths.stateDir, f), { force: true });
      audit('full_device_wiped', { devices: devs.length });
      await run('systemctl', ['reboot']);
    },

    audit,
  };
}
