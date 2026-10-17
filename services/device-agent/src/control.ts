// Root-only control socket of the device agent (WSOS-SEC-007). The caller check is the socket itself: 0600 root in
// the 0700 runtime directory, so only root (pkexec'd CLI) can connect. Requests are validated before any use.
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { dirname } from 'node:path';

export interface ControlHandlers {
  enroll(serverUrl: string, token: string): Promise<unknown>;
  refresh(): Promise<unknown>;
  status(): unknown;
}

const HTTPS = /^https:\/\/[^\s]{1,2040}$/;

export async function controlDispatch(h: ControlHandlers, line: string): Promise<{ result?: unknown; error?: string }> {
  let req: unknown;
  try { req = JSON.parse(line); } catch { return { error: 'bad_request' }; }
  if (!req || typeof req !== 'object' || Array.isArray(req)) return { error: 'bad_request' };
  const { method, params } = req as { method?: unknown; params?: unknown };
  if (typeof method !== 'string') return { error: 'bad_request' };
  if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) return { error: 'invalid_argument' };
  const p = (params ?? {}) as Record<string, unknown>;
  try {
    switch (method) {
      case 'Enroll': {
        if (typeof p.server_url !== 'string' || !HTTPS.test(p.server_url) || typeof p.enrollment_token !== 'string' || !p.enrollment_token || p.enrollment_token.length > 4096) return { error: 'invalid_argument' };
        return { result: await h.enroll(p.server_url, p.enrollment_token) };
      }
      case 'Refresh': return { result: await h.refresh() };
      case 'Status': return { result: h.status() };
      default: return { error: 'unknown_method' };
    }
  } catch (e) { return { error: String((e as Error)?.message ?? e) }; }
}

export function serveControl(path: string, h: ControlHandlers): Server {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });
  const server = createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', async (c) => {
      buf += c;
      if (buf.length > 16 * 1024) return sock.destroy();
      const nl = buf.indexOf('\n'); if (nl < 0) return;
      const line = buf.slice(0, nl); buf = '';
      const res = await controlDispatch(h, line);
      if (!sock.destroyed) sock.end(JSON.stringify(res) + '\n');
    });
    sock.on('error', () => {});
  });
  // umask first, then chmod: the socket is never reachable by another user, not even for an instant.
  const old = process.umask(0o177);
  server.listen(path, () => { process.umask(old); chmodSync(path, 0o600); });
  return server;
}
