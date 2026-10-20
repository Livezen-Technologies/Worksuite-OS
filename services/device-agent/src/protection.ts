// WorkSuite Security protection layers (issue #38, follow-up to #20): real-time scanning (ClamAV clamonacc on
// fanotify), protected folders and ransomware burst detection and the executable deny list (native/guard,
// worksuite-guard), DNS blocklists (NetworkManager's dnsmasq), Downloads scanning, firewall threat-intel feeds and the
// quarantine records. Pure, like src/security.ts: it renders configuration and parses what the tools print;
// src/securityHost.ts applies it and src/securityCenter.ts runs it.
import { createHash, createPublicKey, verify } from 'node:crypto';
import type { Policy } from './state.ts';
import { isCidr4 as guard4, isCidr6 as guard6 } from './security.ts';

const isCidr4 = (x: string): boolean => guard4(x), isCidr6 = (x: string): boolean => guard6(x);

/** clamonacc's configuration (worksuite-onaccess.service); its absence keeps the unit from starting. */
export const ONACCESS_CONF = '/etc/worksuite/clamd-onaccess.conf';
/** worksuite-guard's configuration (worksuite-guard.service, native/guard/worksuite-guard.c). */
export const GUARD_CONF = '/etc/worksuite/guard.conf';
/** dnsmasq run by NetworkManager reads its drop-ins from here once dns=dnsmasq is set (DNS_MODE_CONF). */
export const DNS_BLOCKLIST = '/etc/NetworkManager/dnsmasq.d/worksuite-blocklist.conf';
export const DNS_MODE_CONF = '/etc/NetworkManager/conf.d/50-worksuite-dns.conf';
export const ONACCESS_UNIT = 'worksuite-onaccess.service';
export const GUARD_UNIT = 'worksuite-guard.service';
/** clamd's socket in Debian's clamav-daemon. */
export const CLAMD_SOCKET = '/run/clamav/clamd.ctl';

const HEADER = '# Written by worksuite-device-agent from the signed device policy. Local changes are replaced.\n';
const HEX64 = /^[0-9a-fA-F]{64}$/;
const ABS = (s: unknown): s is string => typeof s === 'string' && /^\/[^\0\n]{0,4095}$/.test(s) && !s.split('/').includes('..');
/** An absolute path, or "~/<path>" for that folder in every user's home. */
const FOLDER = (s: unknown): s is string => typeof s === 'string' && (ABS(s) || /^~\/[^\0\n]{1,4000}$/.test(s as string) && !(s as string).split('/').includes('..'));
const DOMAIN = /^(?=.{1,253}$)(?!-)([a-z0-9-]{1,63}(?<!-)\.)+[a-z][a-z0-9-]{0,62}(?<!-)$/;
export const isDomain = (s: unknown): s is string => typeof s === 'string' && DOMAIN.test(s.toLowerCase());

export interface Feed { url: string; sha256?: string; key?: string }
export const isFeed = (v: unknown): v is Feed => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const f = v as Record<string, unknown>;
  if (typeof f.url !== 'string' || !/^https:\/\/[^\s]{1,2000}$/.test(f.url)) return false;
  try { if (new URL(f.url).protocol !== 'https:') return false; } catch { return false; }
  const sha = f.sha256 === undefined || typeof f.sha256 === 'string' && HEX64.test(f.sha256);
  const key = f.key === undefined || typeof f.key === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(f.key);
  // Unsigned and unpinned feeds are refused: a feed changes the firewall or DNS of every device.
  return sha && key && (f.sha256 !== undefined || f.key !== undefined);
};

export interface ProtectionSettings {
  realtime: boolean;
  realtime_prevention: boolean;
  realtime_paths: string[];
  realtime_exclusions: string[];
  download_scan: boolean;
  protected_folders: string[];
  protected_folders_mode: 'block' | 'audit';
  protected_folders_allow: string[];
  ransomware_burst: { count: number; seconds: number };
  app_denylist: { paths: string[]; sha256: string[] };
  dns_blocklist: string[];
  dns_threat_feeds: Feed[];
  firewall_threat_feeds: Feed[];
  firewall_threat_max_entries: number;
  security_auto_patch: 'immediate' | 'window' | 'off';
}

