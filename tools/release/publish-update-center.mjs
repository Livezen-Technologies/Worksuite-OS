#!/usr/bin/env node
// Publish a WorkSuite OS build to the WorkSuite Update Center (Livezen-Technologies/worksite-download, §18).
// No dependencies; Node 20+. Same idea as worksuite-office build/publish-release.mjs: CI uploads and publishes to a
// pre-release ring; promotion to stable, pause, pull and emergency releases stay with release managers.
//
//   UC_URL=https://download.worksuitecloud.com UPDATE_CENTER_TOKEN=<client_id>.<secret> \
//   node tools/release/publish-update-center.mjs --version 1.2.0 --ring development --type feature \
//     --min-version 1.0.0 --dist dist [--apt apt-repo.tar.gz] [--dry-run]
//
// --dist is searched recursively for worksuite-os-*-<arch>.iso (+ .sha256) and worksuite-os-*-<arch>.spdx.json;
// "-perf" test images are skipped. Files are uploaded as worksuite-os-<version>-<arch>.{iso,iso.sha256,sbom.spdx.json}.
// The token is an Update Center API client with the os.publish permission; it is read from the environment only.
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';

export function parseArgs(argv) {
  const o = { ring: 'development', type: 'feature', dist: 'dist', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === '--version') o.version = v().replace(/^v/, '');
    else if (a === '--ring') o.ring = v();
    else if (a === '--type') o.type = v();
    else if (a === '--min-version') o.minVersion = v();
    else if (a === '--rollout') o.rollout = Number(v());
    else if (a === '--dist') o.dist = v();
    else if (a === '--apt') o.apt = v();
    else if (a === '--notes') o.notes = v();
    else if (a === '--dry-run') o.dryRun = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!/^[0-9][A-Za-z0-9.+~-]*$/.test(o.version ?? '')) throw new Error('--version is required (e.g. 1.2.0)');
  if (!['development', 'pilot', 'canary', 'beta'].includes(o.ring)) throw new Error('CI publishes to development (canary) or pilot (beta); promote to stable in the Update Center');
  if (!['security', 'feature', 'emergency'].includes(o.type)) throw new Error('--type is security, feature or emergency');
  return o;
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

/** The upload plan: [{arch, local, remote, sha256?}] for every architecture found in dist. */
export function plan(dist, version) {
  const files = walk(dist).filter((f) => !/-perf/.test(basename(f)));
  const out = [];
  for (const arch of ['amd64', 'arm64']) {
    const iso = files.find((f) => new RegExp(`^worksuite-os-.*-${arch}\\.iso$`).test(basename(f)));
    if (!iso) continue;
    const name = `worksuite-os-${version}-${arch}`;
    out.push({ arch, local: iso, remote: `${name}.iso` });
    const sbom = files.find((f) => new RegExp(`^worksuite-os-.*-${arch}\\.spdx\\.json$`).test(basename(f)) && !/\.syft\./.test(f));
    if (sbom) out.push({ arch, local: sbom, remote: `${name}.sbom.spdx.json` });
  }
  return out;
}

const sha256File = (p) => new Promise((res, rej) => { const h = createHash('sha256'); createReadStream(p).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej); });

async function call(base, token, method, path, body, type) {
  const init = { method, headers: { authorization: `Bearer ${token}`, 'content-type': type }, redirect: 'error' };
  if (body && typeof body === 'object' && 'file' in body) { init.body = Readable.toWeb(createReadStream(body.file)); init.duplex = 'half'; init.headers['content-length'] = String(statSync(body.file).size); }
  else if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const r = await fetch(new URL(path, base), init);
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

export async function main() {
  const o = parseArgs(process.argv.slice(2));
  const base = process.env.UC_URL || 'https://download.worksuitecloud.com';
  if (!/^https:\/\//.test(base) && !(process.env.UC_ALLOW_HTTP_LOCALHOST === '1' && /^http:\/\/127\.0\.0\.1:/.test(base))) throw new Error('UC_URL must be https');
  const token = process.env.UPDATE_CENTER_TOKEN;
  if (!token && !o.dryRun) throw new Error('UPDATE_CENTER_TOKEN is not set');
  const items = plan(o.dist, o.version);
  if (!items.some((i) => i.remote.endsWith('.iso'))) throw new Error(`no worksuite-os-*-<arch>.iso under ${o.dist}`);
  const arches = [...new Set(items.map((i) => i.arch))];
  for (const it of items) {
    const p = `/api/v1/os/artifacts/${o.version}/${it.arch}/${it.remote}`;
    console.log(`${o.dryRun ? '[dry-run] ' : ''}PUT ${p} (${statSync(it.local).size} bytes)`);
    if (o.dryRun) continue;
    const r = await call(base, token, 'PUT', p, { file: it.local }, 'application/octet-stream');
    if (it.remote.endsWith('.iso')) {
      const sha = await sha256File(it.local);
      if (r.sha256 !== sha) throw new Error(`${it.remote}: Update Center stored ${r.sha256}, expected ${sha}`);
      await call(base, token, 'PUT', `${p}.sha256`, `${sha}  ${it.remote}\n`, 'text/plain');
    }
  }
  if (o.apt) {
    console.log(`${o.dryRun ? '[dry-run] ' : ''}PUT /api/v1/os/apt (${basename(o.apt)})`);
    if (!o.dryRun) console.log(await call(base, token, 'PUT', '/api/v1/os/apt', { file: o.apt }, 'application/gzip'));
  }
  const release = { version: o.version, ring: o.ring, arches, release_type: o.type, min_version: o.minVersion ?? o.version,
    ...(o.rollout !== undefined ? { rollout_percent: o.rollout } : {}), ...(o.notes ? { notes: readFileSync(o.notes, 'utf8') } : {}) };
  console.log(`${o.dryRun ? '[dry-run] ' : ''}POST /api/v1/os/releases ${JSON.stringify(release)}`);
  if (!o.dryRun) {
    const r = await call(base, token, 'POST', '/api/v1/os/releases', release, 'application/json');
    for (const x of r.data) console.log(`published ${x.version} ${x.ring}/${x.arch} (${x.state}, ${x.rollout_percent} %), signed by ${String(x.manifest?.signature).split(':')[0]}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
