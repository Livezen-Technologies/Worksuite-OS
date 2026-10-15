import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Broker, type Account } from '../src/broker.ts';
import { memoryStore } from '../src/keyring.ts';
import { checkUrl, OidcError } from '../src/oidc.ts';
import { dispatch } from '../src/main.ts';

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
  const r = await dispatch(broker, { id: 7, method: 'SignIn', params: { server_url: s.base } });
  const t = await dispatch(broker, { method: 'GetAccessToken', params: { account_id: (r.result as { id: string }).id } });
  assert.equal(t.result, 'at-1');
  s.server.close();
});
