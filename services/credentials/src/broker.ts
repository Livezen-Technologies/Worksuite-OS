// One token broker for the shell, WorkSuite apps, Office and sync (WSOS-IDN-008).
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { authorizationUrl, checkUrl, discover, OidcError, OS_LOGIN_CODE, TOKEN_EXCHANGE, tokenRequest, userinfo, type Endpoints, type OidcOptions, type TokenSet } from './oidc.ts';
import { pkcePair, randomState } from './pkce.ts';
import { appsEndpoints, logoutApps, pollOnce, refreshApps, signInPage, type AppsEndpoints, type AppsSession } from './apps.ts';
import { getJson } from './oidc.ts';
import { hostname } from 'node:os';
import type { SecretStore } from './keyring.ts';

export interface Account { id: string; server_url: string; issuer: string; sub: string; name?: string; email?: string; protocol?: 'desktop-v1' }
export type BrokerState = 'signed_out' | 'signed_in' | 'refresh_failed' | 'locked';

export interface BrokerOptions extends OidcOptions {
  clientId: string;
  secrets: SecretStore;
  /** Persist non-secret account metadata (server, issuer, subject). */
  saveAccounts: (a: Account[]) => void;
  accounts?: Account[];
  /** Open the system browser on the authorization URL (xdg-open via the portal). */
  openBrowser: (url: string) => Promise<void>;
  now?: () => number;
  signInTimeoutMs?: number;
  onState?: (account: string, state: BrokerState) => void;
  /** Called once a sign-in completes, before SignIn returns (writes the sync config). Errors fail the sign-in. */
  onSignedIn?: (account: Account, ctx: { apiBase: string; accessToken: string; mode: 'personal' | 'enterprise' }) => Promise<void>;
  onSignedOut?: (account: Account) => Promise<void>;
  /** desktop-v1 sign-in: how often to ask the server whether the browser sign-in finished. */
  pollIntervalMs?: number;
}

/** Access tokens are reused until this close to expiry. */
const EXPIRY_SKEW_MS = 60_000;
/** WSOS-IDN-003: never keep an access token longer than 15 min, whatever the server says. */
const MAX_ACCESS_TTL_MS = 15 * 60_000;

type Cached = { token: string; expiresAt: number };

export class Broker {
  private accounts = new Map<string, Account>();
  private endpoints = new Map<string, Endpoints | AppsEndpoints>();
  private cache = new Map<string, Cached>();               // in memory only
  private inflight = new Map<string, Promise<Cached>>();
  private states = new Map<string, BrokerState>();
  private locked = false;
  /** Browser sign-ins waiting for their redirect: one at a time, so a retry replaces a forgotten browser tab. */
  private pendingSignIn: ((e: OidcError) => void) | null = null;
  private o: BrokerOptions & { now: () => number; signInTimeoutMs: number };

  constructor(opts: BrokerOptions) {
    this.o = { now: Date.now, signInTimeoutMs: 5 * 60_000, ...opts };
    for (const a of opts.accounts ?? []) { this.accounts.set(a.id, a); this.states.set(a.id, 'signed_in'); }
  }

  /** Stop a browser sign-in that is waiting for its redirect (the person gave up or wants to retry). */
  cancelSignIn(): boolean {
    const stop = this.pendingSignIn;
    this.pendingSignIn = null;
    stop?.(new OidcError('sign_in_cancelled'));
    return stop !== null;
  }

  /**
   * #55: "is this a WorkSuite server, reachable over trusted https?" before the browser opens, so a typo, an offline
   * network or a bad certificate is reported straight away. Discovery only; nothing is stored.
   */
  async checkServer(serverUrl: string): Promise<{ server_url: string; issuer: string }> {
    const ep = await this.resolve(serverUrl);
    return { server_url: checkUrl(serverUrl, this.o).origin, issuer: new URL('protocol' in ep ? ep.server : ep.issuer).host };
  }

  /**
   * Which sign-in the server speaks: a real WorkSuite server (desktop-v1, no OneAuth issuer) → the apps flow;
   * otherwise OneAuth OIDC discovery as before.
   */
  private async resolve(serverUrl: string): Promise<Endpoints | AppsEndpoints> {
    const server = checkUrl(serverUrl, this.o);
    const d = await getJson(new URL('/.well-known/worksuite-desktop', server), this.o);
    if (d.status === 200) { const apps = appsEndpoints(server, d.body); if (apps) return apps; }
    return discover(serverUrl, this.o);
  }

  private async appsSignIn(serverUrl: string, ep: AppsEndpoints, mode: 'personal' | 'enterprise'): Promise<Account> {
    const { verifier, challenge } = pkcePair();
    const state = randomState();
    const s = await this.awaitPoll(ep, verifier, () => this.o.openBrowser(signInPage(ep, { challenge, state, device: `WorkSuite OS on ${hostname()}` })));
    return this.finishAppsSignIn(serverUrl, ep, s, mode);
  }

