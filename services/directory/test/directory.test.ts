import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, privateDecrypt, constants } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHANGE_PREFIX, authenticate, BREAK_GLASS_USER, localGroups, offlineUntil, rotate, ServerError, session, UID_BASE,
  type Accounts, type AuditEvent, type CacheEntry, type Deps, type DirectoryUser, type Server,
} from '../src/directory.ts';

const PW = 'S3cret-Pa55word!';
const DAY = 86_400_000;

function fakes(o: { online?: boolean; disabled?: boolean; escrowKey?: string; failEvents?: boolean } = {}) {
  const logs: string[] = [];
  const calls: string[] = [];
  const accounts = new Map<string, { uid: number; locked: boolean; groups: string[]; password?: string }>();
  let cache: Record<string, CacheEntry> = {};
  let pending: AuditEvent[] = [];
  const escrowed: { encrypted_secret: string }[] = [];
  const events: AuditEvent[] = [];
  const state = { pw: PW, mfa: false, mfaBypass: false, expired: false, online: o.online ?? true, disabled: o.disabled ?? false, failEvents: o.failEvents ?? false, now: Date.UTC(2026, 9, 1) };
  const marks = new Map<string, string>();
  const handoffs: { uid: number; data: { server_url: string; login_code: string } }[] = [];
  const server: Server = {
    async authenticate(u, p): Promise<DirectoryUser> {
      calls.push(`auth ${u}`);
      if (!state.online) throw new ServerError(0, 'NETWORK');
      if (state.mfa) {
        if (p === PW) throw new ServerError(401, 'MFA_REQUIRED');
        if (p !== PW + '123456') throw new ServerError(401, 'INVALID_CREDENTIALS');
      } else if (p !== state.pw) throw new ServerError(401, 'INVALID_CREDENTIALS');
      if (state.disabled) throw new ServerError(403, 'ACCOUNT_DISABLED');
      if (state.expired) throw new ServerError(401, 'PASSWORD_EXPIRED');
      return { username: u, user_id: 42, name: 'Ana Silva', groups: ['worksuite-admins'], offline_login_days: 7, mfa: state.mfa, allow_offline_mfa_bypass: state.mfaBypass, login_code: 'wsl_code' };
    },
    async changePassword(u, old, next): Promise<DirectoryUser> {
      calls.push(`change ${u}`);
      if (!state.online) throw new ServerError(0, 'NETWORK');
      if (old !== state.pw) throw new ServerError(401, 'INVALID_CREDENTIALS');
      if (next.length < 10) throw new ServerError(400, 'VALIDATION');
      state.pw = next; state.expired = false;
      return { username: u, user_id: 42, name: 'Ana Silva', groups: [], offline_login_days: 7, login_code: 'wsl_code2' };
    },
    serverUrl: () => 'https://ws.example/',
    async directory() { if (!state.online) throw new ServerError(0, 'NETWORK'); return { escrow_public_key: o.escrowKey }; },
    async escrow(b) { if (!state.online) throw new ServerError(0, 'NETWORK'); escrowed.push(b); },
    async event(e) { if (!state.online || state.failEvents) throw new ServerError(0, 'NETWORK'); events.push(e); },
  };
  const acc: Accounts = {
    uid: (n) => accounts.get(n)?.uid ?? null,
    async create(n, uid) { accounts.set(n, { uid, locked: false, groups: [] }); },
    async setGroups(n, g) { accounts.get(n)!.groups = g; },
    async lock(n) { accounts.get(n)!.locked = true; },
    async unlock(n) { accounts.get(n)!.locked = false; },
    async setPassword(n, p) { accounts.get(n)!.password = p; },
    async startRotation() { calls.push('rotate'); },
  };
  const deps: Deps = {
    server, accounts: acc, log: (m) => logs.push(m), now: () => state.now,
    store: { cache: () => structuredClone(cache), saveCache: (c) => { cache = structuredClone(c); }, pending: () => [...pending], savePending: (p) => { pending = [...p]; },
      markName: (n, st) => { if (st) marks.set(n, st); else marks.delete(n); }, handoff: (_n, uid, data) => { handoffs.push({ uid, data }); }, saveGreeterConfig: () => {} },
  };
  return { marks, handoffs, deps, logs, calls, accounts, state, escrowed, events, getCache: () => cache, getPending: () => pending };
}

