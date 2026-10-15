import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, privateDecrypt, constants } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authenticate, BREAK_GLASS_USER, localGroups, rotate, ServerError, session, UID_BASE,
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
  const state = { online: o.online ?? true, disabled: o.disabled ?? false, failEvents: o.failEvents ?? false, now: Date.UTC(2026, 9, 1) };
  const server: Server = {
    async authenticate(u, p): Promise<DirectoryUser> {
      calls.push(`auth ${u}`);
      if (!state.online) throw new ServerError(0, 'NETWORK');
      if (p !== PW) throw new ServerError(401, 'INVALID_CREDENTIALS');
      if (state.disabled) throw new ServerError(403, 'ACCOUNT_DISABLED');
      return { username: u, user_id: 42, name: 'Ana Silva', groups: ['worksuite-admins'], offline_login_days: 7 };
    },
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
    store: { cache: () => structuredClone(cache), saveCache: (c) => { cache = structuredClone(c); }, pending: () => [...pending], savePending: (p) => { pending = [...p]; } },
  };
  return { deps, logs, calls, accounts, state, escrowed, events, getCache: () => cache, getPending: () => pending };
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
