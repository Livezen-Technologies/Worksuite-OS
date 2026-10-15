// Directory sign-in pieces shared by the OS PAM helper endpoints and the OneAuth login page:
//  - TOTP second factor (RFC 6238: HMAC-SHA1, 30 s, 6 digits), WSOS-DIR-009. At the greeter the code follows the
//    password ("password" + "123456"), the same convention FreeIPA uses for its PAM path, because pam_exec has a
//    single secret prompt; the WorkSuite greeter has a separate field and joins the two.
//  - Password expiry and change-at-next-login (WSOS-DIR-007).
//  - One-time OS login codes (WSOS-DIR-008): a successful directory sign-in returns a code bound to the device and
//    user that the session's token broker exchanges for tokens, so there is no second prompt.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { secret, sha256, tx } from './db.ts';
import { hashPassword } from './oauth.ts';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DAY = 86_400_000;
export const LOGIN_CODE_TTL_MS = 2 * 60_000;

export function base32Encode(b: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of b) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function totp(secretB32: string, at: number, step = 0): string {
  const counter = Math.floor(at / 30_000) + step;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const n = (h.readUInt32BE(off) & 0x7fffffff) % 1_000_000;
  return String(n).padStart(6, '0');
}

/** Accepts the current code and one step either side (clock drift); each code works once per user. */
export function verifyTotp(db: DatabaseSync, userId: number, secretB32: string, code: string, now = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  for (const step of [-1, 0, 1]) {
    const want = totp(secretB32, now, step);
    if (timingSafeEqual(Buffer.from(want), Buffer.from(code))) {
      const counter = Math.floor(now / 30_000) + step;
      const used = db.prepare('SELECT last_counter FROM totp_used WHERE user_id = ?').get(userId) as { last_counter: number } | undefined;
      if (used && used.last_counter >= counter) return false;   // replay
      db.prepare('INSERT INTO totp_used (user_id, last_counter) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET last_counter = excluded.last_counter').run(userId, counter);
      return true;
    }
  }
  return false;
}

/** Enroll (or replace) a user's TOTP secret; returns the otpauth:// URI for an authenticator app. */
export function enrollTotp(db: DatabaseSync, email: string, issuer = 'WorkSuite'): string {
  const u = db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim().toLowerCase()) as { id: number } | undefined;
  if (!u) throw new Error('no such user');
  const s = base32Encode(randomBytes(20));
  db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(s, u.id);
  db.prepare('DELETE FROM totp_used WHERE user_id = ?').run(u.id);
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email.trim().toLowerCase())}?secret=${s}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export function removeTotp(db: DatabaseSync, email: string) {
  db.prepare('UPDATE users SET totp_secret = NULL WHERE email = ?').run(email.trim().toLowerCase());
}

export interface DirUserRow {
  id: number; org_id: number; email: string; name: string; role: string; pw_salt: Uint8Array; pw_hash: Uint8Array; disabled: number;
  totp_secret: string | null; pw_changed_at: number | null; must_change_pw: number;
}

export type Verify =
  | { ok: true; user: DirUserRow }
  | { ok: false; code: 'INVALID_CREDENTIALS' | 'MFA_REQUIRED' | 'ACCOUNT_DISABLED' | 'PASSWORD_EXPIRED'; user?: DirUserRow };

/**
 * Password (+ TOTP when enrolled) check with constant scrypt work. `secretText` is the password, or the password
 * followed by the 6-digit code when `otp` is not given separately. Expiry is reported only after a correct password.
 */
