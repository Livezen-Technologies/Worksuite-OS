// WorkSuite directory sign-in for the OS (SRS §14.4, WSOS-DIR-002…010), run by pam_exec as root.
//
//  auth     PAM_USER + password (stdin) → server `desktop/v1/os/directory/authenticate` with the device credential.
//           Online: the server decides; a disabled account loses its offline cache and its local account is locked.
//           Offline (network error only): a local scrypt verifier, valid for the policy's offline_login_days.
//           On success the local account exists with a stable UID (UID_BASE + server user id) and its role groups.
//  session  On a break-glass admin session: audit (journal + server event), lock the password at once and start a
//           rotation, so each escrowed password works exactly once.
//  rotate   New random break-glass password, escrowed (RSA-OAEP to the org key) BEFORE it is set; without escrow the
//           account stays locked.
//
// Passwords never reach argv, the environment, logs or disk; only a salted scrypt verifier is stored.
import { constants, publicEncrypt, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

export const UID_BASE = 200_000;
export const BREAK_GLASS_USER = 'wsadmin';
const DAY = 86_400_000;
/** Directory accounts are e-mail style (name@domain); anything else is a local account and is left to pam_unix. */
export const DIRECTORY_NAME = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,63}$/;

export interface DirectoryUser { username: string; user_id: number; name: string; groups: string[]; offline_login_days: number; mfa?: boolean; allow_offline_mfa_bypass?: boolean; login_code?: string }
export interface CacheEntry extends Omit<DirectoryUser, 'login_code'> { salt: string; verifier: string; cached_at: number }
/** Non-secret settings the greeter shows (WSOS-DIR-002). */
export interface GreeterConfig { domain?: string; netbios_domain?: string; upn_suffixes?: string[]; org_name?: string; server_host?: string }
/** Greeter status for a name after a failed sign-in: shown, never secret (WSOS-DIR-007/009). */
export type NameStatus = 'expired' | 'mfa';

/**
 * WSOS-DIR-007: the WorkSuite greeter answers the PAM password prompt with this frame to change an expired password:
 * ESC "WSCHG" US old US new. pam_exec has one secret prompt, so the frame carries both; it lives only in memory.
 */
export const CHANGE_PREFIX = '\x1bWSCHG\x1f';
export function parseChange(secret: string): { old: string; next: string } | null {
  if (!secret.startsWith(CHANGE_PREFIX)) return null;
  const rest = secret.slice(CHANGE_PREFIX.length);
  const i = rest.indexOf('\x1f');
  if (i < 0) return null;
  return { old: rest.slice(0, i), next: rest.slice(i + 1) };
}
/** Password part of "password + 6-digit code" for accounts with a second factor. */
export const withoutCode = (s: string) => s.replace(/\d{6}$/, '');
export interface AuditEvent { id: string; type: 'used' | 'rotated'; username: string; at: string; reason?: string }

export class ServerError extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string) { super(`${status} ${code}`); this.status = status; this.code = code; }
}

export interface Server {
  /** Throws ServerError (status 0 = unreachable / not enrolled). */
  authenticate(username: string, password: string): Promise<DirectoryUser>;
  /** WSOS-DIR-007: change the password; succeeds with the same reply as authenticate. */
  changePassword(username: string, oldPassword: string, newPassword: string): Promise<DirectoryUser>;
  /** Server URL of the enrolled device (for the login-code handoff). */
  serverUrl(): string | null;
  directory(): Promise<{ escrow_public_key?: string; offline_login_days?: number; group_role_map?: Record<string, string> } & GreeterConfig>;
  escrow(body: { username: string; encrypted_secret: string; rotated_at: string }): Promise<void>;
  event(e: AuditEvent): Promise<void>;
}

export interface Store {
  cache(): Record<string, CacheEntry>;
  saveCache(c: Record<string, CacheEntry>): void;
  pending(): AuditEvent[];
  savePending(p: AuditEvent[]): void;
  /** Status the greeter reads for this name (null clears it). */
  markName(name: string, status: NameStatus | null): void;
  /** WSOS-DIR-008: hand the one-time login code to the user's session (file owned by uid, mode 0600). */
  handoff(name: string, uid: number, data: { server_url: string; login_code: string; username: string }): void;
  saveGreeterConfig(c: GreeterConfig): void;
  /** G04: the reason typed at the greeter for a break-glass sign-in (read once, then removed). */
  takeBreakGlassReason?(): string | null;
}

