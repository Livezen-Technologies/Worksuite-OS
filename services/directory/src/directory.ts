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

export interface DirectoryUser { username: string; user_id: number; name: string; groups: string[]; offline_login_days: number }
export interface CacheEntry extends DirectoryUser { salt: string; verifier: string; cached_at: number }
export interface AuditEvent { id: string; type: 'used' | 'rotated'; username: string; at: string }

export class ServerError extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string) { super(`${status} ${code}`); this.status = status; this.code = code; }
}

export interface Server {
  /** Throws ServerError (status 0 = unreachable / not enrolled). */
  authenticate(username: string, password: string): Promise<DirectoryUser>;
  directory(): Promise<{ escrow_public_key?: string; offline_login_days?: number; group_role_map?: Record<string, string> }>;
  escrow(body: { username: string; encrypted_secret: string; rotated_at: string }): Promise<void>;
  event(e: AuditEvent): Promise<void>;
}

export interface Store {
  cache(): Record<string, CacheEntry>;
  saveCache(c: Record<string, CacheEntry>): void;
  pending(): AuditEvent[];
  savePending(p: AuditEvent[]): void;
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

export type AuthResult = 'ok' | 'ok_offline' | 'not_directory' | 'denied' | 'disabled' | 'expired_cache' | 'unavailable' | 'uid_conflict';

export async function authenticate(d: Deps, user: string, password: string): Promise<AuthResult> {
  const now = (d.now ?? Date.now)();
  const name = user.trim().toLowerCase();
  if (!DIRECTORY_NAME.test(name) || name !== user) return 'not_directory';
  if (!password) return 'denied';
  let u: DirectoryUser;
  try {
    u = await d.server.authenticate(name, password);
  } catch (e) {
    const err = e instanceof ServerError ? e : new ServerError(0, 'NETWORK');
    const cache = d.store.cache();
    if (err.status === 403 && err.code === 'ACCOUNT_DISABLED') {
      delete cache[name]; d.store.saveCache(cache);
      if (d.accounts.uid(name) !== null) await d.accounts.lock(name);
      d.log(`directory: ${name} refused: account disabled; offline cache removed`);
      return 'disabled';
    }
    if (err.status !== 0) {
      d.log(`directory: ${name} refused by server (${err.code})`);
      return 'denied';
    }
    const c = cache[name];
    if (!c) { d.log(`directory: ${name} refused: server unreachable and no offline cache`); return 'unavailable'; }
    if (now - c.cached_at > c.offline_login_days * DAY) {
      d.log(`directory: ${name} refused: offline cache older than ${c.offline_login_days} days`);
      return 'expired_cache';
    }
    const ok = timingSafeEqual(verifier(password, Buffer.from(c.salt, 'base64')), Buffer.from(c.verifier, 'base64'));
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
  cache[name] = { ...u, username: name, salt: salt.toString('base64'), verifier: verifier(password, salt).toString('base64'), cached_at: now };
  d.store.saveCache(cache);
  d.log(`directory: ${name} signed in (uid ${uid})`);
  return 'ok';
}

async function flush(d: Deps) {
  const left: AuditEvent[] = [];
  for (const e of d.store.pending()) { try { await d.server.event(e); } catch { left.push(e); } }
  d.store.savePending(left);
}

async function audit(d: Deps, type: AuditEvent['type']) {
  const e: AuditEvent = { id: randomUUID(), type, username: BREAK_GLASS_USER, at: new Date((d.now ?? Date.now)()).toISOString() };
  d.store.savePending([...d.store.pending(), e]);
  await flush(d);
}

/** pam_exec session hook: one-time use of the break-glass admin. */
export async function session(d: Deps, user: string): Promise<void> {
  if (user !== BREAK_GLASS_USER) return;
  d.log(`break-glass: ${BREAK_GLASS_USER} session opened; password invalidated, rotation started`);
  await d.accounts.lock(BREAK_GLASS_USER);
  await audit(d, 'used');
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
