// worksuite-credentials: the session's token broker on a 0600 Unix socket (SRS §10.3), line-delimited JSON.
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Broker, type Account } from './broker.ts';
import { OidcError } from './oidc.ts';
import { secretToolStore } from './keyring.ts';

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
        if (!server) return { id, error: 'invalid_argument' };
        const a = await broker.signIn(server);
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
        sock.write(JSON.stringify(await dispatch(broker, req)) + '\n');
      }
    });
    sock.on('error', () => {});
  });
  server.listen(path, () => chmodSync(path, 0o600));
  return server;
}

async function main() {
  const env = process.env;
  const configDir = join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'worksuite');
  const runtimeDir = join(env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`, 'worksuite');
  const accountsPath = join(configDir, 'accounts.json');
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
  });
  const server = serve(join(runtimeDir, 'credentials.sock'), broker);
  const stop = () => { broker.lock(); server.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  log('started', { accounts: accounts.length });
}

if (import.meta.main) main().catch((e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(1); });
