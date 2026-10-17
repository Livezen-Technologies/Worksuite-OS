// worksuite-credentials: the session's token broker on a 0600 Unix socket (SRS §10.3), line-delimited JSON.
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Broker, type Account } from './broker.ts';
import { OidcError } from './oidc.ts';
import { secretToolStore } from './keyring.ts';
import { buildSyncConfig, fetchBootstrap, removeSyncConfig, systemctlUser, writeSyncConfig } from './syncconfig.ts';

type Req = { id?: unknown; method?: unknown; params?: Record<string, unknown> };

const str = (v: unknown, max = 2048) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);

export async function dispatch(broker: Broker, req: Req) {
  const id = req.id ?? null;
  const p = req.params ?? {};
  try {
    switch (req.method) {
      case 'GetAccessToken': {
        const account = str(p.account_id, 512);
        if (!account) return { id, error: 'invalid_argument' };
        const t = await broker.getAccessToken(account, p.force_refresh === true);
        return { id, result: t.token, expires_at: t.expiresAt };
      }
      case 'SignIn': {
        const server = str(p.server_url);
        const mode = p.mode === 'personal' || p.mode === 'enterprise' ? p.mode : null;
        if (!server || !mode) return { id, error: 'invalid_argument' };
        const a = await broker.signIn(server, mode);
        return { id, result: { id: a.id, name: a.name ?? null, server_url: a.server_url } };
      }
      case 'SignOut': {
        const account = str(p.account_id, 512);
        if (!account) return { id, error: 'invalid_argument' };
        await broker.signOut(account);
        return { id, result: true };
      }
      case 'Status': return { id, result: broker.list() };
      case 'Lock': broker.lock(); return { id, result: true };
      case 'Unlock': broker.unlock(); return { id, result: true };
      default: return { id, error: 'unknown_method' };
    }
  } catch (e) {
    return { id, error: e instanceof OidcError ? e.code : 'internal_error' };
  }
}

export function serve(path: string, broker: Broker): Server {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });
  const server = createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', async (chunk) => {
      buf += chunk;
      if (buf.length > 16 * 1024) { sock.destroy(); return; }
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let req: Req;
        try { req = JSON.parse(line); } catch { sock.write('{"error":"bad_request"}\n'); continue; }
        // §13.1 malicious IPC: non-object requests and non-object params are refused, never dereferenced.
        if (!req || typeof req !== 'object' || Array.isArray(req) || typeof req.method !== 'string' ||
            (req.params !== undefined && (req.params === null || typeof req.params !== 'object' || Array.isArray(req.params)))) {
          sock.write('{"error":"bad_request"}\n'); continue;
        }
        let res: unknown;
        try { res = await dispatch(broker, req); } catch { res = { error: 'internal_error' }; }
        if (!sock.destroyed) sock.write(JSON.stringify(res) + '\n');
      }
    });
    sock.on('error', () => {});
  });
  // umask first, then chmod: the socket is never reachable by another user, not even for an instant.
  const old = process.umask(0o177);
  server.listen(path, () => { process.umask(old); chmodSync(path, 0o600); });
  return server;
}

/**
 * WSOS-DIR-008: the directory PAM helper leaves a one-time login code for this user after a greeter sign-in
 * (/run/worksuite-directory/sso/<uid>/login.json, 0600). Use it once: delete it first, then exchange it.
 */
export async function importLoginHandoff(broker: Broker, o: { path: string; deviceCredential: () => string | null; log: (e: string, f?: Record<string, unknown>) => void; now?: () => number }) {
  let raw: string;
  try { raw = readFileSync(o.path, 'utf8'); } catch { return null; }
  rmSync(o.path, { force: true });
  let h: { server_url?: unknown; login_code?: unknown; issued_at?: unknown };
  try { h = JSON.parse(raw); } catch { o.log('login_handoff_invalid'); return null; }
  const server = str(h.server_url), code = str(h.login_code, 512);
  const issued = typeof h.issued_at === 'string' ? Date.parse(h.issued_at) : NaN;
  if (!server || !code || !(issued > (o.now ?? Date.now)() - 2 * 60_000)) { o.log('login_handoff_stale'); return null; }
  const device = o.deviceCredential();
  if (!device) { o.log('login_handoff_no_device'); return null; }
  try {
    const a = await broker.signInWithLoginCode(server, code, device);
    o.log('signed_in_from_greeter', { account: a.id });
    return a;
  } catch (e) {
    o.log('login_handoff_failed', { error: e instanceof OidcError ? e.code : 'internal_error' });
    return null;
  }
}

async function main() {
  const env = process.env;
  const configDir = join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'worksuite');
  const runtimeDir = join(env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`, 'worksuite');
  const accountsPath = join(configDir, 'accounts.json');
  const syncConfigPath = join(configDir, 'sync.json');
  const readDeviceCredential = () => {
    try { return readFileSync('/run/worksuite-device-agent/device-token', 'utf8').trim() || null; } catch { return null; }
  };
  mkdirSync(configDir, { recursive: true, mode: 0o700 });

  const log = (event: string, f: Record<string, unknown> = {}) =>
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), service: 'worksuite-credentials', event, ...f }) + '\n');

  const accounts: Account[] = existsSync(accountsPath) ? JSON.parse(readFileSync(accountsPath, 'utf8')) : [];
  const broker = new Broker({
    clientId: env.WORKSUITE_ONEAUTH_CLIENT_ID || 'worksuite-os',
    secrets: secretToolStore,
    accounts,
    saveAccounts: (a) => {
      // Atomic replace; no secrets in this file.
      writeFileSync(accountsPath + '.tmp', JSON.stringify(a, null, 2), { mode: 0o600 });
      renameSync(accountsPath + '.tmp', accountsPath);
    },
    openBrowser: (url) => new Promise((resolve, reject) => execFile('xdg-open', [url], (e) => (e ? reject(e) : resolve()))),
    onState: (account, state) => log('state', { account, state }),
    // Sync config from bootstrap, then start sync (it exits quietly while unconfigured).
    onSignedIn: async (account, { apiBase, accessToken, mode }) => {
      const device = readDeviceCredential();
      if (mode === 'enterprise' && !device) log('device_not_enrolled', { account: account.id });
      const bootstrap = await fetchBootstrap(apiBase, accessToken, device);
      writeSyncConfig(syncConfigPath, buildSyncConfig(account, apiBase, mode, bootstrap));
      await systemctlUser('restart');
      log('sync_configured', { account: account.id });
    },
    // The shell has already settled unsent changes (WSOS-SYN-008) and told sync to forget the account.
    onSignedOut: async (account) => {
      if (removeSyncConfig(syncConfigPath, account.id)) await systemctlUser('stop');
    },
  });
  const server = serve(join(runtimeDir, 'credentials.sock'), broker);
  await importLoginHandoff(broker, { path: join(env.WORKSUITE_DIRECTORY_RUN || '/run/worksuite-directory', 'sso', String(process.getuid?.() ?? -1), 'login.json'), deviceCredential: readDeviceCredential, log });
  const stop = () => { broker.lock(); server.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  log('started', { accounts: accounts.length });
}

if (import.meta.main) main().catch((e) => { process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), service: 'worksuite-credentials', level: 'error', event: 'fatal', error: String(e?.stack ?? e) }) + '\n'); process.exit(1); });
