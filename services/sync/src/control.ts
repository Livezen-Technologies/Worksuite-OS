// Line-delimited JSON over 0600 Unix sockets (SRS §10.3). One request per line, one response per line.
import { createServer, createConnection, type Server } from 'node:net';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SyncService } from './service.ts';
import type { TokenProvider } from './transport.ts';

type Request = { id?: unknown; method: string; params?: Record<string, unknown> };

/** Serve lk.worksuite.Sync1-equivalent methods for the shell: Status, ListFailed, RetryFailed, SyncNow. */
export function serveControl(path: string, svc: SyncService): Server {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });
  const server = createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', async (chunk) => {
      buf += chunk;
      if (buf.length > 64 * 1024) { sock.destroy(); return; }
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        sock.write(JSON.stringify(await dispatch(svc, line)) + '\n');
      }
    });
    sock.on('error', () => {});
  });
  server.listen(path, () => chmodSync(path, 0o600));
  return server;
}

async function dispatch(svc: SyncService, line: string) {
  let req: Request;
  try { req = JSON.parse(line); } catch { return { error: 'bad_request' }; }
  const id = req.id ?? null;
  switch (req.method) {
    case 'Status': return { id, result: svc.status() };
    case 'ListFailed': return { id, result: svc.listFailed() };
    case 'SyncNow': void svc.syncNow(); return { id, result: true };
    case 'RetryFailed': {
      const m = req.params?.mutation_id;
      if (typeof m !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(m)) return { id, error: 'invalid_argument' };
      void svc.retryFailed(m);
      return { id, result: true };
    }
    default: return { id, error: 'unknown_method' };
  }
}

/** Token provider backed by the credentials broker socket (lk.worksuite.Credentials1 GetAccessToken). */
export function brokerTokens(path: string, accountId: string): TokenProvider {
  const ask = (refresh: boolean) => new Promise<string>((resolve, reject) => {
    const sock = createConnection(path);
    let buf = '';
    sock.setEncoding('utf8');
    sock.setTimeout(10_000, () => sock.destroy(new Error('broker timeout')));
    sock.on('connect', () => sock.write(JSON.stringify({ method: 'GetAccessToken', params: { account_id: accountId, force_refresh: refresh } }) + '\n'));
    sock.on('data', (c) => {
      buf += c;
      if (!buf.includes('\n')) return;
      sock.end();
      try {
        const res = JSON.parse(buf.slice(0, buf.indexOf('\n')));
        typeof res.result === 'string' ? resolve(res.result) : reject(new Error(res.error ?? 'no token'));
      } catch (e) { reject(e); }
    });
    sock.on('error', reject);
  });
  return { current: () => ask(false), refresh: () => ask(true) };
}
