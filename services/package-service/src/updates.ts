// Update decision rules (SRS §9.1 WSOS-UPD-*, §14.1 WSOS-AUP-*). Pure functions: no I/O, no clock.
import { createHash, verify, type KeyObject } from 'node:crypto';

export type Ring = 'development' | 'pilot' | 'stable';
export type Mode = 'automatic' | 'notify' | 'manual';

/** Signed OS release manifest per ring and arch on download.worksuitecloud.com (api-contracts ReleaseManifest). */
export interface Manifest {
  release_id: string;
  version: string;
  min_version: string;
  ring: Ring;
  arch: 'amd64' | 'arm64';
  mandatory?: boolean;
  critical?: boolean;
  /** Security-only release: installs in every mode except Manual (WSOS-AUP-005). */
  security?: boolean;
  rollout_percent?: number;
  state?: 'active' | 'paused' | 'pulled';
  /** RFC 3339; for mandatory/critical releases (WSOS-AUP-007). */
  deadline?: string;
  /** Present only when this release is an allowed downgrade target (WSOS-AUP-003). */
  rollback_directive?: { from_version: string; reason: string } | null;
  /** WSOS-AUP-012: edition entitlement a feature release needs (e.g. "business"); absent = everyone. */
  entitlement?: string;
  /** Update Manager: a version upgrade (not a patch release). Scheduled separately: in Automatic mode it installs only
   *  in the maintenance window, otherwise it waits for the person (or the deadline, when mandatory). */
  upgrade?: boolean;
  /** What the Update Manager shows before installing: plain-text release notes, a link to the full notes, and sizes. */
  notes?: string;
  notes_url?: string;
  download_bytes?: number;
  installed_bytes?: number;
  signature: string;
}

/** Signed device licence from desktop/v1/os/licence (CoreLicenseService state for this device's organization). */
export interface Licence {
  device_id: string;
  edition: string;
  state: 'active' | 'grace' | 'expired';
  entitlements: string[];
  grace_until?: string | null;
  issued_at: string;
  /** Short-lived so an old "active" licence can't be replayed after it lapses. */
  valid_until: string;
  signature: string;
}

/** Deterministic JSON with sorted keys (same form the server signs). */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

/** WSOS-AUP-002: "<key_id>:<base64 Ed25519>" over the canonical manifest without its signature. */
export function verifyManifest(m: unknown, keys: (id: string) => KeyObject | undefined): m is Manifest {
  if (!m || typeof m !== 'object') return false;
  const sig = (m as { signature?: unknown }).signature;
  if (typeof sig !== 'string') return false;
  const [keyId, value] = sig.split(':', 2);
  const key = value ? keys(keyId) : undefined;
  if (!key) return false;
  const { signature: _s, ...rest } = m as Record<string, unknown>;
  try { return verify(null, Buffer.from(canonical(rest)), key, Buffer.from(value, 'base64')); } catch { return false; }
}

/** WSOS-AUP-012: a licence counts only if signed by a release key, for this device, and still within valid_until. */
export function verifyLicence(l: unknown, keys: (id: string) => KeyObject | undefined, deviceId: string, now: Date): l is Licence {
  if (!verifyManifest(l, keys)) return false;
  const x = l as unknown as Licence;
  if (x.device_id !== deviceId || !['active', 'grace', 'expired'].includes(x.state) || !Array.isArray(x.entitlements)) return false;
  const until = Date.parse(x.valid_until);
  return !Number.isNaN(until) && now.getTime() <= until;
}

/** Numeric-aware version compare for "1.0.2", "1.0.0~dev1", "1.1.0-2". Tilde sorts before anything (Debian style). */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => v.split(/(~|\d+|[^\d~]+)/).filter(Boolean);
  const pa = split(a), pb = split(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (x === y) continue;
    if (x === '~') return -1;
    if (y === '~') return 1;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y) || 0;
    if (nx !== ny) return nx ? 1 : -1;   // "1.0.1" > "1.0.a"
    return x < y ? -1 : 1;
  }
  return 0;
}

/** WSOS-AUP-006: stable 0–99 bucket per device and release, so a rollout widens without reshuffling devices. */
export function rolloutBucket(deviceKey: string, releaseId: string): number {
  return createHash('sha256').update(`${deviceKey}\0${releaseId}`).digest().readUInt32BE(0) % 100;
}

/** Maintenance window "HH:MM-HH:MM" (local time), may wrap midnight. No window = any time. */
export function inWindow(window: string | undefined, now: Date): boolean {
  const m = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(window ?? '');
  if (!m) return !window;
  const t = now.getHours() * 60 + now.getMinutes();
  const a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4];
  return a <= b ? t >= a && t < b : t >= a || t < b;
}