/**
 * Policy → protection settings. Unmanaged devices get Downloads scanning only (with antivirus on): real-time
 * scanning needs clamd (about 1 GB of memory), so an organization turns it on. Malformed values fall back.
 */
export function protectionSettings(p: Policy | null | undefined, antivirus = true): ProtectionSettings {
  const q = (p ?? {}) as Record<string, unknown>;
  const int = (v: unknown, lo: number, hi: number, d: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? v as number : d;
  const arr = <T>(v: unknown, ok: (x: unknown) => x is T, max: number): T[] => Array.isArray(v) ? [...new Set((v as unknown[]).filter(ok))].slice(0, max) : [];
  const deny = arr(q.app_denylist, (x): x is string => ABS(x) || typeof x === 'string' && HEX64.test(x), 5000);
  const rb = q.ransomware_burst as Record<string, unknown> | undefined;
  return {
    realtime: antivirus && q.realtime_protection === true,
    realtime_prevention: q.realtime_prevention !== false,
    realtime_paths: Array.isArray(q.realtime_paths) && (q.realtime_paths as unknown[]).length && (q.realtime_paths as unknown[]).every(FOLDER) ? (q.realtime_paths as string[]).slice(0, 32) : ['/home'],
    realtime_exclusions: arr(q.av_exclusions, ABS, 100),
    download_scan: antivirus && q.download_scan !== false,
    protected_folders: arr(q.protected_folders, FOLDER, 32),
    protected_folders_mode: q.protected_folders_mode === 'audit' ? 'audit' : 'block',
    protected_folders_allow: arr(q.protected_folders_allow, ABS, 200),
    ransomware_burst: { count: int(rb?.count, 20, 10_000, 200), seconds: int(rb?.seconds, 1, 300, 10) },
    app_denylist: { paths: deny.filter((x) => x.startsWith('/')), sha256: deny.filter((x) => !x.startsWith('/')).map((x) => x.toLowerCase()) },
    dns_blocklist: arr(q.dns_blocklist, isDomain, 5000).map((d) => d.toLowerCase()),
    dns_threat_feeds: arr(q.dns_threat_feeds, isFeed, 10),
    firewall_threat_feeds: arr(q.firewall_threat_feeds, isFeed, 10),
    firewall_threat_max_entries: int(q.firewall_threat_max_entries, 100, 200_000, 50_000),
    security_auto_patch: q.security_auto_patch === 'immediate' || q.security_auto_patch === 'off' ? q.security_auto_patch : 'window',
  };
}

/** "~/Documents" → that folder in every home; absolute paths as they are. Sorted, unique. */
export function expandFolders(list: string[], homes: string[]): string[] {
  const out = list.flatMap((f) => f.startsWith('~/') ? homes.map((h) => h.replace(/\/+$/, '') + f.slice(1)) : [f]);
  return [...new Set(out.map((p) => p.length > 1 ? p.replace(/\/+$/, '') : p))].sort();
}

export const downloadDirs = (homes: string[]) => homes.map((h) => h.replace(/\/+$/, '') + '/Downloads');

/**
 * clamonacc configuration: fanotify on the policy's paths and every Downloads folder, files passed to clamd by
 * descriptor. Prevention denies the open of an infected file; without it, detections are only reported.
 */
export function renderOnAccessConf(s: ProtectionSettings, homes: string[]): string | null {
  if (!s.realtime) return null;
  const inc = expandFolders([...s.realtime_paths, ...downloadDirs(homes)], homes);
  // A path below another one is already covered; clamonacc watches each include recursively.
  const top = inc.filter((p) => !inc.some((o) => o !== p && (o === '/' || p.startsWith(o + '/'))));
  return HEADER + [
    `LocalSocket ${CLAMD_SOCKET}`,
    ...top.map((p) => `OnAccessIncludePath ${p}`),
    ...s.realtime_exclusions.map((p) => `OnAccessExcludePath ${p}`),
    // clamd's own reads must not be scanned again, and the agent quarantines (moves) as root.
    'OnAccessExcludeUname clamav',
    'OnAccessExcludeRootUID yes',
    `OnAccessPrevention ${s.realtime_prevention ? 'yes' : 'no'}`,
    'OnAccessExtraScanning yes',
    'OnAccessMaxFileSize 50M',
    'OnAccessMaxThreads 4',
    'OnAccessRetryAttempts 2',
    'OnAccessDenyOnError no',
  ].join('\n') + '\n';
}

/** worksuite-guard configuration (native/guard/worksuite-guard.c parse_line). null = nothing to guard. */
export function renderGuardConf(s: ProtectionSettings, homes: string[]): string | null {
  const prot = expandFolders(s.protected_folders, homes);
  if (!prot.length && !s.app_denylist.paths.length && !s.app_denylist.sha256.length) return null;
  return HEADER + [
    `mode ${s.protected_folders_mode === 'audit' ? 'audit' : 'enforce'}`,
    `burst ${s.ransomware_burst.count} ${s.ransomware_burst.seconds}`,
    ...prot.map((p) => `protect ${p}`),
    ...s.protected_folders_allow.map((p) => `allow ${p}`),
    ...s.app_denylist.paths.map((p) => `deny-path ${p}`),
    ...s.app_denylist.sha256.map((h) => `deny-sha256 ${h}`),
  ].join('\n') + '\n';
}

export type ProtectionEventKind = 'onaccess_blocked' | 'onaccess_detected' | 'write_blocked' | 'exec_blocked' | 'ransomware_suspended' | 'download_threat';
export interface ProtectionEvent {
  id: string; at: number; kind: ProtectionEventKind; path: string;
  exe?: string; pid?: number; start?: string; signature?: string; enforced?: boolean;
  /** A suspended process: what the user or the administrator decided. */
  resolved?: 'resumed' | 'terminated' | 'gone';
}

/** One JSON line of worksuite-guard's output → an event (started lines and anything else → null). */
export function parseGuardLine(line: string): Omit<ProtectionEvent, 'id' | 'at'> | null {
  let j: Record<string, unknown>;
  try { j = JSON.parse(line.slice(line.indexOf('{'))); } catch { return null; }
  if (!j || typeof j !== 'object' || typeof j.path !== 'string') return null;
  const base = { path: j.path, exe: typeof j.exe === 'string' ? j.exe : undefined, pid: Number.isInteger(j.pid) ? j.pid as number : undefined, enforced: j.enforced === true };
  if (j.event === 'write_blocked') return { kind: 'write_blocked', ...base };
  if (j.event === 'exec_blocked') return { kind: 'exec_blocked', ...base, signature: typeof j.sha256 === 'string' && j.sha256 ? `sha256:${j.sha256}` : undefined };
  if (j.event === 'burst_suspended' && typeof j.start === 'string' && /^\d+$/.test(j.start)) return { kind: 'ransomware_suspended', ...base, start: j.start };
  return null;
}

/**
 * clamonacc output: "<path>: <Signature> FOUND". With prevention on, the open was refused; the agent then moves the
 * file to quarantine like a scan detection.
 */
export function parseOnAccessLine(line: string): { path: string; signature: string } | null {
  const m = /(\/.*): (\S+) FOUND\s*$/.exec(line);
  return m ? { path: m[1], signature: m[2] } : null;
}

/** NetworkManager's dnsmasq: "address=/domain/" answers NXDOMAIN for the domain and every name below it. */
export function renderDnsBlocklist(domains: string[]): string | null {
  if (!domains.length) return null;
  return HEADER + domains.map((d) => `address=/${d}/`).join('\n') + '\n';
}
export function renderDnsMode(on: boolean): string | null {
  return on ? HEADER + '[main]\ndns=dnsmasq\n' : null;
}

/** A domain feed: plain names or hosts-file lines ("0.0.0.0 bad.example"); comments and invalid names skipped. */
export function parseDomainFeed(text: string, max: number): string[] {
  const out = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const name = (parts.length > 1 && /^(0\.0\.0\.0|127\.0\.0\.1|::1?)$/.test(parts[0]) ? parts[1] : parts[0]).toLowerCase().replace(/\.$/, '');
    if (name === 'localhost' || !isDomain(name)) continue;
    out.add(name);
    if (out.size >= max) break;
  }
  return [...out];
}