test('online sign-in creates the account with a stable uid and admin role, and caches a verifier only', async () => {
  const f = fakes();
  assert.equal(await authenticate(f.deps, 'ana@corp.example', PW), 'ok');
  assert.deepEqual(f.accounts.get('ana@corp.example'), { uid: UID_BASE + 42, locked: false, groups: ['sudo'] });
  const c = f.getCache()['ana@corp.example'];
  assert.ok(c.verifier && c.salt);
  assert.equal(JSON.stringify(f.getCache()).includes(PW), false);
  assert.equal(await authenticate(f.deps, 'ana@corp.example', 'wrong'), 'denied');
});

test('local names and odd input never reach the server', async () => {
  const f = fakes();
  assert.equal(await authenticate(f.deps, 'root', PW), 'not_directory');
  assert.equal(await authenticate(f.deps, 'Ana@Corp.example', PW), 'not_directory');
  assert.equal(await authenticate(f.deps, 'a:b@corp.example', PW), 'not_directory');
  assert.deepEqual(f.calls, []);
});

test('offline sign-in works within offline_login_days and expires after', async () => {
  const f = fakes();
  await authenticate(f.deps, 'ana@corp.example', PW);
  f.state.online = false;
  f.state.now += 6 * DAY;
  assert.equal(await authenticate(f.deps, 'ana@corp.example', PW), 'ok_offline');
  assert.equal(await authenticate(f.deps, 'ana@corp.example', 'wrong'), 'denied');
  f.state.now += 2 * DAY;
  assert.equal(await authenticate(f.deps, 'ana@corp.example', PW), 'expired_cache');
  assert.equal(await authenticate(f.deps, 'new@corp.example', PW), 'unavailable');
});

test('a disabled account loses its cache and is locked', async () => {
  const f = fakes();
  await authenticate(f.deps, 'ana@corp.example', PW);
  f.state.disabled = true;
  assert.equal(await authenticate(f.deps, 'ana@corp.example', PW), 'disabled');
  assert.equal(f.getCache()['ana@corp.example'], undefined);
  assert.equal(f.accounts.get('ana@corp.example')!.locked, true);
  f.state.online = false;
  assert.equal(await authenticate(f.deps, 'ana@corp.example', PW), 'unavailable');
});

test('a uid clash with an existing local account is refused', async () => {
  const f = fakes();
  await f.deps.accounts.create('ana@corp.example', 1001, '');
  assert.equal(await authenticate(f.deps, 'ana@corp.example', PW), 'uid_conflict');
});

test('the password never appears in logs', async () => {
  const f = fakes();
  await authenticate(f.deps, 'ana@corp.example', PW);
  await authenticate(f.deps, 'ana@corp.example', 'wrong-' + PW);
  f.state.online = false;
  await authenticate(f.deps, 'ana@corp.example', PW);
  assert.ok(f.logs.length >= 3);
  for (const l of f.logs) assert.equal(l.includes(PW), false, l);
});

test('group role map: administrators get sudo, others nothing', () => {
  assert.deepEqual(localGroups(['worksuite-admins']), ['sudo']);
  assert.deepEqual(localGroups(['worksuite-users']), []);
  assert.deepEqual(localGroups(['it'], { it: 'administrator' }), ['sudo']);
  assert.deepEqual(localGroups(['worksuite-admins'], { 'worksuite-admins': 'standard' }), []);
});

test('break-glass: escrowed before set, one-time use is audited and locks the password', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const f = fakes({ escrowKey: publicKey.export({ type: 'spki', format: 'pem' }) as string });
  await f.deps.accounts.create(BREAK_GLASS_USER, 999, '');
  await f.deps.accounts.lock(BREAK_GLASS_USER);
  assert.equal(await rotate(f.deps), 'rotated');
  const acc = f.accounts.get(BREAK_GLASS_USER)!;
  assert.equal(acc.locked, false);
  const plain = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(f.escrowed[0].encrypted_secret, 'base64')).toString();
  assert.equal(plain, acc.password);
  assert.equal(plain.length, 24);
  for (const l of f.logs) assert.equal(l.includes(plain), false);
  // Use: password invalidated at once, audited, rotation started.
  await session(f.deps, BREAK_GLASS_USER);
  assert.equal(acc.locked, true);
  assert.deepEqual(f.events.map((e) => e.type), ['rotated', 'used']);
  assert.ok(f.calls.includes('rotate'));
  // Other users' sessions are not touched.
  await session(f.deps, 'ana@corp.example');
  assert.equal(f.events.length, 2);
});

