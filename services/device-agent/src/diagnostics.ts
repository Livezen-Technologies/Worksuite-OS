// Diagnostic profiles an admin may request with CollectApprovedDiagnostics {bundle_profile} (WSOS-MDM-001).
// Fixed programs and arguments only (WSOS-ARC-002). Logs only from WorkSuite units; no user files and no secrets:
// no NetworkManager connection files (Wi-Fi keys, VPN private key), and user:password is removed from every URL.
// The admin console offers exactly these names (services/server/src/console.ts DIAG_PROFILES; a test checks).

import { UPDATE_STATUS_FILE } from './inventory.ts';

export interface DiagnosticIo {
  run(cmd: string, args: string[]): Promise<string>;
  read(path: string): string;
  lookup(host: string): Promise<string[]>;
}

export const DIAGNOSTIC_PROFILES = ['basic', 'session', 'network', 'update'] as const;
export type DiagnosticProfile = (typeof DIAGNOSTIC_PROFILES)[number];

export const UPDATE_CONFIG_FILE = '/etc/worksuite/updates.json';
const DEFAULT_UPDATE_HOST = 'https://download.worksuitecloud.com';

/** https://user:secret@host/path → https://host/path; anything that is not a URL is returned unchanged. */
export function stripUserinfo(s: string): string {
  return s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1');
}

const json = (s: string): Record<string, unknown> | null => {
  try { const v = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
};

export function diagnosticProfiles(io: DiagnosticIo, kernel: string): Record<DiagnosticProfile, () => Promise<Record<string, string>>> {
  const run = (cmd: string, args: string[]) => io.run(cmd, args).catch((e: Error) => `error: ${e.message}`);
  const journal = (units: string[], lines: number) =>
    run('journalctl', ['--since', '-24h', '--no-pager', '-o', 'short-iso', '-n', String(lines), ...units.flatMap((u) => ['-u', u])]);
  const updateConfig = () => {
    const c = json(io.read(UPDATE_CONFIG_FILE)) ?? {};
    const pick = (k: string) => (typeof c[k] === 'string' ? stripUserinfo(c[k] as string) : null);
    return { update_host: pick('update_host'), update_ring: pick('update_ring'), update_mode: pick('update_mode') };
  };
  const basic = async () => ({
    'os-release': io.read('/etc/os-release'),
    kernel,
    'failed-units': await run('systemctl', ['--failed', '--no-legend', '--plain']),
  });
  return {
    basic,
    session: async () => ({ ...(await basic()), journal: await journal(['worksuite-*'], 5000) }),
    network: async () => {
      const host = new URL(updateConfig().update_host ?? DEFAULT_UPDATE_HOST).hostname;
      const dns = await io.lookup(host).then((a) => a.join(' '), (e: Error) => `error: ${e.message}`);
      return {
        ...(await basic()),
        addresses: await run('ip', ['-j', 'address', 'show']),
        routes: await run('ip', ['-j', 'route', 'show', 'table', 'all']),
        routes6: await run('ip', ['-j', '-6', 'route', 'show', 'table', 'all']),
        'resolv.conf': io.read('/etc/resolv.conf'),
        // Device list and connectivity only: `nmcli connection show <id>` would print secrets with --show-secrets.
        devices: await run('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device', 'status']),
        connectivity: (await run('nmcli', ['networking', 'connectivity', 'check'])).trim(),
        [`dns ${host}`]: dns,
      };
    },
    update: async () => {
      const status = json(io.read(UPDATE_STATUS_FILE));
      if (status && typeof status.update_host === 'string') status.update_host = stripUserinfo(status.update_host);
      return {
        ...(await basic()),
        // state, ring (channel), offered/installed version, last_check, reason: the coordinator's own status file.
        status: status ? JSON.stringify(status) : 'none (the package service has not published a status)',
        config: JSON.stringify(updateConfig()),
        'apt-source': stripUserinfo(io.read('/etc/apt/sources.list.d/worksuite.list') || io.read('/etc/apt/sources.list.d/worksuite.sources')),
        journal: await journal(['worksuite-package-service.service', 'worksuite-package-service.timer'], 2000),
      };
    },
  };
}
