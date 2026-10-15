#!/usr/bin/env worksuite-node
// worksuite-server: WorkSuite server MVP. Plain HTTP on loopback by default (put TLS in front of it), or HTTPS
// with --tls-cert/--tls-key. Clients refuse non-https URLs, so production always has TLS in the path.
//   worksuite-server serve --db server.db --public-url https://ws.example.com [--listen 127.0.0.1:8080] [--apt-dir REPO]
//   worksuite-server init --db server.db --org "Example Ltd" [--require-device]
//   worksuite-server user-add --db server.db --org 1 --email a@example.com --name "A User" [--admin]   (password on stdin)
//   worksuite-server enroll-token --db server.db --org 1 [--hours 24] [--uses 1]
//   worksuite-server policy-set --db server.db --org 1 policy.json
//   worksuite-server command --db server.db --device ID --name RefreshPolicy [--args '{}'] [--ttl-hours 24]
//   worksuite-server release-publish --db server.db manifest.json
//   worksuite-server catalog-put --db server.db item.json | app-put --db server.db app.json
//   worksuite-server keys-export --db server.db DIR | keys-rotate --db server.db | devices --db server.db | device-revoke --db server.db --device ID
import { createReadStream, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { parseArgs } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import * as admin from './admin.ts';
import { apiRoutes, purgeTombstones } from './api.ts';
import { openDb } from './db.ts';
import { HttpError, makeCtx, Router, sendError } from './http.ts';
import { oauthRoutes } from './oauth.ts';
import { consoleRoutes } from './console.ts';

/** webUrl: base the WorkSuite web apps live under (<webUrl>/<app>/); defaults to <publicUrl>/apps/. */
export interface ServerOptions { publicUrl: string; clientIds?: string[]; updateHost?: string; aptDir?: string; webUrl?: string }

const APT_TYPES: Record<string, string> = { '.deb': 'application/vnd.debian.binary-package', '.gz': 'application/gzip', '.xz': 'application/x-xz', '.gpg': 'application/pgp-signature' };

/** Static APT repository (tools/repo/publish.sh output) at /os/apt/. Integrity comes from the signed InRelease. */
function serveApt(root: string, path: string, res: ServerResponse): boolean {
  const rel = decodeURIComponent(path.slice('/os/apt/'.length));
  if (!/^(dists|pool)\/[A-Za-z0-9._+~\/-]+$/.test(rel) || rel.split('/').some((p) => p === '..' || p === '.' || p === '')) return false;
  let file: string;
  try { file = realpathSync(join(root, rel)); } catch { return false; }
  if (!file.startsWith(realpathSync(root) + sep)) return false;
  const st = statSync(file);
  if (!st.isFile()) return false;
  res.writeHead(200, { 'content-type': APT_TYPES[extname(file)] ?? 'text/plain; charset=utf-8', 'content-length': st.size, 'cache-control': rel.startsWith('pool/') ? 'public, max-age=31536000, immutable' : 'public, max-age=60' });
  createReadStream(file).pipe(res);
  return true;
}

export function createHandler(db: DatabaseSync, o: ServerOptions) {
  const publicUrl = o.publicUrl.replace(/\/?$/, '/');
  const issuer = new URL('oauth', publicUrl).toString();
  const r = new Router();
  oauthRoutes(r, db, { issuer, clientIds: o.clientIds ?? ['worksuite-os'] });
  const webUrl = o.webUrl ? o.webUrl.replace(/\/?$/, '/') : new URL('apps/', publicUrl).toString();
  apiRoutes(r, db, { publicUrl, issuer, updateHost: o.updateHost ?? new URL(publicUrl).host, webUrl });
  consoleRoutes(r, db, { secureCookie: publicUrl.startsWith('https:') });
  return async (req: IncomingMessage, res: ServerResponse) => {
    const ctx = makeCtx(req, res, publicUrl);
    try {
      if (o.aptDir && (req.method === 'GET' || req.method === 'HEAD') && ctx.url.pathname.startsWith('/os/apt/')) {
        if (serveApt(o.aptDir, ctx.url.pathname, res)) return;
        throw new HttpError(404, 'NOT_FOUND', 'not found');
      }
      const m = r.match(req.method ?? 'GET', ctx.url.pathname);
      if (m === 'method') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
      if (!m) throw new HttpError(404, 'NOT_FOUND', 'not found');
      ctx.params = m.params;
      await m.h(ctx);
    } catch (e) {
      if (!res.headersSent) sendError(ctx, e); else res.destroy();
    }
  };
}

const readStdin = () => readFileSync(0, 'utf8').replace(/\r?\n$/, '');
const readJson = (path: string | undefined) => {
  if (!path) throw new Error('JSON file argument required');
  return JSON.parse(readFileSync(path, 'utf8'));
};

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  const { values: v, positionals } = parseArgs({
    args: rest, allowPositionals: true, options: {
      db: { type: 'string' }, 'public-url': { type: 'string' }, listen: { type: 'string', default: '127.0.0.1:8080' },
      'tls-cert': { type: 'string' }, 'apt-dir': { type: 'string' }, 'tls-key': { type: 'string' }, 'update-host': { type: 'string' }, 'web-url': { type: 'string' }, apps: { type: 'string' },
      org: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' }, device: { type: 'string' },
      args: { type: 'string' }, hours: { type: 'string' }, uses: { type: 'string' }, 'ttl-hours': { type: 'string' },
      'require-device': { type: 'boolean' }, admin: { type: 'boolean' },
    },
  });
  if (!v.db) throw new Error('--db PATH required');
  const db = openDb(v.db);
  const org = () => { const n = Number(v.org); if (!Number.isInteger(n) || n < 1) throw new Error('--org ID required'); return n; };
  const out = (x: unknown) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));

  switch (cmd) {
    case 'serve': {
      if (!v['public-url']) throw new Error('--public-url required (the https URL clients use)');
      const handler = createHandler(db, { publicUrl: v['public-url'], updateHost: v['update-host'], aptDir: v['apt-dir'], webUrl: v['web-url'] });
      const server = v['tls-cert'] && v['tls-key']
        ? createHttps({ cert: readFileSync(v['tls-cert']), key: readFileSync(v['tls-key']) }, handler)
        : createHttp(handler);
      const [host, port] = [v.listen!.slice(0, v.listen!.lastIndexOf(':')), Number(v.listen!.slice(v.listen!.lastIndexOf(':') + 1))];
      purgeTombstones(db);
      setInterval(() => purgeTombstones(db), 3_600_000).unref();
      server.listen(port, host, () => console.log(`worksuite-server listening on ${v.listen} as ${v['public-url']}`));
      process.on('SIGTERM', () => server.close(() => process.exit(0)));
      return;
    }
    case 'set-web-apps': admin.setWebApps(db, org(), v.apps ? v.apps.split(',').map((x) => x.trim()) : null); return out('ok');
    case 'init': return out({ org_id: admin.createOrg(db, v.org ?? v.name ?? 'WorkSuite', { requireDevice: v['require-device'] }) });
    case 'user-add': return out({ user_id: admin.addUser(db, org(), v.email ?? '', v.name ?? v.email ?? '', readStdin(), v.admin ? 'admin' : 'user') });
    case 'enroll-token': return out(admin.createEnrollmentToken(db, org(), { hours: v.hours ? Number(v.hours) : undefined, uses: v.uses ? Number(v.uses) : undefined }));
    case 'policy-set': return out({ version: admin.setPolicy(db, org(), readJson(positionals[0])) });
    case 'command': return out({ command_id: admin.issueCommand(db, v.device ?? '', v.name ?? '', v.args ? JSON.parse(v.args) : {}, v['ttl-hours'] ? Number(v['ttl-hours']) : undefined) });
    case 'release-publish': return out(admin.publishRelease(db, readJson(positionals[0])));
    case 'catalog-put': admin.putCatalogItem(db, readJson(positionals[0])); return;
    case 'app-put': admin.putApp(db, readJson(positionals[0])); return;
    case 'keys-export': return out(admin.exportKeys(db, positionals[0] ?? '.'));
    case 'keys-rotate': return out(admin.rotateKey(db));
    case 'devices': return out(admin.listDevices(db));
    case 'device-revoke': return out({ revoked: admin.revokeDevice(db, v.device ?? '') });
    default: throw new Error(`unknown command ${cmd ?? ''}; see the header of src/main.ts`);
  }
}

if (import.meta.main) main(process.argv.slice(2)).catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
