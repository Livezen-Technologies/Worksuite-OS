// Directory sign-in: TOTP (WSOS-DIR-009), password expiry / change at the greeter (WSOS-DIR-007), and the OS login
// code exchanged by the session's token broker (WSOS-DIR-008).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as admin from '../src/admin.ts';
import { openDb } from '../src/db.ts';
import { createHandler } from '../src/main.ts';
import { base32Decode, base32Encode, enrollTotp, requirePasswordChange, totp } from '../src/identity.ts';
import { OS_LOGIN_CODE, TOKEN_EXCHANGE } from '../src/oauth.ts';

let dir: string, server: Server, base: string, db: ReturnType<typeof openDb>, org: number, org2: number;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ws-identity-'));
  db = openDb(join(dir, 'db'));
  org = admin.createOrg(db, 'Org A');
  org2 = admin.createOrg(db, 'Org B');
  server = createServer(createHandler(db, { publicUrl: 'https://ws.test/' }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

const call = async (path: string, body: unknown, device?: string) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(device ? { 'x-ws-device': device } : {}) }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};
async function enroll(orgId = org) {
  const r = await fetch(`${base}/desktop/v1/devices/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ enrollment_token: admin.createEnrollmentToken(db, orgId), public_key: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }), arch: 'amd64', hostname: 'h' }),
  });
  return (await r.json()) as { device_id: string; credential: string };
}
const token = async (form: Record<string, string>, device?: string) => {
  const res = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(device ? { 'x-ws-device': device } : {}) }, body: new URLSearchParams(form).toString() });
  return { status: res.status, body: await res.json() };
};

test('RFC 6238 test vector and base32 round trip', () => {
  // RFC 6238 Appendix B, SHA-1, T = 59 s → 94287082 (8 digits); 6 digits are the last six.
  const s = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totp(s, 59_000), '287082');
  assert.equal(totp(s, 1111111109_000), '081804');
  assert.deepEqual(base32Decode(s), Buffer.from('12345678901234567890'));
});

test('WSOS-DIR-009: an enrolled TOTP is required at the greeter (password + code) and codes are single use', async () => {
  const d = await enroll();
  admin.addUser(db, org, 'mfa@a.test', 'M', 'password-123');
  const uri = enrollTotp(db, 'mfa@a.test');
  const secretB32 = new URL(uri).searchParams.get('secret')!;
  const auth = (password: string, otp?: string) => call('/desktop/v1/os/directory/authenticate', { username: 'mfa@a.test', password, ...(otp ? { otp } : {}) }, d.credential);
  assert.equal((await auth('password-123')).body.error.code, 'MFA_REQUIRED');
  assert.equal((await auth('wrong-password' + totp(secretB32, Date.now()))).body.error.code, 'INVALID_CREDENTIALS');
  assert.equal((await auth('password-123000000')).body.error.code, 'INVALID_CREDENTIALS');
  const code = totp(secretB32, Date.now());
  const ok = await auth('password-123' + code);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.mfa, true);
  assert.equal((await auth('password-123' + code)).status, 401);   // replay refused
});

test('WSOS-DIR-009: the OneAuth sign-in page asks for the code too', async () => {
  admin.addUser(db, org, 'web@a.test', 'W', 'password-123');
  const s = new URL(enrollTotp(db, 'web@a.test')).searchParams.get('secret')!;
  const form = (otp: string) => new URLSearchParams({ email: 'web@a.test', password: 'password-123', otp, client_id: 'worksuite-os',
    redirect_uri: 'http://127.0.0.1:5000/callback', response_type: 'code', code_challenge_method: 'S256', code_challenge: 'a'.repeat(43), state: 'x' }).toString();
  const post = (otp: string) => fetch(`${base}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(otp) });
  const page = await (await fetch(`${base}/oauth/authorize?` + form(''))).text();
  assert.match(page, /one-time-code/);
  assert.equal((await post('')).status, 401);
  assert.equal((await post(totp(s, Date.now()))).status, 302);
});

test('WSOS-DIR-007: expired and must-change passwords are changed at the greeter, which then signs in', async () => {
  const d = await enroll();
  admin.addUser(db, org, 'exp@a.test', 'E', 'password-123');
  requirePasswordChange(db, 'exp@a.test');
  const auth = (password: string) => call('/desktop/v1/os/directory/authenticate', { username: 'exp@a.test', password }, d.credential);
  assert.equal((await auth('nope-nope-nope')).body.error.code, 'INVALID_CREDENTIALS');   // expiry is only revealed after the right password
  assert.equal((await auth('password-123')).body.error.code, 'PASSWORD_EXPIRED');
  const change = (old_password: string, new_password: string) => call('/desktop/v1/os/directory/change-password', { username: 'exp@a.test', old_password, new_password }, d.credential);
  assert.equal((await change('wrong-password', 'brand-new-pass-1')).status, 401);
  assert.equal((await change('password-123', 'short')).status, 400);
  assert.equal((await change('password-123', 'password-123')).status, 400);
  const ok = await change('password-123', 'brand-new-pass-1');
  assert.equal(ok.status, 200);
  assert.ok(ok.body.login_code);
  assert.equal((await auth('password-123')).status, 401);
  assert.equal((await auth('brand-new-pass-1')).status, 200);

  // Maximum password age from the directory settings.
  admin.setDirectory(db, org, { offline_login_days: 7, password_max_age_days: 30 });
  db.prepare('UPDATE users SET pw_changed_at = ? WHERE email = ?').run(Date.now() - 31 * 86_400_000, 'exp@a.test');
  assert.equal((await auth('brand-new-pass-1')).body.error.code, 'PASSWORD_EXPIRED');
  admin.setDirectory(db, org, { offline_login_days: 7 });
  assert.throws(() => admin.setDirectory(db, org, { run: 'x' }));
  assert.throws(() => admin.setDirectory(db, org, { netbios_domain: 'bad domain' }));
});

test('WSOS-DIR-008: the login code becomes tokens once, only with the same device', async () => {
  const d = await enroll();
  const other = await enroll();
  const foreign = await enroll(org2);
  admin.addUser(db, org, 'sso@a.test', 'S', 'password-123');
  const login = async () => (await call('/desktop/v1/os/directory/authenticate', { username: 'sso@a.test', password: 'password-123' }, d.credential)).body.login_code as string;
  const form = (code: string) => ({ grant_type: TOKEN_EXCHANGE, subject_token_type: OS_LOGIN_CODE, subject_token: code, client_id: 'worksuite-os' });
  const c1 = await login();
  assert.equal((await token(form(c1))).status, 400);                    // no device credential
  assert.equal((await token(form(c1), other.credential)).status, 400);   // a different device (code now burnt)
  const c2 = await login();
  assert.equal((await token(form(c2), foreign.credential)).status, 400);
  const c3 = await login();
  const ok = await token(form(c3), d.credential);
  assert.equal(ok.status, 200);
  assert.ok(ok.body.access_token && ok.body.refresh_token);
  assert.equal((await token(form(c3), d.credential)).status, 400);      // single use
  const me = await fetch(`${base}/oauth/userinfo`, { headers: { authorization: `Bearer ${ok.body.access_token}` } });
  assert.equal((await me.json()).email, 'sso@a.test');
});
