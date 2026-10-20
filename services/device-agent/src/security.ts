// WorkSuite Security (issue #20): firewall policy, endpoint isolation, ClamAV antivirus and the security status the
// shell and the admin console show. Pure: renders rules and files and parses tool output, so it is testable without
// root. src/securityHost.ts applies it on the machine.
//
// The packaged default firewall (/etc/nftables.conf, table inet worksuite_filter: inbound default-deny) stays as it is;
// the policy adds its own table, inet worksuite_policy, so a packet must pass both. That table only ever narrows
// what the default allows: blocked destinations, and isolation (everything except the management path).
import type { Policy } from './state.ts';

export const POLICY_TABLE = 'worksuite_policy';
/** Loaded at boot by /etc/nftables.conf (include "/etc/worksuite/nftables.d/*.nft") and by the agent at once. */
export const FIREWALL_RULES = '/etc/worksuite/nftables.d/50-policy.nft';
/** clamav-freshclam.service drop-in (packaging) reads FRESHCLAM_CHECKS from here: signature checks per day. */
export const FRESHCLAM_ENV = '/etc/worksuite/freshclam.env';
export const LOG_PREFIX = 'worksuite-fw-drop: ';

const HEADER = '# Written by worksuite-device-agent from the signed device policy. Local changes are replaced.\n';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Isolation lasts at most this long unless the administrator renews it: a lockout always ends (#20 §12). */
export const ISOLATION_MAX_HOURS = 72;

const CIDR4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(\/([0-9]|[12]\d|3[0-2]))?$/;
const CIDR6 = /^[0-9a-fA-F:]{2,39}(\/([0-9]|[1-9]\d|1[01]\d|12[0-8]))?$/;
export const isCidr4 = (s: unknown): s is string => typeof s === 'string' && CIDR4.test(s);
export const isCidr6 = (s: unknown): s is string => typeof s === 'string' && s.includes(':') && CIDR6.test(s);

export interface SecuritySettings {
  firewall_outbound_block: string[];
  firewall_log_blocked: boolean;
  antivirus: boolean;
  av_scan_schedule: 'off' | 'daily' | 'weekly';
  /** Local hour the scheduled scan may start from (it still waits for the device to be idle). */
  av_scan_hour: number;
  av_scan_paths: string[];
  av_exclusions: string[];
  av_signature_checks_per_day: number;
  av_cpu_quota_percent: number;
  security_log_retention_days: number;
}

const ABS = (s: unknown): s is string => typeof s === 'string' && /^\/[^\0\n]{0,4095}$/.test(s) && !s.split('/').includes('..');

/** Policy → settings with defaults. Malformed values fall back to the default instead of failing the policy. */
export function securitySettings(p: Policy | null | undefined): SecuritySettings {
  const int = (v: unknown, lo: number, hi: number, d: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? v as number : d;
  const block = Array.isArray(p?.firewall_outbound_block) ? (p!.firewall_outbound_block as unknown[]).filter((x) => isCidr4(x) || isCidr6(x)) as string[] : [];
  const sched = p?.av_scan_schedule;
  return {
    firewall_outbound_block: [...new Set(block)].slice(0, 500),
    firewall_log_blocked: p?.firewall_log_blocked === true,
    antivirus: p?.antivirus !== false,
    av_scan_schedule: sched === 'off' || sched === 'daily' || sched === 'weekly' ? sched : 'weekly',
    av_scan_hour: int(p?.av_scan_hour, 0, 23, 12),
    av_scan_paths: Array.isArray(p?.av_scan_paths) && (p!.av_scan_paths as unknown[]).every(ABS) ? (p!.av_scan_paths as string[]).slice(0, 20) : ['/home'],
    av_exclusions: Array.isArray(p?.av_exclusions) ? (p!.av_exclusions as unknown[]).filter(ABS).slice(0, 100) as string[] : [],
    av_signature_checks_per_day: int(p?.av_signature_checks_per_day, 1, 24, 12),
    av_cpu_quota_percent: int(p?.av_cpu_quota_percent, 10, 100, 50),
    security_log_retention_days: int(p?.security_log_retention_days, 7, 3650, 90),
  };
}

export interface Isolation { since: number; until: number; management: string[] }

/** IPs the management connection may use while isolated. No address → no isolation (it would lock the device out). */
export function isolationPlan(now: number, hours: unknown, managementIps: string[]): Isolation {
  const h = Number.isInteger(hours) && (hours as number) >= 1 && (hours as number) <= ISOLATION_MAX_HOURS ? hours as number : 24;
  const ips = managementIps.filter((x) => isCidr4(x) || isCidr6(x));
  if (!ips.length) throw new Error('NO_MANAGEMENT_PATH');
  return { since: now, until: now + h * HOUR, management: ips };
}

export const isolationActive = (i: Isolation | undefined | null, now: number): i is Isolation => !!i && i.until > now;

/**
 * The policy table. null when there is nothing to add (the file is removed and the table deleted).
 * Isolation keeps: loopback, replies to connections already allowed, DHCP, DNS and HTTPS to the management server
 * (the agent's check-in, so the release command still arrives).
 */
export function renderPolicyFirewall(s: SecuritySettings, iso: Isolation | null): string | null {
  if (!s.firewall_outbound_block.length && !iso) return null;
  const v4 = s.firewall_outbound_block.filter(isCidr4), v6 = s.firewall_outbound_block.filter(isCidr6);
  // Logging is rate-limited on its own rule: a limit on the drop rule itself would let packets over the rate through.
  const log = s.firewall_log_blocked ? `limit rate 6/minute burst 3 packets log prefix "${LOG_PREFIX}" flags skuid` : '';
  const drop = (match: string) => [...(log ? [`    ${match}${log}`] : []), `    ${match}drop`];
  // Blocked destinations first: they stay blocked even for connections that were open before the policy arrived.
  const out: string[] = [];
  if (v4.length) out.push(...drop(`ip daddr { ${v4.join(', ')} } `));
  if (v6.length) out.push(...drop(`ip6 daddr { ${v6.join(', ')} } `));
  if (iso) {
    const m4 = iso.management.filter(isCidr4), m6 = iso.management.filter(isCidr6);
    out.push(
      '    oifname "lo" accept',
      '    ct state { established, related } accept',
      '    udp dport { 67, 547 } accept',
      '    meta l4proto { tcp, udp } th dport 53 accept',
      ...(m4.length ? [`    ip daddr { ${m4.join(', ')} } tcp dport 443 accept`] : []),
      ...(m6.length ? [`    ip6 daddr { ${m6.join(', ')} } tcp dport 443 accept`] : []),
    );
  }
  if (iso) out.push(...drop(''));
  const lines = [
    HEADER.trimEnd(),
    `# Isolation: ${iso ? `on until ${new Date(iso.until).toISOString()}` : 'off'}`,
    `table inet ${POLICY_TABLE}`,
    `delete table inet ${POLICY_TABLE}`,
    `table inet ${POLICY_TABLE} {`,
    '  chain output {',
    '    type filter hook output priority filter + 10; policy accept;',
    ...out,
    '  }',
  ];
  if (iso) lines.push(
    '  chain input {',
    '    type filter hook input priority filter + 10; policy drop;',
    '    iifname "lo" accept',
    '    ct state { established, related } accept',
    '    udp sport 67 udp dport 68 accept',
    '    udp sport 547 udp dport 546 accept',
    '  }',
  );
  lines.push('}');
  return lines.join('\n') + '\n';
}

export function freshclamEnv(s: SecuritySettings): string {
  return HEADER + `FRESHCLAM_CHECKS=${s.av_signature_checks_per_day}\n`;
}

/** "ClamAV 1.0.7/27431/Mon Oct 19 08:24:01 2026" → engine, signature version and date (ms). */
export function parseClamVersion(out: string): { engine: string; signatures: number | null; signatures_at: number | null } | null {
  const m = /^ClamAV ([\w.~+-]+)(?:\/(\d+)\/(.+))?$/m.exec(out.trim());
  if (!m) return null;
  const at = m[3] ? Date.parse(m[3].trim()) : NaN;
  return { engine: m[1], signatures: m[2] ? Number(m[2]) : null, signatures_at: Number.isNaN(at) ? null : at };
}

export interface Detection { path: string; signature: string }

/** clamscan --infected --no-summary output: "<path>: <Signature> FOUND". Paths may contain ": ". */
export function parseClamscan(out: string): Detection[] {
  const r: Detection[] = [];
  for (const line of out.split('\n')) {
    const m = /^(.*): (\S+) FOUND$/.exec(line);
    if (m && m[1].startsWith('/')) r.push({ path: m[1], signature: m[2] });
  }
  return r;
}

/** Kernel log lines from the policy table's log rule → firewall alerts (no payload, addresses and ports only). */
export function parseFirewallLog(lines: string[]): { at: number | null; dst: string; dport: number | null; proto: string; uid: number | null }[] {
  const r = [];
  for (const l of lines) {
    const i = l.indexOf(LOG_PREFIX);
    if (i < 0) continue;
    const f = (k: string) => new RegExp(`\\b${k}=(\\S+)`).exec(l.slice(i))?.[1];
    const dst = f('DST');
    if (!dst) continue;
    const ts = /^(\d{4}-\d\d-\d\dT\S+)/.exec(l)?.[1];
    r.push({ at: ts ? Date.parse(ts) : null, dst, dport: f('DPT') ? Number(f('DPT')) : null, proto: f('PROTO') ?? '', uid: f('UID') ? Number(f('UID')) : null });
  }
  return r;
}

export interface ScanRecord { id: string; kind: 'quick' | 'full'; trigger: 'schedule' | 'remote' | 'user'; started: number; finished: number; files: number; detections: number; error?: string }
export interface ThreatRecord { id: string; at: number; path: string; signature: string; action: 'quarantined' | 'detected' | 'restored' | 'deleted'; quarantine_id?: string; scan_id?: string }
export interface SecurityState {
  isolation?: Isolation;
  last_full_scan?: number;
  last_scan?: number;
  scans: ScanRecord[];
  threats: ThreatRecord[];
  firewall_alerts: { at: number; dst: string; dport: number | null; proto: string }[];
  firewall_log_cursor?: string;
  restarts: Record<string, number>;
}
export const emptySecurity = (): SecurityState => ({ scans: [], threats: [], firewall_alerts: [], restarts: {} });

/** Applies the retention period: older history is dropped (#20 §14 configurable security log retention). */
export function pruneSecurity(st: SecurityState, retentionDays: number, now: number): SecurityState {
  const cut = now - retentionDays * DAY;
  return {
    ...st,
    scans: st.scans.filter((x) => x.finished >= cut).slice(-200),
    threats: st.threats.filter((x) => x.at >= cut || x.action === 'quarantined').slice(-500),
    firewall_alerts: st.firewall_alerts.filter((x) => x.at >= cut).slice(-500),
  };
}

/** Which scan is due now, if any. Scheduled scans wait for an idle, unloaded machine on mains power. */
export function scanDue(s: SecuritySettings, st: SecurityState, now: number, load: { idle: boolean; loadPerCore: number; onBattery: boolean; hour: number }): 'quick' | 'full' | null {
  if (!s.antivirus || s.av_scan_schedule === 'off') return null;
  if (!load.idle || load.loadPerCore > 0.75 || load.onBattery || load.hour < s.av_scan_hour) return null;
  const fullEvery = s.av_scan_schedule === 'daily' ? 7 * DAY : 30 * DAY;
  const quickEvery = s.av_scan_schedule === 'daily' ? DAY : 7 * DAY;
  if (!st.last_full_scan || now - st.last_full_scan >= fullEvery) return 'full';
  if (!st.last_scan || now - st.last_scan >= quickEvery - HOUR) return 'quick';
  return null;
}

export interface EngineFacts {
  firewall_active: boolean;
  policy_table_active: boolean;
  clamav: ReturnType<typeof parseClamVersion>;
  freshclam: 'active' | 'failed' | 'inactive' | 'missing';
}

export type Overall = 'protected' | 'attention' | 'at_risk' | 'unavailable';

/** What Settings › Privacy & security › WorkSuite Security and the admin console show. No file contents, ever. */
export function securityStatus(s: SecuritySettings, st: SecurityState, f: EngineFacts, now: number, managed: boolean, scanning = false) {
  const sigAge = f.clamav?.signatures_at ? Math.floor((now - f.clamav.signatures_at) / DAY) : null;
  const isolated = isolationActive(st.isolation, now);
  const active = st.threats.filter((t) => t.action === 'detected');
  const issues: string[] = [];
  if (!f.firewall_active) issues.push('firewall_off');
  if (s.antivirus && !f.clamav) issues.push('antivirus_missing');
  if (s.antivirus && f.clamav && f.freshclam !== 'active') issues.push('updates_not_running');
  if (s.antivirus && sigAge !== null && sigAge > 3) issues.push('signatures_outdated');
  if (active.length) issues.push('threats_need_action');
  if (isolated) issues.push('isolated');
  const overall: Overall = !f.firewall_active && !f.clamav ? 'unavailable'
    : active.length || !f.firewall_active ? 'at_risk' : issues.length ? 'attention' : 'protected';
  return {
    overall, issues, managed, scanning, updated: now,
    firewall: { active: f.firewall_active, policy_rules: s.firewall_outbound_block.length, policy_table: f.policy_table_active, log_blocked: s.firewall_log_blocked },
    isolation: isolated ? { since: st.isolation!.since, until: st.isolation!.until } : null,
    antivirus: {
      enabled: s.antivirus, installed: !!f.clamav, engine: f.clamav?.engine ?? null,
      signatures: f.clamav?.signatures ?? null, signatures_at: f.clamav?.signatures_at ?? null, signatures_age_days: sigAge,
      updates: f.freshclam, schedule: s.av_scan_schedule, exclusions: s.av_exclusions.length,
      last_scan: st.scans.at(-1) ?? null, last_full_scan: st.last_full_scan ?? null,
    },
    threats: { active: active.length, quarantined: st.threats.filter((t) => t.action === 'quarantined').length },
    history: st.threats.slice(-50).reverse().map(({ id, at, path, signature, action }) => ({ id, at, path, signature, action })),
    firewall_alerts: st.firewall_alerts.slice(-20).reverse(),
    retention_days: s.security_log_retention_days,
  };
}
export type SecurityStatus = ReturnType<typeof securityStatus>;

/** Exclusions → clamscan --exclude-dir / --exclude regexes (anchored; regex metacharacters escaped). */
export function exclusionArgs(paths: string[]): string[] {
  const esc = (p: string) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return paths.flatMap((p) => [`--exclude-dir=^${esc(p.replace(/\/+$/, ''))}(/|$)`, `--exclude=^${esc(p)}$`]);
}

/** Files to scan: under roots, not excluded, regular, and (quick scan) changed since `since`. Bounded walk. */
export function* walkFiles(roots: string[], exclusions: string[], since: number | null, fs: {
  readdir(p: string): { name: string; dir: boolean; file: boolean; link: boolean }[];
  mtimeMs(p: string): number;
}, limit = 2_000_000): Generator<string> {
  const excluded = (p: string) => exclusions.some((e) => p === e || p.startsWith(e.replace(/\/+$/, '') + '/'));
  const stack = [...roots].filter((r) => !excluded(r));
  let n = 0;
  while (stack.length) {
    const d = stack.pop()!;
    let ents;
    try { ents = fs.readdir(d); } catch { continue; }
    for (const e of ents) {
      const p = d.replace(/\/+$/, '') + '/' + e.name;
      if (e.link || excluded(p)) continue;
      if (e.dir) { stack.push(p); continue; }
      if (!e.file) continue;
      if (since !== null) { let m = 0; try { m = fs.mtimeMs(p); } catch { continue; } if (m < since) continue; }
      if (++n > limit) return;
      yield p;
    }
  }
}
