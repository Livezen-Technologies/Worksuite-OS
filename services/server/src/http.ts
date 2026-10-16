// Minimal HTTP plumbing: structured errors (Error schema), JSON bodies with the 1 MiB limit, request ids.
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from './log.ts';

export class HttpError extends Error {
  readonly status: number; readonly code: string; readonly retryable?: boolean;
  readonly details?: { field?: string; code?: string; message?: string }[];
  constructor(status: number, code: string, message = code, extra: { retryable?: boolean; details?: HttpError['details'] } = {}) {
    super(message); this.status = status; this.code = code; this.retryable = extra.retryable; this.details = extra.details;
  }
}

export const invalid = (field: string, message = 'invalid') =>
  new HttpError(400, 'VALIDATION', `${field}: ${message}`, { details: [{ field, code: 'invalid', message }] });

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  requestId: string;
  params: Record<string, string>;
  body(): Promise<unknown>;
  raw(): Promise<Buffer>;
  header(name: string): string | undefined;
}

const MAX_BODY = 1024 * 1024;

export function makeCtx(req: IncomingMessage, res: ServerResponse, publicUrl: string): Ctx {
  const rid = req.headers['x-request-id'];
  const requestId = typeof rid === 'string' && rid.length <= 128 && /^[\x21-\x7e]+$/.test(rid) ? rid : randomUUID();
  let rawP: Promise<Buffer> | undefined;
  const raw = () => rawP ??= new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []; let n = 0;
    req.on('data', (c: Buffer) => {
      if (n > MAX_BODY) return;   // drain the rest; the 413 goes out with Connection: close
      n += c.length;
      if (n > MAX_BODY) { chunks.length = 0; res.shouldKeepAlive = false; reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', 'body over 1 MiB')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  return {
    req, res, requestId, params: {},
    url: new URL(req.url ?? '/', publicUrl),
    raw,
    async body() {
      const b = await raw();
      if (!b.length) return {};
      const ct = String(req.headers['content-type'] ?? '');
      if (ct.startsWith('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(b.toString('utf8')));
      try { return JSON.parse(b.toString('utf8')); } catch { throw new HttpError(400, 'VALIDATION', 'body is not JSON'); }
    },
    header: (name) => { const v = req.headers[name.toLowerCase()]; return Array.isArray(v) ? v[0] : v; },
  };
}

export function send(ctx: Ctx, status: number, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { 'x-request-id': ctx.requestId, 'cache-control': 'no-store', ...headers };
  if (body === undefined) { ctx.res.writeHead(status, h); ctx.res.end(); return; }
  if (typeof body === 'string' && h['content-type']) { ctx.res.writeHead(status, h); ctx.res.end(body); return; }
  ctx.res.writeHead(status, { ...h, 'content-type': 'application/json' });
  ctx.res.end(JSON.stringify(body));
}

export function sendError(ctx: Ctx, e: unknown) {
  const err = e instanceof HttpError ? e : new HttpError(500, 'INTERNAL', 'internal error', { retryable: true });
  if (!(e instanceof HttpError)) log('error', 'unhandled_error', { request_id: ctx.requestId, error: e instanceof Error ? e.message : String(e) });
  send(ctx, err.status, { error: {
    code: err.code, message: err.message, request_id: ctx.requestId,
    ...(err.retryable !== undefined ? { retryable: err.retryable } : {}), ...(err.details ? { details: err.details } : {}),
  } });
}

export type Handler = (ctx: Ctx) => Promise<void> | void;

/** Path patterns with `{name}` segments. */
export class Router {
  private routes: { method: string; re: RegExp; names: string[]; h: Handler }[] = [];
  on(method: string, pattern: string, h: Handler) {
    const names: string[] = [];
    const re = new RegExp('^' + pattern.replace(/[.]/g, '\\.').replace(/\{(\w+)\}/g, (_m, n) => { names.push(n); return '([^/]+)'; }) + '$');
    this.routes.push({ method, re, names, h });
    return this;
  }
  match(method: string, path: string): { h: Handler; params: Record<string, string> } | 'method' | undefined {
    let other = false;
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      if (r.method !== method) { other = true; continue; }
      return { h: r.h, params: Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
    }
    return other ? 'method' : undefined;
  }
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