test('break-glass: without escrow the account stays locked; offline audit events queue until delivered', async () => {
  const f = fakes({ escrowKey: undefined });
  await f.deps.accounts.create(BREAK_GLASS_USER, 999, '');
  assert.equal(await rotate(f.deps), 'locked');
  assert.equal(f.accounts.get(BREAK_GLASS_USER)!.locked, true);
  assert.equal(f.accounts.get(BREAK_GLASS_USER)!.password, undefined);
  f.state.failEvents = true;
  await session(f.deps, BREAK_GLASS_USER);
  assert.equal(f.getPending().length, 1);
  f.state.failEvents = false;
  await session(f.deps, BREAK_GLASS_USER);
  assert.equal(f.getPending().length, 0);
  assert.equal(f.events.length, 2);
});

test('HTTP client: password only in the request body, device credential header, https only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-dir-'));
  try {
    const agent = join(dir, 'agent.json');
    writeFileSync(agent, JSON.stringify({ server_url: 'https://ws.test/', credential: 'wsd_abc' }));
    process.env.WORKSUITE_AGENT_STATE = agent;
    const { httpServer } = await import('../src/main.ts');
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fake = (async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), headers: init.headers as Record<string, string>, body: String(init.body) });
      return new Response(JSON.stringify({ error: { code: 'ACCOUNT_DISABLED' } }), { status: 403 });
    }) as unknown as typeof fetch;
    await assert.rejects(httpServer(fake).authenticate('ana@corp.example', PW), (e: ServerError) => e.status === 403 && e.code === 'ACCOUNT_DISABLED');
    assert.equal(seen[0].url, 'https://ws.test/desktop/v1/os/directory/authenticate');
    assert.equal(seen[0].url.includes(PW), false);
    assert.equal(seen[0].headers['x-ws-device'], 'wsd_abc');
    assert.equal(JSON.parse(seen[0].body).password, PW);
    const down = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    await assert.rejects(httpServer(down).authenticate('a@b.cd', PW), (e: ServerError) => e.status === 0);
    writeFileSync(agent, JSON.stringify({ server_url: 'http://ws.test/', credential: 'wsd_abc' }));
    await assert.rejects(httpServer(fake).authenticate('a@b.cd', PW), (e: ServerError) => e.code === 'INSECURE_URL');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('WSOS-DIR-008: a successful online sign-in hands the one-time login code to the user only', async () => {
  const f = fakes();
  assert.equal(await authenticate(f.deps, 'ana@corp.example', PW), 'ok');
  assert.deepEqual(f.handoffs, [{ uid: UID_BASE + 42, data: { server_url: 'https://ws.example/', login_code: 'wsl_code', username: 'ana@corp.example' } }]);
  assert.equal(JSON.stringify(f.getCache()).includes('wsl_code'), false);   // the code is not cached
  f.state.online = false;
  assert.equal(await authenticate(f.deps, 'ana@corp.example', PW), 'ok_offline');
  assert.equal(f.handoffs.length, 1);   // nothing to hand over offline
});

test('WSOS-DIR-007: an expired password is flagged for the greeter and changed through the frame', async () => {
  const f = fakes();
  f.state.expired = true;
  assert.equal(await authenticate(f.deps, 'ana@corp.example', PW), 'password_expired');
  assert.equal(f.marks.get('ana@corp.example'), 'expired');
  const NEW = 'An0ther-Passw0rd';
  assert.equal(await authenticate(f.deps, 'ana@corp.example', `${CHANGE_PREFIX}${PW}\x1fshort`), 'password_expired');   // server refused it
  assert.equal(await authenticate(f.deps, 'ana@corp.example', `${CHANGE_PREFIX}${PW}\x1f${NEW}`), 'ok');
  assert.equal(f.marks.has('ana@corp.example'), false);
  assert.equal(f.handoffs.at(-1)!.data.login_code, 'wsl_code2');
  for (const l of f.logs) { assert.equal(l.includes(NEW), false); assert.equal(l.includes(PW), false); }
  assert.equal(JSON.stringify(f.getCache()).includes(NEW), false);
  // The offline verifier is for the new password.
  f.state.online = false;
  assert.equal(await authenticate(f.deps, 'ana@corp.example', NEW), 'ok_offline');
  assert.equal(await authenticate(f.deps, 'ana@corp.example', PW), 'denied');
  // A change needs the server.
  assert.equal(await authenticate(f.deps, 'ana@corp.example', `${CHANGE_PREFIX}${NEW}\x1fYet-another-pass1`), 'unavailable');
});

