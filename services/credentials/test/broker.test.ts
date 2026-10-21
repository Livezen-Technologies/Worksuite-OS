import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Broker, type Account } from '../src/broker.ts';
import { memoryStore } from '../src/keyring.ts';
import { checkUrl, OidcError } from '../src/oidc.ts';
import { dispatch, importLoginHandoff, serve } from '../src/main.ts';
import { createConnection } from 'node:net';
import { writeFileSync } from 'node:fs';
import { buildSyncConfig, fetchBootstrap, removeSyncConfig, writeSyncConfig } from '../src/syncconfig.ts';
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Minimal WorkSuite server + OneAuth: discovery, PKCE-checked code exchange, rotating refresh tokens. */
async function fakeOneAuth() {
  const s = {
    base: '', codes: new Map<string, string>(), refreshes: 0, revoked: new Set<string>(), live: new Set<string>(),
    tokenCalls: 0, expiresIn: 3600, server: null as unknown as Server,
  };
  s.server = createServer(async (req, res) => {
    const url = new URL(req.url!, s.base);
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    let raw = ''; for await (const c of req) raw += c;
    const form = new URLSearchParams(raw);
    switch (url.pathname) {
      case '/.well-known/worksuite-desktop': return json(200, { api_base: s.base, oneauth_issuer: `${s.base}/oneauth` });
      case '/oneauth/.well-known/openid-configuration': return json(200, {
        issuer: `${s.base}/oneauth`, authorization_endpoint: `${s.base}/oneauth/authorize`, token_endpoint: `${s.base}/oneauth/token`,
        userinfo_endpoint: `${s.base}/oneauth/userinfo`, revocation_endpoint: `${s.base}/oneauth/revoke`,
      });
      case '/oneauth/userinfo': return json(200, { sub: 'u-42', name: 'Hasarinda' });
      case '/desktop/v1/bootstrap':
        if (req.headers.authorization !== 'Bearer at-1') return json(401, {});
        return json(200, { user: { id: 42 }, org: { id: 'livezen' }, modules: [
          { key: 'tasks' }, { key: 'prefs', data_type: 'preference' }, { key: 'meet', offline: 'online_only' }, { key: 'Bad Key' },
        ] });
      case '/oneauth/revoke': s.revoked.add(form.get('token')!); return json(200, {});
      case '/oneauth/token': {
        s.tokenCalls++;
        if (form.get('client_secret')) return json(400, { error: 'invalid_client' });
        if (form.get('grant_type') === 'authorization_code') {
          const challenge = s.codes.get(form.get('code')!);
          const ok = challenge && createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === challenge;
          if (!ok) return json(400, { error: 'invalid_grant' });
          s.codes.delete(form.get('code')!);
          s.live.add('rt-1');
          return json(200, { access_token: 'at-1', expires_in: s.expiresIn, refresh_token: 'rt-1' });
        }
        if (form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:token-exchange') {
          const ok = form.get('subject_token_type') === 'urn:worksuite:params:oauth:token-type:os-login-code'
            && form.get('subject_token') === 'wsl_code' && req.headers['x-ws-device'] === 'dev-cred';
          if (!ok) return json(400, { error: 'invalid_grant' });
          s.live.add('rt-1');
          return json(200, { access_token: 'at-1', expires_in: s.expiresIn, refresh_token: 'rt-1' });
        }
        const rt = form.get('refresh_token')!;
        if (!s.live.has(rt)) return json(400, { error: 'invalid_grant' });
        s.live.delete(rt);
        const n = ++s.refreshes + 1;
        s.live.add(`rt-${n}`);
        await new Promise((r) => setTimeout(r, 10));
        return json(200, { access_token: `at-${n}`, expires_in: s.expiresIn, refresh_token: `rt-${n}` });
      }
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => s.server.listen(0, '127.0.0.1', r));
  s.base = `http://127.0.0.1:${(s.server.address() as AddressInfo).port}`;
  return s;
}

/** Plays the browser: follow the authorization URL by redirecting to the loopback callback with a code. */
function browser(s: Awaited<ReturnType<typeof fakeOneAuth>>, tamper?: (u: URL) => void) {
  return async (authUrl: string) => {
    const u = new URL(authUrl);
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    s.codes.set('code-1', u.searchParams.get('code_challenge')!);
    const cb = new URL(u.searchParams.get('redirect_uri')!);
    cb.searchParams.set('code', 'code-1');
    cb.searchParams.set('state', u.searchParams.get('state')!);
    tamper?.(cb);
    setTimeout(() => void fetch(cb).catch(() => {}), 0);
  };
}

function makeBroker(s: Awaited<ReturnType<typeof fakeOneAuth>>, extra: Partial<ConstructorParameters<typeof Broker>[0]> = {}) {
  const secrets = memoryStore();
  let saved: Account[] = [];
  let clock = 1_000_000;
  const broker = new Broker({
    clientId: 'worksuite-os', secrets, allowInsecureLoopback: true, openBrowser: browser(s),
    saveAccounts: (a) => { saved = a; }, now: () => clock, signInTimeoutMs: 2_000, ...extra,
  });
  return { broker, secrets, saved: () => saved, tick: (ms: number) => { clock += ms; } };
}

test('sign-in: PKCE code exchange, refresh token only in the keyring, account saved without secrets', async () => {
  const s = await fakeOneAuth();
  const { broker, secrets, saved } = makeBroker(s);
  const a = await broker.signIn(s.base);
  assert.equal(a.sub, 'u-42');
  assert.equal(secrets.data.get(a.id), 'rt-1');
  assert.ok(!JSON.stringify(saved()).includes('rt-1'));
  assert.equal((await broker.getAccessToken(a.id)).token, 'at-1');
  assert.equal(broker.state(a.id), 'signed_in');
  s.server.close();
});

test('redirect with a wrong state is refused; sign-in times out', async () => {
  const s = await fakeOneAuth();
  const { broker } = makeBroker(s, { openBrowser: browser(s, (cb) => cb.searchParams.set('state', 'forged')), signInTimeoutMs: 200 });
  await assert.rejects(broker.signIn(s.base), (e: OidcError) => e.code === 'sign_in_timeout');
  s.server.close();
});

test('cached token reused; near expiry it refreshes once and rotates the refresh token', async () => {
  const s = await fakeOneAuth();
  const { broker, secrets, tick } = makeBroker(s);
  const a = await broker.signIn(s.base);
  const calls = s.tokenCalls;
  await broker.getAccessToken(a.id);
  assert.equal(s.tokenCalls, calls);
  tick(15 * 60_000); // capped at 15 min even though the server said 1 h (WSOS-IDN-003)
  const [x, y, z] = await Promise.all([broker.getAccessToken(a.id), broker.getAccessToken(a.id), broker.getAccessToken(a.id)]);
  assert.equal(s.tokenCalls, calls + 1, 'single flight');
  assert.equal(x.token, 'at-2'); assert.equal(y.token, 'at-2'); assert.equal(z.token, 'at-2');
  assert.equal(secrets.data.get(a.id), 'rt-2');
  s.server.close();
});

test('force_refresh after a 401 refreshes even with a fresh cache', async () => {
  const s = await fakeOneAuth();
  const { broker } = makeBroker(s);
  const a = await broker.signIn(s.base);
  assert.equal((await broker.getAccessToken(a.id, true)).token, 'at-2');
  s.server.close();
});

test('revoked sign-in: invalid_grant → sign_in_required and refresh_failed state', async () => {
  const s = await fakeOneAuth();
  const { broker } = makeBroker(s);
  const a = await broker.signIn(s.base);
  s.live.clear();
  await assert.rejects(broker.getAccessToken(a.id, true), (e: OidcError) => e.code === 'sign_in_required');
  assert.equal(broker.state(a.id), 'refresh_failed');
  s.server.close();
});

test('lock drops in-memory tokens and refuses requests until unlock', async () => {
  const s = await fakeOneAuth();
  const { broker } = makeBroker(s);
  const a = await broker.signIn(s.base);
  broker.lock();
  await assert.rejects(broker.getAccessToken(a.id), (e: OidcError) => e.code === 'locked');
  broker.unlock();
  const calls = s.tokenCalls;
  assert.equal((await broker.getAccessToken(a.id)).token, 'at-2');
  assert.equal(s.tokenCalls, calls + 1, 'cache was cleared by lock');
  s.server.close();
});

test('sign-out revokes and clears the keyring and account list', async () => {
  const s = await fakeOneAuth();
  const { broker, secrets, saved } = makeBroker(s);
  const a = await broker.signIn(s.base);
  await broker.signOut(a.id);
  assert.ok(s.revoked.has('rt-1'));
  assert.equal(secrets.data.size, 0);
  assert.deepEqual(saved(), []);
  await assert.rejects(broker.getAccessToken(a.id), (e: OidcError) => e.code === 'unknown_account');
  s.server.close();
});

test('only https issuers unless loopback is explicitly allowed', () => {
  assert.throws(() => checkUrl('http://auth.worksuitecloud.com'), (e: OidcError) => e.code === 'insecure_url');
  assert.throws(() => checkUrl('http://127.0.0.1:9'), (e: OidcError) => e.code === 'insecure_url');
  assert.equal(checkUrl('https://auth.worksuitecloud.com').host, 'auth.worksuitecloud.com');
});

test('socket dispatch validates arguments and maps errors to codes', async () => {
  const s = await fakeOneAuth();
  const { broker } = makeBroker(s);
  assert.equal((await dispatch(broker, { method: 'GetAccessToken', params: {} })).error, 'invalid_argument');
  assert.equal((await dispatch(broker, { method: 'GetAccessToken', params: { account_id: 'nobody' } })).error, 'unknown_account');
  assert.equal((await dispatch(broker, { method: 'Nope' })).error, 'unknown_method');
  assert.equal((await dispatch(broker, { method: 'SignIn', params: { server_url: s.base } })).error, 'invalid_argument', 'mode required');
  const r = await dispatch(broker, { id: 7, method: 'SignIn', params: { server_url: s.base, mode: 'personal' } });
  const t = await dispatch(broker, { method: 'GetAccessToken', params: { account_id: (r.result as { id: string }).id } });
  assert.equal(t.result, 'at-1');
  s.server.close();
});

test('sign-in writes the sync config from bootstrap before storing the refresh token', async () => {
  const s = await fakeOneAuth();
  const dir = mkdtempSync(join(tmpdir(), 'ws-cred-'));
  const path = join(dir, 'sync.json');
  const { broker, secrets } = makeBroker(s, {
    onSignedIn: async (account, ctx) => {
      assert.equal(secrets.data.size, 0, 'keyring written only after config succeeds');
      writeSyncConfig(path, buildSyncConfig(account, ctx.apiBase, ctx.mode, await fetchBootstrap(ctx.apiBase, ctx.accessToken, null, { allowInsecureLoopback: true })));
    },
    onSignedOut: async (account) => { removeSyncConfig(path, account.id); },
  });
  const a = await broker.signIn(s.base, 'personal');
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(cfg.account, { id: a.id, server_url: s.base + '/', org_id: 'livezen', user_id: '42', mode: 'personal' });
  assert.deepEqual(cfg.modules, { tasks: 'document', prefs: 'preference' }, 'online-only and malformed modules are left out');
  assert.deepEqual(cfg.streams, ['tasks', 'prefs']);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(!readFileSync(path, 'utf8').includes('rt-1'), 'no secrets in the sync config');
  await broker.signOut(a.id);
  assert.ok(!existsSync(path));
  s.server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a failed post-sign-in step fails the sign-in and stores nothing', async () => {
  const s = await fakeOneAuth();
  const { broker, secrets, saved } = makeBroker(s, { onSignedIn: async () => { throw new Error('bootstrap_failed'); } });
  await assert.rejects(broker.signIn(s.base, 'enterprise'));
  assert.equal(secrets.data.size, 0);
  assert.deepEqual(saved(), []);
  assert.deepEqual(broker.list(), []);
  s.server.close();
});

test('sync config: bootstrap without user/org is rejected; removal only touches the same account', () => {
  const acct = { id: 'h:1', server_url: 'https://x', issuer: 'https://x', sub: '1' };
  assert.throws(() => buildSyncConfig(acct, 'https://x/', 'personal', { modules: [] }), (e: OidcError) => e.code === 'bootstrap_invalid');
  const dir = mkdtempSync(join(tmpdir(), 'ws-cred-'));
  const path = join(dir, 'sync.json');
  writeSyncConfig(path, buildSyncConfig(acct, 'https://x/', 'personal', { user: { id: 1 }, org: { id: 2 } }));
  assert.equal(removeSyncConfig(path, 'someone-else'), false);
  assert.equal(removeSyncConfig(path, 'h:1'), true);
  rmSync(dir, { recursive: true, force: true });
});

test('WSOS-DIR-008: the greeter login code signs the session in without a prompt, once', async () => {
  const s = await fakeOneAuth();
  const opened: string[] = [];
  const { broker, secrets } = makeBroker(s, { openBrowser: async (u) => { opened.push(u); } });
  const dir = mkdtempSync(join(tmpdir(), 'ws-handoff-'));
  const path = join(dir, 'login.json');
  const logs: string[] = [];
  const log = (e: string) => { logs.push(e); };
  const write = (o: Record<string, unknown>) => writeFileSync(path, JSON.stringify({ server_url: s.base, login_code: 'wsl_code', issued_at: new Date().toISOString(), ...o }));
  assert.equal(await importLoginHandoff(broker, { path, deviceCredential: () => 'dev-cred', log }), null);   // nothing there
  write({ issued_at: new Date(Date.now() - 10 * 60_000).toISOString() });
  assert.equal(await importLoginHandoff(broker, { path, deviceCredential: () => 'dev-cred', log }), null);
  assert.ok(logs.includes('login_handoff_stale'));
  write({});
  assert.equal(await importLoginHandoff(broker, { path, deviceCredential: () => 'other-device', log }), null);
  assert.ok(logs.includes('login_handoff_failed'));
  assert.equal(existsSync(path), false);   // used or not, the code is gone
  write({});
  const a = await importLoginHandoff(broker, { path, deviceCredential: () => 'dev-cred', log });
  assert.ok(a);
  assert.equal(secrets.data.get(a!.id), 'rt-1');
  assert.equal((await broker.getAccessToken(a!.id)).token, 'at-1');
  assert.deepEqual(opened, []);   // no browser, no second prompt
  assert.equal(existsSync(path), false);
  rmSync(dir, { recursive: true, force: true });
  s.server.close();
});

test('§13.1 malicious IPC: hostile lines on the broker socket get errors and the broker keeps serving', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-cred-'));
  const path = join(dir, 'c.sock');
  const broker = new Broker({ clientId: 'worksuite-os', secrets: memoryStore(), saveAccounts: () => {}, openBrowser: async () => {} } as ConstructorParameters<typeof Broker>[0]);
  const srv = serve(path, broker);
  await new Promise((r) => srv.once('listening', r));
  const call = (line: string) => new Promise<any>((resolve) => {
    const s = createConnection(path);
    let buf = '';
    s.on('data', (c) => { buf += c; if (buf.includes('\n')) { s.end(); resolve(JSON.parse(buf)); } });
    s.write(line + '\n');
  });
  for (const line of ['null', '42', '"x"', '[]', '{"method":1}', '{"method":"GetAccessToken","params":null}', '{"method":"GetAccessToken","params":[1]}', '{"__proto__":{"method":"Status"}}']) {
    assert.equal((await call(line)).error, 'bad_request', line);
  }
  assert.equal((await call('{"method":"GetAccessToken","params":{"account_id":{"toString":1}}}')).error, 'invalid_argument');
  assert.equal((await call('{"method":"constructor"}')).error, 'unknown_method');
  // An oversized line closes the connection without answering.
  await new Promise<void>((resolve) => { const s = createConnection(path); s.on('close', () => resolve()); s.on('error', () => {}); s.write('x'.repeat(20 * 1024)); });
  assert.deepEqual((await call('{"id":7,"method":"Status"}')), { id: 7, result: [] });
  srv.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a waiting browser sign-in can be cancelled, and a retry replaces it', async () => {
  const s = await fakeOneAuth();
  let opened = 0;
  const { broker } = makeBroker(s, { openBrowser: async () => { opened++; }, signInTimeoutMs: 5_000 });
  const first = broker.signIn(s.base);
  while (opened < 1) await new Promise((r) => setTimeout(r, 5));
  const second = broker.signIn(s.base);
  await assert.rejects(first, (e: OidcError) => e.code === 'sign_in_cancelled');
  while (opened < 2) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(await dispatch(broker, { id: 1, method: 'CancelSignIn' }), { id: 1, result: true });
  await assert.rejects(second, (e: OidcError) => e.code === 'sign_in_cancelled');
  assert.equal((await dispatch(broker, { method: 'CancelSignIn' })).result, false, 'nothing left waiting');
  assert.deepEqual(broker.list(), []);
  s.server.close();
});

// #55: the account form checks the server first and says what went wrong instead of one generic message.
test('CheckServer: discovery only, nothing stored; bad addresses are refused', async () => {
  const s = await fakeOneAuth();
  const { broker, saved } = makeBroker(s);
  const r = await dispatch(broker, { method: 'CheckServer', params: { server_url: s.base } });
  assert.deepEqual(r.result, { server_url: s.base, issuer: new URL(s.base).host });
  assert.deepEqual(saved(), []);
  assert.equal(s.tokenCalls, 0);
  assert.equal((await dispatch(broker, { method: 'CheckServer', params: {} })).error, 'invalid_argument');
  assert.equal((await dispatch(broker, { method: 'CheckServer', params: { server_url: 'http://work.example.com' } })).error, 'insecure_url');
  assert.equal((await dispatch(broker, { method: 'CheckServer', params: { server_url: 'https://me:pw@work.example.com' } })).error, 'invalid_url');
  assert.equal((await dispatch(broker, { method: 'CheckServer', params: { server_url: 'not a url' } })).error, 'invalid_url');
  s.server.close();
});

const fakeFetch = (routes: Record<string, () => Response | Promise<Response>>) =>
  (async (u: URL | string) => { const r = routes[String(u)]; if (!r) return new Response('', { status: 404 }); return r(); }) as typeof fetch;
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const oidcMeta = { issuer: 'https://id.example', authorization_endpoint: 'https://id.example/a', token_endpoint: 'https://id.example/t', userinfo_endpoint: 'https://id.example/u' };

test('discovery follows https redirects (example.com → www) but never to http, and not forever', async () => {
  const { discover } = await import('../src/oidc.ts');
  const f = fakeFetch({
    'https://example.com/.well-known/worksuite-desktop': () => new Response('', { status: 301, headers: { location: 'https://www.example.com/.well-known/worksuite-desktop' } }),
    'https://www.example.com/.well-known/worksuite-desktop': () => json({ oneauth_issuer: 'https://id.example' }),
    'https://id.example/.well-known/openid-configuration': () => json(oidcMeta),
    'https://down.example/.well-known/worksuite-desktop': () => new Response('', { status: 302, headers: { location: 'http://down.example/x' } }),
    'https://loop.example/.well-known/worksuite-desktop': () => new Response('', { status: 302, headers: { location: '/.well-known/worksuite-desktop' } }),
  });
  assert.equal((await discover('https://example.com', { fetch: f })).issuer, 'https://id.example');
  await assert.rejects(discover('https://down.example', { fetch: f }), (e: OidcError) => e.code === 'insecure_url');
  await assert.rejects(discover('https://loop.example', { fetch: f }), (e: OidcError) => e.code === 'discovery_failed');
  await assert.rejects(discover('https://nothing.example', { fetch: f }), (e: OidcError) => e.code === 'discovery_failed');
});

test('network failures become codes the person can act on', async () => {
  const { discover, networkError } = await import('../src/oidc.ts');
  const failing = (cause: unknown) => (async () => { throw Object.assign(new TypeError('fetch failed'), { cause }); }) as unknown as typeof fetch;
  for (const [cause, code] of [
    [{ code: 'ENOTFOUND' }, 'dns_failed'], [{ code: 'EAI_AGAIN' }, 'dns_failed'], [{ code: 'ECONNREFUSED' }, 'unreachable'],
    [{ code: 'ENETUNREACH' }, 'unreachable'], [{ code: 'CERT_HAS_EXPIRED' }, 'tls_failed'], [{ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, 'tls_failed'],
    [{ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, 'tls_failed'], [{ code: 'UND_ERR_CONNECT_TIMEOUT' }, 'network_timeout'],
  ] as const) {
    await assert.rejects(discover('https://work.example.com', { fetch: failing(cause) }), (e: OidcError) => e.code === code, cause.code);
  }
  assert.equal(networkError(new DOMException('t', 'TimeoutError')).code, 'network_timeout');
});

test('the browser opens in its own unit, falling back to a detached xdg-open', async () => {
  const { openBrowser } = await import('../src/main.ts');
  const tried: string[][] = [];
  await openBrowser('https://id.example/a?x=1', async (c) => { tried.push(c); if (c[0] === 'systemd-run') throw new Error('ENOENT'); });
  assert.equal(tried[0][0], 'systemd-run');
  assert.deepEqual(tried[0].slice(-3), ['--', 'xdg-open', 'https://id.example/a?x=1']);
  assert.deepEqual(tried[1], ['xdg-open', 'https://id.example/a?x=1']);
  await assert.rejects(openBrowser('https://x', async () => { throw new Error('no'); }), (e: OidcError) => e.code === 'browser_failed');
});
