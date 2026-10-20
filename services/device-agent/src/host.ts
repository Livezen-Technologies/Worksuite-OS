// Real Debian/Linux effects for the agent. Every external program runs with fixed argument arrays (WSOS-ARC-002,
// WSOS-LCH-001); package changes go through lk.worksuite.PackageService1, never apt directly.
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, hostname, release, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import type { Host } from './agent.ts';
import { lookup } from 'node:dns/promises';
import { ENFORCED_PATHS, type Enforcement } from './enforce.ts';
import { KILLSWITCH_TABLE, parseNmConnections, renderKillSwitch, renderNmConnection, VPN_CONNECTION_UUID, VPN_KEYFILE, wgKeyPair, wgPublicKey } from './vpn.ts';
import type { Policy } from './state.ts';
import { collectHardware, readUpdateStatus } from './inventory.ts';
import { runPackageJob, systemJobBus } from './packageJob.ts';
import { diagnosticProfiles, type DiagnosticProfile } from './diagnostics.ts';

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
  // The unit runs with UMask=0077, which strips the mode above: PAM modules in unprivileged callers (gtklock
  // reads faillock.conf as the user) must be able to read these files.
  chmodSync(path + '.tmp', 0o644);
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
        update_status: readUpdateStatus()?.state ?? 'unknown',
      };
    },

    async inventory() {
      const pkgs = await run('dpkg-query', ['-W', '-f=${Package}\t${Version}\t${Architecture}\n']).catch(() => '');
      const flatpaks = await run('flatpak', ['list', '--app', '--columns=application,version,origin']).catch(() => '');
      return {
        // WSOS-MDM-001: hardware, OS/shell/kernel versions and update status alongside the software lists.
        hardware: {
          ...collectHardware(),
          cpu: cpus()[0]?.model ?? '', cores: cpus().length, memory_bytes: totalmem(),
          tpm: existsSync('/dev/tpmrm0'), encrypted: (await luksDevices().catch(() => [])).length > 0,
        },
        versions: await this.facts(),
        update: readUpdateStatus(),
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

    async applyEnforcement(e: Enforcement) {
      const changed = new Set<string>();
      for (const [path, content] of Object.entries(e.files)) {
        let now: string | null = null;
        try { now = readFileSync(path, 'utf8'); } catch { /* absent */ }
        if (content === null) { if (now !== null) { rmSync(path, { force: true }); changed.add(path); } continue; }
        if (now === content) continue;
        mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
        writePublic(path, content);
        changed.add(path);
      }
      // Kiosk exit PIN verifier: root-only (worksuite-kiosk-exit reads it as root).
      for (const [path, content] of Object.entries(e.secret_files ?? {})) {
        let now: string | null = null;
        try { now = readFileSync(path, 'utf8'); } catch { /* absent */ }
        if (content === null) { if (now !== null) rmSync(path, { force: true }); continue; }
        if (now === content) continue;
        writeFileSync(path + '.tmp', content, { mode: 0o600 });
        renameSync(path + '.tmp', path);
      }
      // Kiosk account, greetd autologin, Ctrl+Alt+Del and logind VTs live outside the agent's sandbox: the root helper
      // runs as its own transient unit (fixed argv; the user name was validated in kiosk.ts).
      if (changed.has(ENFORCED_PATHS.sessionEnv)) {
        const args = e.kiosk_user ? ['enable', e.kiosk_user] : ['disable'];
        try {
          await run('systemd-run', ['--quiet', '--wait', '--collect', '--unit=worksuite-kiosk-apply', '--', '/usr/lib/worksuite/worksuite-kiosk-apply', ...args]);
        } catch (err) {
          rmSync(ENFORCED_PATHS.sessionEnv, { force: true });   // rewritten (and the helper retried) at the next enforcement
          throw err;
        }
      }
      if (changed.has(ENFORCED_PATHS.usbUdev) || changed.has(ENFORCED_PATHS.usbModprobe)) {
        await run('udevadm', ['control', '--reload']).catch(() => {});
        // Re-evaluate disks already plugged in: read-only is applied, ignored disks drop out of UDisks2.
        await run('udevadm', ['trigger', '--subsystem-match=block', '--action=change']).catch(() => {});
        if (e.usb_storage === 'block') await run('modprobe', ['-r', 'uas', 'usb_storage']).catch(() => {});   // busy → stays until unplugged
      }
      // Bluetooth: only undo what the agent did, so a user's own airplane mode is left alone.
      const marker = join(paths.stateDir, 'bluetooth-blocked');
      if (e.bluetooth === 'block') {
        writeFileSync(marker, '');
        await run('systemctl', ['mask', '--now', 'bluetooth.service']).catch(() => {});
        await run('rfkill', ['block', 'bluetooth']).catch(() => {});
      } else if (existsSync(marker)) {
        await run('systemctl', ['unmask', 'bluetooth.service']);
        await run('systemctl', ['start', 'bluetooth.service']).catch(() => {});
        await run('rfkill', ['unblock', 'bluetooth']).catch(() => {});
        rmSync(marker, { force: true });
      }
    },

    setOfflineAccessBlock(notice) {
      if (notice) { mkdirSync(dirname(ENFORCED_PATHS.offlineExpired), { recursive: true, mode: 0o755 }); writePublic(ENFORCED_PATHS.offlineExpired, notice); }
      else rmSync(ENFORCED_PATHS.offlineExpired, { force: true });
    },

    // Software Management: wait for the package job so the server sees whether it really installed or why not.
    async installApproved(catalogId) {
      const [source, name] = splitCatalogId(catalogId);
      const bus = await systemJobBus();
      try { await runPackageJob(bus, 'Install', source, name); } finally { bus.close(); }
    },
    async removeApplication(catalogId) {
      const [source, name] = splitCatalogId(catalogId);
      const bus = await systemJobBus();
      try { await runPackageJob(bus, 'Remove', source, name); } finally { bus.close(); }
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
      const profiles = diagnosticProfiles({ run: (c, a) => run(c, a, 30_000), read: (p) => readOr(p), lookup: async (h) => (await lookup(h, { all: true })).map((x) => x.address) }, release());
      const make = Object.hasOwn(profiles, profile) ? profiles[profile as DiagnosticProfile] : undefined;
      if (!make) throw new Error('UNKNOWN_PROFILE');
      const content = JSON.stringify(await make());
      return { profile, sha256: createHash('sha256').update(content).digest('hex'), content };
    },

    async isFullyEncrypted() {
      const src = (await run('findmnt', ['-n', '-o', 'SOURCE', '/'])).trim();
      if (!src.startsWith('/dev/')) return false;   // overlay (live ISO), tmpfs, network roots: not a LUKS disk
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

    async wgPublicKey(rotate) {
      // The private key stays in the 0700 state dir and in NetworkManager's root-only keyfile; it is never sent.
      const p = join(paths.stateDir, 'wireguard.key');
      if (!rotate && existsSync(p)) return wgPublicKey(readFileSync(p, 'utf8').trim());
      const k = wgKeyPair();
      writeFileSync(p + '.tmp', k.privateKey + '\n', { mode: 0o600 });
      renameSync(p + '.tmp', p);
      return k.publicKey;
    },

    forgetWgKey() { rmSync(join(paths.stateDir, 'wireguard.key'), { force: true }); },

    async applyVpn(plan) {
      if (!plan) {
        if (existsSync(VPN_KEYFILE)) {
          await run('nmcli', ['connection', 'delete', 'uuid', VPN_CONNECTION_UUID]).catch(() => {});
          rmSync(VPN_KEYFILE, { force: true });
        }
        await run('nft', ['delete', 'table', 'inet', KILLSWITCH_TABLE]).catch(() => {});   // absent → fine
        rmSync(join(paths.runtimeDir, 'vpn-killswitch.nft'), { force: true });   // the shell reads its presence (captive portal)
        return;
      }
      const priv = readFileSync(join(paths.stateDir, 'wireguard.key'), 'utf8').trim();
      const content = renderNmConnection(plan, priv);
      let cur: string | null = null;
      try { cur = readFileSync(VPN_KEYFILE, 'utf8'); } catch { /* absent */ }
      if (cur !== content) {
        mkdirSync(dirname(VPN_KEYFILE), { recursive: true, mode: 0o755 });
        writeFileSync(VPN_KEYFILE + '.tmp', content, { mode: 0o600 });   // NM loads only root-owned 0600 keyfiles
        renameSync(VPN_KEYFILE + '.tmp', VPN_KEYFILE);
        await run('nmcli', ['connection', 'load', VPN_KEYFILE]);
      }
      // Kill switch before connecting, so traffic never leaves outside the tunnel while it comes up.
      if (plan.kill_switch) {
        let ips: string[] = [];
        try { ips = (await lookup(plan.endpoint.host, { all: true })).map((a) => a.address); } catch { /* DNS blocked or down */ }
        const rules = join(paths.runtimeDir, 'vpn-killswitch.nft');
        if (ips.length) { writeFileSync(rules, renderKillSwitch(ips, plan.endpoint.port), { mode: 0o600 }); await run('nft', ['-f', rules]); }
        else audit('vpn_killswitch_unresolved', { endpoint: plan.endpoint.host });   // rules already loaded stay in force
      } else {
        await run('nft', ['delete', 'table', 'inet', KILLSWITCH_TABLE]).catch(() => {});
        rmSync(join(paths.runtimeDir, 'vpn-killswitch.nft'), { force: true });
      }
      if (plan.autoconnect) {
        const active = await run('nmcli', ['-t', '-f', 'UUID', 'connection', 'show', '--active']).catch(() => '');
        if (!active.split('\n').includes(VPN_CONNECTION_UUID)) {
          await run('nmcli', ['--wait', '30', 'connection', 'up', 'uuid', VPN_CONNECTION_UUID]).catch((e: Error) => audit('vpn_connect_failed', { error: e.message }));
        }
      }
    },

    async vpnConnections() {
      return parseNmConnections(await run('nmcli', ['-t', '-f', 'NAME,UUID,TYPE,ACTIVE', 'connection', 'show']));
    },

    async removeConnection(uuid) {
      if (!/^[0-9a-f-]{36}$/i.test(uuid)) throw new Error('BAD_UUID');
      await run('nmcli', ['connection', 'delete', 'uuid', uuid]);
    },

    audit,
  };
}