  private async finishAppsSignIn(serverUrl: string, ep: AppsEndpoints, s: AppsSession, mode: 'personal' | 'enterprise'): Promise<Account> {
    const account: Account = { id: `${new URL(ep.server).host}:${s.user.id}`, server_url: serverUrl, issuer: ep.server, sub: s.user.id, name: s.user.name, email: s.user.email, protocol: 'desktop-v1' };
    await this.o.onSignedIn?.(account, { apiBase: ep.api_base, accessToken: s.tokens.access_token, mode });
    await this.o.secrets.set(account.id, s.tokens.refresh_token);
    this.accounts.set(account.id, account);
    this.endpoints.set(account.id, ep);
    this.cache.set(account.id, this.cached(s.tokens));
    this.o.saveAccounts([...this.accounts.values()]);
    this.setState(account.id, 'signed_in');
    return account;
  }

  /** Open the browser, then poll until the server has the session, the person cancels, or the sign-in times out. */
  private awaitPoll(ep: AppsEndpoints, verifier: string, open: () => Promise<void>): Promise<AppsSession> {
    return new Promise((resolve, reject) => {
      let done = false, timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (e: OidcError | null, s?: AppsSession) => {
        if (done) return; done = true; clearTimeout(timer); clearTimeout(deadline);
        if (this.pendingSignIn === stop) this.pendingSignIn = null;
        if (e) reject(e); else resolve(s!);
      };
      const stop = (e: OidcError) => finish(e);
      this.pendingSignIn = stop;
      const deadline = setTimeout(() => finish(new OidcError('sign_in_timeout')), this.o.signInTimeoutMs);
      const tick = async () => {
        if (done) return;
        try { const s = await pollOnce(ep, verifier, this.o); if (s) return finish(null, s); }
        catch (e) { if (e instanceof OidcError && !/^(unreachable|network_timeout|dns_failed)$/.test(e.code)) return finish(e); }
        if (!done) timer = setTimeout(tick, this.o.pollIntervalMs ?? 2000);
      };
      open().then(() => { timer = setTimeout(tick, this.o.pollIntervalMs ?? 2000); }, (e) => finish(e instanceof OidcError ? e : new OidcError('browser_failed')));
    });
  }

  list() { return [...this.accounts.values()].map((a) => ({ ...a, state: this.state(a.id) })); }
  state(id: string): BrokerState { return this.locked ? 'locked' : this.states.get(id) ?? 'signed_out'; }

  /**
   * Authorization code + PKCE through the system browser with a one-shot loopback redirect (RFC 8252).
   * The refresh token goes straight to the keyring; the access token stays in memory.
   */
  async signIn(serverUrl: string, mode: 'personal' | 'enterprise' = 'enterprise'): Promise<Account> {
    if (this.locked) throw new OidcError('locked');
    this.cancelSignIn();
    const resolved = await this.resolve(serverUrl);
    if ('protocol' in resolved) return this.appsSignIn(serverUrl, resolved, mode);
    const ep = resolved;
    const { verifier, challenge } = pkcePair();
    const state = randomState();
    const { code, redirectUri } = await this.awaitRedirect(state, (redirectUri) =>
      this.o.openBrowser(authorizationUrl(ep, { clientId: this.o.clientId, redirectUri, challenge, state })));
    const tokens = await tokenRequest(ep, {
      grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: this.o.clientId, code_verifier: verifier,
    }, this.o);
    return this.finishSignIn(serverUrl, ep, tokens, mode);
  }

  /**
   * WSOS-DIR-008: after a directory sign-in at the greeter, exchange the one-time login code (bound to this device)
   * for tokens: no browser and no second prompt. The code and device credential are used once and not stored.
   */
  async signInWithLoginCode(serverUrl: string, code: string, deviceCredential: string): Promise<Account> {
    if (this.locked) throw new OidcError('locked');
    const ep = await discover(serverUrl, this.o);
    const tokens = await tokenRequest(ep, {
      grant_type: TOKEN_EXCHANGE, subject_token: code, subject_token_type: OS_LOGIN_CODE, client_id: this.o.clientId,
    }, this.o, { 'x-ws-device': deviceCredential });
    return this.finishSignIn(serverUrl, ep, tokens, 'enterprise');
  }

  private async finishSignIn(serverUrl: string, ep: Endpoints, tokens: TokenSet, mode: 'personal' | 'enterprise'): Promise<Account> {
    if (!tokens.refresh_token) throw new OidcError('no_refresh_token');
    const info = await userinfo(ep, tokens.access_token, this.o);
    const account: Account = { id: `${new URL(ep.issuer).host}:${info.sub}`, server_url: serverUrl, issuer: ep.issuer, sub: info.sub, name: info.name };
    await this.o.onSignedIn?.(account, { apiBase: ep.api_base, accessToken: tokens.access_token, mode });
    await this.o.secrets.set(account.id, tokens.refresh_token);
    this.accounts.set(account.id, account);
    this.endpoints.set(account.id, ep);
    this.cache.set(account.id, this.cached(tokens));
    this.o.saveAccounts([...this.accounts.values()]);
    this.setState(account.id, 'signed_in');
    return account;
  }