/** G04: when each cached account's offline sign-in stops working, so the greeter can show the days left. */
export function offlineUntil(cache: Record<string, CacheEntry>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, c] of Object.entries(cache)) out[name] = c.cached_at + c.offline_login_days * DAY;
  return out;
}

export interface Accounts {
  /** uid of an existing local account, or null. */
  uid(name: string): number | null;
  create(name: string, uid: number, comment: string): Promise<void>;
  setGroups(name: string, groups: string[]): Promise<void>;
  lock(name: string): Promise<void>;
  unlock(name: string): Promise<void>;
  /** Sets the password through chpasswd's stdin. */
  setPassword(name: string, password: string): Promise<void>;
  startRotation(): Promise<void>;
}

export interface Deps { server: Server; store: Store; accounts: Accounts; log: (msg: string) => void; now?: () => number }

/** Local groups per directory group; administrators get sudo (WSOS-DIR-006). */
export function localGroups(groups: string[], map: Record<string, string> = {}): string[] {
  const roles = new Set(groups.map((g) => map[g] ?? (g === 'worksuite-admins' ? 'administrator' : 'standard')));
  return roles.has('administrator') ? ['sudo'] : [];
}

const verifier = (password: string, salt: Buffer) => scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });

export type AuthResult = 'ok' | 'ok_offline' | 'not_directory' | 'denied' | 'disabled' | 'expired_cache' | 'unavailable' | 'uid_conflict' | 'password_expired' | 'mfa_required';

export async function authenticate(d: Deps, user: string, secretText: string): Promise<AuthResult> {
  let password = secretText;
  const now = (d.now ?? Date.now)();
  const name = user.trim().toLowerCase();
  if (!DIRECTORY_NAME.test(name) || name !== user) return 'not_directory';
  if (!password) return 'denied';
  const change = parseChange(password);
  if (change && (!change.old || !change.next)) return 'denied';
  let u: DirectoryUser;
  try {
    u = change ? await d.server.changePassword(name, change.old, change.next) : await d.server.authenticate(name, password);
  } catch (e) {
    const err = e instanceof ServerError ? e : new ServerError(0, 'NETWORK');
    if (change && err.status === 0) { d.log(`directory: ${name} password change needs the server`); return 'unavailable'; }
    if (change && err.status === 400) { d.log(`directory: ${name} password change refused (${err.code})`); d.store.markName(name, 'expired'); return 'password_expired'; }
    if (err.status === 401 && err.code === 'PASSWORD_EXPIRED') {
      d.store.markName(name, 'expired');
      d.log(`directory: ${name} password expired; the greeter asks for a new one`);
      return 'password_expired';
    }
    if (err.status === 401 && err.code === 'MFA_REQUIRED') {
      d.store.markName(name, 'mfa');
      d.log(`directory: ${name} needs a verification code`);
      return 'mfa_required';
    }
    if (change) password = change.old;
    const cache = d.store.cache();
    if (err.status === 403 && err.code === 'ACCOUNT_DISABLED') {
      delete cache[name]; d.store.saveCache(cache);
      if (d.accounts.uid(name) !== null) await d.accounts.lock(name);
      d.log(`directory: ${name} refused: account disabled; offline cache removed`);
      return 'disabled';
    }
    if (err.status !== 0) {
      d.store.markName(name, null);
      d.log(`directory: ${name} refused by server (${err.code})`);
      return 'denied';
    }
    const c = cache[name];
    if (!c) { d.log(`directory: ${name} refused: server unreachable and no offline cache`); return 'unavailable'; }
    if (now - c.cached_at > c.offline_login_days * DAY) {
      d.log(`directory: ${name} refused: offline cache older than ${c.offline_login_days} days`);
      return 'expired_cache';
    }
    // A second factor cannot be checked offline (the TOTP secret stays on the server). Unless the directory policy
    // allows it (allow_offline_mfa_bypass, default false), accounts with one do not sign in offline at all.
    if (c.mfa && c.allow_offline_mfa_bypass !== true) {
      d.log(`directory: ${name} refused offline: the account has a second factor and the policy needs the server`);
      return 'unavailable';
    }
    const offlinePw = c.mfa ? withoutCode(password) : password;
    const ok = timingSafeEqual(verifier(offlinePw, Buffer.from(c.salt, 'base64')), Buffer.from(c.verifier, 'base64'));
    if (!ok) { d.log(`directory: ${name} refused offline: wrong password`); return 'denied'; }
    if (d.accounts.uid(name) === null) return 'unavailable';
    d.log(`directory: ${name} signed in offline (cache from ${new Date(c.cached_at).toISOString()})`);
    return 'ok_offline';
  }
  const uid = UID_BASE + u.user_id;
  const existing = d.accounts.uid(name);
  if (existing !== null && existing !== uid) { d.log(`directory: ${name} refused: local uid ${existing} != directory uid ${uid}`); return 'uid_conflict'; }
  if (existing === null) await d.accounts.create(name, uid, u.name.replace(/[:,=\n]/g, ' ').slice(0, 128));
  else await d.accounts.unlock(name);
  let map: Record<string, string> | undefined;
  try { map = (await d.server.directory()).group_role_map; } catch { /* default mapping */ }
  await d.accounts.setGroups(name, localGroups(u.groups, map));
  const salt = randomBytes(16);
  const cache = d.store.cache();
  const plain = change ? change.next : u.mfa ? withoutCode(password) : password;
  const { login_code, ...record } = u;
  cache[name] = { ...record, mfa: !!u.mfa, allow_offline_mfa_bypass: u.allow_offline_mfa_bypass === true, username: name, salt: salt.toString('base64'), verifier: verifier(plain, salt).toString('base64'), cached_at: now };
  d.store.saveCache(cache);
  d.store.markName(name, null);
  const server = d.server.serverUrl();
  if (login_code && server) {
    try { d.store.handoff(name, uid, { server_url: server, login_code, username: name }); } catch { d.log(`directory: ${name} sign-in token handoff failed`); }
  }
  d.log(`directory: ${name} signed in (uid ${uid})`);
  return 'ok';
}

