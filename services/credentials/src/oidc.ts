// OneAuth discovery and token endpoint calls: public client, authorization code + PKCE, no client secret.
export interface Endpoints { api_base: string; issuer: string; authorization_endpoint: string; token_endpoint: string; userinfo_endpoint: string; revocation_endpoint?: string }
export interface TokenSet { access_token: string; expires_in?: number; refresh_token?: string }

export class OidcError extends Error {
  readonly code: string;
  constructor(code: string, message = code) { super(message); this.code = code; }
}

export interface OidcOptions { fetch?: typeof fetch; allowInsecureLoopback?: boolean }

/** Only https, except loopback http when explicitly allowed (tests, local development). */
export function checkUrl(raw: string, o: OidcOptions = {}): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new OidcError('invalid_url'); }
  if (u.username || u.password) throw new OidcError('invalid_url', 'credentials in URL');
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  if (u.protocol === 'https:' || (o.allowInsecureLoopback && loopback && u.protocol === 'http:')) return u;
  throw new OidcError('insecure_url', `refusing non-https URL ${u.origin}`);
}

/**
 * A failed fetch (undici puts the system error in `cause`) → a code the person can act on (#55: these all used to
 * surface as "internal_error" and one generic message, whatever went wrong).
 */
export function networkError(e: unknown): OidcError {
  if (e instanceof OidcError) return e;
  const err = e as { name?: string; code?: string; cause?: { code?: string; name?: string; message?: string } } | null;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.cause?.name === 'TimeoutError' || err?.cause?.name === 'ConnectTimeoutError') return new OidcError('network_timeout');
  const code = String(err?.cause?.code ?? err?.code ?? '');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME') return new OidcError('dns_failed');
  if (/^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EPIPE|UND_ERR_SOCKET)$/.test(code)) return new OidcError('unreachable');
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT') return new OidcError('network_timeout');
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|ERR_SSL|EPROTO|HOSTNAME_MISMATCH|ALTNAME/i.test(code + ' ' + (err?.cause?.message ?? ''))) return new OidcError('tls_failed');
  return new OidcError('unreachable');
}

/** At most this many redirects, each to https (or the allowed loopback) again; never with a body. */
const MAX_REDIRECTS = 3;

async function getJson(url: URL, o: OidcOptions, init?: RequestInit) {
  let res: Response;
  // #55: redirect "error" made every redirect (say example.com → www.example.com, a trailing slash) a failed sign-in.
  // Redirects are followed by hand so each hop is checked again: https only, and only for GETs.
  for (let hop = 0; ; hop++) {
    try {
      res = await (o.fetch ?? fetch)(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    } catch (e) { throw networkError(e); }
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!loc) break;
    if ((init?.method ?? 'GET') !== 'GET' || hop >= MAX_REDIRECTS) throw new OidcError('discovery_failed', 'too many or unexpected redirects');
    url = checkUrl(new URL(loc, url).toString(), o);
  }
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body: body as Record<string, any> };
}

/** WorkSuite server → OneAuth issuer (/.well-known/worksuite-desktop), then OIDC discovery. */
export async function discover(serverUrl: string, o: OidcOptions = {}): Promise<Endpoints> {
  const server = checkUrl(serverUrl, o);
  const d = await getJson(new URL('/.well-known/worksuite-desktop', server), o);
  if (d.status !== 200 || typeof d.body.oneauth_issuer !== 'string') throw new OidcError('discovery_failed');
  const issuer = checkUrl(d.body.oneauth_issuer, o).toString().replace(/\/$/, '');
  const api_base = checkUrl(typeof d.body.api_base === 'string' ? d.body.api_base : server.toString(), o).toString();
  const meta = await getJson(new URL(`${issuer}/.well-known/openid-configuration`), o);
  const m = meta.body;
  if (meta.status !== 200 || m.issuer?.replace(/\/$/, '') !== issuer) throw new OidcError('discovery_failed', 'issuer mismatch');
  for (const k of ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint']) checkUrl(m[k], o);
  return { api_base, issuer, authorization_endpoint: m.authorization_endpoint, token_endpoint: m.token_endpoint, userinfo_endpoint: m.userinfo_endpoint, revocation_endpoint: m.revocation_endpoint };
}

export function authorizationUrl(ep: Endpoints, p: { clientId: string; redirectUri: string; challenge: string; state: string }) {
  const u = new URL(ep.authorization_endpoint);
  u.search = new URLSearchParams({
    response_type: 'code', client_id: p.clientId, redirect_uri: p.redirectUri, scope: 'openid profile offline_access',
    code_challenge: p.challenge, code_challenge_method: 'S256', state: p.state,
  }).toString();
  return u.toString();
}

export async function tokenRequest(ep: Endpoints, form: Record<string, string>, o: OidcOptions = {}, headers: Record<string, string> = {}): Promise<TokenSet> {
  const r = await getJson(new URL(ep.token_endpoint), o, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString(),
  });
  if (r.status !== 200 || typeof r.body.access_token !== 'string') throw new OidcError(r.body.error ?? `http_${r.status}`);
  return r.body as TokenSet;
}

export async function userinfo(ep: Endpoints, accessToken: string, o: OidcOptions = {}) {
  const r = await getJson(new URL(ep.userinfo_endpoint), o, { headers: { authorization: `Bearer ${accessToken}` } });
  if (r.status !== 200 || typeof r.body.sub !== 'string') throw new OidcError('userinfo_failed');
  return r.body as { sub: string; name?: string; email?: string };
}

/** RFC 8693 token exchange of the one-time code from a directory sign-in at the greeter (WSOS-DIR-008). */
export const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const OS_LOGIN_CODE = 'urn:worksuite:params:oauth:token-type:os-login-code';