const v4num = (ip: string) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
/** Does IPv4 CIDR a contain address b? */
export function cidr4Contains(cidr: string, ip: string): boolean {
  const [net, bits = '32'] = cidr.split('/');
  const b = Number(bits);
  if (b === 0) return true;
  const span = 2 ** (32 - b);
  return Math.floor(v4num(net) / span) === Math.floor(v4num(ip) / span);
}

/**
 * An IP/CIDR feed (one per line, "#" or ";" comments, extra columns ignored). Entries that are too wide
 * (shorter than /8 or /16), cover loopback, private or link-local space, or any of `keep` (the management
 * server: isolation and check-ins depend on it) are dropped, so a feed can never cut the device off its management.
 */
export function parseIpFeed(text: string, max: number, keep: string[] = []): { v4: string[]; v6: string[]; dropped: number } {
  const v4 = new Set<string>(), v6 = new Set<string>();
  let dropped = 0;
  const SAFE4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4', '240.0.0.0/4'];
  const keep4 = keep.filter((k) => isCidr4(k) && !k.includes('/'));
  for (const raw of text.split('\n')) {
    const e = raw.replace(/[#;].*/, '').trim().split(/[\s,]+/)[0];
    if (!e) continue;
    if (isCidr4(e)) {
      const bits = Number(e.split('/')[1] ?? 32);
      const net = e.split('/')[0];
      const overlapsSafe = SAFE4.some((s) => cidr4Contains(s, net) || cidr4Contains(e, s.split('/')[0]));
      if (bits < 8 || overlapsSafe || keep4.some((k) => cidr4Contains(e, k))) { dropped++; continue; }
      v4.add(e);
    } else if (isCidr6(e)) {
      const bits = Number(e.split('/')[1] ?? 128);
      const lower = e.toLowerCase();
      if (bits < 16 || /^(::|::1|fe[89ab]|f[cd]|ff)/.test(lower) || keep.includes(e)) { dropped++; continue; }
      v6.add(e);
    } else dropped++;
    if (v4.size + v6.size >= max) break;
  }
  return { v4: [...v4], v6: [...v6], dropped };
}

/** A fetched feed body is used only if it matches the pinned SHA-256 or carries a valid Ed25519 signature. */
export function verifyFeed(f: Feed, body: Buffer, signature: Buffer | null): boolean {
  if (f.sha256 && createHash('sha256').update(body).digest('hex') !== f.sha256.toLowerCase()) return false;
  if (f.key) {
    if (!signature) return false;
    try {
      const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(f.key, 'base64')]), format: 'der', type: 'spki' });
      const sig = /^[A-Za-z0-9+/=\s]+$/.test(signature.toString('latin1')) ? Buffer.from(signature.toString('latin1').trim(), 'base64') : signature;
      if (!verify(null, body, key, sig)) return false;
    } catch { return false; }
  }
  return true;
}

/** The nft set statement for the threat-intel entries (inside table inet worksuite_policy). */
export function renderThreatSets(t: { v4: string[]; v6: string[] }): string[] {
  const set = (name: string, type: string, els: string[]) => [
    `  set ${name} {`, `    type ${type}; flags interval; auto-merge;`, ...(els.length ? [`    elements = { ${els.join(', ')} }`] : []), '  }',
  ];
  return [...set('threat_v4', 'ipv4_addr', t.v4), ...set('threat_v6', 'ipv6_addr', t.v6)];
}

/** Quarantined items as Settings and the console list them (from the threat history). */
export function quarantineList(threats: { id: string; at: number; path: string; signature: string; action: string; quarantine_id?: string }[]) {
  return threats.filter((t) => t.action === 'quarantined' && t.quarantine_id).slice(-100).reverse()
    .map(({ quarantine_id, at, path, signature }) => ({ id: quarantine_id!, at, path, signature }));
}