async function flush(d: Deps) {
  const left: AuditEvent[] = [];
  for (const e of d.store.pending()) { try { await d.server.event(e); } catch { left.push(e); } }
  d.store.savePending(left);
}

async function audit(d: Deps, type: AuditEvent['type'], reason?: string) {
  const e: AuditEvent = { id: randomUUID(), type, username: BREAK_GLASS_USER, at: new Date((d.now ?? Date.now)()).toISOString(), ...(reason ? { reason } : {}) };
  d.store.savePending([...d.store.pending(), e]);
  await flush(d);
}

/** pam_exec session hook: one-time use of the break-glass admin. */
export async function session(d: Deps, user: string): Promise<void> {
  if (user !== BREAK_GLASS_USER) return;
  d.log(`break-glass: ${BREAK_GLASS_USER} session opened; password invalidated, rotation started`);
  await d.accounts.lock(BREAK_GLASS_USER);
  let reason: string | null = null;
  try { reason = d.store.takeBreakGlassReason?.()?.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 200) || null; } catch { /* no reason */ }
  await audit(d, 'used', reason ?? undefined);
  await d.accounts.startRotation();
}

export function encryptToEscrow(pem: string, secret: string): string {
  return publicEncrypt({ key: pem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(secret)).toString('base64');
}

export function newPassword(): string {
  // 24 characters from an unambiguous alphabet (~139 bits).
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const out: string[] = [];
  while (out.length < 24) { const b = randomBytes(1)[0]; if (b < abc.length * 4) out.push(abc[b % abc.length]); }
  return out.join('');
}

export async function rotate(d: Deps): Promise<'rotated' | 'locked'> {
  if (d.accounts.uid(BREAK_GLASS_USER) === null) return 'locked';
  const pw = newPassword();
  try {
    const key = (await d.server.directory()).escrow_public_key;
    if (!key) throw new Error('no escrow key');
    await d.server.escrow({ username: BREAK_GLASS_USER, encrypted_secret: encryptToEscrow(key, pw), rotated_at: new Date((d.now ?? Date.now)()).toISOString() });
  } catch {
    await d.accounts.lock(BREAK_GLASS_USER);
    d.log('break-glass: escrow unavailable; account stays locked');
    await flush(d).catch(() => {});
    return 'locked';
  }
  await d.accounts.setPassword(BREAK_GLASS_USER, pw);
  await d.accounts.unlock(BREAK_GLASS_USER);
  await audit(d, 'rotated');
  d.log('break-glass: password rotated and escrowed');
  return 'rotated';
}

/** Boot / refresh: the non-secret settings the greeter needs to show the domain (WSOS-DIR-002). */
export async function greeterConfig(d: Deps): Promise<GreeterConfig | null> {
  try {
    const s = await d.server.directory();
    const c: GreeterConfig = { domain: s.domain, netbios_domain: s.netbios_domain, upn_suffixes: s.upn_suffixes };
    d.store.saveGreeterConfig(c);
    return c;
  } catch { return null; }
}
