// OneAuth MVP: OpenID Connect provider for the desktop's public client (authorization code + PKCE S256 only,
// loopback redirect URIs per RFC 8252). Opaque access tokens (15 min) and rotating refresh tokens (30 days);
// reuse of a rotated refresh token revokes its whole family.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { escapeHtml, HttpError, send, type Ctx, type Router } from './http.ts';
import { secret, sha256, tx } from './db.ts';

export const ACCESS_TTL_S = 15 * 60;
const REFRESH_TTL_MS = 30 * 86_400_000;
const CODE_TTL_MS = 2 * 60_000;

export interface User { id: number; org_id: number; email: string; name: string }

export function hashPassword(pw: string) {
  const salt = randomBytes(16);
  return { salt, hash: scryptSync(pw, salt, 32) };
}

export function checkPassword(db: DatabaseSync, email: string, pw: string): User | undefined {
  const u = db.prepare('SELECT id, org_id, email, name, pw_salt, pw_hash, disabled FROM users WHERE email = ?').get(email.trim().toLowerCase()) as
    (User & { pw_salt: Uint8Array; pw_hash: Uint8Array; disabled: number }) | undefined;
  // Constant work whether or not the user exists.
  const got = scryptSync(pw, u ? Buffer.from(u.pw_salt) : Buffer.alloc(16), 32);
  if (!u || u.disabled || !timingSafeEqual(got, Buffer.from(u.pw_hash))) return undefined;
  return { id: u.id, org_id: u.org_id, email: u.email, name: u.name };
}

/** Loopback http redirect (any port) only: the desktop broker's one-shot listener. */
function loopbackRedirect(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === '[::1]') && !u.username && !u.password && !u.hash;
  } catch { return false; }
}

export interface OAuthOptions { issuer: string; clientIds: string[] }

export function issueTokens(db: DatabaseSync, userId: number, clientId: string, family = randomBytes(12).toString('hex')) {
  const access = secret('wsa'), refresh = secret('wsr');
  const ins = db.prepare('INSERT INTO tokens (hash, kind, user_id, client_id, family, expires) VALUES (?, ?, ?, ?, ?, ?)');
  ins.run(sha256(access), 'access', userId, clientId, family, Date.now() + ACCESS_TTL_S * 1000);
  ins.run(sha256(refresh), 'refresh', userId, clientId, family, Date.now() + REFRESH_TTL_MS);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: 'openid profile offline_access' };
}

/** Bearer access token → user, or 401 TOKEN_EXPIRED. */
export function userFromBearer(db: DatabaseSync, ctx: Ctx): User {
  const m = /^Bearer (\S+)$/.exec(ctx.header('authorization') ?? '');
  if (!m) throw new HttpError(401, 'TOKEN_EXPIRED', 'missing bearer token');
  const row = db.prepare(`SELECT u.id, u.org_id, u.email, u.name, u.disabled, t.expires, t.revoked FROM tokens t JOIN users u ON u.id = t.user_id
    WHERE t.hash = ? AND t.kind = 'access'`).get(sha256(m[1])) as (User & { expires: number; revoked: number; disabled: number }) | undefined;
  if (!row || row.revoked || row.disabled || row.expires < Date.now()) throw new HttpError(401, 'TOKEN_EXPIRED', 'access token invalid or expired');
  return { id: row.id, org_id: row.org_id, email: row.email, name: row.name };
}

const tokenError = (ctx: Ctx, error: string, status = 400) => send(ctx, status, { error });

