// Kiosk device policy (WSOS-AUTH-002, SRS §2.3 "Kiosk / shared device: single app, auto-login, locked-down account").
// The admin sets it in the console; devices listed in `devices` run the kiosk session for `user` (worksuite-autologin
// --kiosk), see services/device-agent/src/kiosk.ts. The exit PIN is never stored: the console sends `exit_pin` once,
// the server keeps only an scrypt verifier, and the admin API shows `exit_pin_set` instead of the verifier.
import { randomBytes, scryptSync } from 'node:crypto';
import { invalid } from './http.ts';

/** WorkSuite Desktop modules (shell/electron/xdg.ts DESKTOP_MODULES). */
export const KIOSK_MODULES = ['home', 'mail', 'chat', 'calendar', 'tasks', 'files', 'crm', 'hr'] as const;
const USER = /^[a-z_][a-z0-9_.@-]{0,63}$/;
const DESKTOP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.desktop$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** `https://host[:port][/path-prefix]`, host may start with `*.`; no query, fragment, credentials or spaces. */
const URL_PATTERN = /^https:\/\/(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?(\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/;
/** scrypt$N$r$p$salt(b64)$hash(b64), shared with services/session/kiosk/worksuite_kiosk.py. */
export const VERIFIER = /^scrypt\$(16384|32768|65536)\$8\$1\$[A-Za-z0-9+/]{22,24}={0,2}\$[A-Za-z0-9+/]{43}=$/;
const SCRYPT_N = 32768;

export type KioskApp = { type: 'url'; url: string } | { type: 'module'; id: string } | { type: 'desktop'; id: string };
export interface KioskPolicy {
  enabled: boolean;
  user?: string;
  devices?: string[];
  app?: KioskApp;
  allowed_urls?: string[];
  idle_reset_minutes?: number;
  show_on_screen_keyboard?: boolean;
  allow_exit_pin?: boolean;
  exit_pin_verifier?: string;
}

export function pinVerifier(pin: string, salt: Buffer = randomBytes(16)): string {
  const hash = scryptSync(pin.normalize('NFKC'), salt, 32, { N: SCRYPT_N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT_N}$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export const kioskUrlPattern = (v: unknown): v is string => typeof v === 'string' && v.length <= 300 && URL_PATTERN.test(v);

function app(v: unknown): KioskApp {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid('kiosk.app', 'choose a web address, a WorkSuite module or an installed app');
  const a = v as Record<string, unknown>;
  if (a.type === 'url') {
    if (typeof a.url !== 'string' || a.url.length > 2000) throw invalid('kiosk.app.url', 'must be an https address');
    let u: URL;
    try { u = new URL(a.url); } catch { throw invalid('kiosk.app.url', 'must be an https address'); }
    if (u.protocol !== 'https:' || u.username || u.password) throw invalid('kiosk.app.url', 'must be an https address without credentials');
    return { type: 'url', url: u.toString() };
  }
  if (a.type === 'module' && (KIOSK_MODULES as readonly unknown[]).includes(a.id)) return { type: 'module', id: a.id as string };
  if (a.type === 'desktop' && typeof a.id === 'string' && DESKTOP_ID.test(a.id)) return { type: 'desktop', id: a.id };
  throw invalid('kiosk.app', 'choose a web address, a WorkSuite module or an installed app (.desktop id)');
}

/**
 * Validates the `kiosk` policy field. `current` is the stored kiosk policy: `exit_pin_set: true` without a new
 * `exit_pin` keeps its verifier. The result never contains the PIN.
 */
export function normalizeKiosk(v: unknown, current?: KioskPolicy | null): KioskPolicy {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid('kiosk', 'must be an object');
  const k = v as Record<string, unknown>;
  const known = new Set(['enabled', 'user', 'devices', 'app', 'allowed_urls', 'idle_reset_minutes', 'show_on_screen_keyboard', 'allow_exit_pin', 'exit_pin', 'exit_pin_set', 'exit_pin_verifier']);
  for (const key of Object.keys(k)) if (!known.has(key)) throw invalid('kiosk.' + key, 'unknown kiosk field');
  if (typeof k.enabled !== 'boolean') throw invalid('kiosk.enabled', 'must be true or false');
  const out: KioskPolicy = { enabled: k.enabled };
  if (k.user !== undefined && k.user !== '') {
    if (typeof k.user !== 'string' || !USER.test(k.user) || k.user === 'root' || k.user === 'wsadmin') throw invalid('kiosk.user', 'must be a local account name other than root or wsadmin');
    out.user = k.user;
  }
  if (k.devices !== undefined) {
    if (!Array.isArray(k.devices) || k.devices.length > 10_000 || !k.devices.every((d) => typeof d === 'string' && DEVICE_ID.test(d))) throw invalid('kiosk.devices', 'must be a list of device IDs');
    out.devices = [...new Set(k.devices as string[])];
  }
  if (k.app !== undefined && k.app !== null) out.app = app(k.app);
  if (k.allowed_urls !== undefined) {
    if (!Array.isArray(k.allowed_urls) || k.allowed_urls.length > 100) throw invalid('kiosk.allowed_urls', 'at most 100 addresses');
    for (const u of k.allowed_urls) if (!kioskUrlPattern(u)) throw invalid('kiosk.allowed_urls', `not an https address pattern: ${String(u).slice(0, 80)}`);
    out.allowed_urls = k.allowed_urls as string[];
  }
  if (k.idle_reset_minutes !== undefined) {
    if (!Number.isInteger(k.idle_reset_minutes) || (k.idle_reset_minutes as number) < 0 || (k.idle_reset_minutes as number) > 1440) throw invalid('kiosk.idle_reset_minutes', '0 (never) to 1440');
    out.idle_reset_minutes = k.idle_reset_minutes as number;
  }
  if (k.show_on_screen_keyboard !== undefined) {
    if (typeof k.show_on_screen_keyboard !== 'boolean') throw invalid('kiosk.show_on_screen_keyboard', 'must be true or false');
    out.show_on_screen_keyboard = k.show_on_screen_keyboard;
  }
  if (k.allow_exit_pin !== undefined && typeof k.allow_exit_pin !== 'boolean') throw invalid('kiosk.allow_exit_pin', 'must be true or false');
  // A verifier is only ever made here from a PIN, or carried over from the stored policy; never accepted from the client.
  if (k.exit_pin_verifier !== undefined) throw invalid('kiosk.exit_pin_verifier', 'set exit_pin instead');
  if (k.allow_exit_pin === true) {
    out.allow_exit_pin = true;
    if (k.exit_pin !== undefined && k.exit_pin !== '') {
      if (typeof k.exit_pin !== 'string' || !/^\d{6,12}$/.test(k.exit_pin)) throw invalid('kiosk.exit_pin', '6 to 12 digits');
      if (/^(\d)\1+$/.test(k.exit_pin) || '0123456789012345678909876543210'.includes(k.exit_pin)) throw invalid('kiosk.exit_pin', 'too easy to guess');
      out.exit_pin_verifier = pinVerifier(k.exit_pin);
    } else if (k.exit_pin_set === true && current?.exit_pin_verifier && VERIFIER.test(current.exit_pin_verifier)) {
      out.exit_pin_verifier = current.exit_pin_verifier;
    } else throw invalid('kiosk.exit_pin', 'set an exit PIN, or turn the exit PIN off');
  }
  if (out.enabled) {
    if (!out.user) throw invalid('kiosk.user', 'required when kiosk mode is on');
    if (!out.app) throw invalid('kiosk.app', 'required when kiosk mode is on');
    if (!out.devices?.length) throw invalid('kiosk.devices', 'choose at least one device');
  }
  return out;
}

/** What the admin API shows: the verifier is replaced by `exit_pin_set`. */
export function redactKiosk(k: KioskPolicy | undefined | null): Record<string, unknown> | undefined {
  if (!k) return undefined;
  const { exit_pin_verifier, ...rest } = k;
  return { ...rest, exit_pin_set: !!exit_pin_verifier };
}