export interface DecideInput {
  manifest: Manifest;
  installed: string;                    // current OS version
  managed: boolean;
  mode: Mode;                           // from policy; Manual is honoured only on unmanaged (personal) devices
  window?: string;
  deviceKey: string;
  now: Date;
  idle: boolean;                        // no user activity / at the lock screen
  metered: boolean;
  deferrals: number;                    // deferrals already used for this release
  /** Verified licence; null on personal devices or when none could be fetched (WSOS-AUP-012). */
  licence?: Licence | null;
  /**
   * Policy security_auto_patch (#38): 'window' (default) installs security releases in the maintenance window or at
   * idle; 'immediate' as soon as they are verified; 'off' treats them like any other release of the update mode.
   */
  securityPatch?: 'immediate' | 'window' | 'off';
}

export type Decision =
  | { action: 'none'; reason: 'up_to_date' | 'paused' | 'pulled' | 'not_in_rollout' | 'manual_mode' | 'not_entitled' }
  | { action: 'refuse'; reason: 'downgrade' }
  | { action: 'wait'; reason: 'metered' | 'outside_window' | 'waiting_for_user' | 'not_idle' | 'major_upgrade' }
  | { action: 'install'; reason: 'automatic' | 'security' | 'deadline' | 'user' }
  | { action: 'warn_restart'; minutes: 15 };

export const MAX_DEFERRALS = 3;
const flagged = (m: Manifest) => !!(m.mandatory || m.critical);

/** What to do with one verified manifest right now. */
export function decide(i: DecideInput): Decision {
  const m = i.manifest;
  const cmp = compareVersions(m.version, i.installed);
  if (cmp === 0) return { action: 'none', reason: 'up_to_date' };
  // WSOS-AUP-003: going backwards needs a signed rollback directive naming the installed version.
  if (cmp < 0 && m.rollback_directive?.from_version !== i.installed) return { action: 'refuse', reason: 'downgrade' };
  // min_version is the oldest supported version: a device below it treats the release as mandatory.
  const urgent = (x: Manifest) => flagged(x) || compareVersions(i.installed, x.min_version) < 0;
  // WSOS-AUP-006: paused or pulled releases stop installing within one check cycle.
  if (m.state === 'pulled') return { action: 'none', reason: 'pulled' };
  if (m.state === 'paused') return { action: 'none', reason: 'paused' };
  // WSOS-AUP-012: feature releases may need an edition entitlement; security releases keep installing during the
  // licence grace period. Nothing here ever removes anything: an unentitled device simply stays where it is.
  if (m.entitlement) {
    const l = i.licence;
    const entitled = !!l && l.entitlements.includes(m.entitlement) && (l.state === 'active' || (l.state === 'grace' && !!m.security));
    if (!entitled) return { action: 'none', reason: 'not_entitled' };
  }
  if (!urgent(m) && !m.security && rolloutBucket(i.deviceKey, m.release_id) >= (m.rollout_percent ?? 100)) return { action: 'none', reason: 'not_in_rollout' };

  const mode: Mode = i.mode === 'manual' && i.managed ? 'notify' : i.mode;   // WSOS-AUP-004: Manual is personal-only
  if (mode === 'manual') return { action: 'none', reason: 'manual_mode' };

  // WSOS-AUP-007: past the deadline (or out of deferrals) a mandatory/critical release installs after a 15-min warning.
  const deadline = m.deadline ? Date.parse(m.deadline) : NaN;
  if (urgent(m) && ((!Number.isNaN(deadline) && i.now.getTime() >= deadline) || i.deferrals >= MAX_DEFERRALS)) return { action: 'warn_restart', minutes: 15 };

  // WSOS-AUP-008: metered connections wait unless the release is critical.
  if (i.metered && !m.critical) return { action: 'wait', reason: 'metered' };

  // WSOS-AUP-005: security releases install in Automatic and Notify; policy may apply them at once or not specially.
  const sp = i.securityPatch ?? 'window';
  if (m.security && sp === 'immediate') return { action: 'install', reason: 'security' };
  if (m.security && sp === 'window') return inWindow(i.window, i.now) || i.idle ? { action: 'install', reason: 'security' } : { action: 'wait', reason: 'outside_window' };
  if (mode === 'notify') return { action: 'wait', reason: 'waiting_for_user' };
  // Major upgrades are scheduled apart from routine updates: only in the maintenance window, else the person chooses.
  if (m.upgrade) return i.window && inWindow(i.window, i.now) ? { action: 'install', reason: 'automatic' } : { action: 'wait', reason: 'major_upgrade' };
  // Automatic: install at idle or in the maintenance window (WSOS-UPD-003).
  if (i.window ? inWindow(i.window, i.now) : i.idle) return { action: 'install', reason: 'automatic' };
  return { action: 'wait', reason: i.window ? 'outside_window' : 'not_idle' };
}

/** WSOS-AUP-007: may the user defer this release once more? */
export function canDefer(m: Manifest, installed: string, deferrals: number, now: Date): boolean {
  if (!flagged(m) && compareVersions(installed, m.min_version) >= 0) return true;
  const deadline = m.deadline ? Date.parse(m.deadline) : NaN;
  return deferrals < MAX_DEFERRALS && (Number.isNaN(deadline) || now.getTime() < deadline);
}
