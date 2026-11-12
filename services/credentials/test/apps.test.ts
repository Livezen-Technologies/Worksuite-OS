// desktop-v1 sign-in (a real WorkSuite server, demo.worksuite.lk 3.1.0): fake server with the same answers, recorded
// from the live server: 202 while waiting, 200 + session once the page approved, single-use codes bound to the PKCE
// verifier, rotating refresh with 409 for a refresh already in flight, 401 for a dead refresh token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Broker, type Account } from '../src/broker.ts';
import { memoryStore } from '../src/keyring.ts';
import { appsEndpoints } from '../src/apps.ts';

async function fakeWorkSuite() {
  const s = { base: '', approved: new Map<string, number>(), rt: new Set<string>(['']), n: 0, busyOnce: false, loggedOut: [] as string[], polls: 0 };
  const server = createServer(async (req, res) => {
    const json = (st: number, b: unknown) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    let raw = ''; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const tokens = () => { s.n++; const rt = `rt-${s.n}`; s.rt.add(rt); return { access_token: `at-${s.n}`, refresh_token: rt, expires_in: 3600, token_type: 'Bearer' }; };
    switch (new URL(req.url!, s.base).pathname) {
      case '/.well-known/worksuite-desktop': return json(200, { api: 'desktop-v1', api_version: 1, name: 'WorkSuite' });
      case '/api/auth/apps/poll': {
        s.polls++;
        const ch = createHash('sha256').update(String(body.code_verifier)).digest('base64url');
        if (body.client !== 'worksuite-desktop' || !s.approved.has(ch)) return json(202, { data: { pending: true } });
        s.approved.delete(ch);                                   // single use
        return json(200, { message: 'Signed in', data: { user: { id: 1, uuid: 'u-1', name: 'Admin', email: 'a@x' }, tokens: tokens() } });
      }
      case '/api/auth/refresh':
        if (s.busyOnce) { s.busyOnce = false; return json(409, { message: 'A refresh is already in progress. Try again.' }); }
        if (!s.rt.has(body.refresh_token) || !body.refresh_token) return json(401, { message: 'expired' });
        s.rt.delete(body.refresh_token);                         // rotation
        return json(200, { message: 'Refreshed', data: tokens() });
      case '/api/auth/logout': s.loggedOut.push(String(req.headers.authorization)); return json(200, {});
      default: return json(404, {});
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  s.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { s, close: () => server.close() };
}

const broker = (base: string, secrets = memoryStore(), extra: Partial<ConstructorParameters<typeof Broker>[0]> = {}) => {
  let saved: Account[] = [];
  const b = new Broker({ clientId: 'worksuite-desktop', secrets, allowInsecureLoopback: true, pollIntervalMs: 20, saveAccounts: (a) => { saved = a; }, openBrowser: async () => {}, ...extra });
  return { b, saved: () => saved, secrets };
};

test('a server without a OneAuth issuer is a desktop-v1 server; one with an issuer keeps OIDC', () => {
  assert.equal(appsEndpoints(new URL('https://demo.worksuite.lk/x'), { api: 'desktop-v1' })?.sign_in, 'https://demo.worksuite.lk/desktop/sign-in');
  assert.equal(appsEndpoints(new URL('https://a.example'), { api: 'desktop-v1', oneauth_issuer: 'https://a.example/oneauth' }), null);
  assert.equal(appsEndpoints(new URL('https://a.example'), {}), null);
});

test('sign-in opens the server page with a PKCE challenge and collects the session by polling with the verifier', async () => {
  const { s, close } = await fakeWorkSuite();
  let opened = '';
  const { b, saved, secrets } = broker(s.base, memoryStore(), { openBrowser: async (url) => { opened = url; const u = new URL(url); setTimeout(() => s.approved.set(u.searchParams.get('challenge')!, 1), 60); } });
  try {
    assert.deepEqual(await b.checkServer(s.base), { server_url: s.base, issuer: new URL(s.base).host });
    const a = await b.signIn(s.base);
    const u = new URL(opened);
    assert.equal(u.pathname, '/desktop/sign-in');
    assert.match(u.searchParams.get('challenge')!, /^[A-Za-z0-9_-]{43}$/);     // what the server page accepts
    assert.match(u.searchParams.get('state')!, /^[A-Za-z0-9_-]{16,128}$/);
    assert.ok(s.polls >= 2, 'polled while the person was still in the browser');
    assert.equal(a.protocol, 'desktop-v1');
    assert.equal(a.sub, 'u-1');
    assert.equal(await secrets.get(a.id), 'rt-1');                           // refresh token only in the keyring
    assert.ok(!JSON.stringify(saved()).includes('rt-1'), 'no token in the saved account list');
    assert.equal((await b.getAccessToken(a.id)).token, 'at-1');
  } finally { close(); }
});

test('refresh rotates the token, survives a restart, retries once on 409 and asks for sign-in on 401', async () => {
  const { s, close } = await fakeWorkSuite();
  const store = memoryStore();
  const { b, saved } = broker(s.base, store, { openBrowser: async (url) => { s.approved.set(new URL(url).searchParams.get('challenge')!, 1); } });
  try {
    const a = await b.signIn(s.base);
    assert.equal((await b.getAccessToken(a.id, true)).token, 'at-2');
    assert.equal(await store.get(a.id), 'rt-2');
    const again = broker(s.base, store, { accounts: saved() }).b;               // after a restart: no endpoints cached
    s.busyOnce = true;
    assert.equal((await again.getAccessToken(a.id)).token, 'at-3');
    await store.set(a.id, 'rt-dead');
    await assert.rejects(again.getAccessToken(a.id, true), { code: 'sign_in_required' });
    assert.equal(again.state(a.id), 'refresh_failed');
  } finally { close(); }
});

test('sign-out ends the server session and clears the keyring', async () => {
  const { s, close } = await fakeWorkSuite();
  const { b, secrets } = broker(s.base, memoryStore(), { openBrowser: async (url) => { s.approved.set(new URL(url).searchParams.get('challenge')!, 1); } });
  try {
    const a = await b.signIn(s.base);
    await b.signOut(a.id);
    assert.deepEqual(s.loggedOut, ['Bearer at-1']);
    assert.equal(await secrets.get(a.id), null);
    assert.equal(b.state(a.id), 'signed_out');
  } finally { close(); }
});

test('a sign-in nobody finishes times out, and cancel stops it at once', async () => {
  const { s, close } = await fakeWorkSuite();
  try {
    await assert.rejects(broker(s.base, memoryStore(), { signInTimeoutMs: 150 }).b.signIn(s.base), { code: 'sign_in_timeout' });
    const { b } = broker(s.base);
    const p = b.signIn(s.base);
    setTimeout(() => b.cancelSignIn(), 80);
    await assert.rejects(p, { code: 'sign_in_cancelled' });
  } finally { close(); }
});

test('sync config from the real server bootstrap: data-wrapped, organization by id, no modules yet', async () => {
  const { buildSyncConfig } = await import('../src/syncconfig.ts');
  const acct = { id: 'demo.worksuite.lk:u-1', server_url: 'https://demo.worksuite.lk', issuer: 'https://demo.worksuite.lk', sub: 'u-1' };
  // Shape recorded from demo.worksuite.lk 3.1.0 (values trimmed).
  const real = { status: 'success', message: 'OK', data: { user: { id: 1, uuid: 'u-1' }, organization_id: null, default_organization_id: '2', organizations: [{ id: '2' }, { id: '3' }], modules: undefined, apps: [] } };
  const c = buildSyncConfig(acct, 'https://demo.worksuite.lk/', 'enterprise', real);
  assert.equal(c.account.org_id, '2');
  assert.equal(c.account.user_id, '1');
  assert.deepEqual(c.streams, []);
  assert.throws(() => buildSyncConfig(acct, 'x', 'enterprise', { status: 'success', data: { user: { id: 1 } } }), { code: 'bootstrap_invalid' });
});