export function verifyDirectoryUser(db: DatabaseSync, orgId: number | null, email: string, secretText: string, o: { otp?: string; maxAgeDays?: number; now?: number } = {}): Verify {
  const now = o.now ?? Date.now();
  const u = db.prepare(`SELECT id, org_id, email, name, role, pw_salt, pw_hash, disabled, totp_secret, pw_changed_at, must_change_pw FROM users
    WHERE email = ? ${orgId === null ? '' : 'AND org_id = ?'}`).get(...(orgId === null ? [email] : [email, orgId])) as DirUserRow | undefined;
  let password = secretText, otp = o.otp;
  if (u?.totp_secret && otp === undefined) {
    const m = /^([\s\S]*?)(\d{6})$/.exec(secretText);
    if (m) { password = m[1]; otp = m[2]; } else otp = '';
  }
  const got = scryptSync(password, u ? Buffer.from(u.pw_salt) : Buffer.alloc(16), 32);
  if (!u || !timingSafeEqual(got, Buffer.from(u.pw_hash))) return { ok: false, code: 'INVALID_CREDENTIALS' };
  if (u.totp_secret && !otp) return { ok: false, code: 'MFA_REQUIRED', user: u };
  if (u.totp_secret && !verifyTotp(db, u.id, u.totp_secret, otp!, now)) return { ok: false, code: 'INVALID_CREDENTIALS' };
  if (u.disabled) return { ok: false, code: 'ACCOUNT_DISABLED', user: u };
  if (passwordExpired(u, o.maxAgeDays, now)) return { ok: false, code: 'PASSWORD_EXPIRED', user: u };
  return { ok: true, user: u };
}

export function passwordExpired(u: Pick<DirUserRow, 'must_change_pw' | 'pw_changed_at'>, maxAgeDays: number | undefined, now = Date.now()): boolean {
  if (u.must_change_pw) return true;
  return !!maxAgeDays && u.pw_changed_at !== null && now - u.pw_changed_at > maxAgeDays * DAY;
}

/** Passwords: at least 10 characters, not the old one. */
export function setNewPassword(db: DatabaseSync, userId: number, oldPassword: string, newPassword: string, now = Date.now()) {
  if (newPassword.length < 10 || newPassword.length > 1024) throw new Error('password must be 10 to 1024 characters');
  if (newPassword === oldPassword) throw new Error('the new password must differ from the old one');
  const { salt, hash } = hashPassword(newPassword);
  db.prepare('UPDATE users SET pw_salt = ?, pw_hash = ?, pw_changed_at = ?, must_change_pw = 0 WHERE id = ?').run(salt, hash, now, userId);
}

export function requirePasswordChange(db: DatabaseSync, email: string, on = true) {
  const r = db.prepare('UPDATE users SET must_change_pw = ? WHERE email = ?').run(on ? 1 : 0, email.trim().toLowerCase());
  if (!r.changes) throw new Error('no such user');
}

/** One-time code handed to the user's session after a directory sign-in on `deviceId`. */
export function issueLoginCode(db: DatabaseSync, userId: number, deviceId: string, now = Date.now()): string {
  const code = secret('wsl');
  db.prepare('DELETE FROM login_codes WHERE expires < ?').run(now);
  db.prepare('INSERT INTO login_codes (hash, user_id, device_id, expires) VALUES (?, ?, ?, ?)').run(sha256(code), userId, deviceId, now + LOGIN_CODE_TTL_MS);
  return code;
}

/** Single use; must be presented with the same device's credential. */
export function redeemLoginCode(db: DatabaseSync, code: string, deviceId: string, now = Date.now()): number | null {
  return tx(db, () => {
    const row = db.prepare('SELECT user_id, device_id, expires FROM login_codes WHERE hash = ?').get(sha256(code)) as { user_id: number; device_id: string; expires: number } | undefined;
    db.prepare('DELETE FROM login_codes WHERE hash = ?').run(sha256(code));
    if (!row || row.expires < now || row.device_id !== deviceId) return null;
    const u = db.prepare('SELECT disabled FROM users WHERE id = ?').get(row.user_id) as { disabled: number } | undefined;
    return u && !u.disabled ? row.user_id : null;
  });
}

export const randomTotpSecret = () => base32Encode(randomBytes(20));
