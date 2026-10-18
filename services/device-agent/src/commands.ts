// Remote command envelope validation (WSOS-MDM-003, WSOS-MDM-004, WSOS-MDM-006, WSOS-WIPE-004).
// There is deliberately no "RunShell"/"Exec" command: unknown commands are rejected.
import { verify, type KeyObject } from 'node:crypto';
import { DIAGNOSTIC_PROFILES } from './diagnostics.ts';

export const ALLOWED_COMMANDS = [
  'RefreshPolicy',
  'InstallApprovedApplication',
  'ScheduleUpdate',
  'RequestLock',
  'RebootDuringWindow',
  'CollectApprovedDiagnostics',
  'RemoteWipe',
] as const;
export type CommandName = (typeof ALLOWED_COMMANDS)[number];

const DAY = 86_400_000;
/** Max lifetime issued_at → expires_at. Wipe: 30 days (WSOS-WIPE-004). */
const MAX_TTL: Record<CommandName, number> = {
  RefreshPolicy: 7 * DAY,
  InstallApprovedApplication: 7 * DAY,
  ScheduleUpdate: 30 * DAY,
  RequestLock: 7 * DAY,
  RebootDuringWindow: 30 * DAY,
  CollectApprovedDiagnostics: 7 * DAY,
  RemoteWipe: 30 * DAY,
};
const CLOCK_SKEW_MS = 5 * 60_000;

export interface CommandEnvelope {
  id: string;                 // unique, server-assigned (UUID)
  command: CommandName;
  device_id: string;          // binding: must equal this device's enrolled id
  issued_at: string;          // RFC 3339
  expires_at: string;         // RFC 3339
  args: Record<string, unknown>;
  signature: { alg: 'ed25519'; key_id: string; value: string }; // base64 over canonical(envelope minus signature)
}

export type Rejection =
  | 'MALFORMED' | 'UNKNOWN_COMMAND' | 'WRONG_DEVICE' | 'NOT_YET_VALID' | 'EXPIRED'
  | 'TTL_TOO_LONG' | 'SIGNATURE_MISSING' | 'UNKNOWN_KEY' | 'BAD_SIGNATURE' | 'REPLAY' | 'BAD_ARGS';

export type Validation = { ok: true; envelope: CommandEnvelope } | { ok: false; reason: Rejection; detail?: string };

/** Persistent record of accepted command ids, kept until their expiry. Root-owned file/DB in production. */
export interface ReplayStore {
  has(id: string): boolean;
  add(id: string, expiresAtMs: number): void;
  prune(nowMs: number): void;
}

export class MemoryReplayStore implements ReplayStore {
  private m = new Map<string, number>();
  has(id: string) { return this.m.has(id); }
  add(id: string, exp: number) { this.m.set(id, exp); }
  prune(now: number) { for (const [k, v] of this.m) if (v < now) this.m.delete(k); }
}

/** Deterministic JSON: sorted keys, no whitespace. Signature field excluded by caller. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

export function signingBytes(env: Omit<CommandEnvelope, 'signature'> & { signature?: unknown }): Buffer {
  const { signature: _s, ...rest } = env;
  return Buffer.from(canonical(rest), 'utf8');
}

const ARG_CHECKS: Partial<Record<CommandName, (a: Record<string, unknown>) => boolean>> = {
  InstallApprovedApplication: (a) => typeof a.catalog_id === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(a.catalog_id),
  RemoteWipe: (a) => (a.scope === 'worksuite_data' || a.scope === 'full_device') && typeof a.approval_id === 'string',
  CollectApprovedDiagnostics: (a) => (DIAGNOSTIC_PROFILES as readonly unknown[]).includes(a.bundle_profile),
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ValidatorDeps {
  deviceId: string;
  keys: (keyId: string) => KeyObject | undefined;   // server command-signing public keys
  replay: ReplayStore;
  now?: () => number;
}

/**
 * Validate an untrusted command. On success the id is recorded (single-use) — call only when
 * about to execute. Never logs the signature or args values (WSOS-SEC-008).
 */
export function validateCommand(input: unknown, deps: ValidatorDeps): Validation {
  const now = (deps.now ?? Date.now)();
  if (!input || typeof input !== 'object') return { ok: false, reason: 'MALFORMED' };
  const e = input as Partial<CommandEnvelope>;
  if (typeof e.id !== 'string' || !UUID.test(e.id)) return { ok: false, reason: 'MALFORMED', detail: 'id' };
  if (typeof e.command !== 'string' || !(ALLOWED_COMMANDS as readonly string[]).includes(e.command)) return { ok: false, reason: 'UNKNOWN_COMMAND' };
  if (typeof e.device_id !== 'string' || typeof e.issued_at !== 'string' || typeof e.expires_at !== 'string'
    || !e.args || typeof e.args !== 'object' || Array.isArray(e.args)) return { ok: false, reason: 'MALFORMED' };
  if (!e.signature || typeof e.signature.value !== 'string' || !e.signature.value || typeof e.signature.key_id !== 'string')
    return { ok: false, reason: 'SIGNATURE_MISSING' };
  if (e.signature.alg !== 'ed25519') return { ok: false, reason: 'BAD_SIGNATURE', detail: 'alg' };

  const key = deps.keys(e.signature.key_id);
  if (!key) return { ok: false, reason: 'UNKNOWN_KEY' };
  if (!verify(null, signingBytes(e as CommandEnvelope), key, Buffer.from(e.signature.value, 'base64')))
    return { ok: false, reason: 'BAD_SIGNATURE' };

  // Checks below run only on authentic data.
  if (e.device_id !== deps.deviceId) return { ok: false, reason: 'WRONG_DEVICE' };
  const issued = Date.parse(e.issued_at), expires = Date.parse(e.expires_at);
  if (Number.isNaN(issued) || Number.isNaN(expires) || expires <= issued) return { ok: false, reason: 'MALFORMED', detail: 'times' };
  if (issued > now + CLOCK_SKEW_MS) return { ok: false, reason: 'NOT_YET_VALID' };
  if (expires <= now) return { ok: false, reason: 'EXPIRED' };
  if (expires - issued > MAX_TTL[e.command as CommandName]) return { ok: false, reason: 'TTL_TOO_LONG' };
  const argCheck = ARG_CHECKS[e.command as CommandName];
  if (argCheck && !argCheck(e.args)) return { ok: false, reason: 'BAD_ARGS' };

  deps.replay.prune(now);
  if (deps.replay.has(e.id)) return { ok: false, reason: 'REPLAY' };
  deps.replay.add(e.id, expires);
  return { ok: true, envelope: e as CommandEnvelope };
}