function loginPage(params: URLSearchParams, message?: string) {
  const hidden = ['client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'response_type']
    .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(params.get(k) ?? '')}">`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in to WorkSuite</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1120;color:#e2e8f0;font:16px system-ui,sans-serif}
form{width:min(360px,90vw);background:#111a2e;padding:32px;border-radius:16px;display:grid;gap:14px}
h1{margin:0 0 4px;font-size:22px}input{padding:11px 12px;border-radius:10px;border:1px solid #334155;background:#0b1120;color:inherit;font:inherit}
button{padding:12px;border:0;border-radius:10px;background:#0A6CFF;color:#fff;font:600 16px system-ui}.err{color:#fca5a5;margin:0}
label{display:grid;gap:6px;font-size:14px;color:#94a3b8}</style></head><body>
<form method="post" action="authorize"><h1>Sign in to WorkSuite</h1>${message ? `<p class="err" role="alert">${escapeHtml(message)}</p>` : ''}
<label>Email<input name="email" type="email" autocomplete="username" required autofocus></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
${hidden}<button type="submit">Sign in</button></form></body></html>`;
}

export function oauthRoutes(r: Router, db: DatabaseSync, o: OAuthOptions) {
  const base = o.issuer.replace(/\/$/, '');
  r.on('GET', '/oauth/.well-known/openid-configuration', (ctx) => send(ctx, 200, {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    userinfo_endpoint: `${base}/userinfo`,
    revocation_endpoint: `${base}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['openid', 'profile', 'offline_access'],
    subject_types_supported: ['public'],
  }));

  // Errors before the redirect URI is trusted are shown here, never redirected (RFC 6749 §4.1.2.1).
  const checkAuthz = (p: URLSearchParams) => {
    if (!o.clientIds.includes(p.get('client_id') ?? '')) throw new HttpError(400, 'VALIDATION', 'unknown client_id');
    if (!loopbackRedirect(p.get('redirect_uri') ?? '')) throw new HttpError(400, 'VALIDATION', 'redirect_uri must be a loopback http URI');
    if (p.get('response_type') !== 'code') throw new HttpError(400, 'VALIDATION', 'response_type must be code');
    if (p.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(p.get('code_challenge') ?? ''))
      throw new HttpError(400, 'VALIDATION', 'PKCE S256 code_challenge required');
  };
  const html = { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' http://127.0.0.1:* http://[::1]:*; frame-ancestors 'none'" };

  r.on('GET', '/oauth/authorize', (ctx) => {
    checkAuthz(ctx.url.searchParams);
    send(ctx, 200, loginPage(ctx.url.searchParams), html);
  });

  r.on('POST', '/oauth/authorize', async (ctx) => {
    const p = new URLSearchParams(await ctx.body() as Record<string, string>);
    checkAuthz(p);
    const user = checkPassword(db, p.get('email') ?? '', p.get('password') ?? '');
    if (!user) return send(ctx, 401, loginPage(p, 'Email or password is incorrect.'), html);
    const code = secret('wsc');
    db.prepare('INSERT INTO oauth_codes (hash, user_id, client_id, redirect_uri, challenge, expires) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sha256(code), user.id, p.get('client_id')!, p.get('redirect_uri')!, p.get('code_challenge')!, Date.now() + CODE_TTL_MS);
    const to = new URL(p.get('redirect_uri')!);
    to.searchParams.set('code', code);
    if (p.get('state')) to.searchParams.set('state', p.get('state')!);
    send(ctx, 302, undefined, { location: to.toString() });
  });

  r.on('POST', '/oauth/token', async (ctx) => {
    const f = await ctx.body() as Record<string, string>;
    if (!o.clientIds.includes(f.client_id ?? '')) return tokenError(ctx, 'invalid_client', 401);
    if (f.grant_type === 'authorization_code') {
      const row = tx(db, () => {
        const c = db.prepare('SELECT user_id, client_id, redirect_uri, challenge, expires FROM oauth_codes WHERE hash = ?').get(sha256(f.code ?? '')) as
          { user_id: number; client_id: string; redirect_uri: string; challenge: string; expires: number } | undefined;
        db.prepare('DELETE FROM oauth_codes WHERE hash = ? OR expires < ?').run(sha256(f.code ?? ''), Date.now());   // single use
        return c;
      });
      if (!row || row.expires < Date.now() || row.client_id !== f.client_id || row.redirect_uri !== f.redirect_uri) return tokenError(ctx, 'invalid_grant');
      const challenge = createHash('sha256').update(f.code_verifier ?? '').digest('base64url');
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(f.code_verifier ?? '') || challenge !== row.challenge) return tokenError(ctx, 'invalid_grant');
      return send(ctx, 200, issueTokens(db, row.user_id, f.client_id));
    }
    if (f.grant_type === 'refresh_token') {
      const out = tx(db, () => {
        const t = db.prepare("SELECT user_id, client_id, family, expires, revoked FROM tokens WHERE hash = ? AND kind = 'refresh'").get(sha256(f.refresh_token ?? '')) as
          { user_id: number; client_id: string; family: string; expires: number; revoked: number } | undefined;
        if (!t || t.client_id !== f.client_id || t.expires < Date.now()) return undefined;
        if (t.revoked) { db.prepare('UPDATE tokens SET revoked = 1 WHERE family = ?').run(t.family); return 'reuse' as const; }
        const u = db.prepare('SELECT disabled FROM users WHERE id = ?').get(t.user_id) as { disabled: number } | undefined;
        if (!u || u.disabled) return undefined;
        db.prepare('UPDATE tokens SET revoked = 1 WHERE hash = ?').run(sha256(f.refresh_token!));
        return issueTokens(db, t.user_id, t.client_id, t.family);
      });
      if (!out || out === 'reuse') return tokenError(ctx, 'invalid_grant');
      return send(ctx, 200, out);
    }
    return tokenError(ctx, 'unsupported_grant_type');
  });

  r.on('GET', '/oauth/userinfo', (ctx) => {
    const u = userFromBearer(db, ctx);
    send(ctx, 200, { sub: String(u.id), name: u.name, email: u.email });
  });

  // RFC 7009: always 200; revoking a refresh token ends its family (sign-out).
  r.on('POST', '/oauth/revoke', async (ctx) => {
    const f = await ctx.body() as Record<string, string>;
    const t = db.prepare('SELECT family FROM tokens WHERE hash = ? AND client_id = ?').get(sha256(f.token ?? ''), f.client_id ?? '') as { family: string } | undefined;
    if (t) db.prepare('UPDATE tokens SET revoked = 1 WHERE family = ?').run(t.family);
    send(ctx, 200, {});
  });
}