  /** Cached access token, or one refresh (single flight per account). Refresh tokens rotate when the server rotates them. */
  async getAccessToken(id: string, forceRefresh = false): Promise<Cached> {
    if (this.locked) throw new OidcError('locked');
    const account = this.accounts.get(id);
    if (!account) throw new OidcError('unknown_account');
    const hit = this.cache.get(id);
    if (!forceRefresh && hit && hit.expiresAt - EXPIRY_SKEW_MS > this.o.now()) return hit;
    let p = this.inflight.get(id);
    if (!p) {
      p = this.refresh(account).finally(() => this.inflight.delete(id));
      this.inflight.set(id, p);
    }
    return p;
  }

  /** Forget tokens everywhere. Unsent-change handling (WSOS-SYN-008) is decided by the shell before calling this. */
  async signOut(id: string) {
    const account = this.accounts.get(id);
    if (!account) return;
    const rt = await this.o.secrets.get(id).catch(() => null);
    const ep = this.endpoints.get(id);
    if (ep && 'protocol' in ep) await logoutApps(ep, this.cache.get(id)?.token ?? null, this.o);
    else if (rt && ep?.revocation_endpoint) {
      // Best effort: a sign-out must succeed offline too.
      await (this.o.fetch ?? fetch)(ep.revocation_endpoint, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: rt, token_type_hint: 'refresh_token', client_id: this.o.clientId }).toString(),
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {});
    }
    await this.o.secrets.clear(id);
    await this.o.onSignedOut?.(account).catch(() => {});
    this.cache.delete(id);
    this.accounts.delete(id);
    this.endpoints.delete(id);
    this.o.saveAccounts([...this.accounts.values()]);
    this.setState(id, 'signed_out');
  }

  /** Screen lock or logout: drop in-memory tokens; the keyring locks with the session (WSOS-INT-009). */
  lock() {
    this.locked = true;
    this.cache.clear();
    for (const id of this.accounts.keys()) this.o.onState?.(id, 'locked');
  }

  unlock() {
    this.locked = false;
    for (const id of this.accounts.keys()) this.o.onState?.(id, this.state(id));
  }

  private async refresh(account: Account): Promise<Cached> {
    const rt = await this.o.secrets.get(account.id);
    if (!rt) { this.setState(account.id, 'refresh_failed'); throw new OidcError('sign_in_required'); }
    let ep = this.endpoints.get(account.id);
    if (!ep) { ep = await this.resolve(account.server_url); this.endpoints.set(account.id, ep); }
    let tokens: TokenSet;
    try {
      tokens = 'protocol' in ep ? await refreshApps(ep, rt, this.o)
        : await tokenRequest(ep, { grant_type: 'refresh_token', refresh_token: rt, client_id: this.o.clientId }, this.o);
    } catch (e) {
      // invalid_grant = revoked or expired sign-in: the user signs in again. Anything else is transient.
      if (e instanceof OidcError && e.code === 'invalid_grant') { this.setState(account.id, 'refresh_failed'); throw new OidcError('sign_in_required'); }
      throw e;
    }
    if (tokens.refresh_token && tokens.refresh_token !== rt) await this.o.secrets.set(account.id, tokens.refresh_token);
    const c = this.cached(tokens);
    if (!this.locked) this.cache.set(account.id, c);
    this.setState(account.id, 'signed_in');
    return c;
  }

  private cached(t: TokenSet): Cached {
    const ttl = Math.min((t.expires_in ?? 300) * 1000, MAX_ACCESS_TTL_MS);
    return { token: t.access_token, expiresAt: this.o.now() + ttl };
  }

  private setState(id: string, s: BrokerState) {
    if (this.states.get(id) === s) return;
    if (s === 'signed_out') this.states.delete(id); else this.states.set(id, s);
    this.o.onState?.(id, s);
  }

  private awaitRedirect(state: string, open: (redirectUri: string) => Promise<void>): Promise<{ code: string; redirectUri: string }> {
    return new Promise((resolve, reject) => {
      const stop = (e: OidcError) => { clearTimeout(timer); server.close(); if (this.pendingSignIn === stop) this.pendingSignIn = null; reject(e); };
      this.pendingSignIn = stop;
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
        const done = (ok: boolean) => {
          res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' })
            .end(ok ? 'Signed in to WorkSuite. You can close this window.' : 'Sign-in failed. Return to WorkSuite and try again.');
          clearTimeout(timer); server.close();
          if (this.pendingSignIn === stop) this.pendingSignIn = null;
        };
        // A wrong state is someone else's redirect: refuse it and keep waiting for ours.
        if (url.searchParams.get('state') !== state) { res.writeHead(400).end(); return; }
        const code = url.searchParams.get('code');
        if (!code) { done(false); reject(new OidcError(url.searchParams.get('error') ?? 'access_denied')); return; }
        done(true);
        resolve({ code, redirectUri });
      });
      let redirectUri = '';
      const timer = setTimeout(() => stop(new OidcError('sign_in_timeout')), this.o.signInTimeoutMs);
      server.listen(0, '127.0.0.1', () => {
        redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
        open(redirectUri).catch((e) => stop(e instanceof OidcError ? e : new OidcError('browser_failed')));
      });
    });
  }
}