test('WSOS-DIR-009: accounts with a second factor do not sign in offline by default', async () => {
  const f = fakes();
  f.state.mfa = true;
  assert.equal(await authenticate(f.deps, 'ana@corp.example', PW + '123456'), 'ok');
  assert.equal(f.getCache()['ana@corp.example'].allow_offline_mfa_bypass, false);
  f.state.online = false;
  assert.equal(await authenticate(f.deps, 'ana@corp.example', PW + '999999'), 'unavailable');
  assert.equal(await authenticate(f.deps, 'ana@corp.example', PW), 'unavailable');
});

test('WSOS-DIR-009: accounts with a second factor need password + code; with allow_offline_mfa_bypass offline checks the password part', async () => {
  const f = fakes();
  f.state.mfa = true;
  f.state.mfaBypass = true;
  assert.equal(await authenticate(f.deps, 'ana@corp.example', PW), 'mfa_required');
  assert.equal(f.marks.get('ana@corp.example'), 'mfa');
  assert.equal(await authenticate(f.deps, 'ana@corp.example', PW + '123456'), 'ok');
  assert.equal(f.getCache()['ana@corp.example'].mfa, true);
  f.state.online = false;
  assert.equal(await authenticate(f.deps, 'ana@corp.example', PW + '999999'), 'ok_offline');
  assert.equal(await authenticate(f.deps, 'ana@corp.example', 'wrong-pass' + '123456'), 'denied');
});

test('G04: break-glass reason typed at the greeter goes into the audit event once; offline end per cached account', async () => {
  const f = fakes();
  await f.deps.accounts.create(BREAK_GLASS_USER, 999, '');
  let reason: string | null = 'Directory down,\nrestoring network';
  f.deps.store.takeBreakGlassReason = () => { const r = reason; reason = null; return r; };
  await session(f.deps, BREAK_GLASS_USER);
  assert.equal(f.events.at(-1)!.reason, 'Directory down, restoring network');
  await session(f.deps, BREAK_GLASS_USER);
  assert.equal(f.events.at(-1)!.reason, undefined);
  assert.equal(await authenticate(f.deps, 'ana@corp.example', PW), 'ok');
  assert.deepEqual(offlineUntil(f.getCache()), { 'ana@corp.example': f.state.now + 7 * DAY });
});

test('helper exit codes for pam_worksuite.so (WSOS-DIR-009)', async () => {
  const { authExit } = await import('../src/main.ts');
  assert.equal(authExit('ok'), 0);
  assert.equal(authExit('ok_offline'), 0);
  assert.equal(authExit('mfa_required'), 10);
  assert.equal(authExit('password_expired'), 11);
  assert.equal(authExit('not_directory'), 12);
  for (const r of ['denied', 'disabled', 'expired_cache', 'unavailable', 'uid_conflict'] as const) assert.equal(authExit(r), 1);
});

test('boot units: an offline or unenrolled device exits 0 with an info line instead of failing the unit', async () => {
  const { main } = await import('../src/main.ts');
  const f = fakes({ online: false });
  assert.equal(await main(['greeter-config'], f.deps), 0);
  assert.ok(f.logs.some((l) => l.includes('greeter keeps its saved domain settings')));
  await f.deps.accounts.create(BREAK_GLASS_USER, 999, '');
  assert.equal(await main(['rotate'], f.deps), 0);
  assert.equal(f.accounts.get(BREAK_GLASS_USER)!.locked, true);
  assert.ok(f.logs.some((l) => l.includes('account stays locked')));
});
