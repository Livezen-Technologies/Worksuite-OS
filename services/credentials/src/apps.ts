// WorkSuite server "desktop-v1" sign-in (the protocol a real WorkSuite server offers in /.well-known/worksuite-desktop,
// seen on demo.worksuite.lk 3.1.0): the system browser opens <server>/desktop/sign-in with a PKCE challenge, the person
// signs in there (password, passkey, MFA: all the server's), and the server hands a one-time code to the client
// "worksuite-desktop". The broker collects the session by polling /api/auth/apps/poll with its PKCE verifier, which
// only the process that started the sign-in holds, so no custom URL scheme or loopback port is needed. Codes are
// single use and bound to the verifier (checked against the server: a replay or a wrong verifier gets 401).
// Tokens: access 1 h (the broker caps it at 15 min), refresh token rotated on every /api/auth/refresh.
import { checkUrl, getJson, OidcError, type OidcOptions, type TokenSet } from './oidc.ts';

export const DESKTOP_CLIENT = 'worksuite-desktop';

export interface AppsEndpoints {
  protocol: 'desktop-v1';
  server: string;            // origin, e.g. https://demo.worksuite.lk
  api_base: string;          // <server>/ (desktop/v1/* lives at the root, auth under /api)
  sign_in: string;           // browser page
  poll: string; refresh: string; me: string; logout: string;
}

export interface AppsSession { tokens: TokenSet & { refresh_token: string }; user: { id: string; name?: string; email?: string } }

/** The server's desktop document says desktop-v1 and has no OneAuth issuer: use the apps flow. */
export function appsEndpoints(server: URL, doc: Record<string, unknown>): AppsEndpoints | null {
  if (doc.api !== 'desktop-v1' || typeof doc.oneauth_issuer === 'string') return null;
  const o = server.origin;
  return { protocol: 'desktop-v1', server: o, api_base: `${o}/`, sign_in: `${o}/desktop/sign-in`,
    poll: `${o}/api/auth/apps/poll`, refresh: `${o}/api/auth/refresh`, me: `${o}/api/auth/me`, logout: `${o}/api/auth/logout` };
}

export function signInPage(ep: AppsEndpoints, p: { challenge: string; state: string; device: string }): string {
  const u = new URL(ep.sign_in);
  u.search = new URLSearchParams({ challenge: p.challenge, state: p.state, device: p.device.slice(0, 80) }).toString();
  return u.toString();
}

const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function session(body: Record<string, any>): AppsSession {
  const d = body?.data ?? {};
  const t = d.tokens ?? {};
  if (typeof t.access_token !== 'string') throw new OidcError('no_access_token');
  if (typeof t.refresh_token !== 'string') throw new OidcError('no_refresh_token');
  const u = d.user ?? {};
  const id = String(u.uuid ?? u.id ?? '');
  if (!id) throw new OidcError('userinfo_failed');
  return { tokens: { access_token: t.access_token, refresh_token: t.refresh_token, expires_in: Number(t.expires_in) || undefined }, user: { id, name: u.name, email: u.email } };
}

/** One poll: null while the person has not finished in the browser (202), the session once they have (200). */
export async function pollOnce(ep: AppsEndpoints, verifier: string, o: OidcOptions = {}): Promise<AppsSession | null> {
  const r = await getJson(checkUrl(ep.poll, o), o, json({ client: DESKTOP_CLIENT, code_verifier: verifier }));
  if (r.status === 202) return null;
  if (r.status === 200) return session(r.body);
  throw new OidcError(r.status === 401 ? 'access_denied' : `http_${r.status}`, String(r.body?.message ?? ''));
}

/** Rotating refresh. 401/403 → the sign-in is gone (person signs in again); 409 = another refresh in flight, retried once. */
export async function refreshApps(ep: AppsEndpoints, refreshToken: string, o: OidcOptions = {}, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<TokenSet> {
  for (let attempt = 0; ; attempt++) {
    const r = await getJson(checkUrl(ep.refresh, o), o, json({ refresh_token: refreshToken }));
    if (r.status === 409 && attempt === 0) { await wait(1000); continue; }
    if (r.status === 401 || r.status === 403) throw new OidcError('invalid_grant');
    const t = r.body?.data?.tokens ?? r.body?.data ?? {};
    if (r.status !== 200 || typeof t.access_token !== 'string') throw new OidcError(`http_${r.status}`);
    return { access_token: t.access_token, refresh_token: t.refresh_token, expires_in: Number(t.expires_in) || undefined };
  }
}

/** Best effort: end the server session (sign-out must still succeed offline). */
export async function logoutApps(ep: AppsEndpoints, accessToken: string | null, o: OidcOptions = {}) {
  if (!accessToken) return;
  await getJson(checkUrl(ep.logout, o), o, { ...json({}), headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` } }).catch(() => {});
}
